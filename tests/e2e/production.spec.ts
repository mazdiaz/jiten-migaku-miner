import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SERVER = "http://127.0.0.1:8931";
const RESOURCE_NOT_FOUND =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";
const DISCOVERY_FOLDERS = ["WORDS%20TO%20MINE", "MIGAKU%20KNOWN%20WORDS"];

test.describe("production build serving", () => {
  test("app boots from production build", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const notFoundUrls: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 404) notFoundUrls.push(response.url());
    });

    await page.goto("/dist/");

    await expect(page.locator("h1")).toHaveText("JITEN → MIGAKU MINER");
    await expect(page.locator("#importGrid")).toBeVisible();
    await expect(page.locator("#jitenStatus")).toHaveText("No CSV loaded");

    await page.waitForLoadState("networkidle");

    const discoveryProbes = notFoundUrls.filter((url) =>
      DISCOVERY_FOLDERS.some((folder) => url.endsWith(`/${folder}/`)),
    );
    expect(notFoundUrls, notFoundUrls.join("\n")).toEqual(discoveryProbes);
    const realErrors = consoleErrors.filter((text) => text !== RESOURCE_NOT_FOUND);
    expect(realErrors).toEqual([]);
  });

  test("worker import and query work in production bundle", async ({ page, request }) => {
    await page.goto("/dist/");

    const fixture = await request.get("/tests/fixtures/jiten-small.csv");
    expect(fixture.status()).toBe(200);
    await page.setInputFiles("#jitenInput", {
      name: "jiten-small.csv",
      mimeType: "text/csv",
      buffer: await fixture.body(),
    });
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#resultStats")).toContainText("Loaded 3");

    const firstEntry = page.locator(".mining-entry").first();
    await firstEntry.locator('[data-decision-action="known"]').click();
    await expect(
      page.locator("#resultsList .mining-entry .entry-badge-decision").first(),
    ).toHaveText("Known");

    await page.locator("#advancedToggle").click();
    await expect(page.locator("#advancedPanel")).toBeVisible();
    await page.locator("#decisionFilter").selectOption("known");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(page.locator("#resultsList .mining-entry .entry-badge-decision")).toHaveText(
      "Known",
    );

    await page.locator("#decisionFilter").selectOption("all");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  });

  test("legacy redirect serves from production build", async ({ page }) => {
    await page.goto("/dist/jiten-migaku-miner-v1.html");

    await expect(page).toHaveURL(/\/dist\/index\.html$/);
    await expect(page.locator("h1")).toHaveText("JITEN → MIGAKU MINER");
  });

  test("production assets served with expected types", async ({ request }) => {
    const document = await request.get("/dist/");
    expect(document.status()).toBe(200);
    expect(document.headers()["content-type"]).toContain("text/html");

    const html = await document.text();
    const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)]
      .map((match) => match[1] ?? "")
      .filter((src) => src.length > 0);
    expect(scriptSrcs.length).toBeGreaterThan(0);

    const assetsDir = join(process.cwd(), "dist", "assets");
    const workerChunks = readdirSync(assetsDir).filter(
      (name) => name.includes("worker") && name.endsWith(".js"),
    );
    expect(workerChunks.length).toBeGreaterThan(0);

    const assetPaths = new Set<string>([
      ...scriptSrcs.map((src) => new URL(src, `${SERVER}/dist/`).pathname),
      ...workerChunks.map((name) => `/dist/assets/${name}`),
    ]);
    expect(assetPaths.size).toBeGreaterThan(0);

    for (const assetPath of assetPaths) {
      const asset = await request.get(assetPath);
      expect(asset.status(), assetPath).toBe(200);
      expect(asset.headers()["content-type"], assetPath).toContain("javascript");
    }
  });

  test("vocabulary folders are not bundled into dist", async ({ request }) => {
    for (const folder of [...DISCOVERY_FOLDERS, "DL"]) {
      const response = await request.get(`/dist/${folder}/`);
      expect(response.status(), folder).toBe(404);
    }
  });

  test("folder discovery auto-loads vocabulary from repository root in production", async ({
    page,
  }) => {
    const autoCsv = [
      "Word,Occurences,ExampleSentence,Definitions,ReadingFurigana",
      '自動,5,"これは**自動**の例文です。",automatic,自動[じどう]',
      '静か,3,"とても**静か**な夜です。",quiet,静か[しずか]',
    ].join("\n");

    const listingRequests: string[] = [];
    await page.route("**/WORDS%20TO%20MINE/", async (route) => {
      listingRequests.push(route.request().url());
      await route.fulfill({
        contentType: "text/html",
        body: '<a href="vocab.csv">vocab.csv</a>',
      });
    });
    await page.route("**/vocab.csv", async (route) => {
      if (route.request().method() === "HEAD") {
        await route.fulfill({
          headers: { "Last-Modified": "Thu, 03 Sep 2026 00:00:00 GMT" },
        });
        return;
      }
      await route.fulfill({ contentType: "text/csv", body: autoCsv });
    });

    await page.goto("/dist/");

    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);
    await expect(page.locator(".mining-entry .target-word").first()).toHaveText("自動");
    await expect(page.locator("#jitenStatus")).toContainText("vocab.csv (auto)");
    expect(listingRequests).toEqual([`${SERVER}/WORDS%20TO%20MINE/`]);
  });
});
