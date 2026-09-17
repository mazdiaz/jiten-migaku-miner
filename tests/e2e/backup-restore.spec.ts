import { readFileSync } from "node:fs";
import { expect, type Page, test } from "./fixtures";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";
const SMALL_KNOWN = "tests/fixtures/known-small.txt";

async function acceptDialogs(page: Page): Promise<void> {
  page.on("dialog", (dialog) => dialog.accept());
}

test.describe("backup and restore", () => {
  test("exports and restores known words, decisions, and preferences while keeping the dataset", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await acceptDialogs(page);
    await page.goto("/");
    await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await page.locator("#knownInput").setInputFiles(SMALL_KNOWN);
    await expect(page.locator("#knownStatus")).toContainText("known-small.txt");

    await page.locator('[data-decision-action="mined"][data-word="気になる"]').click();
    await expect(
      page
        .locator(".mining-entry", {
          has: page.locator(".target-word", { hasText: "気になる" }),
        })
        .locator(".entry-badge-decision"),
    ).toHaveText("Mined");

    await page.locator('[data-decision-action="later"][data-word="静か"]').click();
    await expect(
      page
        .locator(".mining-entry", {
          has: page.locator(".target-word", { hasText: "静か" }),
        })
        .locator(".entry-badge-decision"),
    ).toHaveText("Later");

    await page.locator("#advancedToggle").click();
    await expect(page.locator("#advancedPanel")).toBeVisible();
    await page.locator("#sortSelect").selectOption("original");
    await page.locator("#pageSize").selectOption("25");
    await page.locator("#hideKanaOnly").check();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportBackup").click();
    const download = await downloadPromise;
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath!, "utf-8")) as {
      datasets: unknown[];
      version: number;
      knownWords: { name: string; words: string[] } | null;
      decisions: Array<{ normalizedWord: string; status: string }>;
      preferences: {
        query: { sort: string; pageSize: number; hideKanaOnly: boolean };
      };
    };
    expect(backup.datasets).toHaveLength(1);
    expect(backup.version).toBe(3);
    expect(backup.knownWords).toMatchObject({
      name: "known-small.txt",
      words: ["プール"],
    });
    expect(backup.decisions).toMatchObject([
      { normalizedWord: "気になる", status: "mined" },
      { normalizedWord: "静か", status: "later" },
    ]);
    expect(backup.preferences.query).toMatchObject({
      sort: "original",
      pageSize: 25,
      hideKanaOnly: true,
    });
    expect(await download.suggestedFilename()).toMatch(
      /^jiten-migaku-miner-backup-\d{4}-\d{2}-\d{2}\.json$/,
    );
    await expect(page.locator("#backupStatus")).toHaveText("Backup exported.");

    await page.locator("#clearData").click();
    await expect(page.locator("#jitenStatus")).toHaveText("No CSV loaded");
    await expect(page.locator("#knownStatus")).toHaveText("Optional · no list loaded");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator(".entry-badge")).toHaveCount(0);

    // Reimport resets the disclosure to collapsed; reopen before interacting.
    await page.locator("#advancedToggle").click();
    await expect(page.locator("#advancedPanel")).toBeVisible();

    await page.locator("#restoreBackupInput").setInputFiles({
      name: await download.suggestedFilename(),
      mimeType: "application/json",
      buffer: readFileSync(backupPath!),
    });

    await expect(page.locator("#knownStatus")).toContainText("known-small.txt ✓ · 1 entries");
    await expect(
      page
        .locator(".mining-entry", {
          has: page.locator(".target-word", { hasText: "気になる" }),
        })
        .locator(".entry-badge-decision"),
    ).toHaveText("Mined");
    await expect(
      page
        .locator(".mining-entry", {
          has: page.locator(".target-word", { hasText: "静か" }),
        })
        .locator(".entry-badge-decision"),
    ).toHaveText("Later");
    await expect(page.locator("#sortSelect")).toHaveValue("original");
    await expect(page.locator("#pageSize")).toHaveValue("25");
    await expect(page.locator("#hideKanaOnly")).toBeChecked();
    await expect(page.locator("#hideKnown")).toBeChecked();
    await expect(
      page.locator(".mining-entry", {
        has: page.locator(".target-word", { hasText: "プール" }),
      }),
    ).toHaveCount(0);
    await expect(page.locator("#resultStats")).toContainText("Loaded 3");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);
    await expect(page.locator("#backupStatus")).toContainText("Complete backup restored.");

    await page.locator("#advancedToggle").click();
    await page.locator("#hideKnown").uncheck();
    await expect(
      page
        .locator(".mining-entry", {
          has: page.locator(".target-word", { hasText: "気になる" }),
        })
        .locator(".entry-badge-decision"),
    ).toHaveText("Mined");
    await page.locator("#hideKanaOnly").uncheck();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(
      page
        .locator(".mining-entry", {
          has: page.locator(".target-word", { hasText: "プール" }),
        })
        .locator(".entry-badge-migaku"),
    ).toHaveText("Migaku known");
  });

  test("rejects an invalid backup without changing current state", async ({ page }) => {
    test.setTimeout(60_000);
    await acceptDialogs(page);
    await page.goto("/");
    await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");

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
    await expect(page.locator(".cloud-status")).toHaveText("Saved to PostgreSQL");

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

  test("local-first export flushes pending outbox mutations before downloading backup", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await acceptDialogs(page);
    await page.goto("/");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    let releaseSync = () => {};
    const syncPaused = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    await page.route("**/api/sync", async (route) => {
      const data = route.request().postDataJSON();
      if (data?.operation === "push") {
        await syncPaused;
      }
      return route.continue();
    });

    await page.locator('[data-decision-action="known"]').first().click();

    const downloadPromise = page.waitForEvent("download");
    const exportClick = page.locator("#exportBackup").click();

    releaseSync();
    await exportClick;

    const download = await downloadPromise;
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath!, "utf-8")) as {
      decisions: Array<{ normalizedWord: string; status: string }>;
    };
    expect(backup.decisions.some((d) => d.status === "known")).toBe(true);
  });

  test("complete restore restores new dataset and marks bootstrap complete", async ({ page }) => {
    test.setTimeout(60_000);
    await acceptDialogs(page);
    await page.goto("/");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportBackup").click();
    const download = await downloadPromise;
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath!, "utf-8")) as {
      datasets: Array<{ id: string; name: string }>;
      version: number;
    };
    backup.datasets[0]!.id = "restore-dataset";
    backup.datasets[0]!.name = "restore-dataset.csv";

    await page.locator("#restoreBackupInput").setInputFiles({
      name: "restore-dataset.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup), "utf-8"),
    });

    await expect(page).toHaveURL(/\/\?restored=1/);
    await expect(page.locator("#backupStatus")).toHaveText("Complete backup restored.");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  });

  test("aborted restore request preserves pre-restore cached dataset and local data", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await acceptDialogs(page);
    await page.goto("/");

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await page.route("**/api/store", (route) => {
      const data = route.request().postDataJSON();
      if (data?.operation === "restoreCompleteBackup") {
        return route.abort();
      }
      return route.continue();
    });

    await page.locator("#restoreBackupInput").setInputFiles({
      name: "aborted-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ version: 3, format: "jiten-migaku-miner-backup" }),
        "utf-8",
      ),
    });

    await expect(page.locator("#errorBox")).toBeVisible();
    await expect(page.locator("#errorBox")).toContainText("Backup could not be restored");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  });
});
