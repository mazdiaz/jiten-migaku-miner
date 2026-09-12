import { expect, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

test.describe("Migaku sentence baseline compatibility", () => {
  test("normalizes inline token baseline and line height without touching ruby readings", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);
    await expect(page.locator("#resultsList .sentence").first()).toBeVisible();

    await page.evaluate(() => {
      const sentence = document.querySelector<HTMLElement>("#resultsList .sentence[data-surface]");
      if (sentence === null) throw new Error("Expected a rendered sentence");

      const token = document.createElement("span");
      token.id = "migaku-baseline-probe";
      token.textContent = "兄";
      token.style.setProperty("vertical-align", "super");
      token.style.setProperty("line-height", "2");

      const ruby = document.createElement("ruby");
      ruby.id = "migaku-ruby-probe";
      ruby.style.setProperty("vertical-align", "super");
      ruby.innerHTML = "兄<rt>あに</rt>";

      sentence.append(token, ruby);
    });

    const token = page.locator("#migaku-baseline-probe");
    const ruby = page.locator("#migaku-ruby-probe");

    await expect
      .poll(() =>
        token.evaluate((element) => ({
          verticalAlign: getComputedStyle(element).verticalAlign,
          lineHeight: getComputedStyle(element).lineHeight,
          parentLineHeight: getComputedStyle(element.parentElement as Element).lineHeight,
        })),
      )
      .toEqual({
        verticalAlign: "baseline",
        lineHeight: await token.evaluate(
          (element) => getComputedStyle(element.parentElement as Element).lineHeight,
        ),
        parentLineHeight: await token.evaluate(
          (element) => getComputedStyle(element.parentElement as Element).lineHeight,
        ),
      });

    await expect
      .poll(() => ruby.evaluate((element) => getComputedStyle(element).verticalAlign))
      .toBe("super");
  });
});
