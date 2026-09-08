import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Deterministic weighted fixture — hand-computed arithmetic (documented):
//
//   Entries (Word, Occurences):
//     既知語一 300, 既知語二 150   <- in the imported Migaku known list
//     未知語一  20, 未知語二  12, 未知語三  8,
//     未知語四   5, 未知語五   3, 未知語六   2
//
//   totalTrackedOccurrences = 300+150+20+12+8+5+3+2 = 500
//   totalUniqueWords        = 8
//
//   After CSV + known import (step 2-3):
//     known occurrences = 300+150 = 450 -> coverage 450/500 = 90.00%
//     unique known      = 2 / 8
//     Priority path (greedy occ-desc over unknowns 20,12,8,5,3,2):
//       98.0%  reached at +3 words  (450+20+12+8  = 490 -> 98.0%)
//       98.5%  reached at +4 words  (450+20+12+8+5 = 495 -> 99.0% >= 98.5)
//       99.0%  reached at +4 words  (495 -> 99.0%)
//       99.5%  reached at +5 words  (495+3 = 498 -> 99.6% >= 99.5)
//
//   Mark 未知語一 Known (steps 4-5):
//     known occurrences = 470 -> coverage 94.00%, unique 3 / 8
//
//   Reset (step 6): back to 90.00%.
//   Mark Mined (steps 7-8): mined is not known -> still 90.00%.
//
//   Focus (steps 9-10): hide-known + occ-desc, page 1. Hide-known hides
//   Migaku-known + locally-Known only, so the Mined 未知語一 stays listed:
//     未知語一 ×20, 未知語二 ×12, 未知語三 ×8, 未知語四 ×5, 未知語五 ×3, 未知語六 ×2
//
//   Reload (step 11): persisted state = known list + 未知語一 mined decision
//   -> coverage recomputes to 90.00% again.

const UNKNOWN_ORDER = [
  "未知語一",
  "未知語二",
  "未知語三",
  "未知語四",
  "未知語五",
  "未知語六",
] as const;
const UNKNOWN_OCCURRENCES = [20, 12, 8, 5, 3, 2] as const;

function entryByWord(page: Page, word: string): ReturnType<Page["locator"]> {
  return page.locator(".mining-entry").filter({
    has: page.locator(".target-word", { hasText: word }),
  });
}

function decisionButton(page: Page, word: string, action: string) {
  return entryByWord(page, word).locator(`[data-decision-action="${action}"]`);
}

