import { expect, test } from "./fixtures";

test("old bookmarks redirect to the Next.js app", async ({ page }) => {
  await page.goto("/jiten-migaku-miner-v1.html");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#jitenInput")).toBeAttached();
});
test("canonical app is served at root", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await expect(page.locator("#resultsList .empty-state")).toBeVisible();
});
test("flag 0 reports the server-first fallback mode", async ({ page }) => {
  test.skip(
    process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC !== "0",
    "Requires server-first fallback mode (NEXT_PUBLIC_LOCAL_FIRST_SYNC=0)",
  );
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await expect
    .poll(() => page.evaluate(() => (window as any).__jitenStorageMode))
    .toBe("server-first fallback");
});
test("legacy entry returns a server redirect", async ({ request }) => {
  const response = await request.get("/index.html", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("/");
});
