import { expect, test, type Page } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";
const FOLLOWUP_CSV = "tests/fixtures/jiten-followup.csv";

const DECISION_ACTIONS = ["known", "mined", "skip", "later"] as const;

type DecisionAction = (typeof DECISION_ACTIONS)[number] | "unreviewed";

async function acceptDialogs(page: Page): Promise<void> {
  page.on("dialog", (dialog) => dialog.accept());
}

function entryByWord(page: Page, word: string): ReturnType<Page["locator"]> {
  return page.locator(".mining-entry").filter({
    has: page.locator(".target-word", { hasText: word }),
  });
}

function decisionButton(page: Page, word: string, action: DecisionAction) {
  return entryByWord(page, word).locator(`[data-decision-action="${action}"]`);
}

async function markDecision(page: Page, word: string, action: DecisionAction): Promise<void> {
  await decisionButton(page, word, action).click();
  if (action === "unreviewed") {
    await expect(decisionButton(page, word, action)).toBeDisabled();
  } else {
    await expect(decisionButton(page, word, action)).toHaveAttribute("aria-pressed", "true");
  }
}

async function expectEntryDecision(
  page: Page,
  word: string,
  status: (typeof DECISION_ACTIONS)[number] | "unreviewed",
): Promise<void> {
  for (const action of DECISION_ACTIONS) {
    await expect(decisionButton(page, word, action)).toHaveAttribute(
      "aria-pressed",
      action === status ? "true" : "false",
    );
  }
  const reset = decisionButton(page, word, "unreviewed");
  if (status === "unreviewed") {
    await expect(reset).toBeDisabled();
  } else {
    await expect(reset).toBeEnabled();
    await expect(entryByWord(page, word).locator(".entry-badge-decision")).toHaveText(
      { known: "Known", mined: "Mined", skip: "Skip", later: "Later" }[status],
    );
  }
}

test.describe("persistent word decisions", () => {
  test("restores known, mined, and later decisions after reload and filters by decision", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await expect(page.locator("#hideKnown")).toBeDisabled();

    await markDecision(page, "気になる", "known");
    await markDecision(page, "プール", "mined");
    await markDecision(page, "静か", "later");

    await expectEntryDecision(page, "気になる", "known");
    await expectEntryDecision(page, "プール", "mined");
    await expectEntryDecision(page, "静か", "later");

    await expect(page.locator("#hideKnown")).toBeEnabled();

    await page.reload();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await expectEntryDecision(page, "気になる", "known");
    await expectEntryDecision(page, "プール", "mined");
    await expectEntryDecision(page, "静か", "later");

    await page.locator("#hideKnown").check();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);
    await expect(entryByWord(page, "気になる")).toHaveCount(0);
    await expect(entryByWord(page, "プール")).toHaveCount(1);
    await expect(entryByWord(page, "静か")).toHaveCount(1);

    await page.locator("#decisionFilter").selectOption("mined");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(entryByWord(page, "プール")).toHaveCount(1);
    await expect(page.locator("#resultsList .mining-entry .entry-badge-decision")).toHaveText("Mined");
  });

  test("follows a mined decision into a new import, resets it, and clears it", async ({ page }) => {
    await acceptDialogs(page);
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await markDecision(page, "プール", "mined");

    await page.locator("#jitenInput").setInputFiles(FOLLOWUP_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);
    await expectEntryDecision(page, "プール", "mined");

    await markDecision(page, "プール", "unreviewed");
    await expectEntryDecision(page, "プール", "unreviewed");
    await expect(entryByWord(page, "プール").locator(".entry-badge-decision")).toHaveCount(0);

    await page.locator("#clearData").click();
    await expect(page.locator("#resultsList .empty-state")).toContainText(
      "Load a Jiten CSV above. Everything stays in this browser tab.",
    );

    await page.reload();
    await expect(page.locator("#resultsList .empty-state")).toBeVisible();

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator(".entry-badge-decision")).toHaveCount(0);
    await expectEntryDecision(page, "気になる", "unreviewed");
    await expectEntryDecision(page, "プール", "unreviewed");
    await expectEntryDecision(page, "静か", "unreviewed");
  });
});
