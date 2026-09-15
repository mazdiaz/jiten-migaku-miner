import { expect, test } from "./fixtures";

test("production build imports and reloads PostgreSQL data", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await page.reload();
  await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  expect(errors).toEqual([]);
});
test("production routes protect files and redirect legacy bookmarks", async ({ page, request }) => {
  await page.goto("/jiten-migaku-miner-v1.html");
  await expect(page).toHaveURL(/\/$/);
  expect((await request.get("/WORDS%20TO%20MINE/")).status()).toBe(404);
  expect((await request.get("/.env.local")).status()).toBe(404);
  expect((await request.get("/src/main.ts")).status()).toBe(404);
  expect((await request.get("/migrations/0000_postgres_store.sql")).status()).toBe(404);
});
