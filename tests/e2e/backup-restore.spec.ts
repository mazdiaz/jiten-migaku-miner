import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";
const SMALL_KNOWN = "tests/fixtures/known-small.txt";

async function acceptDialogs(page: Page): Promise<void> {
  page.on("dialog", (dialog) => dialog.accept());
}

test.describe("backup and restore", () => {
  test("exports and restores known words, decisions, and preferences while keeping the dataset", async ({ page }) => {
    test.setTimeout(60_000);
    await acceptDialogs(page);
    await page.goto("/");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await page.locator("#knownInput").setInputFiles(SMALL_KNOWN);
    await expect(page.locator("#knownStatus")).toContainText("known-small.txt");

    await page.locator('[data-decision-action="mined"][data-word="気になる"]').click();
    await expect(
      page.locator(".mining-entry", { has: page.locator(".target-word", { hasText: "気になる" }) }).locator(".entry-badge-decision"),
    ).toHaveText("Mined");

    await page.locator('[data-decision-action="later"][data-word="静か"]').click();
    await expect(
      page.locator(".mining-entry", { has: page.locator(".target-word", { hasText: "静か" }) }).locator(".entry-badge-decision"),
    ).toHaveText("Later");

    await page.locator("#sortSelect").selectOption("original");
    await page.locator("#pageSize").selectOption("25");
    await page.locator("#hideKanaOnly").check();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportBackup").click();
    const download = await downloadPromise;
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath!, "utf-8")) as {
      format: string;
      version: number;
      knownWords: { name: string; words: string[] } | null;
      wordDecisions: Array<{ normalizedWord: string; status: string }>;
      preferences: { query: { sort: string; pageSize: number; hideKanaOnly: boolean } };
    };
    expect(backup.format).toBe("jiten-migaku-miner-backup");
    expect(backup.version).toBe(1);
    expect(backup.knownWords).toEqual({ name: "known-small.txt", words: ["プール"] });
    expect(backup.wordDecisions).toMatchObject([
      { normalizedWord: "気になる", status: "mined" },
      { normalizedWord: "静か", status: "later" },
    ]);
    expect(backup.preferences.query).toMatchObject({ sort: "original", pageSize: 25, hideKanaOnly: true });
    expect(await download.suggestedFilename()).toMatch(/^jiten-migaku-miner-backup-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(page.locator("#backupStatus")).toHaveText("Backup exported.");

    await page.locator("#clearData").click();
    await expect(page.locator("#jitenStatus")).toHaveText("No CSV loaded");
    await expect(page.locator("#knownStatus")).toHaveText("Optional · no list loaded");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator(".entry-badge")).toHaveCount(0);

    await page.locator("#restoreBackupInput").setInputFiles({
      name: await download.suggestedFilename(),
      mimeType: "application/json",
      buffer: readFileSync(backupPath!),
    });

    await expect(page.locator("#knownStatus")).toContainText("known-small.txt ✓ · 1 entries");
    await expect(
      page.locator(".mining-entry", { has: page.locator(".target-word", { hasText: "気になる" }) }).locator(".entry-badge-decision"),
    ).toHaveText("Mined");
    await expect(
      page.locator(".mining-entry", { has: page.locator(".target-word", { hasText: "静か" }) }).locator(".entry-badge-decision"),
    ).toHaveText("Later");
    await expect(page.locator("#sortSelect")).toHaveValue("original");
    await expect(page.locator("#pageSize")).toHaveValue("25");
    await expect(page.locator("#hideKanaOnly")).toBeChecked();
    await expect(page.locator("#hideKnown")).toBeChecked();
    await expect(
      page.locator(".mining-entry", { has: page.locator(".target-word", { hasText: "プール" }) }),
    ).toHaveCount(0);
    await expect(page.locator("#resultStats")).toContainText("Loaded 3");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);
    await expect(page.locator("#backupStatus")).toContainText("Backup restored: 1 Migaku-known words · 2 decisions.");

    await page.locator("#hideKnown").uncheck();
    await expect(
      page.locator(".mining-entry", { has: page.locator(".target-word", { hasText: "気になる" }) }).locator(".entry-badge-decision"),
    ).toHaveText("Mined");
    await page.locator("#hideKanaOnly").uncheck();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(
      page.locator(".mining-entry", { has: page.locator(".target-word", { hasText: "プール" }) }).locator(".entry-badge-migaku"),
    ).toHaveText("Migaku known");
  });

  test("rejects an invalid backup without changing current state", async ({ page }) => {
    test.setTimeout(60_000);
    await acceptDialogs(page);
    await page.goto("/");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#resultStats")).toContainText("currently shown");

    await page.locator("#restoreBackupInput").setInputFiles({
      name: "broken.json",
      mimeType: "application/json",
      buffer: Buffer.from("{not json", "utf-8"),
    });

    await expect(page.locator("#errorBox")).toBeVisible();
    await expect(page.locator("#errorBox")).toContainText("Backup could not be restored");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator(".entry-badge-decision")).toHaveCount(0);
    await expect(page.locator("#sortSelect")).toHaveValue("occ-desc");
    await expect(page.locator("#backupStatus")).toHaveText("");
  });

  test("rejects an unsupported backup version without changing current state", async ({ page }) => {
    test.setTimeout(60_000);
    await acceptDialogs(page);
    await page.goto("/");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.locator("#restoreBackupInput").setInputFiles({
      name: "future-version.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ format: "jiten-migaku-miner-backup", version: 99 }),
        "utf-8",
      ),
    });

    await expect(page.locator("#errorBox")).toBeVisible();
    await expect(page.locator("#errorBox")).toContainText("Unsupported backup version: 99");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  });
});
