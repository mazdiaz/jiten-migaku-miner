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

test("two browser contexts converge on word decisions without manual reload", async ({
  page,
  browser,
  context,
  baseURL,
}) => {
  await page.goto("/");
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  // Context A: set 気になる known -> wait for Synced
  const entryA = page.locator(".mining-entry", {
    has: page.locator(".target-word", { hasText: "気になる" }),
  });
  await entryA.locator("[data-decision-action='known']").click();
  await expect(entryA.locator("[data-decision-action='known']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  // Context B: fresh browser context with same cookies
  const secondContext = await browser.newContext();
  try {
    await secondContext.addCookies(await context.cookies());
    const pageB = await secondContext.newPage();
    await pageB.goto(`${baseURL}/`);
    await expect(pageB.locator(".cloud-status")).toHaveText("Synced");
    await expect(pageB.locator(".mining-entry")).toHaveCount(3);

    // Context B: assert 気になる is known
    const entryB = pageB.locator(".mining-entry", {
      has: pageB.locator(".target-word", { hasText: "気になる" }),
    });
    await expect(entryB.locator("[data-decision-action='known']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Context B: set 気になる mined -> wait for Synced
    await entryB.locator("[data-decision-action='mined']").click();
    await expect(entryB.locator("[data-decision-action='mined']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(pageB.locator(".cloud-status")).toHaveText("Synced");

    // Context A: bring page to foreground / trigger sync -> assert 気になる mined
    await page.bringToFront();
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(entryA.locator("[data-decision-action='mined']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await secondContext.close();
  }
});

test("offline edits survive reload and sync when connection is restored", async ({
  page,
  browser,
  context,
  baseURL,
}) => {
  await page.goto("/");
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  // Set browser context offline
  await context.setOffline(true);

  // Set first entry known and set hideKnown=true
  const firstEntry = page.locator(".mining-entry").first();
  await firstEntry.locator("[data-decision-action='known']").click();

  await page.locator("#advancedToggle").click();
  await expect(page.locator("#advancedPanel")).toBeVisible();
  await page.locator("#hideKnown").check();

  // Reload while offline
  await page.reload();

  // Assert decision and filter are restored locally
  await expect(page.locator("#hideKnown")).toBeChecked();
  await expect(page.locator(".cloud-status")).toHaveText("Offline · changes saved locally");

  // Bring context online
  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  // Open fresh second context to assert cloud received the change
  const secondContext = await browser.newContext();
  try {
    await secondContext.addCookies(await context.cookies());
    const pageB = await secondContext.newPage();
    await pageB.goto(`${baseURL}/`);
    await expect(pageB.locator(".cloud-status")).toHaveText("Synced");
    const entryB = pageB.locator(".mining-entry").first();
    await expect(entryB.locator("[data-decision-action='known']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await secondContext.close();
  }
});
