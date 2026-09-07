// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindControls } from "../../src/ui/controls";
import { getDomMap } from "../../src/ui/dom";
import type { DomMap } from "../../src/ui/dom";
import { createRenderer } from "../../src/ui/renderer";
import type { Renderer } from "../../src/ui/renderer";
import type { AppState, FileSource, MinerController } from "../../src/app/state";
import { createInitialAppState, DEFAULT_QUERY } from "../../src/app/state";
import type { EntryWithKnown, QueryResult, QueryState } from "../../src/domain/types";

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

  add("results", "section");
  add("resultsHeading", "h2").setAttribute("tabindex", "-1");
  add("resultStats", "p");
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
    importJiten: vi.fn(async (_source: FileSource) => {}),
    importKnown: vi.fn(async (_source: FileSource) => {}),
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

function resultFixture(totalEntries: number, items: EntryWithKnown[] = []): QueryResult {
  return {
    items,
    page: 1,
    totalPages: totalEntries === 0 ? 0 : 1,
    totalEntries,
    startIndex: totalEntries === 0 ? 0 : 1,
    endIndex: totalEntries,
    pageSize: 50,
    knownCount: 0,
    windowed: false,
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

const chipsOf = (harness: Harness): HTMLElement[] =>
  Array.from(harness.dom.filterChips.querySelectorAll<HTMLElement>("button[data-filter-chip]"));

const publishQuery = (harness: Harness, patch: Partial<QueryState>): void => {
  harness.controller.publishState({ query: { ...DEFAULT_QUERY, ...patch } });
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("active filter chip derivation", () => {
  it("resolves the chips container via getDomMap", () => {
    const dom = seedDom();
    expect(dom.filterChips.id).toBe("filterChips");
  });

  it("renders no chips and hides the row for a default query", () => {
    const harness = setup(datasetReady());
    try {
      expect(chipsOf(harness)).toHaveLength(0);
      expect(harness.dom.filterChips.hidden).toBe(true);
      expect(harness.dom.filterChips.querySelector("#resetFilters")).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("renders a search chip with a quoted label and remove aria-label", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { search: "プール" });
      const [chip] = chipsOf(harness);
      expect(chip?.dataset.filterChip).toBe("search");
      expect(chip?.textContent).toBe('Search: "プール"');
      expect(chip?.getAttribute("aria-label")).toBe('Remove Search: "プール" filter');
    } finally {
      harness.dispose();
    }
  });

  it("truncates long search terms to 20 characters with an ellipsis", () => {
    const harness = setup(datasetReady());
    try {
      const long = "あ".repeat(30);
      publishQuery(harness, { search: long });
      const [chip] = chipsOf(harness);
      expect(chip?.textContent).toBe(`Search: "${"あ".repeat(20)}…"`);
    } finally {
      harness.dispose();
    }
  });

  it("does not render a search chip for blank search text", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { search: "   " });
      expect(chipsOf(harness).filter((chip) => chip.dataset.filterChip === "search")).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it("renders chips for both hide filters", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { hideKnown: true, hideKanaOnly: true });
      const labels = chipsOf(harness).map((chip) => chip.textContent);
      expect(labels).toEqual(["Hide known", "Hide kana-only"]);
    } finally {
      harness.dispose();
    }
  });

  it("renders sentence chips for has and none but not any", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { sentence: "has" });
      expect(chipsOf(harness)[0]?.textContent).toBe("Sentence: has");

      publishQuery(harness, { sentence: "none" });
      expect(chipsOf(harness)[0]?.textContent).toBe("Sentence: none");

      publishQuery(harness, { sentence: "any" });
      expect(chipsOf(harness).filter((chip) => chip.dataset.filterChip === "sentence")).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it("renders decision chips for every non-all value", () => {
    const harness = setup(datasetReady());
    try {
      const cases: Array<[QueryState["decision"], string]> = [
        ["unreviewed", "Decision: unreviewed"],
        ["known", "Decision: known"],
        ["mined", "Decision: mined"],
        ["skip", "Decision: skip"],
        ["later", "Decision: later"],
      ];
      for (const [value, label] of cases) {
        publishQuery(harness, { decision: value });
        expect(chipsOf(harness)[0]?.textContent).toBe(label);
      }
      publishQuery(harness, { decision: "all" });
      expect(chipsOf(harness).filter((chip) => chip.dataset.filterChip === "decision")).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it("renders a min occurrences chip only above 1", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { minOccurrences: 5 });
      expect(chipsOf(harness)[0]?.textContent).toBe("Min occurrences: 5");

      publishQuery(harness, { minOccurrences: 1 });
      expect(chipsOf(harness).filter((chip) => chip.dataset.filterChip === "minOccurrences")).toHaveLength(0);

      publishQuery(harness, { minOccurrences: 0 });
      expect(chipsOf(harness).filter((chip) => chip.dataset.filterChip === "minOccurrences")).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it("renders all six chips together plus the reset button when all filters are active", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, {
        search: "言葉",
        hideKnown: true,
        hideKanaOnly: true,
        sentence: "none",
        decision: "mined",
        minOccurrences: 2,
      });
      expect(chipsOf(harness).map((chip) => chip.dataset.filterChip)).toEqual([
        "search",
        "hideKnown",
        "hideKanaOnly",
        "sentence",
        "decision",
        "minOccurrences",
      ]);
      const reset = harness.dom.filterChips.querySelector<HTMLButtonElement>("#resetFilters");
      expect(reset).not.toBeNull();
      expect(reset?.textContent).toBe("Reset Filters");
      expect(reset?.nextElementSibling).toBeNull();
    } finally {
      harness.dispose();
    }
  });
});

