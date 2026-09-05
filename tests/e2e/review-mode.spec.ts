import { expect, test, type Page } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

async function acceptDialogs(page: Page): Promise<void> {
  page.on("dialog", (dialog) => dialog.accept());
}

function reviewTarget(page: Page): ReturnType<Page["locator"]> {
  return page.locator("#reviewContent .review-entry .target-word");
}

async function openReview(page: Page): Promise<void> {
  await page.locator("#reviewButton").click();
  await expect(page.locator("#reviewOverlay")).toBeVisible();
}

test.describe("review mode", () => {
  test.beforeEach(async ({ page }) => {
    await acceptDialogs(page);
  });

  test("triages the queue with the keyboard and persists every decision", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#reviewButton")).toBeEnabled();

    // First word under the current sort (occ-desc) is 気になる (×12).
    await openReview(page);
    await expect(page.locator("#reviewHeading")).toHaveText("Review");
    await expect(page.locator("#reviewProgress")).toHaveText("0 processed · 3 remaining");
    await expect(reviewTarget(page)).toHaveText("気になる");
    await expect(page.locator("#reviewKnown")).toBeEnabled();

    // Normal list stays untouched underneath.
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.keyboard.press("m");
    await expect(reviewTarget(page)).toHaveText("プール");
    await expect(page.locator("#reviewProgress")).toHaveText("1 processed · 2 remaining");

    await page.keyboard.press("l");
    await expect(reviewTarget(page)).toHaveText("静か");

    await page.keyboard.press("k");
    await expect(page.locator("#reviewComplete")).toBeVisible();
    await expect(page.locator("#reviewComplete")).toContainText(
      "No unreviewed candidates remain for the current filters.",
    );
    await expect(page.locator("#reviewContent")).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(page.locator("#reviewOverlay")).toBeHidden();
    await expect(page.locator("#reviewButton")).toBeFocused();

    // Decisions land in the normal list filters.
    await page.locator("#decisionFilter").selectOption("mined");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("気になる");
    await expect(page.locator(".entry-badge-decision").first()).toHaveText("Mined");
  });

  test("keeps reviewed words out of a reopened session after reload", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await openReview(page);
    await expect(reviewTarget(page)).toHaveText("気になる");
    await page.keyboard.press("m");
    await expect(reviewTarget(page)).toHaveText("プール");
    await page.keyboard.press("Escape");
    await expect(page.locator("#reviewOverlay")).toBeHidden();

    await page.reload();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    // Mined decision persisted and follows the word.
    await page.locator("#decisionFilter").selectOption("mined");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("気になる");
    await page.locator("#decisionFilter").selectOption("all");

    await openReview(page);
    // processed counts this session only; the mined decision is durable, not the counter.
    await expect(page.locator("#reviewProgress")).toHaveText("0 processed · 2 remaining");
    await expect(reviewTarget(page)).toHaveText("プール");
    await expect(page.locator(".review-entry .target-word", { hasText: "気になる" })).toHaveCount(0);

    await page.keyboard.press("s");
    await expect(reviewTarget(page)).toHaveText("静か");
    await page.keyboard.press("l");
    await expect(page.locator("#reviewComplete")).toBeVisible();
  });

  test("list shortcuts stay suppressed while the overlay is open", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await openReview(page);
    await expect(reviewTarget(page)).toHaveText("気になる");
    await page.locator("#pageSize").selectOption("25");
    await page.locator("#reviewContent").click();
    await page.keyboard.press("n");
    await expect(reviewTarget(page)).toHaveText("気になる");
    await expect(page.locator("#topPage")).toHaveText("Page 1 / 1");
  });

  test("button clicks apply the same decisions as shortcuts", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await openReview(page);
    await expect(reviewTarget(page)).toHaveText("気になる");
    await page.locator("#reviewKnown").click();
    await expect(reviewTarget(page)).toHaveText("プール");

    await page.locator("#reviewExit").click();
    await expect(page.locator("#reviewOverlay")).toBeHidden();

    await page.locator("#decisionFilter").selectOption("known");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("気になる");
  });
});
