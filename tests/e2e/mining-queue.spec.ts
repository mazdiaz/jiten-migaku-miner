import { expect, test, type Page } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";
const FOLLOWUP_CSV = "tests/fixtures/jiten-followup.csv";

function entryByWord(page: Page, word: string): ReturnType<Page["locator"]> {
  return page.locator(".mining-entry").filter({
    has: page.locator(".target-word", { hasText: word }),
  });
}

function queueToggleFor(page: Page, word: string) {
  return entryByWord(page, word).locator("[data-queue-action='toggle']");
}

async function queueWord(page: Page, word: string): Promise<void> {
  await queueToggleFor(page, word).click();
  await expect(queueToggleFor(page, word)).toHaveAttribute("aria-pressed", "true");
  await expect(queueToggleFor(page, word)).toHaveText("✓ Queued");
}

test.describe("session mining queue", () => {
  test("queues words, survives reload, mines in queue mode, and resets per dataset", async ({ page }) => {
    // 1. Import fixture.
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#queueToggle")).toHaveText("Queue (0)");
    await expect(page.locator("#queueToggle")).toBeDisabled();

    // 2. Queue three visible words.
    await queueWord(page, "気になる");
    await queueWord(page, "プール");
    await queueWord(page, "静か");
    await expect(page.locator("#queueToggle")).toHaveText("Queue (3)");

    // 3. Reload.
    await page.reload();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    // 4. Queue count restores for the same dataset/session.
    await expect(page.locator("#queueToggle")).toHaveText("Queue (3)");
    await expect(queueToggleFor(page, "気になる")).toHaveAttribute("aria-pressed", "true");
    await expect(queueToggleFor(page, "プール")).toHaveAttribute("aria-pressed", "true");
    await expect(queueToggleFor(page, "静か")).toHaveAttribute("aria-pressed", "true");

    // 5. Enter Queue Mode.
    await page.locator("#queueToggle").click();
    await expect(page.locator("#queueHeader")).toBeVisible();
    await expect(page.locator("#queueHeading")).toHaveText("Mining Queue — 3 words");

    // 6. The three words appear in add order.
    const targets = page.locator("#resultsList .mining-entry .target-word");
    await expect(targets.nth(0)).toHaveText("気になる");
    await expect(targets.nth(1)).toHaveText("プール");
    await expect(targets.nth(2)).toHaveText("静か");

    // 7. Mark the first word Mined.
    await entryByWord(page, "気になる").locator("[data-decision-action='mined']").click();

    // 8. Count decreases and the Mined decision persists.
    await expect(page.locator("#queueHeading")).toHaveText("Mining Queue — 2 words");
    const remaining = page.locator("#resultsList .mining-entry .target-word");
    await expect(remaining.nth(0)).toHaveText("プール");
    await expect(remaining.nth(1)).toHaveText("静か");

    // 9. Remove the second word without any decision.
    await entryByWord(page, "プール").locator("[data-queue-action='remove']").click();
    await expect(page.locator("#queueHeading")).toHaveText("Mining Queue — 1 words");

    // 10. Mark the last word Later.
    await entryByWord(page, "静か").locator("[data-decision-action='later']").click();

    // 11. Queue complete.
    await expect(page.locator("#queueHeading")).toHaveText("Mining Queue — 0 words");
    await expect(page.locator("#resultsList .empty-state")).toHaveText("Mining queue complete.");

    // 12. Exit back to the normal list.
    await page.locator("#exitQueue").click();
    await expect(page.locator("#queueHeader")).toBeHidden();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(entryByWord(page, "気になる").locator(".entry-badge-decision")).toHaveText("Mined");
    await expect(entryByWord(page, "プール").locator(".entry-badge")).toHaveCount(0);
    await expect(entryByWord(page, "静か").locator(".entry-badge-decision")).toHaveText("Later");
    await expect(page.locator("#queueToggle")).toHaveText("Queue (0)");
    await expect(page.locator("#queueToggle")).toBeDisabled();

    // 13. Import a different dataset.
    await page.locator("#jitenInput").setInputFiles(FOLLOWUP_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);

    // 14. The old dataset's queue is not applied.
    await expect(page.locator("#queueToggle")).toHaveText("Queue (0)");
    await expect(page.locator("#queueToggle")).toBeDisabled();
    await expect(page.locator("#queueToggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#queueHeader")).toBeHidden();
  });
});