describe("chip and reset interactions", () => {
  it("chip click resets only its own filter field", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { search: "言葉", hideKnown: true, sentence: "none", decision: "mined", minOccurrences: 3 });
      const cases: Array<[string, Partial<QueryState>]> = [
        ["search", { search: "" }],
        ["hideKnown", { hideKnown: false }],
        ["sentence", { sentence: "any" }],
        ["decision", { decision: "all" }],
        ["minOccurrences", { minOccurrences: 1 }],
      ];
      for (const [key, patch] of cases) {
        const chip = harness.dom.filterChips.querySelector<HTMLButtonElement>(`button[data-filter-chip="${key}"]`);
        chip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(harness.controller.updateQuery).toHaveBeenCalledWith(patch);
      }
      expect(harness.controller.updateQuery).toHaveBeenCalledTimes(cases.length);
    } finally {
      harness.dispose();
    }
  });

  it("hide kana-only chip click resets only hideKanaOnly", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { hideKanaOnly: true, search: "言葉" });
      harness.dom.filterChips
        .querySelector<HTMLButtonElement>('button[data-filter-chip="hideKanaOnly"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.controller.updateQuery).toHaveBeenCalledWith({ hideKanaOnly: false });
    } finally {
      harness.dispose();
    }
  });

  it("Reset Filters click resets the whole query to defaults", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { search: "言葉", decision: "mined", sort: "occ-asc", page: 3, pageSize: 25 });
      harness.dom.filterChips
        .querySelector<HTMLButtonElement>("#resetFilters")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.controller.updateQuery).toHaveBeenCalledWith({ ...DEFAULT_QUERY });
    } finally {
      harness.dispose();
    }
  });
});

describe("chips row visibility", () => {
  it("stays hidden without a dataset even when filters are active", () => {
    const harness = setup();
    try {
      publishQuery(harness, { search: "言葉", hideKnown: true });
      expect(harness.dom.filterChips.hidden).toBe(true);
      expect(chipsOf(harness)).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it("shows with a dataset and at least one active filter", () => {
    const harness = setup(datasetReady());
    try {
      publishQuery(harness, { hideKnown: true });
      expect(harness.dom.filterChips.hidden).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("hides in queue mode even with active filters", () => {
    const harness = setup({ ...datasetReady(), query: { ...DEFAULT_QUERY, search: "言葉" } });
    try {
      expect(harness.dom.filterChips.hidden).toBe(false);
      harness.controller.publishState({
        queue: { datasetId: "d1", normalizedWords: ["言葉"], mode: "queue" },
      });
      expect(harness.dom.filterChips.hidden).toBe(true);
      expect(chipsOf(harness)).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it("reappears after leaving queue mode", () => {
    const harness = setup({ ...datasetReady(), query: { ...DEFAULT_QUERY, search: "言葉" } });
    try {
      harness.controller.publishState({
        queue: { datasetId: "d1", normalizedWords: ["言葉"], mode: "queue" },
      });
      harness.controller.publishState({
        queue: { datasetId: "d1", normalizedWords: ["言葉"], mode: "normal" },
      });
      expect(harness.dom.filterChips.hidden).toBe(false);
    } finally {
      harness.dispose();
    }
  });
});

describe("filtered-empty hint", () => {
  it("appends the remove-a-filter hint when the dataset has zero matches", () => {
    const harness = setup(datasetReady());
    try {
      harness.controller.publishState({ query: { ...DEFAULT_QUERY, search: "zzzz" }, result: resultFixture(0) });
      const empty = harness.dom.resultsList.querySelector<HTMLElement>(".empty-state");
      expect(empty?.textContent).toContain("No entries match the current filters.");
      expect(empty?.querySelector(".empty-hint")?.textContent).toBe("Try removing a filter.");
      expect(harness.dom.filterChips.hidden).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("omits the hint for the no-dataset empty state", () => {
    const harness = setup();
    try {
      const empty = harness.dom.resultsList.querySelector<HTMLElement>(".empty-state");
      expect(empty?.textContent).toBe("Load a Jiten CSV above.");
      expect(empty?.querySelector(".empty-hint")).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("omits the hint when results are non-empty", () => {
    const harness = setup(datasetReady());
    try {
      harness.controller.publishState({ query: { ...DEFAULT_QUERY, search: "言葉" }, result: resultFixture(1, [makeEntry()]) });
      expect(harness.dom.resultsList.querySelector(".empty-state")).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("keeps the queue-complete message hint-free", () => {
    const harness = setup({
      ...datasetReady(),
      query: { ...DEFAULT_QUERY, search: "言葉" },
      queue: { datasetId: "d1", normalizedWords: [], mode: "queue" },
    });
    try {
      harness.controller.publishState({ result: resultFixture(0) });
      const empty = harness.dom.resultsList.querySelector<HTMLElement>(".empty-state");
      expect(empty?.textContent).toBe("Mining queue complete.");
      expect(empty?.querySelector(".empty-hint")).toBeNull();
    } finally {
      harness.dispose();
    }
  });
});
