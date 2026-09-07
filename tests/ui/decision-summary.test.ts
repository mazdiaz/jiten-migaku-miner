// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDomMap } from "../../src/ui/dom";
import type { DomMap } from "../../src/ui/dom";
import { createRenderer } from "../../src/ui/renderer";
import type { Renderer } from "../../src/ui/renderer";
import type { AppState, MinerController } from "../../src/app/state";
import { createInitialAppState } from "../../src/app/state";
import type { WordDecision, WordDecisionStatus } from "../../src/domain/types";

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
  const importSummary = add("importSummary", "div");
  for (const className of ["import-dataset-line", "import-known-line"]) {
    const line = document.createElement("span");
    line.className = className;
    importSummary.appendChild(line);
  }
  const changeFiles = add("changeFiles", "button");
  changeFiles.setAttribute("aria-expanded", "false");
  changeFiles.setAttribute("aria-controls", "importGrid");
  add("importGrid", "div");
  add("clearData", "button");
  add("exportBackup", "button");
  add("restoreBackup", "button");
  add("restoreBackupInput", "input").setAttribute("type", "file");
  add("backupFreshness", "span");
  add("backupStatus", "span");
  add("errorBox", "div");
  const advancedToggle = add("advancedToggle", "button");
  advancedToggle.setAttribute("aria-expanded", "false");
  advancedToggle.setAttribute("aria-controls", "advancedPanel");
  const advancedPanel = add("advancedPanel", "div");
  advancedPanel.hidden = true;
  add("stickySearch", "input").setAttribute("type", "search");
  for (const id of ["hideKnown", "hideKanaOnly", "showFurigana", "pillHighlight", "showHighlight", "showDefinitions"]) {
    add(id, "input").setAttribute("type", "checkbox");
  }
  add("minOccurrences", "input").setAttribute("type", "number");

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
  withOptions("sortSelect", [["occ-desc", "occ-desc"], ["occ-asc", "occ-asc"], ["original", "original"]]);
  withOptions("pageSize", [["25", "25"], ["50", "50"], ["100", "100"], ["all", "all"]]);
  withOptions("decisionFilter", [
    ["all", "All decisions"], ["unreviewed", "Unreviewed"], ["known", "Known"],
    ["mined", "Mined"], ["skip", "Skipped"], ["later", "Later"],
  ]);

  withOptions("sentenceSize", [["medium", "medium"], ["large", "large"]]);
  withOptions("density", [["comfortable", "comfortable"], ["compact", "compact"]]);
  add("results", "section");
  add("resultsHeading", "h2").setAttribute("tabindex", "-1");
  add("resultStats", "p");
  add("decisionSummary", "p");
  add("resultsList", "div");
  add("filterChips", "div");
  add("undoButton", "button");
  add("reviewButton", "button");
  const reviewOverlay = add("reviewOverlay", "div");
  reviewOverlay.setAttribute("role", "dialog");
  reviewOverlay.setAttribute("aria-modal", "true");
  reviewOverlay.setAttribute("aria-labelledby", "reviewHeading");
  const reviewPanel = add("reviewPanel", "div");
  reviewPanel.setAttribute("tabindex", "-1");
  reviewOverlay.appendChild(reviewPanel);
  const intoPanel = (id: string, tag: string): HTMLElement => {
    const element = add(id, tag);
    reviewPanel.appendChild(element);
    return element;
  };
  intoPanel("reviewHeading", "h2");
  intoPanel("reviewProgress", "span");
  intoPanel("reviewContent", "div");
  const reviewComplete = intoPanel("reviewComplete", "div");
  const completeCopy = document.createElement("p");
  completeCopy.textContent = "No unreviewed candidates remain for the current filters.";
  reviewComplete.appendChild(completeCopy);
  const reviewReturn = add("reviewReturn", "button");
  reviewComplete.appendChild(reviewReturn);
  intoPanel("reviewExit", "button");
  intoPanel("reviewKnown", "button");
  intoPanel("reviewMined", "button");
  intoPanel("reviewSkip", "button");
  intoPanel("reviewLater", "button");
  intoPanel("reviewUndo", "button");
  add("queueToggle", "button");
  add("queueHeader", "div");
  add("queueHeading", "h2");
  add("queueStats", "p");
  add("exitQueue", "button");
  add("clearQueue", "button");
  const stickyToolbar = add("stickyToolbar", "div");
  const stickyTitle = add("stickyTitle", "div");
  const stickyPrev = add("stickyPrev", "button");
  const stickyNext = add("stickyNext", "button");
  const stickyPage = add("stickyPage", "span");
  add("bottomPrev", "button");
  add("bottomNext", "button");
  add("bottomPage", "span");

  stickyToolbar.append(stickyTitle, stickyPrev, stickyNext, stickyPage);

  const appShell = document.createElement("main");
  appShell.className = "app-shell";
  document.body.appendChild(appShell);

  const coveragePanel = add("coveragePanel", "section");
  const coverageToggle = add("coverageToggle", "button");
  const coverageLabel = document.createElement("span");
  coverageLabel.textContent = "Tracked vocabulary coverage:";
  const coverageSummary = add("coverageSummary", "span");
  coverageToggle.append(coverageLabel, coverageSummary);
  coveragePanel.appendChild(coverageToggle);
  const coverageBody = add("coverageBody", "div");
  coverageBody.hidden = true;
  coveragePanel.appendChild(coverageBody);
  for (const id of ["coverageUniqueWords", "coverageKnownOccurrences", "coveragePercent", "coverageTargets"]) {
    coverageBody.appendChild(add(id, "div"));
  }
  const coverageError = add("coverageError", "p");
  coverageError.hidden = true;
  coverageBody.appendChild(coverageError);
  coverageBody.appendChild(add("coverageFocus", "button"));

  return getDomMap();
}

