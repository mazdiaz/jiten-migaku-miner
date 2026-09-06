import { expect, test, type Page } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

async function importSmall(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
  await expect(page.locator("#resultsList .mining-entry")).toHaveCount(3);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

function childClassList(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).first().evaluate((node) =>
    [...node.children].map((child) => (child as HTMLElement).classList.value),
  );
}

test.describe("mobile layout at 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("renders entries in audit order without horizontal overflow", async ({ page }) => {
    await importSmall(page);

    await expectNoHorizontalOverflow(page);

    const toolbarBox = await page.locator("#stickyToolbar").boundingBox();
    expect(toolbarBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(200);

    const classes = await childClassList(page, "#resultsList .mining-entry");
    const indexes = [
      classes.findIndex((name) => name.includes("entry-header")),
      classes.findIndex((name) => name.includes("sentence")),
      classes.findIndex((name) => name.includes("entry-definitions")),
      classes.findIndex((name) => name.includes("entry-actions")),
    ];
    for (const index of indexes) expect(index).toBeGreaterThanOrEqual(0);
    expect(classes[0]).toContain("entry-header");
    expect(classes[classes.length - 1]).toContain("entry-actions");
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  test("queue mode keeps header and actions visible with touch-sized buttons", async ({ page }) => {
    await importSmall(page);

    await page.locator("[data-queue-action='toggle']").first().click();
    await expect(page.locator("#queueToggle")).toHaveText("Queue (1)");
    await page.locator("#queueToggle").click();
    await expect(page.locator("#queueHeader")).toBeVisible();

    await expectNoHorizontalOverflow(page);

    const exitBox = await page.locator("#exitQueue").boundingBox();
    expect(exitBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    const clearBox = await page.locator("#clearQueue").boundingBox();
    expect(clearBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    const removeBox = await page.locator("[data-queue-action='remove']").first().boundingBox();
    expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});

test.describe("small phone layout at 320x568", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("keeps touch-sized decision buttons without horizontal overflow", async ({ page }) => {
    await importSmall(page);

    await expectNoHorizontalOverflow(page);

    await expect
      .poll(async () => (await page.locator("[data-decision-action='known']").first().boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);

    await expect
      .poll(async () => (await page.locator("[data-queue-action='toggle']").first().boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
  });

  test("keeps the sticky toolbar inside the viewport", async ({ page }) => {
    await importSmall(page);

    const toolbarBox = await page.locator("#stickyToolbar").boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(toolbarBox!.width).toBeLessThanOrEqual(320);
    await expectNoHorizontalOverflow(page);
  });
});
