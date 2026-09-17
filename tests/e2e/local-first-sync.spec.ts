import { expect, test } from "./fixtures";

test("warm offline boot allows study and marks changes saved locally", async ({ page }) => {
  await page.goto("/");
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  // Reload once to prove cached state exists locally
  await page.reload();
  await expect(page.locator(".mining-entry")).toHaveCount(3);

  // Route /api/sync to abort/fail
  await page.route("**/api/sync", (route) => route.abort());

  // Reload page
  await page.reload();
  await expect(page.locator(".mining-entry")).toHaveCount(3);

  // Set a decision
  const firstEntry = page.locator(".mining-entry").first();
  await firstEntry.locator("[data-decision-action='known']").click();
  await expect(firstEntry.locator("[data-decision-action='known']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Assert study controls remain interactive
  await expect(page.locator("#reviewButton")).toBeEnabled();
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");

  // Assert status text
  await expect(page.locator(".cloud-status")).toHaveText("Offline · changes saved locally");
});