interface FakeController extends MinerController {
  publishState(patch: Partial<AppState>): void;
}

function createFakeController(initial?: Partial<AppState>): FakeController {
  let state: AppState = { ...createInitialAppState("memory"), ...initial };
  const listeners = new Set<Listener>();
  const controller: FakeController = {
    publishState(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    importJiten: vi.fn(async () => {}),
    importKnown: vi.fn(async () => {}),
    updateQuery: vi.fn(),
    updateView: vi.fn(),
    updateViewport: vi.fn(),
    changePage: vi.fn(),
    setWordDecision: vi.fn(async () => {}),
    undoLastDecision: vi.fn(async () => {}),
    startReview: vi.fn(async () => {}),
    stopReview: vi.fn(),
    reviewDecision: vi.fn(async () => {}),
    toggleQueued: vi.fn(),
    removeQueued: vi.fn(),
    clearQueue: vi.fn(),
    startQueueMode: vi.fn(async () => {}),
    stopQueueMode: vi.fn(),
    exportBackup: vi.fn(async () => "{}"),
    restoreBackup: vi.fn(async () => {}),
    clearSavedData: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
  };
  return controller;
}

function datasetReady(): Partial<AppState> {
  return {
    dataset: {
      id: "d1", name: "book.csv", sourceType: "file", sourceName: "book.csv",
      headers: ["Word"], entryCount: 3, createdAt: "x", updatedAt: "x", schemaVersion: 1,
    },
    status: "ready",
  };
}

function decisions(spec: Array<[string, WordDecisionStatus]>): Map<string, WordDecision> {
  const map = new Map<string, WordDecision>();
  for (const [normalizedWord, status] of spec) {
    map.set(normalizedWord, { normalizedWord, status, updatedAt: "x" });
  }
  return map;
}

interface Harness {
  dom: DomMap;
  controller: FakeController;
  renderer: Renderer;
  dispose(): void;
}

function setup(initial?: Partial<AppState>): Harness {
  const dom = seedDom();
  const controller = createFakeController(initial);
  const renderer = createRenderer(dom);
  const unsubscribe = controller.subscribe((state) => renderer.render(state));
  return {
    dom,
    controller,
    renderer,
    dispose() {
      unsubscribe();
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("decision summary visibility", () => {
  it("resolves the summary element via getDomMap", () => {
    const dom = seedDom();
    expect(dom.decisionSummary.id).toBe("decisionSummary");
  });

  it("stays hidden with no dataset, no decisions, and no known words", () => {
    const harness = setup();
    try {
      expect(harness.dom.decisionSummary.hidden).toBe(true);
      expect(harness.dom.decisionSummary.textContent).toBe("");
    } finally {
      harness.dispose();
    }
  });

  it("shows all-zero decision counts with a dataset present", () => {
    const harness = setup(datasetReady());
    try {
      expect(harness.dom.decisionSummary.hidden).toBe(false);
      expect(harness.dom.decisionSummary.textContent).toBe(
        `Decisions: 0 known · 0 mined · 0 later · 0 skip · Migaku-known: 0`,
      );
    } finally {
      harness.dispose();
    }
  });

  it("shows without a dataset when decisions exist (persisted decisions)", () => {
    const harness = setup({ wordDecisions: decisions([["言葉", "known"]]) });
    try {
      expect(harness.dom.decisionSummary.hidden).toBe(false);
      expect(harness.dom.decisionSummary.textContent).toBe(
        `Decisions: 1 known · 0 mined · 0 later · 0 skip · Migaku-known: 0`,
      );
    } finally {
      harness.dispose();
    }
  });

  it("shows without a dataset when only known words exist", () => {
    const harness = setup({ knownWords: new Set(["言葉", "読む"]), knownWordsName: "list.txt" });
    try {
      expect(harness.dom.decisionSummary.hidden).toBe(false);
      expect(harness.dom.decisionSummary.textContent).toBe(
        `Decisions: 0 known · 0 mined · 0 later · 0 skip · Migaku-known: 2`,
      );
    } finally {
      harness.dispose();
    }
  });
});

describe("decision summary counts", () => {
  it("renders mixed decision counts in known/mined/later/skip order with the separate Migaku label", () => {
    const spec: Array<[string, WordDecisionStatus]> = [
      ...Array.from({ length: 12 }, (_, i): [string, WordDecisionStatus] => [`k${i}`, "known"]),
      ...Array.from({ length: 3 }, (_, i): [string, WordDecisionStatus] => [`m${i}`, "mined"]),
      ...Array.from({ length: 2 }, (_, i): [string, WordDecisionStatus] => [`l${i}`, "later"]),
      ["s0", "skip"],
    ];
    const harness = setup({
      ...datasetReady(),
      wordDecisions: decisions(spec),
      knownWords: new Set(Array.from({ length: 8614 }, (_, i) => `w${i}`)),
    });
    try {
      expect(harness.dom.decisionSummary.textContent).toBe(
        `Decisions: 12 known · 3 mined · 2 later · 1 skip · Migaku-known: ${(8614).toLocaleString()}`,
      );
    } finally {
      harness.dispose();
    }
  });

  it("formats large counts with locale separators", () => {
    const spec: Array<[string, WordDecisionStatus]> = [
      ...Array.from({ length: 1234 }, (_, i): [string, WordDecisionStatus] => [`k${i}`, "known"]),
    ];
    const harness = setup({ ...datasetReady(), wordDecisions: decisions(spec) });
    try {
      expect(harness.dom.decisionSummary.textContent).toBe(
        `Decisions: ${(1234).toLocaleString()} known · 0 mined · 0 later · 0 skip · Migaku-known: 0`,
      );
    } finally {
      harness.dispose();
    }
  });

  it("re-derives counts on every publish as decisions change", () => {
    const harness = setup(datasetReady());
    try {
      expect(harness.dom.decisionSummary.textContent).toContain("0 mined");
      harness.controller.publishState({ wordDecisions: decisions([["言葉", "mined"]]) });
      expect(harness.dom.decisionSummary.textContent).toBe(
        `Decisions: 0 known · 1 mined · 0 later · 0 skip · Migaku-known: 0`,
      );
      harness.controller.publishState({ wordDecisions: new Map() });
      expect(harness.dom.decisionSummary.textContent).toBe(
        `Decisions: 0 known · 0 mined · 0 later · 0 skip · Migaku-known: 0`,
      );
    } finally {
      harness.dispose();
    }
  });

  it("hides again when everything returns to zero without a dataset", () => {
    const harness = setup({ wordDecisions: decisions([["言葉", "known"]]) });
    try {
      expect(harness.dom.decisionSummary.hidden).toBe(false);
      harness.controller.publishState({ wordDecisions: new Map() });
      expect(harness.dom.decisionSummary.hidden).toBe(true);
      expect(harness.dom.decisionSummary.textContent).toBe("");
    } finally {
      harness.dispose();
    }
  });
});
