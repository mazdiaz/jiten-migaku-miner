import { expect, type Page, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

async function acceptDialogs(page: Page): Promise<void> {
  page.on("dialog", (dialog) => dialog.accept());
}

function reviewTarget(page: Page): ReturnType<Page["locator"]> {
  return page.locator("#reviewContent #resultsList .review-entry .target-word");
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

    // Review temporarily mounts the existing results surface into the modal.
    // This keeps the same Migaku-facing DOM surface instead of creating a
    // separate Japanese sentence tree that Full Power never parsed.
    await expect(page.locator("#reviewContent > #resultsList")).toHaveCount(1);
    await expect(page.locator("#reviewContent #resultsList .review-entry")).toHaveCount(1);
    await expect(page.locator("main.app-shell #resultsList")).toHaveCount(0);

    // Q is intentionally not consumed by our review shortcuts so Migaku can
    // keep using its instant-card shortcut on the shared results surface.
    await page.evaluate(() => {
      (window as unknown as { __reviewQ?: { key: string; defaultPrevented: boolean } }).__reviewQ =
        undefined;
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key.toLowerCase() !== "q") return;
          (window as unknown as { __reviewQ?: { key: string; defaultPrevented: boolean } }).__reviewQ = {
            key: event.key,
            defaultPrevented: event.defaultPrevented,
          };
        },
        { once: true },
      );
    });
    await page.keyboard.press("q");
    await expect(reviewTarget(page)).toHaveText("気になる");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __reviewQ?: { key: string; defaultPrevented: boolean } }).__reviewQ,
      ),
    ).toEqual({ key: "q", defaultPrevented: false });

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

    // The same results surface returns to the normal app after review exits.
    await expect(page.locator("main.app-shell #resultsList")).toHaveCount(1);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    // Decisions land in the normal list filters.
    await page.locator("#advancedToggle").click();
    await expect(page.locator("#advancedPanel")).toBeVisible();
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
    await page.locator("#advancedToggle").click();
    await expect(page.locator("#advancedPanel")).toBeVisible();
    await page.locator("#decisionFilter").selectOption("mined");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("気になる");
    await page.locator("#decisionFilter").selectOption("all");

    await openReview(page);
    // processed counts this session only; the mined decision is durable, not the counter.
    await expect(page.locator("#reviewProgress")).toHaveText("0 processed · 2 remaining");
    await expect(reviewTarget(page)).toHaveText("プール");
    await expect(page.locator(".review-entry .target-word", { hasText: "気になる" })).toHaveCount(
      0,
    );

    await page.keyboard.press("s");
    await expect(reviewTarget(page)).toHaveText("静か");
    await page.keyboard.press("l");
    await expect(page.locator("#reviewComplete")).toBeVisible();
  });

  test("list shortcuts stay suppressed while the overlay is open", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    // Expand filters first: the disclosure stays expanded (but inert) under the overlay.
    await page.locator("#advancedToggle").click();
    await expect(page.locator("#advancedPanel")).toBeVisible();

    await openReview(page);
    await expect(reviewTarget(page)).toHaveText("気になる");
    await page.locator("#pageSize").selectOption("25");
    await page.locator("#reviewContent").click();
    await page.keyboard.press("n");
    await expect(reviewTarget(page)).toHaveText("気になる");
    await expect(page.locator("#stickyPage")).toHaveText("Page 1 / 1");
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

    await page.locator("#advancedToggle").click();
    await expect(page.locator("#advancedPanel")).toBeVisible();
    await page.locator("#decisionFilter").selectOption("known");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("気になる");
  });
});
