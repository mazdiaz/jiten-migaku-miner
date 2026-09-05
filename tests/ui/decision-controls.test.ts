// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindControls } from "../../src/ui/controls";
import { getDomMap } from "../../src/ui/dom";
import type { DomMap } from "../../src/ui/dom";
import { createRenderer, renderEntryNode } from "../../src/ui/renderer";
import type { Renderer } from "../../src/ui/renderer";
import type { AppState, FileSource, MinerController } from "../../src/app/state";
import { createInitialAppState } from "../../src/app/state";
import type { EntryWithKnown, QueryState, WordDecision } from "../../src/domain/types";

type Listener = (state: Readonly<AppState>) => void;

function seedDom(): DomMap {
  const add = (id: string, tag: string): HTMLElement => {
    const existing = document.getElementById(id);
    if (existing !== null) existing.remove();
    const element = document.createElement(tag);
    element.id = id;
    document.body.appendChild(element);
    return element;
  };

  add("jitenInput", "input").setAttribute("type", "file");
  add("knownInput", "input").setAttribute("type", "file");
  add("jitenDropzone", "div");
  add("knownDropzone", "div");
  add("jitenStatus", "div");
  add("knownStatus", "div");
  add("clearData", "button");
  add("errorBox", "div");
  add("filtersFieldset", "fieldset");
  add("searchInput", "input").setAttribute("type", "search");
  add("stickySearch", "input").setAttribute("type", "search");
  for (const id of ["hideKnown", "hideKanaOnly", "showFurigana", "pillHighlight", "stickyPill", "showHighlight", "stickyHl", "showDefinitions", "stickyDefs", "stickyHideKnown", "stickyHideKana", "stickyFurigana"]) {
    add(id, "input").setAttribute("type", "checkbox");
  }
  add("minOccurrences", "input").setAttribute("type", "number");
  add("stickyMin", "input").setAttribute("type", "number");

  const withOptions = (id: string, options: Array<[string, string]>): HTMLSelectElement => {
    const select = add(id, "select") as HTMLSelectElement;
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    return select;
  };

  withOptions("sentenceFilter", [["any", "any"], ["has", "has"], ["none", "none"]]);
  withOptions("stickySentence", [["any", "any"], ["has", "has"], ["none", "none"]]);
  withOptions("sortSelect", [["occ-desc", "occ-desc"], ["occ-asc", "occ-asc"], ["original", "original"]]);
  withOptions("stickySort", [["occ-desc", "occ-desc"], ["occ-asc", "occ-asc"], ["original", "original"]]);
  withOptions("pageSize", [["25", "25"], ["50", "50"], ["100", "100"], ["all", "all"]]);
  withOptions("stickyPageSize", [["25", "25"], ["50", "50"], ["100", "100"], ["all", "all"]]);
  withOptions("decisionFilter", [
    ["all", "All decisions"], ["unreviewed", "Unreviewed"], ["known", "Known"],
    ["mined", "Mined"], ["skip", "Skipped"], ["later", "Later"],
  ]);
  withOptions("stickyDecision", [
    ["all", "All"], ["unreviewed", "Unreviewed"], ["known", "Known"],
    ["mined", "Mined"], ["skip", "Skipped"], ["later", "Later"],
  ]);

  add("results", "section");
  add("resultsHeading", "h2");
  add("resultStats", "p");
  add("resultsList", "div");
  add("stickyToolbar", "div");
  add("stickyTitle", "div");
  add("stickyPrev", "button");
  add("stickyNext", "button");
  add("stickyPage", "span");
  add("topPrev", "button");
  add("topNext", "button");
  add("topPage", "span");
  add("bottomPrev", "button");
  add("bottomNext", "button");
  add("bottomPage", "span");

  return getDomMap();
}

interface FakeController extends MinerController {
  calls: {
    updateQuery: Partial<QueryState>[];
    setWordDecision: Array<[string, string]>;
  };
  notify(queryPatch?: Partial<QueryState>): void;
}