test.describe("coverage analysis", () => {
  test("tracks occurrence coverage through import, decisions, focus, and reload", async ({
    page,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), "jiten-miner-coverage-"));
    try {
      const csvPath = join(directory, "weighted.csv");
      const knownPath = join(directory, "weighted-known.txt");
      writeFileSync(
        csvPath,
        [
          "Word,Occurences,ExampleSentence,Definitions,ReadingFurigana",
          '既知語一,300,"これは**既知語一**の例文です。","known one",',
          '既知語二,150,"これは**既知語二**の例文です。","known two",',
          '未知語一,20,"これは**未知語一**の例文です。","unknown one",',
          '未知語二,12,"これは**未知語二**の例文です。","unknown two",',
          '未知語三,8,"これは**未知語三**の例文です。","unknown three",',
          '未知語四,5,"これは**未知語四**の例文です。","unknown four",',
          '未知語五,3,"これは**未知語五**の例文です。","unknown five",',
          '未知語六,2,"これは**未知語六**の例文です。","unknown six",',
          "", // trailing newline
        ].join("\n"),
        "utf8",
      );
      writeFileSync(knownPath, "既知語一\n既知語二\n", "utf8");

      // Step 1: import CSV.
      await page.goto("/");
      await page.locator("#jitenInput").setInputFiles(csvPath);
      await expect(page.locator("#resultsList .mining-entry")).toHaveCount(8);

      // Step 2: import known list. The import auto-checks Hide Known, so the
      // settled state drops to 6 visible entries; wait for it explicitly,
      // then uncheck so every entry stays visible for the decision steps.
      await page.locator("#knownInput").setInputFiles(knownPath);
      await expect(page.locator("#resultStats")).toContainText("6 currently shown");
      await expect(page.locator("#resultStats")).toContainText("2 match Migaku known words");
      await expect(page.locator("#resultsList .mining-entry")).toHaveCount(6);
      await page.locator("#advancedToggle").click();
      await expect(page.locator("#advancedPanel")).toBeVisible();
      await page.locator("#hideKnown").uncheck();
      await expect(page.locator("#resultsList .mining-entry")).toHaveCount(8);

      // Step 3: verify expected coverage (90.00%, see arithmetic above).
      await expect(page.locator("#coveragePanel")).toBeVisible();
      await expect(page.locator("#coverageSummary")).toHaveText("90.00%");
      await page.locator("#coverageToggle").click();
      await expect(page.locator("#coverageBody")).toBeVisible();
      await expect(page.locator("#coverageUniqueWords")).toHaveText("2 / 8");
      await expect(page.locator("#coverageKnownOccurrences")).toHaveText("450 / 500");
      await expect(page.locator("#coveragePercent")).toHaveText("90.00%");
      const targetRows = page.locator("#coverageTargets .coverage-target");
      await expect(targetRows).toHaveCount(4);
      await expect(targetRows.nth(0)).toContainText("98.0%");
      await expect(targetRows.nth(0)).toContainText("+3 words");
      await expect(targetRows.nth(1)).toContainText("98.5%");
      await expect(targetRows.nth(1)).toContainText("+4 words");
      await expect(targetRows.nth(2)).toContainText("99.0%");
      await expect(targetRows.nth(2)).toContainText("+4 words");
      await expect(targetRows.nth(3)).toContainText("99.5%");
      await expect(targetRows.nth(3)).toContainText("+5 words");
      await expect(page.locator("#coverageBody")).toContainText(
        "Based on occurrence counts in this Jiten export. This is not guaranteed raw-text comprehension coverage.",
      );

      // Step 4: mark the highest-occurrence unknown word Known.
      await decisionButton(page, "未知語一", "known").click();
      await expect(decisionButton(page, "未知語一", "known")).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      // Step 5: verify coverage increases (450 -> 470 of 500 = 94.00%).
      await expect(page.locator("#coverageSummary")).toHaveText("94.00%");
      await expect(page.locator("#coverageUniqueWords")).toHaveText("3 / 8");
      await expect(page.locator("#coverageKnownOccurrences")).toHaveText("470 / 500");

      // Step 6: reset the decision; coverage returns to 90.00%.
      await decisionButton(page, "未知語一", "unreviewed").click();
      await expect(decisionButton(page, "未知語一", "unreviewed")).toBeDisabled();
      await expect(page.locator("#coverageSummary")).toHaveText("90.00%");

      // Step 7: mark it Mined instead.
      await decisionButton(page, "未知語一", "mined").click();
      await expect(decisionButton(page, "未知語一", "mined")).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      // Step 8: Mined is not known — coverage must NOT increase.
      await expect(page.locator("#coverageSummary")).toHaveText("90.00%");

      // Step 9: Focus highest-value unknowns.
      await page.locator("#coverageFocus").click();

      // Step 10: list is hide-known + occurrence descending, page 1. The
      // Migaku-known words are gone; the Mined word stays (hide-known hides
      // only Migaku-known + locally-Known).
      await expect(page.locator("#hideKnown")).toBeChecked();
      await expect(page.locator("#sortSelect")).toHaveValue("occ-desc");
      await expect(page.locator("#stickyPage")).toHaveText("Page 1 / 1");
      const entries = page.locator("#resultsList .mining-entry");
      await expect(entries).toHaveCount(6);
      await expect(entryByWord(page, "既知語一")).toHaveCount(0);
      await expect(entryByWord(page, "既知語二")).toHaveCount(0);
      for (const [index, word] of UNKNOWN_ORDER.entries()) {
        await expect(entries.nth(index).locator(".target-word")).toContainText(word);
        await expect(entries.nth(index).locator(".occurrence-count")).toHaveText(
          `×${UNKNOWN_OCCURRENCES[index]}`,
        );
      }
      await expect(entryByWord(page, "未知語一").locator(".entry-badge-decision")).toHaveText(
        "Mined",
      );

      // Step 11: reload; coverage derives from persisted state (known list +
      // mined decision) and comes back as 90.00% with the Mined word intact.
      await page.reload();
      await expect(page.locator("#resultsList .mining-entry")).toHaveCount(6);
      await expect(page.locator("#coveragePanel")).toBeVisible();
      await expect(page.locator("#coverageSummary")).toHaveText("90.00%");
      await expect(entryByWord(page, "未知語一").locator(".entry-badge-decision")).toHaveText(
        "Mined",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
