import { expect, test } from "@playwright/test";

const SIXTY_CSV = "tests/fixtures/jiten-60.csv";

const LONG_DEFS_CSV = [
  "Word,Occurences,ExampleSentence,Definitions,ReadingFurigana",
  "試験,4,\"**試験**は明日だ。\",\"exam, test, trial, quiz, assessment\",試験[しけん]",
].join("\n");

test.describe("accessibility remainder", () => {
  test("markup: labels, lang scoping, live regions, single dropzone focus stop", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("#stickySearch")).toHaveAttribute("aria-label", "Search mining results");
    await expect(page.locator("#reviewContent")).not.toHaveAttribute("lang");
    await expect(page.locator("#results")).not.toHaveAttribute("aria-live");
    await expect(page.locator("#resultStats")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#queueStats")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#jitenDropzone")).not.toHaveAttribute("tabindex");
    await expect(page.locator("#knownDropzone")).not.toHaveAttribute("tabindex");
    await expect(page.locator("#resultsHeading")).toHaveAttribute("tabindex", "-1");
  });

  test("keyboard pagination focuses the results heading clear of the toolbar", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SIXTY_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(50);

    await page.locator("body").press("ArrowRight");
    await expect(page.locator("#stickyPage")).toHaveText("Page 2 / 2");
    await expect.poll(() =>
      page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.id : "")),
    ).toBe("resultsHeading");
    await expect.poll(() =>
      page.locator("#resultsHeading").evaluate((el) => el.getBoundingClientRect().top),
    ).toBeLessThanOrEqual(140.5);

    // Once scrolled, the toolbar is stuck near the top: the heading must sit
    // at or below the sticky toolbar, not underneath it.
    const toolbarBottom = await page.locator("#stickyToolbar").evaluate((el) => el.getBoundingClientRect().bottom);
    const headingTop = await page.locator("#resultsHeading").evaluate((el) => el.getBoundingClientRect().top);
    expect(headingTop).toBeGreaterThanOrEqual(toolbarBottom - 1);
  });

  test("pager click focuses the results heading clear of the toolbar", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SIXTY_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(50);

    await page.locator("#stickyNext").click();
    await expect(page.locator("#stickyPage")).toHaveText("Page 2 / 2");
    await expect.poll(() =>
      page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.id : "")),
    ).toBe("resultsHeading");
    await expect.poll(() =>
      page.locator("#resultsHeading").evaluate((el) => el.getBoundingClientRect().top),
    ).toBeLessThanOrEqual(140.5);

    const toolbarBottom = await page.locator("#stickyToolbar").evaluate((el) => el.getBoundingClientRect().bottom);
    const headingTop = await page.locator("#resultsHeading").evaluate((el) => el.getBoundingClientRect().top);
    expect(headingTop).toBeGreaterThanOrEqual(toolbarBottom - 1);
  });

  test("definitions disclosure opens via keyboard", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles({
      name: "long-defs.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(LONG_DEFS_CSV, "utf-8"),
    });
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);

    const definitions = page.locator(".mining-entry .entry-definitions").first();
    await expect(definitions).toContainText("exam, test, trial, …");
    const details = definitions.locator("details.entry-defs-details");
    await expect(definitions).not.toHaveAttribute("title");
    const summary = details.locator("summary");
    await expect(summary).toHaveText("Show full definition");

    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveJSProperty("open", true);
    await expect(definitions.locator(".entry-defs-full")).toHaveText("exam, test, trial, quiz, assessment");
    await expect(definitions.locator(".entry-defs-full")).toBeVisible();
  });

  test("letter shortcuts are inert inside the toolbar while buttons stay native", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SIXTY_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(50);

    await page.locator("#stickyNext").focus();
    await page.keyboard.press("n");
    await expect(page.locator("#stickyPage")).toHaveText("Page 1 / 2");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#stickyPage")).toHaveText("Page 1 / 2");
    await expect.poll(() =>
      page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.id : "")),
    ).toBe("stickyNext");

    // Native button activation is untouched.
    await page.keyboard.press("Enter");
    await expect(page.locator("#stickyPage")).toHaveText("Page 2 / 2");

    // Search input: caret moves, paging untouched.
    await page.locator("body").press("ArrowLeft");
    await expect(page.locator("#stickyPage")).toHaveText("Page 1 / 2");
    await page.locator("#stickySearch").fill("語");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#stickyPage")).toHaveText("Page 1 / 2");
    await expect(page.locator("#stickySearch")).toHaveValue("語");
  });
});
