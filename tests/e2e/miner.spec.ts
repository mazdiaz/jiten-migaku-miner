import { expect, test, type Page } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";
const SMALL_KNOWN = "tests/fixtures/known-small.txt";
const SIXTY_CSV = "tests/fixtures/jiten-60.csv";

const AUTO_CSV = [
  "Word,Occurences,ExampleSentence,Definitions,ReadingFurigana",
  "自動,5,\"これは**自動**の例文です。\",automatic,自動[じどう]",
].join("\n");

async function acceptDialogs(page: Page): Promise<void> {
  page.on("dialog", (dialog) => dialog.accept());
}

test.describe("canonical miner", () => {
  test("loads the shell with current labels, disabled filters, and empty state", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator(".eyebrow")).toHaveText("Local · Offline · Migaku-friendly");
    await expect(page.locator("h1")).toHaveText("JITEN → MIGAKU MINER");
    await expect(page.locator("#jitenDropzone .dropzone-title")).toHaveText("Jiten CSV");
    await expect(page.locator("#knownDropzone .dropzone-title")).toHaveText("Migaku Known Words");
    await expect(page.locator("#jitenStatus")).toHaveText("No CSV loaded");
    await expect(page.locator("#knownStatus")).toHaveText("Optional · no list loaded");
    await expect(page.locator("#errorBox")).toBeHidden();
    await expect(page.locator("#filtersFieldset")).toHaveAttribute("disabled", "");
    await expect(page.locator("#searchInput")).toBeDisabled();
    await expect(page.locator("#resultsList .empty-state")).toContainText(
      "Load a Jiten CSV above. Everything stays in this browser tab.",
    );
    await expect(page.locator("#resultStats")).toHaveText("Load a Jiten CSV to begin.");
    await expect(page.locator("#stickyToolbar")).toBeHidden();
  });

  test("imports the fixture, numbers entries, and shows stats", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);

    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#resultStats")).toContainText("Loaded 3");
    await expect(page.locator("#resultStats")).toContainText("3 currently shown");
    await expect(page.locator(".mining-entry .entry-number").first()).toHaveText("1.");
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("気になる");
    await expect(page.locator(".mining-entry .sentence").first()).toContainText("彼は気になる。");
    await expect(page.locator(".mining-entry .entry-definitions").first()).toBeVisible();
    await expect(page.locator("#jitenStatus")).toContainText("✓");
    await expect(page.locator("#filtersFieldset")).toBeEnabled();
    await expect(page.locator("#stickyToolbar")).toBeVisible();
    await expect(page.locator("#stickyTitle")).toContainText("jiten-small");
    await expect(page.locator(".mining-entry ruby")).toHaveCount(0);
    await expect(page.locator(".target-highlight")).toHaveCount(0);
  });

  test("searches words and mirrors the sticky search box", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#searchInput").fill("プール");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("プール");
    await expect(page.locator("#stickySearch")).toHaveValue("プール");

    await page.locator("#stickySearch").fill("静か");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator("#searchInput")).toHaveValue("静か");

    await page.locator("#searchInput").fill("");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  });

  test("paginates a larger import with buttons and keyboard shortcuts", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SIXTY_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(50);
    await expect(page.locator("#resultStats")).toContainText("Loaded 60");

    await expect(page.locator("#topPage")).toHaveText("Page 1 / 2");
    await expect(page.locator("#topPrev")).toBeDisabled();
    await expect(page.locator("#bottomNext")).toBeEnabled();

    await page.locator("#topNext").click();
    await expect(page.locator("#topPage")).toHaveText("Page 2 / 2");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(10);
    await expect(page.locator(".mining-entry .entry-number").first()).toHaveText("51.");
    await expect(page.locator("#topNext")).toBeDisabled();

    await page.locator("body").press("ArrowLeft");
    await expect(page.locator("#topPage")).toHaveText("Page 1 / 2");
    await expect(page.locator(".mining-entry .entry-number").first()).toHaveText("1.");

    await page.locator("#searchInput").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#topPage")).toHaveText("Page 1 / 2");

    await page.locator("#searchInput").blur();
    await page.locator("body").press("ArrowRight");
    await expect(page.locator("#topPage")).toHaveText("Page 2 / 2");

    await page.locator("#pageSize").selectOption("25");
    await expect(page.locator("#topPage")).toHaveText("Page 1 / 3");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(25);
    await expect(page.locator("#stickyPageSize")).toHaveValue("25");

    await page.locator("#stickyPageSize").selectOption("all");
    await expect(page.locator("#topPage")).toHaveText("Page 1 / 1");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(60);

    await page.locator("#stickySort").selectOption("occ-asc");
    await expect(page.locator(".mining-entry .entry-number").first()).toHaveText("1.");
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("語1");
    await expect(page.locator("#sortSelect")).toHaveValue("occ-asc");
  });

  test("imports known words, hides known entries, and re-enables them", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#knownInput").setInputFiles(SMALL_KNOWN);
    await expect(page.locator("#knownStatus")).toContainText("✓");
    await expect(page.locator("#knownStatus")).toContainText("1");
    await expect(page.locator("#hideKnown")).toBeChecked();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);
    await expect(page.locator("#resultStats")).toContainText("1 match Migaku known words");

    await page.locator("#hideKnown").uncheck();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  });

  test("filters by sentence presence and kana-only words", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#sentenceFilter").selectOption("has");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);

    await page.locator("#sentenceFilter").selectOption("none");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("静か");

    await page.locator("#sentenceFilter").selectOption("any");
    await page.locator("#hideKanaOnly").check();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);

    await page.locator("#minOccurrences").fill("10");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("気になる");
  });

  test("sorts by occurrences and original order", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);

    await page.locator("#sortSelect").selectOption("occ-asc");
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("静か");

    await page.locator("#sortSelect").selectOption("original");
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("気になる");
  });

  test("toggles definitions, furigana, highlight, and pill modes", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator(".mining-entry .entry-definitions").first()).toBeVisible();

    await page.locator("#showDefinitions").uncheck();
    await expect(page.locator(".mining-entry .entry-definitions")).toHaveCount(0);

    await page.locator("#showFurigana").check();
    await expect(page.locator(".mining-entry .target-word ruby").first()).toBeVisible();
    await expect(page.locator("#stickyFurigana")).toBeChecked();

    await page.locator("#showHighlight").check();
    await expect(page.locator(".target-highlight").first()).toBeVisible();
    await expect(page.locator(".sentence[data-surface]").first()).toBeVisible();

    await page.locator("#pillHighlight").check();
    await expect(page.locator("body")).toHaveClass(/hl-pill/);

    await page.locator("#stickyHl").uncheck();
    await expect(page.locator(".target-highlight")).toHaveCount(0);
  });

  test("reconciles furigana highlights after DOM mutation and falls back live", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await page.locator("#showHighlight").check();
    await page.locator("#showFurigana").check();

    const firstSentence = page.locator(".sentence[data-surface]").first();
    await expect(firstSentence.locator("span.target-highlight ruby").first()).toBeVisible();
    await expect(firstSentence.locator("span.th-wrap").first()).toBeVisible();
    await expect(firstSentence.locator("span.th-wrap.th-first").first()).toBeVisible();

    await page.evaluate(() => {
      document.querySelectorAll("#resultsList span.th-wrap").forEach((element) => {
        const parent = element.parentNode;
        if (parent === null) return;
        while (element.firstChild !== null) parent.insertBefore(element.firstChild, element);
        parent.removeChild(element);
        parent.normalize();
      });
    });

    await expect(page.locator("#resultsList span.th-wrap").first()).toBeVisible();

    await page.evaluate(() => {
      const sentence = document.querySelector("#resultsList .sentence[data-surface]");
      if (sentence === null) return;
      (sentence as HTMLElement).dataset.surface = "存在しない表面";
      sentence.appendChild(document.createTextNode(""));
    });

    await expect(page.locator("#resultsList .target-highlight.th-live").first()).toBeVisible();
    await expect(page.locator("#resultsList span.th-wrap")).toHaveCount(0);
  });

  test("restores dataset, page, and preferences after reload through IndexedDB", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SIXTY_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(50);
    await page.locator("#topNext").click();
    await expect(page.locator("#topPage")).toHaveText("Page 2 / 2");
    await page.locator("#searchInput").fill("語59");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);

    await page.reload();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator("#resultStats")).toContainText("Loaded 60");
    await expect(page.locator("#searchInput")).toHaveValue("語59");
    await expect(page.locator("#topPage")).toHaveText("Page 1 / 1");
  });

  test("clears saved data after confirmation", async ({ page }) => {
    await acceptDialogs(page);
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#clearData").click();

    await expect(page.locator("#resultsList .empty-state")).toContainText(
      "Load a Jiten CSV above. Everything stays in this browser tab.",
    );
    await expect(page.locator("#resultStats")).toHaveText("Load a Jiten CSV to begin.");
    await expect(page.locator("#jitenStatus")).toHaveText("No CSV loaded");
    await expect(page.locator("#filtersFieldset")).toHaveAttribute("disabled", "");
    await expect(page.locator("#searchInput")).toBeDisabled();

    await page.reload();
    await expect(page.locator("#resultsList .empty-state")).toBeVisible();
  });

  test("auto-loads the newest same-origin folder files over http", async ({ page }) => {
    await page.route("**/WORDS%20TO%20MINE/", async (route) => {
      await route.fulfill({ contentType: "text/html", body: '<a href="auto.csv">auto.csv</a>' });
    });
    await page.route("**/auto.csv", async (route) => {
      if (route.request().method() === "HEAD") {
        await route.fulfill({
          headers: { "Last-Modified": "Thu, 03 Sep 2026 00:00:00 GMT" },
        });
        return;
      }
      await route.fulfill({ contentType: "text/csv", body: AUTO_CSV });
    });

    await page.goto("/");

    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("自動");
    await expect(page.locator("#jitenStatus")).toContainText("auto.csv");
  });

  test("keeps loaded data when automatic discovery fails", async ({ page }) => {
    await page.route("**/WORDS%20TO%20MINE/", async (route) => {
      await route.fulfill({ status: 404 });
    });

    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.reload();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#resultStats")).toContainText("Loaded 3");
  });
});
