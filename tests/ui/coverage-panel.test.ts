// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindControls } from "../../src/ui/controls";
import { getDomMap } from "../../src/ui/dom";
import type { DomMap } from "../../src/ui/dom";
import { createRenderer } from "../../src/ui/renderer";
import type { AppState, FileSource, MinerController } from "../../src/app/state";
import { createInitialAppState } from "../../src/app/state";
import type { CoverageStats, QueryState } from "../../src/domain/types";

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
    ["all", "All decisions"],
    ["unreviewed", "Unreviewed"],
    ["known", "Known"],
    ["mined", "Mined"],
    ["skip", "Skipped"],
    ["later", "Later"],
  ]);

  add("results", "section");
  add("resultsHeading", "h2");
  add("resultStats", "p");
  add("decisionSummary", "p");
  add("resultsList", "div");

  // Coverage panel markup mirrors the index.html structure.
  const coveragePanel = add("coveragePanel", "section");
  const coverageToggle = add("coverageToggle", "button");
  coverageToggle.setAttribute("aria-expanded", "false");
  coverageToggle.setAttribute("aria-controls", "coverageBody");
  coveragePanel.appendChild(coverageToggle);
  const coverageLabel = document.createElement("span");
  coverageLabel.className = "coverage-toggle-label";
  coverageLabel.textContent = "Tracked vocabulary coverage:";
  const coverageSummary = add("coverageSummary", "span");
  coverageSummary.className = "coverage-summary";
  coverageToggle.append(coverageLabel, coverageSummary);
  const coverageBody = add("coverageBody", "div");
  coverageBody.hidden = true;
  coveragePanel.appendChild(coverageBody);
  const coverageTitle = document.createElement("h3");
  coverageTitle.className = "coverage-title";
  coverageTitle.textContent = "Tracked vocabulary occurrence coverage";
  coverageBody.appendChild(coverageTitle);
  const statsList = document.createElement("dl");
  statsList.className = "coverage-stats";
  for (const [dtText, ddId] of [
    ["Known unique words", "coverageUniqueWords"],
    ["Known occurrences", "coverageKnownOccurrences"],
    ["Coverage", "coveragePercent"],
  ] as const) {
    const row = document.createElement("div");
    row.className = "coverage-stat";
    const dt = document.createElement("dt");
    dt.textContent = dtText;
    const dd = document.createElement("dd");
    dd.id = ddId;
    row.append(dt, dd);
    statsList.appendChild(row);
  }
  coverageBody.appendChild(statsList);
  const targetsHeading = document.createElement("h4");
  targetsHeading.className = "coverage-targets-heading";
  targetsHeading.textContent = "Priority path";
  coverageBody.appendChild(targetsHeading);
  const coverageTargets = add("coverageTargets", "ul");
  coverageBody.appendChild(coverageTargets);
  const note = document.createElement("p");
  note.className = "coverage-note";
  note.textContent = "Based on occurrence counts in this Jiten export. This is not guaranteed raw-text comprehension coverage.";
  coverageBody.appendChild(note);
  const coverageError = add("coverageError", "p");
  coverageError.hidden = true;
  coverageBody.appendChild(coverageError);
  const coverageFocus = add("coverageFocus", "button");
  coverageFocus.textContent = "Focus highest-value unknowns";
  coverageBody.appendChild(coverageFocus);

  add("undoButton", "button");
  add("filterChips", "div");
  add("reviewButton", "button");
  const reviewOverlay = add("reviewOverlay", "div");
  reviewOverlay.setAttribute("role", "dialog");
  const reviewPanel = add("reviewPanel", "div");
  reviewPanel.setAttribute("tabindex", "-1");
  reviewOverlay.appendChild(reviewPanel);
  for (const id of ["reviewHeading", "reviewProgress", "reviewContent", "reviewComplete", "reviewReturn", "reviewExit", "reviewKnown", "reviewMined", "reviewSkip", "reviewLater", "reviewUndo"]) {
    const element = add(id, "div");
    reviewPanel.appendChild(element);
  }
  add("queueToggle", "button");
  add("queueHeader", "div");
  add("queueHeading", "h2");
  add("queueStats", "p");
  add("exitQueue", "button");
  add("clearQueue", "button");
  add("stickyToolbar", "div");
  add("stickyTitle", "div");
  add("stickyPrev", "button");
  add("stickyNext", "button");
  add("stickyPage", "span");
  add("bottomPrev", "button");
  add("bottomNext", "button");
  add("bottomPage", "span");

  return getDomMap();
}

interface FakeController extends MinerController {
  calls: { updateQuery: Partial<QueryState>[] };
  publishState(patch: Partial<AppState>): void;
}

