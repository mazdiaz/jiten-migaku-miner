// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppState } from "../../src/app/state";
import type { DomMap } from "../../src/ui/dom";
import { syncStickyToolbarClarity } from "../../src/ui/sticky-toolbar-clarity";

function control(id: string): HTMLInputElement {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.id = id;
  input.type = "checkbox";
  label.append(input, ` ${id}`);
  document.body.appendChild(label);
  return input;
}

function harness(): DomMap {
  const advancedToggle = document.createElement("button");
  const advancedPanel = document.createElement("div");
  const resultStats = document.createElement("p");
  const decisionSummary = document.createElement("p");
  advancedPanel.hidden = true;
  document.body.append(advancedToggle, advancedPanel, resultStats, decisionSummary);

  return {
    advancedToggle,
    advancedPanel,
    resultStats,
    decisionSummary,
    hideKnown: control("hideKnown"),
    hideKanaOnly: control("hideKanaOnly"),
    showDefinitions: control("showDefinitions"),
    showHighlight: control("showHighlight"),
    pillHighlight: control("pillHighlight"),
    showFurigana: control("showFurigana"),
  } as unknown as DomMap;
}

function state(overrides: Partial<AppState> = {}): Readonly<AppState> {
  return {
    dataset: {
      id: "dataset",
      name: "Sample",
      sourceType: "file",
      sourceName: "sample.csv",
      headers: [],
      entryCount: 3,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
      schemaVersion: 1,
    },
    result: { totalEntries: 2 },
    knownWords: new Set(["既知"]),
    wordDecisions: new Map([["採掘", { status: "mined" }]]),
    ...overrides,
  } as unknown as Readonly<AppState>;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("sticky toolbar clarity", () => {
  it("moves frequent mining toggles into a persistent quick row", () => {
    const dom = harness();
    syncStickyToolbarClarity(dom, state());

    const quickControls = document.getElementById("quickControls");
    expect(dom.advancedToggle.textContent).toBe("More");
    expect(dom.advancedPanel.hidden).toBe(true);
    expect(quickControls).toBeInstanceOf(HTMLDivElement);
    expect((quickControls as HTMLDivElement).hidden).toBe(false);

    for (const [input, label] of [
      [dom.hideKnown, "Hide Known"],
      [dom.hideKanaOnly, "Hide Kana"],
      [dom.showDefinitions, "Definitions"],
      [dom.showHighlight, "Highlight"],
      [dom.pillHighlight, "Pill"],
      [dom.showFurigana, "Furigana"],
    ] as const) {
      expect(input.closest("#quickControls")).not.toBeNull();
      expect(input.closest("label")?.dataset.shortLabel).toBe(label);
      expect(dom.advancedPanel.contains(input)).toBe(false);
    }
  });

  it("compacts decision information and hides empty decision noise", () => {
    const dom = harness();
    syncStickyToolbarClarity(dom, state());
    expect(dom.decisionSummary.textContent).toBe("1 mined · 1 Migaku-known");
    expect(dom.decisionSummary.hidden).toBe(false);

    syncStickyToolbarClarity(
      dom,
      state({
        knownWords: new Set(),
        wordDecisions: new Map(),
        result: { totalEntries: 3 },
      } as Partial<AppState>),
    );
    expect(dom.decisionSummary.hidden).toBe(true);
  });

  it("styles the quick row compactly and removes persistent shortcut clutter", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/toolbar-cleanup.css"), "utf8");
    expect(css).toContain(".quick-controls");
    expect(css).toContain(".quick-toggle:has(input:checked)");
    expect(css).toContain(".shortcut-note");
  });
});
