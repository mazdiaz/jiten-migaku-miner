import { expect, test } from "./fixtures";

test.beforeEach(async () => {
  test.skip(
    process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC !== "1",
    "Requires local-first sync mode (NEXT_PUBLIC_LOCAL_FIRST_SYNC=1)",
  );
});

test("cold local-first boot remains usable when bootstrap sync is unavailable", async ({
  page,
  browser,
  context,
  baseURL,
}) => {
  await page.route("**/api/sync*", (route) => route.abort());
  await page.goto("/");

  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(page.locator("#reviewButton")).toBeEnabled();
  await expect(page.locator(".cloud-status")).not.toHaveText(/Database|PostgreSQL/);
  await expect(page.locator(".cloud-status")).toHaveText(
    /^(Sync error · changes remain on this device|Offline · changes saved locally)\s*$/,
  );

  await page.unroute("**/api/sync*");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  const secondContext = await browser.newContext();
  try {
    await secondContext.addCookies(await context.cookies());
    const pageB = await secondContext.newPage();
    await pageB.goto(`${baseURL}/`);
    await expect(pageB.locator(".mining-entry")).toHaveCount(3);
    await expect(pageB.locator(".cloud-status")).toHaveText("Synced");
  } finally {
    await secondContext.close();
  }
});

test("warm offline boot allows study and marks changes saved locally", async ({ page }) => {
  const storeRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/store")) storeRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText(/^(Synced|Saved locally)\s*$/);
  expect(storeRequests).toEqual([]);
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

test("CSV import stays usable while sync is unavailable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText(/^(Synced|Saved locally)\s*$/);

  await page.route("**/api/sync*", (route) => route.abort());
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");

  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(page.locator("#reviewButton")).toBeEnabled();
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".cloud-status")).not.toHaveText(/Database|PostgreSQL/);

  await page.unroute("**/api/sync*");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".cloud-status")).toHaveText("Synced");
});

test("a sync 503 keeps local decisions durable across reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText(/^(Synced|Saved locally)\s*$/);
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  let syncFailed = false;
  await page.route("**/api/sync*", async (route) => {
    syncFailed = true;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Database sync operation could not be confirmed. Try again later.",
      }),
    });
  });

  const firstEntry = page.locator(".mining-entry").first();
  await firstEntry.locator("[data-decision-action='known']").click();
  await expect(firstEntry.locator("[data-decision-action='known']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => syncFailed).toBe(true);
  await expect(page.locator(".cloud-status")).toHaveText(
    "Sync error · changes remain on this device",
  );

  await page.reload();
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(
    page.locator(".mining-entry").first().locator("[data-decision-action='known']"),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cloud-status")).toHaveText(
    "Sync error · changes remain on this device",
  );

  await page.unroute("**/api/sync*");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".cloud-status")).toHaveText("Synced");
});

test("two browser contexts converge on word decisions without manual reload", async ({
  page,
  browser,
  context,
  baseURL,
}) => {
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText(/^(Synced|Saved locally)\s*$/);
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
  await expect(page.locator(".cloud-status")).toHaveText(/^(Synced|Saved locally)\s*$/);
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  // Simulate sync connection loss
  await page.route("**/api/sync", (route) => route.abort());

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

  // Restore sync connection
  await page.unroute("**/api/sync");
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
    await pageB.locator("#advancedToggle").click();
    await expect(pageB.locator("#advancedPanel")).toBeVisible();
    await expect(pageB.locator("#hideKnown")).toBeChecked();
    await pageB.locator("#hideKnown").uncheck();
    const entryB = pageB.locator(".mining-entry", {
      has: pageB.locator(".target-word", { hasText: "気になる" }),
    });
    await expect(entryB.locator("[data-decision-action='known']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await secondContext.close();
  }
});