function createFakeController(initial?: Partial<AppState>): FakeController {
  let state: AppState = { ...createInitialAppState("memory"), ...initial };
  const listeners = new Set<Listener>();
  const calls = { updateQuery: [] as Partial<QueryState>[] };
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
    updateQuery(patch: Partial<QueryState>) {
      calls.updateQuery.push(patch);
    },
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

function dataset(id = "d1"): NonNullable<AppState["dataset"]> {
  return {
    id, name: "book.csv", sourceType: "file", sourceName: "book.csv",
    headers: ["Word"], entryCount: 8, createdAt: "x", updatedAt: "x", schemaVersion: 1,
  };
}

// Mirrors the spec's expanded-panel sketch: 8,614 / 9,241 unique,
// 42,810 / 43,497 occurrences, 98.42% coverage, targets 98.5 unreached (+4).
function sampleStats(): CoverageStats {
  return {
    totalUniqueWords: 9_241,
    knownUniqueWords: 8_614,
    unknownUniqueWords: 627,
    totalTrackedOccurrences: 43_497,
    knownTrackedOccurrences: 42_810,
    unknownTrackedOccurrences: 687,
    coveragePercent: 98.4241,
    targets: [
      { targetPercent: 98, reached: true, additionalWords: 0, additionalTrackedOccurrences: 0 },
      { targetPercent: 98.5, reached: false, additionalWords: 4, additionalTrackedOccurrences: 45 },
      { targetPercent: 99, reached: false, additionalWords: 37, additionalTrackedOccurrences: 412 },
      { targetPercent: 99.5, reached: false, additionalWords: 141, additionalTrackedOccurrences: 688 },
    ],
  };
}

interface Harness {
  dom: DomMap;
  controller: FakeController;
  render(state: Partial<AppState>): void;
  dispose(): void;
}

function setup(initial?: Partial<AppState>): Harness {
  const dom = seedDom();
  const controller = createFakeController(initial);
  const renderer = createRenderer(dom);
  const unsubscribe = controller.subscribe((state) => renderer.render(state));
  const bindings = bindControls(dom, controller, {
    onToggleAdvanced: () => renderer.toggleAdvancedPanel(),
    onToggleCoverage: () => renderer.toggleCoveragePanel(),
  });
  const harness: Harness = {
    dom,
    controller,
    render(partial) {
      renderer.render({ ...createInitialAppState("memory"), ...partial });
    },
    dispose() {
      unsubscribe();
      bindings.dispose();
    },
  };
  return harness;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("coverage panel", () => {
  it("resolves the coverage markup via getDomMap", () => {
    const dom = seedDom();
    expect(dom.coveragePanel.tagName).toBe("SECTION");
    expect(dom.coverageToggle.tagName).toBe("BUTTON");
    expect(dom.coverageFocus.tagName).toBe("BUTTON");
  });

  it("ships the panel above the results list with the verbatim note in index.html", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain('id="coveragePanel"');
    expect(html.indexOf('id="coveragePanel"')).toBeGreaterThan(html.indexOf('id="resultsHeading"'));
    expect(html.indexOf('id="coveragePanel"')).toBeLessThan(html.indexOf('id="resultsList"'));
    expect(html).toContain(
      "Based on occurrence counts in this Jiten export. This is not guaranteed raw-text comprehension coverage.",
    );
    for (const banned of ["Reading comprehension", "Text understood", "You know 99%"]) {
      expect(html).not.toContain(banned);
    }
  });

  it("stays hidden without a dataset and appears once a dataset is active", () => {
    const harness = setup();
    try {
      expect(harness.dom.coveragePanel.hidden).toBe(true);

      harness.controller.publishState({ dataset: dataset(), status: "ready", coverageStatus: "ready", coverage: sampleStats() });
      expect(harness.dom.coveragePanel.hidden).toBe(false);

      harness.controller.publishState({ dataset: null, status: "empty", coverage: null, coverageStatus: "idle" });
      expect(harness.dom.coveragePanel.hidden).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("formats the collapsed summary with two decimals", () => {
    const harness = setup({ dataset: dataset(), status: "ready", coverageStatus: "ready", coverage: sampleStats() });
    try {
      expect(harness.dom.coverageSummary.textContent).toBe("98.42%");
      expect(harness.dom.coverageToggle.textContent).toContain("Tracked vocabulary coverage:");
    } finally {
      harness.dispose();
    }
  });

  it("renders N/A for the summary when coverage is null (zero total)", () => {
    const harness = setup({
      dataset: dataset(),
      status: "ready",
      coverageStatus: "ready",
      coverage: { ...sampleStats(), coveragePercent: null },
    });
    try {
      expect(harness.dom.coverageSummary.textContent).toBe("N/A");
    } finally {
      harness.dispose();
    }
  });

  it("expands on toggle and shows counts, coverage, target rows, and the note", () => {
    const harness = setup({ dataset: dataset(), status: "ready", coverageStatus: "ready", coverage: sampleStats() });
    try {
      expect(harness.dom.coverageBody.hidden).toBe(true);
      expect(harness.dom.coverageToggle.getAttribute("aria-expanded")).toBe("false");

      harness.dom.coverageToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.coverageBody.hidden).toBe(false);
      expect(harness.dom.coverageToggle.getAttribute("aria-expanded")).toBe("true");

      expect(harness.dom.coverageUniqueWords.textContent).toBe("8,614 / 9,241");
      expect(harness.dom.coverageKnownOccurrences.textContent).toBe("42,810 / 43,497");
      expect(harness.dom.coveragePercent.textContent).toBe("98.42%");

      const rows = [...harness.dom.coverageTargets.children];
      expect(rows).toHaveLength(4);
      expect(rows[0]?.textContent).toContain("98.0%");
      expect(rows[0]?.textContent).toContain("reached");
      expect(rows[1]?.textContent).toContain("98.5%");
      expect(rows[1]?.textContent).toContain("+4 words");
      expect(rows[2]?.textContent).toContain("99.0%");
      expect(rows[2]?.textContent).toContain("+37 words");
      expect(rows[3]?.textContent).toContain("99.5%");
      expect(rows[3]?.textContent).toContain("+141 words");

      expect(harness.dom.coverageBody.textContent).toContain(
        "Based on occurrence counts in this Jiten export. This is not guaranteed raw-text comprehension coverage.",
      );
      expect(harness.dom.coverageFocus.hidden).toBe(false);

      harness.dom.coverageToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.coverageBody.hidden).toBe(true);
      expect(harness.dom.coverageToggle.getAttribute("aria-expanded")).toBe("false");
    } finally {
      harness.dispose();
    }
  });

  it("recollapses when a new dataset is imported", () => {
    const harness = setup({ dataset: dataset("d1"), status: "ready", coverageStatus: "ready", coverage: sampleStats() });
    try {
      harness.dom.coverageToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.coverageBody.hidden).toBe(false);

      harness.controller.publishState({ dataset: dataset("d2"), coverage: null, coverageStatus: "loading" });
      expect(harness.dom.coverageBody.hidden).toBe(true);
      expect(harness.dom.coverageToggle.getAttribute("aria-expanded")).toBe("false");
    } finally {
      harness.dispose();
    }
  });

  it("Focus calls updateQuery with exactly hideKnown + occ-desc + page 1", () => {
    const harness = setup({ dataset: dataset(), status: "ready", coverageStatus: "ready", coverage: sampleStats() });
    try {
      harness.dom.coverageToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      harness.dom.coverageFocus.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(harness.controller.calls.updateQuery).toHaveLength(1);
      expect(harness.controller.calls.updateQuery[0]).toEqual({ hideKnown: true, sort: "occ-desc", page: 1 });
    } finally {
      harness.dispose();
    }
  });

  it("leaves unrelated filters untouched after Focus", () => {
    const query: QueryState = {
      search: "ねこ",
      hideKnown: false,
      hideKanaOnly: true,
      sentence: "has",
      minOccurrences: 3,
      sort: "original",
      pageSize: 25,
      page: 4,
      decision: "mined",
    };
    const harness = setup({ dataset: dataset(), status: "ready", query, coverageStatus: "ready", coverage: sampleStats() });
    try {
      harness.dom.coverageToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      harness.dom.coverageFocus.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Controller semantics: the Focus patch merges, so only the three
      // intent fields change; the surviving filters stay reflected in the UI.
      harness.controller.publishState({
        query: { ...query, hideKnown: true, sort: "occ-desc", page: 1 },
      });
      expect(harness.dom.sentenceFilter.value).toBe("has");
      expect(harness.dom.decisionFilter.value).toBe("mined");
      expect(harness.dom.minOccurrences.value).toBe("3");
      expect(harness.dom.hideKanaOnly.checked).toBe(true);
      expect(harness.dom.stickySearch.value).toBe("ねこ");
      expect(harness.dom.hideKnown.checked).toBe(true);
      expect(harness.dom.sortSelect.value).toBe("occ-desc");
    } finally {
      harness.dispose();
    }
  });

  it("shows a nonfatal error line while keeping the results list intact", () => {
    const harness = setup({
      dataset: dataset(),
      status: "ready",
      coverageStatus: "error",
      coverageErrorMessage: "worker exploded",
    });
    try {
      harness.dom.coverageToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.coverageError.hidden).toBe(false);
      expect(harness.dom.coverageError.textContent).toContain("Coverage unavailable");
      expect(harness.dom.coverageError.textContent).toContain("worker exploded");
      expect(harness.dom.coverageSummary.textContent).toBe("N/A");
      // The normal results surface is untouched by the coverage failure.
      expect(harness.dom.errorBox.hidden).toBe(true);
      expect(harness.dom.resultsList.textContent).not.toBe("");
    } finally {
      harness.dispose();
    }
  });

  it("keeps the Focus button enabled and focusable inside the normal panel", () => {
    const harness = setup({ dataset: dataset(), status: "ready", coverageStatus: "ready", coverage: sampleStats() });
    try {
      harness.dom.coverageToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.coverageFocus.disabled).toBe(false);
      harness.dom.coverageFocus.focus();
      expect(document.activeElement).toBe(harness.dom.coverageFocus);
      expect(harness.dom.coveragePanel.getAttribute("role")).not.toBe("dialog");
    } finally {
      harness.dispose();
    }
  });
});
