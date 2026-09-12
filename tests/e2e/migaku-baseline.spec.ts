import { expect, test } from "@playwright/test";

const SMALL_CSV = "tests/fixtures/jiten-small.csv";

test.describe("Migaku sentence baseline compatibility", () => {
  test("normalizes inline token baseline and line height without touching ruby readings", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#jitenInput").setInputFiles(SMALL_CSV);

    const sentence = page.locator("#resultsList .sentence").first();
    await expect(sentence).toBeVisible();

    await sentence.evaluate((element) => {
      const token = document.createElement("span");
      token.id = "migaku-baseline-probe";
      token.textContent = "兄";
      token.style.setProperty("vertical-align", "super");
      token.style.setProperty("line-height", "2");

      const ruby = document.createElement("ruby");
      ruby.id = "migaku-ruby-probe";
      ruby.style.setProperty("vertical-align", "super");
      ruby.innerHTML = "兄<rt>あに</rt>";

      element.append(token, ruby);
    });

    const token = page.locator("#migaku-baseline-probe");
    const ruby = page.locator("#migaku-ruby-probe");

    await expect
      .poll(() =>
        token.evaluate((element) => {
          const style = getComputedStyle(element);
          const parentStyle = getComputedStyle(element.parentElement as Element);
          return {
            verticalAlign: style.verticalAlign,
            sharesLineHeight: style.lineHeight === parentStyle.lineHeight,
          };
        }),
      )
      .toEqual({
        verticalAlign: "baseline",
        sharesLineHeight: true,
      });

    await expect
      .poll(() => ruby.evaluate((element) => getComputedStyle(element).verticalAlign))
      .toBe("super");
  });
});
