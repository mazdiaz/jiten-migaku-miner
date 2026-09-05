import { expect, test } from "@playwright/test";

test.describe("compatibility entry point", () => {
  test("redirects the old launcher path to the canonical app", async ({ page }) => {
    await page.goto("/jiten-migaku-miner-v1.html");

    await expect(page).toHaveURL(/\/index\.html$/);
    await expect(page.locator("h1")).toHaveText("JITEN → MIGAKU MINER");
    await expect(page.locator("#jitenInput")).toBeAttached();
  });

  test("serves the canonical app at the root URL", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("h1")).toHaveText("JITEN → MIGAKU MINER");
    await expect(page.locator("#resultsList .empty-state")).toBeVisible();
  });

  test("does not expose the removed inline JitenMinerCore implementation", async ({ request }) => {
    const response = await request.get("/jiten-migaku-miner-v1.html");
    expect(response.status()).toBe(200);
    const body = await response.text();

    expect(body).not.toContain("JitenMinerCore");
    expect(body).not.toContain("miner-core");
    expect(body).toContain("index.html");
  });
});
