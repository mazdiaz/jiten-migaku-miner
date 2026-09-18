import { expect, test } from "./fixtures";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

test.beforeEach(async () => {
  test.skip(
    process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC !== "1",
    "Local-first sync performance tests require NEXT_PUBLIC_LOCAL_FIRST_SYNC=1",
  );
});

test("warm-start renders cached vocabulary within 500ms while cloud sync is blocked", async ({
  page,
}) => {
  test.setTimeout(60_000);

  // Initial cold load: upload dataset and let local-first sync complete
  await page.goto("/");
  await expect(page.locator(".cloud-status")).toHaveText(/^(Synced|Saved locally)\s*$/);
  await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
  await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
  await expect(page.locator(".cloud-status")).toHaveText("Synced");

  // Setup deterministic route gate to block /api/sync
  let unblockSync: () => void = () => {};
  const syncBlocked = new Promise<void>((resolve) => {
    unblockSync = resolve;
  });

  await page.route("**/api/sync*", async (route) => {
    await syncBlocked;
    await route.continue();
  });

  // Reload the page - warm start from IndexedDB local cache
  await page.reload();

  // Assert cached vocabulary renders immediately without waiting for blocked /api/sync
  await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

  // Status must reflect local state while cloud sync is blocked
  await expect(page.locator(".cloud-status")).toHaveText(
    /^(Synced|Saved locally|Saved locally · Syncing…)\s*$/,
  );

  // Verify performance timing: first_query_ready must be < 500ms
  const timing = await page.evaluate(() => {
    return (window as any).__bootTimingEvents as Array<{
      stage: string;
      durationMs: number;
    }>;
  });
  const firstQueryReady = timing?.find((t) => t.stage === "first_query_ready");
  expect(firstQueryReady).toBeDefined();
  expect(firstQueryReady!.durationMs).toBeLessThan(500);

  // Unblock sync route gate so background sync finishes cleanly
  unblockSync();
  await expect(page.locator(".cloud-status")).toHaveText("Synced");
});
