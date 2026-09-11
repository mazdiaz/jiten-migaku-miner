import { expect, type Page, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";
const ANKI_ENDPOINT = "http://127.0.0.1:8765/**";
const READ_ONLY_ACTIONS = new Set([
  "requestPermission",
  "deckNames",
  "modelNames",
  "modelFieldNames",
  "findCards",
  "cardsInfo",
]);

interface FixtureCard {
  word: string;
  newAndNotSuspended: boolean;
}

interface AnkiMock {
  actions: string[];
  mutationActions: string[];
}

async function mockAnkiConnect(page: Page, cards: Record<number, FixtureCard>): Promise<AnkiMock> {
  const actions: string[] = [];
  const mutationActions: string[] = [];
  await page.route(ANKI_ENDPOINT, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
      return;
    }

    const body = route.request().postDataJSON() as {
      action: string;
      params?: { query?: string; cards?: number[] };
    };
    actions.push(body.action);
    if (!READ_ONLY_ACTIONS.has(body.action)) mutationActions.push(body.action);

    let result: unknown;
    switch (body.action) {
      case "requestPermission":
        result = { permission: "granted" };
        break;
      case "deckNames":
        result = ["Main"];
        break;
      case "modelNames":
        result = ["Diaz Custom Mine"];
        break;
      case "modelFieldNames":
        result = ["Target Word (no syntax)", "Back"];
        break;
      case "findCards": {
        const query = body.params?.query ?? "";
        result = Object.entries(cards)
          .filter(([, card]) => !query.includes("is:new") || card.newAndNotSuspended)
          .map(([cardId]) => Number(cardId));
        break;
      }
      case "cardsInfo":
        result = (body.params?.cards ?? []).map((cardId) => ({
          cardId,
          fields: {
            "Target Word (no syntax)": {
              value: cards[cardId]?.word ?? "",
              order: 0,
            },
          },
        }));
        break;
      default:
        result = null;
    }

    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ result, error: null }),
    });
  });
  return { actions, mutationActions };
}

async function importSmallDataset(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
  await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
}

test.describe("Anki decision sync", () => {
  test("configures, previews, and applies read-only Anki sync", async ({ page }) => {
    const mock = await mockAnkiConnect(page, {
      101: { word: "気になる", newAndNotSuspended: false },
      102: { word: "プール", newAndNotSuspended: true },
    });
    await importSmallDataset(page);

    await page.getByRole("button", { name: "Connect to Anki" }).click();
    await expect(page.locator("#ankiSetup")).toBeVisible();
    await page.getByLabel("Deck scope").selectOption({ label: "Main" });
    await page.getByLabel("Note type").selectOption({ label: "Diaz Custom Mine" });
    await page.getByLabel("Target word field").selectOption({ label: "Target Word (no syntax)" });
    await page.getByRole("button", { name: "Check configuration" }).click();
    await expect(page.locator("#ankiActions")).toBeVisible();

    const mainActions = page.locator("#ankiActions");
    await expect(mainActions.getByRole("button", { name: "Sync from Anki" })).toBeVisible();
    await expect(mainActions.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(mainActions.getByRole("button")).toHaveCount(2);
    await expect(page.locator("#ankiClear")).toBeHidden();

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator("#ankiSetup")).toBeVisible();
    await expect(page.locator("#ankiSetup #ankiClear")).toBeVisible();

    await page.getByRole("button", { name: "Sync from Anki" }).click();
    await expect(page.getByText("Anki Sync Preview")).toBeVisible();
    await page.getByRole("button", { name: "Apply Sync" }).click();
    await expect(
      page.locator(".entry-badge-decision").filter({ hasText: "Known · Anki" }),
    ).toBeVisible();
    await expect(
      page.locator(".entry-badge-decision").filter({ hasText: "Mined · Anki" }),
    ).toBeVisible();
    expect(mock.mutationActions).toEqual([]);
    expect(mock.actions).toContain("cardsInfo");
  });

  test("shows connection failure without clearing the visible app", async ({ page }) => {
    await page.route(ANKI_ENDPOINT, (route) => route.abort());
    await importSmallDataset(page);
    await page.getByRole("button", { name: "Connect to Anki" }).click();

    await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
    await expect(page.locator("#ankiError")).toBeVisible();
    await expect(page.locator("#ankiError")).toContainText(/Anki.*unavailable|connection/i);
  });
});
