// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindControls } from "../../src/ui/controls";
import { getDomMap } from "../../src/ui/dom";
import type { DomMap } from "../../src/ui/dom";
import { createRenderer } from "../../src/ui/renderer";
import type { Renderer } from "../../src/ui/renderer";
import type { AppState, FileSource, MinerController } from "../../src/app/state";
import { createInitialAppState } from "../../src/app/state";
import type { EntryWithKnown } from "../../src/domain/types";

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
  add("undoButton", "button");
  add("filterChips", "div");
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

  // Mirror the real markup: pager controls live inside the sticky toolbar.
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
  calls: { undo: number };
  publishState(patch: Partial<AppState>): void;
}

function createFakeController(initial?: Partial<AppState>): FakeController {
  let state: AppState = { ...createInitialAppState("memory"), ...initial };
  const listeners = new Set<Listener>();
  const calls = { undo: 0 };
  const controller: FakeController = {
    calls,
    publishState(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    importJiten: vi.fn(async (_source: FileSource) => {}),
    importKnown: vi.fn(async (_source: FileSource) => {}),
    updateQuery: vi.fn(),
    updateView: vi.fn(),
    updateViewport: vi.fn(),
    changePage: vi.fn(),
    setWordDecision: vi.fn(async () => {}),
    undoLastDecision: vi.fn(async () => {
      calls.undo += 1;
    }),
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

function reviewActive(overrides: Partial<AppState["review"]> = {}): Partial<AppState> {
  return {
    review: {
      active: true,
      initialTotal: 3,
      processed: 1,
      remaining: 2,
      current: makeEntry(),
      status: "ready",
      errorMessage: null,
      ...overrides,
    },
  };
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
  const bindings = bindControls(dom, controller);
  return {
    dom,
    controller,
    renderer,
    dispose() {
      unsubscribe();
      bindings.dispose();
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("one-step undo buttons", () => {
  it("resolves the undo markup via getDomMap", () => {
    const dom = seedDom();
    expect(dom.undoButton.tagName).toBe("BUTTON");
    expect(dom.reviewUndo.tagName).toBe("BUTTON");
  });

  it("renders the results-head undo button disabled with a base label when unavailable", () => {
    const harness = setup(datasetReady());
    try {
      expect(harness.dom.undoButton.disabled).toBe(true);
      expect(harness.dom.undoButton.textContent).toBe("Undo");
    } finally {
      harness.dispose();
    }
  });

  it("enables the results-head undo button and shows the record label when available", () => {
    const harness = setup(datasetReady());
    try {
      harness.controller.publishState({ undo: { available: true, label: "Undo Known — 言葉" } });
      expect(harness.dom.undoButton.disabled).toBe(false);
      expect(harness.dom.undoButton.textContent).toBe("Undo Known — 言葉");

      harness.controller.publishState({ undo: { available: false, label: null } });
      expect(harness.dom.undoButton.disabled).toBe(true);
      expect(harness.dom.undoButton.textContent).toBe("Undo");
    } finally {
      harness.dispose();
    }
  });

  it("mirrors the same undo state on the review panel button", () => {
    const harness = setup({ ...datasetReady(), ...reviewActive() });
    try {
      expect(harness.dom.reviewUndo.disabled).toBe(true);
      expect(harness.dom.reviewUndo.textContent).toBe("Undo last");

      harness.controller.publishState({ undo: { available: true, label: "Undo Known — 言葉" } });
      expect(harness.dom.reviewUndo.disabled).toBe(false);
      expect(harness.dom.reviewUndo.textContent).toBe("Undo Known — 言葉");
    } finally {
      harness.dispose();
    }
  });

  it("clicking either undo button fires undoLastDecision", () => {
    const harness = setup({ ...datasetReady(), ...reviewActive() });
    try {
      harness.controller.publishState({ undo: { available: true, label: "Undo Known — 言葉" } });

      harness.dom.undoButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.controller.calls.undo).toBe(1);

      harness.dom.reviewUndo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.controller.calls.undo).toBe(2);
    } finally {
      harness.dispose();
    }
  });
});

describe("z undo shortcut", () => {
  it("fires undo when a record is available", () => {
    const harness = setup(datasetReady());
    try {
      harness.controller.publishState({ undo: { available: true, label: "Undo Known — 言葉" } });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
      expect(harness.controller.calls.undo).toBe(1);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", bubbles: true }));
      expect(harness.controller.calls.undo).toBe(2);
    } finally {
      harness.dispose();
    }
  });

  it("is a no-op when no undo record is available", () => {
    const harness = setup(datasetReady());
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
      expect(harness.controller.calls.undo).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it("is inert while typing or focused inside the toolbar", () => {
    const harness = setup(datasetReady());
    try {
      harness.controller.publishState({ undo: { available: true, label: "Undo Known — 言葉" } });
      harness.dom.stickySearch.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
      harness.dom.stickyNext.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
      expect(harness.controller.calls.undo).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it("works during review when a record is available", () => {
    const harness = setup({ ...datasetReady(), ...reviewActive() });
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
      expect(harness.controller.calls.undo).toBe(0);

      harness.controller.publishState({ undo: { available: true, label: "Undo Known — 言葉" } });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
      expect(harness.controller.calls.undo).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it("does not collide with review decision shortcuts", () => {
    const harness = setup({ ...datasetReady(), ...reviewActive() });
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
      expect(harness.controller.reviewDecision).toHaveBeenCalledTimes(1);
      expect(harness.controller.calls.undo).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it("works in queue mode while paging shortcuts stay suppressed", () => {
    const harness = setup({
      ...datasetReady(),
      queue: { datasetId: "d1", normalizedWords: ["言葉"], mode: "queue" },
    });
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
      expect(harness.controller.calls.undo).toBe(0);

      harness.controller.publishState({ undo: { available: true, label: "Undo Known — 言葉" } });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
      expect(harness.controller.calls.undo).toBe(1);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(harness.controller.changePage).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});
