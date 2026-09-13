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
  it("keeps frequent mining toggles visible and gives them short labels", () => {
    const dom = harness();
    syncStickyToolbarClarity(dom, state());

    expect(dom.advancedToggle.textContent).toBe("More");
    expect(dom.advancedPanel.hidden).toBe(false);
    expect(dom.advancedPanel.dataset.quickControls).toBe("true");
    expect(dom.hideKnown.closest("label")?.dataset.shortLabel).toBe("Hide Known");
    expect(dom.hideKanaOnly.closest("label")?.dataset.shortLabel).toBe("Hide Kana");
    expect(dom.showDefinitions.closest("label")?.dataset.shortLabel).toBe("Definitions");
    expect(dom.showHighlight.closest("label")?.dataset.shortLabel).toBe("Highlight");
    expect(dom.pillHighlight.closest("label")?.dataset.shortLabel).toBe("Pill");
    expect(dom.showFurigana.closest("label")?.dataset.shortLabel).toBe("Furigana");
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

  it("keeps secondary controls and helper copy out of the default quick row", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/toolbar-cleanup.css"), "utf8");
    expect(css).toContain(
      'body:not(.advanced-open) #advancedPanel[data-quick-controls="true"] .control',
    );
    expect(css).toContain(
      'body:not(.advanced-open) #advancedPanel[data-quick-controls="true"] .adv-note',
    );
    expect(css).toContain(".shortcut-note");
  });
});
