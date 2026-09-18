import { readFileSync } from "node:fs";
import { encode } from "next-auth/jwt";
import { TEST_SECRET } from "../support/environment";
import { expect, test } from "./fixtures";

test("reload initializes controls without hydration errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator("#reviewButton")).toBeEnabled();
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await page.reload();
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await expect(page.locator("#reviewButton")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("unauthenticated and non-owner sessions cannot access saved data", async ({
  browser,
  baseURL,
}) => {
  const outsider = await browser.newContext();
  try {
    const response = await outsider.request.post(`${baseURL}/api/store`, {
      data: { operation: "initialize" },
      headers: { Origin: baseURL! },
    });
    expect(response.status()).toBe(401);
    const cookie = "authjs.session-token";
    const token = await encode({
      secret: TEST_SECRET,
      salt: cookie,
      token: { ownerId: "999", name: "Other user" },
    });
    await outsider.addCookies([{ name: cookie, value: token, url: baseURL! }]);
    expect(
      (
        await outsider.request.post(`${baseURL}/api/store`, {
          data: { operation: "initialize" },
          headers: { Origin: baseURL! },
        })
      ).status(),
    ).toBe(401);
    const page = await outsider.newPage();
    await page.goto(`${baseURL}/`);
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    await outsider.close();
  }
});

test("owner mutations reject foreign origins and invalid payloads", async ({
  context,
  baseURL,
}) => {
  const response = await context.request.post(`${baseURL}/api/store`, {
    data: { operation: "initialize" },
    headers: { Origin: "https://other.example" },
  });
  expect(response.status()).toBe(403);
  const invalid = await context.request.post(`${baseURL}/api/store`, {
    data: { operation: "executeSql", query: "DELETE FROM app_state" },
    headers: { Origin: baseURL! },
  });
  expect(invalid.status()).toBe(400);
});

test("queue and dataset are available in a fresh browser session", async ({
  page,
  browser,
  context,
  baseURL,
}) => {
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await page.locator("[data-queue-action='toggle']").first().click();
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
  await page.screenshot({ path: "test-results/cloud-workspace.png", fullPage: true });
  const second = await browser.newContext();
  try {
    await second.addCookies(await context.cookies());
    const otherPage = await second.newPage();
    await otherPage.goto(`${baseURL}/`);
    await expect(otherPage.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");
    await expect(otherPage.locator(".mining-entry")).toHaveCount(3);
    await expect(otherPage.locator("#queueToggle")).toHaveText("Queue (1)");
  } finally {
    await second.close();
  }
});

test("forces IndexedDB open failure and falls back to server-first remote store", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (window as any).indexedDB;
  });
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");

  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);
  await page.locator("[data-decision-action='known']").first().click();
  await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportBackup").click();
  const download = await downloadPromise;
  const backup = JSON.parse(readFileSync(await download.path()!, "utf-8")) as {
    decisions: Array<{ status: string }>;
  };
  expect(backup.decisions.length).toBeGreaterThan(0);
});

test("forces cloud clear failure and keeps local cached data intact", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText(
    /^(Saved to PostgreSQL|Synced|Saved locally)\s*$/,
  );
  await page.locator("#jitenInput").setInputFiles("tests/fixtures/jiten-small.csv");
  await expect(page.locator(".mining-entry")).toHaveCount(3);

  await page.route("**/api/store", (route) => {
    const postData = route.request().postDataJSON();
    if (
      postData?.operation === "clearAll" ||
      (postData?.operation === "state.clear" && postData?.resource === "all")
    ) {
      return route.abort();
    }
    return route.continue();
  });

  await page.locator("#clearData").click();

  await page.reload();
  await expect(page.locator(".mining-entry")).toHaveCount(3);
});
