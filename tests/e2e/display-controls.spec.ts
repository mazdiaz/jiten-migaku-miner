import { expect, type Page, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

// Preference persistence is fire-and-forget (updateView → void persist), so
// polling the IndexedDB record is the deterministic settle signal before a
// reload — mirrors the app's store (jiten-migaku-miner / preferences / current).
async function waitForStoredView(
  page: Page,
  expected: { sentenceSize: string; density: string },
): Promise<void> {
  await page.waitForFunction(
    (want) => {
      return new Promise<boolean>((resolve) => {
        const open = indexedDB.open("jiten-migaku-miner");
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("preferences", "readonly");
          const get = tx.objectStore("preferences").get("current");
          get.onsuccess = () => {
            const record = get.result as
              | { view?: { sentenceSize?: string; density?: string } }
              | undefined;
            resolve(
              record?.view?.sentenceSize === want.sentenceSize &&
                record?.view?.density === want.density,
            );
          };
          get.onerror = () => resolve(false);
          tx.oncomplete = () => db.close();
        };
        open.onerror = () => resolve(false);
      });
    },
    expected,
    { timeout: 10_000 },
  );
}

async function openFilters(page: Page): Promise<void> {
  await page.locator("#advancedToggle").click();
  await expect(page.locator("#advancedPanel")).toBeVisible();
}

test.describe("reading display controls", () => {
  test("defaults keep the current look: no body classes, base sentence size", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await openFilters(page);

    await expect(page.locator("#sentenceSize")).toHaveValue("medium");
    await expect(page.locator("#density")).toHaveValue("comfortable");
    await expect(page.locator("body")).not.toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).not.toHaveClass(/density-compact/);
  });

  test("toggles both controls, re-renders with classes, and computes a larger sentence font", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await openFilters(page);

    const firstSentence = page.locator("#resultsList .mining-entry .sentence").first();
    await expect(firstSentence).toBeVisible();
    const mediumSize = await firstSentence.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );

    await page.locator("#sentenceSize").selectOption("large");
    await expect(page.locator("body")).toHaveClass(/sent-size-lg/);
    // The list itself stays intact after the preference re-render.
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    const largeSize = await firstSentence.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    expect(largeSize).toBeGreaterThan(mediumSize);

    await page.locator("#density").selectOption("compact");
    await expect(page.locator("body")).toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).toHaveClass(/density-compact/);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#sentenceSize")).toHaveValue("large");
    await expect(page.locator("#density")).toHaveValue("compact");
  });

  test("persists both display preferences across reload", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await openFilters(page);

    await page.locator("#sentenceSize").selectOption("large");
    await page.locator("#density").selectOption("compact");
    await expect(page.locator("body")).toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).toHaveClass(/density-compact/);
    await waitForStoredView(page, {
      sentenceSize: "large",
      density: "compact",
    });

    await page.reload();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#sentenceSize")).toHaveValue("large");
    await expect(page.locator("#density")).toHaveValue("compact");
    await expect(page.locator("body")).toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).toHaveClass(/density-compact/);

    const firstSentence = page.locator("#resultsList .mining-entry .sentence").first();
    const largeSize = await firstSentence.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    await page.locator("#advancedToggle").click();
    await page.locator("#sentenceSize").selectOption("medium");
    const mediumSize = await firstSentence.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    expect(largeSize).toBeGreaterThan(mediumSize);
    await expect(page.locator("body")).not.toHaveClass(/sent-size-lg/);
    await expect(page.locator("body")).toHaveClass(/density-compact/);
  });
});
