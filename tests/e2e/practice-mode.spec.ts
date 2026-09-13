import { expect, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

function practiceTarget(page: import("@playwright/test").Page) {
  return page.locator("#practiceContent #resultsList .practice-entry .target-word");
}

test.describe("practice mode", () => {
  test("reveals the answer before advancing", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#practiceButton").click();
    await expect(page.locator("#practiceOverlay")).toBeVisible();
    await expect(page.locator("#practiceProgress")).toHaveText("1 / 3");
    await expect(practiceTarget(page)).toBeVisible();
    await expect(page.locator("#practiceContent .entry-definitions")).toHaveCount(0);

    await page.keyboard.press("Space");
    await expect(page.locator("#practiceContent .entry-definitions")).toBeVisible();
    await expect(page.locator("#practiceReveal")).toHaveText("Next");
  });
});
