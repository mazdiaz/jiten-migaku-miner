import { expect, type Page, test } from "./fixtures";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

// Wait for the cloud operation queue to drain before exercising reload.
async function waitForStoredView(
  page: Page,
  expected: { sentenceSize: string; density: string },
): Promise<void> {
  await expect(page.locator("#sentenceSize")).toHaveValue(expected.sentenceSize);
  await expect(page.locator("#density")).toHaveValue(expected.density);
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
}
async function openFilters(page: Page): Promise<void> {
  await page.locator("#advancedToggle").click();
  await expect(page.locator("#advancedPanel")).toBeVisible();
}

test.describe("reading display controls", () => {
  test("defaults keep the current look: no body classes, base sentence size", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await openFilters(page);

    await expect(page.locator("#sentenceSize")).toHaveValue("medium");
    await expect(page.locator("#density")).toHaveValue("comfortable");
    await expect(page.locator("body")).not.toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).not.toHaveClass(/density-compact/);
  });

  test("toggles both controls, re-renders with classes, and computes a larger sentence font", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await openFilters(page);

    const firstSentence = page.locator("#resultsList .mining-entry .sentence").first();
    await expect(firstSentence).toBeVisible();
    const mediumSize = await firstSentence.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );

    await page.locator("#sentenceSize").selectOption("large");
    await expect(page.locator("body")).toHaveClass(/sent-size-lg/);
    // The list itself stays intact after the preference re-render.
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    const largeSize = await firstSentence.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    expect(largeSize).toBeGreaterThan(mediumSize);

    await page.locator("#density").selectOption("compact");
    await expect(page.locator("body")).toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).toHaveClass(/density-compact/);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#sentenceSize")).toHaveValue("large");
    await expect(page.locator("#density")).toHaveValue("compact");
  });

  test("persists both display preferences across reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await openFilters(page);

    await page.locator("#sentenceSize").selectOption("large");
    await page.locator("#density").selectOption("compact");
    await expect(page.locator("body")).toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).toHaveClass(/density-compact/);
    await waitForStoredView(page, {
      sentenceSize: "large",
      density: "compact",
    });

    await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
    await page.reload();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#sentenceSize")).toHaveValue("large");
    await expect(page.locator("#density")).toHaveValue("compact");
    await expect(page.locator("body")).toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).toHaveClass(/density-compact/);

    const firstSentence = page.locator("#resultsList .mining-entry .sentence").first();
    const largeSize = await firstSentence.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    await page.locator("#advancedToggle").click();
    await page.locator("#sentenceSize").selectOption("medium");
    const mediumSize = await firstSentence.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    expect(largeSize).toBeGreaterThan(mediumSize);
    await expect(page.locator("body")).not.toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).toHaveClass(/density-compact/);
  });
});
