import { expect, type Page, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

function entryByWord(page: Page, word: string): ReturnType<Page["locator"]> {
  return page.locator(".mining-entry").filter({
    has: page.locator(".target-word", { hasText: word }),
  });
}

test.describe("active filter chips", () => {
  test("hides the chips row on a default query and after load", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#filterChips")).toBeHidden();

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#filterChips")).toBeHidden();
  });

  test("shows chips for search and decision, removes one filter, resets all", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#stickySearch").fill("プール");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);

    await page.locator("#advancedToggle").click();
    await page.locator("#decisionFilter").selectOption("unreviewed");

    const chips = page.locator("#filterChips button[data-filter-chip]");
    await expect(page.locator("#filterChips")).toBeVisible();
    await expect(chips).toHaveCount(2);
    await expect(page.locator('#filterChips [data-filter-chip="search"]')).toHaveText(
      'Search: "プール"',
    );
    await expect(page.locator('#filterChips [data-filter-chip="search"]')).toHaveAttribute(
      "aria-label",
      'Remove Search: "プール" filter',
    );
    await expect(page.locator('#filterChips [data-filter-chip="decision"]')).toHaveText(
      "Decision: unreviewed",
    );
    await expect(page.locator("#resetFilters")).toBeVisible();

    await page.locator('#filterChips [data-filter-chip="search"]').click();
    await expect(page.locator("#stickySearch")).toHaveValue("");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator('#filterChips [data-filter-chip="search"]')).toHaveCount(0);
    await expect(page.locator("#filterChips")).toBeVisible();

    await page.locator("#sortSelect").selectOption("occ-asc");
    await page.locator("#resetFilters").click();
    await expect(page.locator("#sortSelect")).toHaveValue("occ-desc");
    await expect(page.locator("#filterChips")).toBeHidden();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  });

  test("filtered-empty state shows message, hint, chips, and recovers via reset", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#stickySearch").fill("zzzz");
    await expect(page.locator("#resultsList .empty-state")).toContainText(
      "No entries match the current filters.",
    );
    await expect(page.locator("#resultsList .empty-state .empty-hint")).toHaveText(
      "Try removing a filter.",
    );
    await expect(page.locator("#filterChips")).toBeVisible();
    await expect(page.locator('#filterChips [data-filter-chip="search"]')).toBeVisible();
    await expect(page.locator("#resetFilters")).toBeVisible();

    await page.locator("#resetFilters").click();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#filterChips")).toBeHidden();
  });

  test("hides the chips row in queue mode and restores it on exit", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#stickySearch").fill("言葉");
    await expect(page.locator("#filterChips")).toBeVisible();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(0);

    const queueButton = entryByWord(page, "気になる").locator("[data-queue-action='toggle']");
    await page.locator("#stickySearch").fill("");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await queueButton.click();
    await expect(page.locator("#queueToggle")).toHaveText("Queue (1)");

    await page.locator("#queueToggle").click();
    await expect(page.locator("#queueHeader")).toBeVisible();
    await expect(page.locator("#filterChips")).toBeHidden();

    await page.locator("#exitQueue").click();
    await expect(page.locator("#queueHeader")).toBeHidden();
    await expect(page.locator("#filterChips")).toBeHidden();
  });
});
