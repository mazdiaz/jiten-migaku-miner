import { expect, type Page, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";
const FOLLOWUP_CSV = "tests/fixtures/jiten-followup.csv";

const DECISION_ACTIONS = ["known", "mined", "skip", "later"] as const;

type DecisionAction = (typeof DECISION_ACTIONS)[number] | "unreviewed";

async function acceptDialogs(page: Page): Promise<void> {
  page.on("dialog", (dialog) => dialog.accept());
}

function entryByWord(page: Page, word: string): ReturnType<Page["locator"]> {
  return page.locator(".mining-entry").filter({
    has: page.locator(".target-word", { hasText: word }),
  });
}

function decisionButton(page: Page, word: string, action: DecisionAction) {
  return entryByWord(page, word).locator(`[data-decision-action="${action}"]`);
}

async function markDecision(page: Page, word: string, action: DecisionAction): Promise<void> {
  await decisionButton(page, word, action).click();
  if (action === "unreviewed") {
    await expect(decisionButton(page, word, action)).toBeDisabled();
  } else {
    await expect(decisionButton(page, word, action)).toHaveAttribute("aria-pressed", "true");
  }
}

async function expectEntryDecision(
  page: Page,
  word: string,
  status: (typeof DECISION_ACTIONS)[number] | "unreviewed",
): Promise<void> {
  for (const action of DECISION_ACTIONS) {
    await expect(decisionButton(page, word, action)).toHaveAttribute(
      "aria-pressed",
      action === status ? "true" : "false",
    );
  }
  const reset = decisionButton(page, word, "unreviewed");
  if (status === "unreviewed") {
    await expect(reset).toBeDisabled();
  } else {
    await expect(reset).toBeEnabled();
    await expect(entryByWord(page, word).locator(".entry-badge-decision")).toHaveText(
      { known: "Known", mined: "Mined", skip: "Skip", later: "Later" }[status],
    );
  }
}

test.describe("persistent word decisions", () => {
  test("restores known, mined, and later decisions after reload and filters by decision", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await expect(page.locator("#hideKnown")).toBeDisabled();

    await markDecision(page, "気になる", "known");
    await markDecision(page, "プール", "mined");
    await markDecision(page, "静か", "later");

    await expectEntryDecision(page, "気になる", "known");
    await expectEntryDecision(page, "プール", "mined");
    await expectEntryDecision(page, "静か", "later");

    await expect(page.locator("#hideKnown")).toBeEnabled();

    await page.reload();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    await expectEntryDecision(page, "気になる", "known");
    await expectEntryDecision(page, "プール", "mined");
    await expectEntryDecision(page, "静か", "later");

    await page.locator("#advancedToggle").click();
    await expect(page.locator("#advancedPanel")).toBeVisible();
    await page.locator("#hideKnown").check();
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);
    await expect(entryByWord(page, "気になる")).toHaveCount(0);
    await expect(entryByWord(page, "プール")).toHaveCount(1);
    await expect(entryByWord(page, "静か")).toHaveCount(1);

    await page.locator("#decisionFilter").selectOption("mined");
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(1);
    await expect(entryByWord(page, "プール")).toHaveCount(1);
    await expect(page.locator("#resultsList .mining-entry .entry-badge-decision")).toHaveText(
      "Mined",
    );
  });

  test("follows a mined decision into a new import, resets it, and clears it", async ({ page }) => {
    await acceptDialogs(page);
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await markDecision(page, "プール", "mined");

    await page.locator("#jitenInput").setInputFiles(FOLLOWUP_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(2);
    await expectEntryDecision(page, "プール", "mined");

    await markDecision(page, "プール", "unreviewed");
    await expectEntryDecision(page, "プール", "unreviewed");
    await expect(entryByWord(page, "プール").locator(".entry-badge-decision")).toHaveCount(0);

    await page.locator("#clearData").click();
    await expect(page.locator("#resultsList .empty-state")).toContainText(
      "Load a Jiten CSV above.",
    );

    await page.reload();
    await expect(page.locator("#resultsList .empty-state")).toBeVisible();

    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator(".entry-badge-decision")).toHaveCount(0);
    await expectEntryDecision(page, "気になる", "unreviewed");
    await expectEntryDecision(page, "プール", "unreviewed");
    await expectEntryDecision(page, "静か", "unreviewed");
  });

  test("keyboard focus survives decisions and review", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    // Keyboard: activate the first entry's Known button with Enter; focus
    // must land back on the same (rebuilt) action button, not on <body>.
    const known = decisionButton(page, "気になる", "known");
    await known.focus();
    await page.keyboard.press("Enter");
    await expect(known).toHaveAttribute("aria-pressed", "true");
    await expect(known).toBeFocused();

    // Keyboard: open review; focus moves into the panel.
    await page.locator("#reviewButton").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#reviewOverlay")).toBeVisible();
    await expect(page.locator("#reviewPanel")).toBeFocused();
    await expect(page.locator("#reviewKnown")).toBeEnabled();

    // Shift+Tab from the first control wraps to the last control and never
    // escapes into the background app shell. The Known decision above left
    // an undo record, so the enabled #reviewUndo is the last focusable.
    await page.locator("#reviewExit").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#reviewUndo")).toBeFocused();

    // Escape closes the overlay and returns focus to the review button.
    await page.keyboard.press("Escape");
    await expect(page.locator("#reviewOverlay")).toBeHidden();
    await expect(page.locator("#reviewButton")).toBeFocused();
  });

  test("one-step undo restores a decision and its queue membership", async ({ page }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);

    // Queue the word, then decide Known (a decision auto-removes it).
    await entryByWord(page, "気になる").locator("[data-queue-action='toggle']").click();
    await expect(page.locator("#queueToggle")).toHaveText("Queue (1)");
    await expect(
      entryByWord(page, "気になる").locator("[data-queue-action='toggle']"),
    ).toHaveAttribute("aria-pressed", "true");

    await decisionButton(page, "気になる", "known").click();
    await expect(entryByWord(page, "気になる").locator(".entry-badge-decision")).toHaveText(
      "Known",
    );
    await expect(page.locator("#queueToggle")).toHaveText("Queue (0)");

    // The undo button carries the record label and fires the undo.
    await expect(page.locator("#undoButton")).toBeEnabled();
    await expect(page.locator("#undoButton")).toHaveText("Undo Known — 気になる");
    await page.locator("#undoButton").click();

    // Decision badge gone (unreviewed) AND the word is back in the queue.
    await expectEntryDecision(page, "気になる", "unreviewed");
    await expect(entryByWord(page, "気になる").locator(".entry-badge-decision")).toHaveCount(0);
    await expect(page.locator("#queueToggle")).toHaveText("Queue (1)");
    await expect(
      entryByWord(page, "気になる").locator("[data-queue-action='toggle']"),
    ).toHaveAttribute("aria-pressed", "true");

    // The record is consumed: a second undo no-ops.
    await expect(page.locator("#undoButton")).toBeDisabled();
    await expect(page.locator("#undoButton")).toHaveText("Undo");
    await page
      .locator("#undoButton")
      .click({ force: true })
      .catch(() => undefined);
    await expectEntryDecision(page, "気になる", "unreviewed");
    await expect(page.locator("#queueToggle")).toHaveText("Queue (1)");
  });
});
