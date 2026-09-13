import { expect, type Page, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

function practiceTarget(page: Page) {
  return page.locator("#practiceContent #resultsList .practice-entry .target-word");
}

async function openPractice(page: Page): Promise<void> {
  await page.locator("#practiceButton").click();
  await expect(page.locator("#practiceOverlay")).toBeVisible();
}

test.describe("practice mode", () => {
  test("reveals the answer before advancing", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await openPractice(page);
    await expect(page.locator("#practiceProgress")).toHaveText("1 / 3");
    await expect(practiceTarget(page)).toBeVisible();
    await expect(page.locator("#practiceContent .entry-definitions")).toBeHidden();
    await expect(page.locator("#practiceContent rt")).toBeHidden();
    await expect(page.locator("#practiceReveal")).toHaveText("Reveal");

    await page.keyboard.press("Space");
    await expect(page.locator("#practiceContent .entry-definitions")).toBeVisible();
    await expect(page.locator("#practiceReveal")).toHaveText("Next");
  });

  test("uses the current filters once each without saving practice as decisions", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#hideKanaOnly").check();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);

    await openPractice(page);
    await expect(page.locator("#practiceProgress")).toHaveText("1 / 2");

    const seen: string[] = [];
    seen.push(await practiceTarget(page).innerText());
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await expect(page.locator("#practiceProgress")).toHaveText("2 / 2");
    seen.push(await practiceTarget(page).innerText());
    expect(new Set(seen).size).toBe(2);
    expect(seen).not.toContain("プール");

    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await expect(page.locator("#practiceComplete")).toBeVisible();
    await page.locator("#practiceReturn").click();
    await expect(page.locator("#practiceOverlay")).toBeHidden();
    await expect(page.locator("#resultsList .entry-badge-decision")).toHaveCount(0);
  });
});
