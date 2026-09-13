import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

describe("sticky toolbar clarity", () => {
  it("keeps frequent mining toggles in a persistent quick row", () => {
    expect(html).toContain('id="quickControls"');
    expect(html).toContain(">More</button>");
  });

  it("hides verbose mining helper copy by default", () => {
    expect(html).toContain('class="adv-note" hidden');
    expect(html).toContain('class="shortcut-note" hidden');
  });
});
