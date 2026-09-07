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
import type { QueryState } from "../../src/domain/types";

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
  withOptions("decisionFilter", [["all", "All decisions"]]);

  add("results", "section");
  add("resultsHeading", "h2");
  add("resultStats", "p");
  add("resultsList", "div");
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
    headers: ["Word"], entryCount: 3, createdAt: "x", updatedAt: "x", schemaVersion: 1,
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

describe("advanced panel disclosure", () => {
  it("resolves the new toolbar markup via getDomMap", () => {
    const dom = seedDom();
    expect(dom.advancedToggle.tagName).toBe("BUTTON");
    expect(dom.advancedPanel.id).toBe("advancedPanel");
  });

  it("keeps the panel collapsed and the toggle disabled without data", () => {
    const harness = setup();
    try {
      expect(harness.dom.advancedToggle.disabled).toBe(true);
      expect(harness.dom.advancedPanel.hidden).toBe(true);
      expect(harness.dom.advancedToggle.getAttribute("aria-expanded")).toBe("false");
    } finally {
      harness.dispose();
    }
  });

  it("enables the toggle with data and expands on click", () => {
    const harness = setup({ dataset: dataset(), status: "ready" });
    try {
      expect(harness.dom.advancedToggle.disabled).toBe(false);
      expect(harness.dom.advancedPanel.hidden).toBe(true);

      harness.dom.advancedToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.advancedPanel.hidden).toBe(false);
      expect(harness.dom.advancedToggle.getAttribute("aria-expanded")).toBe("true");

      harness.dom.advancedToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.advancedPanel.hidden).toBe(true);
      expect(harness.dom.advancedToggle.getAttribute("aria-expanded")).toBe("false");
    } finally {
      harness.dispose();
    }
  });

  it("hides the expanded panel when the dataset is cleared", () => {
    const harness = setup({ dataset: dataset(), status: "ready" });
    try {
      harness.dom.advancedToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.advancedPanel.hidden).toBe(false);

      harness.controller.publishState({ dataset: null, status: "empty" });
      expect(harness.dom.advancedToggle.disabled).toBe(true);
      expect(harness.dom.advancedPanel.hidden).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("recollapses after a new dataset import", () => {
    const harness = setup({ dataset: dataset("d1"), status: "ready" });
    try {
      harness.dom.advancedToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.advancedPanel.hidden).toBe(false);

      harness.controller.publishState({ dataset: dataset("d2"), status: "ready" });
      expect(harness.dom.advancedPanel.hidden).toBe(true);
      expect(harness.dom.advancedToggle.getAttribute("aria-expanded")).toBe("false");
    } finally {
      harness.dispose();
    }
  });

  it("survivor filter controls stay live while the panel is collapsed", () => {
    const harness = setup({ dataset: dataset(), status: "ready" });
    try {
      expect(harness.dom.advancedPanel.hidden).toBe(true);
      harness.dom.sortSelect.value = "occ-asc";
      harness.dom.sortSelect.dispatchEvent(new Event("change"));
      expect(harness.controller.calls.updateQuery.at(-1)).toEqual({ sort: "occ-asc" });
    } finally {
      harness.dispose();
    }
  });

  it("toggles the advanced-open body class with the panel visibility", () => {
    const harness = setup({ dataset: dataset(), status: "ready" });
    try {
      expect(document.body.classList.contains("advanced-open")).toBe(false);

      harness.dom.advancedToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.advancedPanel.hidden).toBe(false);
      expect(document.body.classList.contains("advanced-open")).toBe(true);

      harness.dom.advancedToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.dom.advancedPanel.hidden).toBe(true);
      expect(document.body.classList.contains("advanced-open")).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("drops the advanced-open body class when the dataset clears while expanded", () => {
    const harness = setup({ dataset: dataset(), status: "ready" });
    try {
      harness.dom.advancedToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(document.body.classList.contains("advanced-open")).toBe(true);

      harness.controller.publishState({ dataset: null, status: "empty" });
      expect(harness.dom.advancedPanel.hidden).toBe(true);
      expect(document.body.classList.contains("advanced-open")).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("ships the advanced panel without the legacy sticky-row-2 class", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    expect(html).not.toContain("sticky-row-2");
  });
});
