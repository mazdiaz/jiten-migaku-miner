import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test.describe("large dataset performance", () => {
  test("imports 100,000 rows and keeps the mounted DOM bounded while scrolling", async ({ page }) => {
    test.setTimeout(180_000);
    const directory = mkdtempSync(join(tmpdir(), "jiten-miner-100k-"));
    const csvPath = join(directory, "generated-100k.csv");
    try {
      execFileSync(process.execPath, ["tests/fixtures/generate-100k.mjs", csvPath], { stdio: "pipe" });
      expect(statSync(csvPath).size).toBeGreaterThan(1_000_000);

      const importStarted = Date.now();
      await page.goto("/");
      await page.locator("#jitenInput").setInputFiles(csvPath);

      await expect(page.locator("#resultStats")).toContainText("Loaded 100,000", { timeout: 120_000 });
      const importDuration = Date.now() - importStarted;

      await expect(page.locator("#resultsList .mining-entry")).toHaveCount(50);
      const firstQueryDuration = Date.now() - importStarted;

      await page.locator("#pageSize").selectOption("all");
      await expect(page.locator("#resultStats")).toContainText("99,800 currently shown", { timeout: 60_000 });
      await expect(page.locator("#resultsList .vl-spacer-bottom")).toHaveCount(1, { timeout: 60_000 });
      await expect(page.locator("#resultsList .vl-spacer-top")).toHaveCount(1);

      const mountedInitial = await page.locator("#resultsList .mining-entry").count();
      expect(mountedInitial).toBeLessThanOrEqual(120);
      expect(mountedInitial).toBeGreaterThan(0);

      const firstNumber = await page.locator(".mining-entry .entry-number").first().textContent();
      expect(Number.parseInt(firstNumber ?? "0", 10)).toBe(1);

      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = "auto";
        const height = document.documentElement.scrollHeight;
        window.scrollTo(0, Math.floor(height * 0.5));
      });
      await expect
        .poll(async () => {
          const number = await page.locator(".mining-entry .entry-number").first().textContent();
          return Number.parseInt(number ?? "0", 10);
        }, { timeout: 60_000 })
        .toBeGreaterThan(40_000);
      const mountedAfterScroll = await page.locator("#resultsList .mining-entry").count();
      expect(mountedAfterScroll).toBeLessThanOrEqual(120);

      console.log(`[performance] import: ${importDuration}ms, first page ready: ${firstQueryDuration}ms`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