function createFakeController(initial?: Partial<AppState>): FakeController {
  let state: AppState = { ...createInitialAppState("memory"), ...initial };
  const listeners = new Set<Listener>();
  const calls = {
    updateQuery: [] as Partial<QueryState>[],
    setWordDecision: [] as Array<[string, string]>,
  };
  const controller: FakeController = {
    calls,
    notify(queryPatch) {
      if (queryPatch) state = { ...state, query: { ...state.query, ...queryPatch } };
      for (const listener of listeners) listener(state);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    importJiten: vi.fn(async (_source: FileSource) => {}),
    importKnown: vi.fn(async (_source: FileSource) => {}),
    updateQuery(patch: Partial<QueryState>) {
      calls.updateQuery.push(patch);
      controller.notify(patch);
    },
    updateView: vi.fn(),
    updateViewport: vi.fn(),
    changePage: vi.fn(),
    setWordDecision: vi.fn(async (word: string, status: string) => {
      calls.setWordDecision.push([word, status]);
    }),
    clearSavedData: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
  };
  return controller;
}

function makeEntry(overrides: Partial<EntryWithKnown> = {}): EntryWithKnown {
  return {
    id: "entry-1",
    originalIndex: 0,
    word: "言葉",
    normalizedWord: "言葉",
    occurrences: 3,
    sentenceRaw: "**言葉**が好き。",
    hasSentence: true,
    definitions: "word, language",
    furiganaRuns: [],
    known: false,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed",
    ...overrides,
  };
}

function decision(word: string, status: WordDecision["status"]): WordDecision {
  return { normalizedWord: word, status, updatedAt: "2026-09-05T00:00:00.000Z" };
}

interface Harness {
  dom: DomMap;
  controller: FakeController;
  renderer: Renderer;
  state: AppState;
  render(): void;
  dispose(): void;
}

function setup(initial?: Partial<AppState>): Harness {
  const dom = seedDom();
  const controller = createFakeController(initial);
  const renderer = createRenderer(dom);
  const unsubscribe = controller.subscribe((state) => renderer.render(state));
  const harness: Harness = {
    dom,
    controller,
    renderer,
    state: { ...createInitialAppState("memory"), ...initial },
    render() {
      renderer.render({ ...createInitialAppState("memory"), ...harness.state });
    },
    dispose() {
      unsubscribe();
      bindings.dispose();
    },
  };
  const bindings = bindControls(dom, controller);
  return harness;
}

function decisionButton(root: HTMLElement, action: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`[data-decision-action="${action}"]`);
  if (button === null) throw new Error(`Missing decision button for action: ${action}`);
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("decision filter select", () => {
  it("offers exactly the plan's decision options in primary and sticky selects", () => {
    const dom = seedDom();
    const expectedValues = ["all", "unreviewed", "known", "mined", "skip", "later"];
    const expectedLabels = ["All decisions", "Unreviewed", "Known", "Mined", "Skipped", "Later"];
    for (const select of [dom.decisionFilter, dom.stickyDecision]) {
      expect([...select.options].map((option) => option.value)).toEqual(expectedValues);
    }
    expect([...dom.decisionFilter.options].map((option) => option.textContent)).toEqual(expectedLabels);
  });

  it("mirrors state.query.decision in both selects", () => {
    const dom = seedDom();
    const renderer = createRenderer(dom);
    const base = createInitialAppState("memory");
    renderer.render({ ...base, query: { ...base.query, decision: "mined" } });
    expect(dom.decisionFilter.value).toBe("mined");
    expect(dom.stickyDecision.value).toBe("mined");
  });

  it("keeps primary and sticky decision selects synchronized in both directions", () => {
    const harness = setup();
    try {
      harness.dom.stickyDecision.value = "skip";
      harness.dom.stickyDecision.dispatchEvent(new Event("change"));
      expect(harness.controller.calls.updateQuery.at(-1)).toEqual({ decision: "skip" });
      harness.dom.decisionFilter.value = "later";
      harness.dom.decisionFilter.dispatchEvent(new Event("change"));
      expect(harness.controller.calls.updateQuery.at(-1)).toEqual({ decision: "later" });

      harness.state.query.decision = "known";
      harness.render();
      expect(harness.dom.decisionFilter.value).toBe("known");
      expect(harness.dom.stickyDecision.value).toBe("known");
    } finally {
      harness.dispose();
    }
  });
});

describe("per-entry decision actions", () => {
  it("calls the controller with the entry's normalized word", () => {
    const harness = setup();
    try {
      harness.dom.resultsList.appendChild(renderEntryNode(makeEntry(), 1, harness.state.view));
      decisionButton(harness.dom.resultsList, "known").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.controller.setWordDecision).toHaveBeenCalledWith("言葉", "known");

      decisionButton(harness.dom.resultsList, "later").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.controller.setWordDecision).toHaveBeenCalledWith("言葉", "later");
    } finally {
      harness.dispose();
    }
  });

  it("marks the active decision with aria-pressed=true and others false", () => {
    const dom = seedDom();
    for (const status of ["known", "mined", "skip", "later"] as const) {
      dom.resultsList.textContent = "";
      dom.resultsList.appendChild(renderEntryNode(makeEntry({ decision: status }), 1, createInitialAppState("memory").view));
      for (const action of ["known", "mined", "skip", "later"]) {
        expect(decisionButton(dom.resultsList, action).getAttribute("aria-pressed")).toBe(
          action === status ? "true" : "false",
        );
      }
    }
  });

  it("sends unreviewed on Reset and disables Reset while unreviewed", () => {
    const harness = setup();
    try {
      harness.dom.resultsList.appendChild(renderEntryNode(makeEntry({ decision: "mined" }), 1, harness.state.view));
      expect(decisionButton(harness.dom.resultsList, "unreviewed").disabled).toBe(false);
      decisionButton(harness.dom.resultsList, "unreviewed").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.controller.setWordDecision).toHaveBeenCalledWith("言葉", "unreviewed");

      harness.dom.resultsList.textContent = "";
      harness.dom.resultsList.appendChild(renderEntryNode(makeEntry({ decision: "unreviewed" }), 1, harness.state.view));
      expect(decisionButton(harness.dom.resultsList, "unreviewed").disabled).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("shows the Migaku-known badge and the local-decision badge together", () => {
    const dom = seedDom();
    dom.resultsList.appendChild(
      renderEntryNode(
        makeEntry({ knownByMigaku: true, known: true, decision: "mined" }),
        1,
        createInitialAppState("memory").view,
      ),
    );
    const badges = [...dom.resultsList.querySelectorAll(".entry-badge")].map((badge) => badge.textContent);
    expect(badges).toContain("Migaku known");
    expect(badges).toContain("Mined");
    expect(badges).toHaveLength(2);
  });

  it("uses text labels (not color alone) for each decision badge", () => {
    const dom = seedDom();
    const labels = { known: "Known", mined: "Mined", skip: "Skip", later: "Later" } as const;
    for (const [status, label] of Object.entries(labels)) {
      dom.resultsList.textContent = "";
      dom.resultsList.appendChild(
        renderEntryNode(makeEntry({ decision: status as keyof typeof labels }), 1, createInitialAppState("memory").view),
      );
      const badge = dom.resultsList.querySelector(".entry-badge-decision");
      expect(badge?.textContent).toBe(label);
    }
    dom.resultsList.textContent = "";
    dom.resultsList.appendChild(
      renderEntryNode(makeEntry({ knownByMigaku: true }), 1, createInitialAppState("memory").view),
    );
    expect(dom.resultsList.querySelector(".entry-badge-migaku")?.textContent).toBe("Migaku known");
  });
});

describe("sentence integrity with decision controls", () => {
  it("leaves sentence text and target highlight markup unchanged", () => {
    const dom = seedDom();
    const view = { ...createInitialAppState("memory").view, showHighlight: true };
    const plain = renderEntryNode(makeEntry({ decision: "unreviewed" }), 1, view);
    const decided = renderEntryNode(makeEntry({ decision: "known", known: true, knownByDecision: true }), 1, view);

    const plainSentence = plain.querySelector(".sentence");
    const decidedSentence = decided.querySelector(".sentence");
    expect(decidedSentence?.innerHTML).toBe(plainSentence?.innerHTML);

    const highlight = decidedSentence?.querySelector(".target-highlight");
    expect(highlight?.textContent).toBe("言葉");
    expect(decidedSentence?.querySelectorAll("button")).toHaveLength(0);
    expect(decidedSentence?.querySelectorAll(".entry-decision, .entry-badge")).toHaveLength(0);
    expect(decidedSentence?.textContent).toContain("が好き。");
  });
});

describe("hide-known gate", () => {
  it("stays disabled without Migaku words or local known decisions", () => {
    const harness = setup();
    try {
      expect(harness.dom.hideKnown.disabled).toBe(true);
      expect(harness.dom.stickyHideKnown.disabled).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("enables when Migaku words exist", () => {
    const harness = setup({ knownWords: new Set(["透明明"]) });
    try {
      expect(harness.dom.hideKnown.disabled).toBe(false);
      expect(harness.dom.stickyHideKnown.disabled).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("enables when any word decision is known even without Migaku words", () => {
    const harness = setup({
      wordDecisions: new Map([
        ["言葉", decision("言葉", "mined")],
        ["犬", decision("犬", "known")],
      ]),
    });
    try {
      expect(harness.dom.hideKnown.disabled).toBe(false);
      expect(harness.dom.stickyHideKnown.disabled).toBe(false);
    } finally {
      harness.dispose();
    }
  });
});
