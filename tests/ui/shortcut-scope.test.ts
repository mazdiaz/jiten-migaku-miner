// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindControls } from "../../src/ui/controls";
import { getDomMap } from "../../src/ui/dom";
import type { DomMap } from "../../src/ui/dom";
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
  add("resultsHeading", "h2").setAttribute("tabindex", "-1");
  add("resultStats", "p");
  add("resultsList", "div");
  add("reviewButton", "button");
  const reviewOverlay = add("reviewOverlay", "div");
  reviewOverlay.setAttribute("role", "dialog");
  const reviewPanel = add("reviewPanel", "div");
  reviewPanel.setAttribute("tabindex", "-1");
  reviewOverlay.appendChild(reviewPanel);
  for (const id of ["reviewHeading", "reviewProgress", "reviewContent", "reviewComplete", "reviewReturn", "reviewExit", "reviewKnown", "reviewMined", "reviewSkip", "reviewLater"]) {
    const element = add(id, "div");
    reviewPanel.appendChild(element);
  }
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

  return getDomMap();
}

interface FakeController extends MinerController {
  calls: { changePage: number[] };
}

function createFakeController(): FakeController {
  const state: AppState = {
    ...createInitialAppState("memory"),
    dataset: {
      id: "d1", name: "book.csv", sourceType: "file", sourceName: "book.csv",
      headers: ["Word"], entryCount: 60, createdAt: "x", updatedAt: "x", schemaVersion: 1,
    },
    status: "ready",
  };
  const listeners = new Set<Listener>();
  const calls = { changePage: [] as number[] };
  const controller: FakeController = {
    calls,
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
    changePage(delta: number) {
      calls.changePage.push(delta);
    },
    setWordDecision: vi.fn(async () => {}),
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

interface Harness {
  dom: DomMap;
  controller: FakeController;
  dispose(): void;
}

function setup(): Harness {
  const dom = seedDom();
  const controller = createFakeController();
  const bindings = bindControls(dom, controller);
  return {
    dom,
    controller,
    dispose() {
      bindings.dispose();
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("list shortcut scoping and pagination focus", () => {
  it("letter and arrow shortcuts bail when focus is inside the sticky toolbar", () => {
    const harness = setup();
    try {
      const keydown = (key: string, target: HTMLElement): void => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      };
      keydown("n", harness.dom.stickyNext);
      keydown("ArrowRight", harness.dom.stickyNext);
      keydown("Home", harness.dom.stickyNext);
      expect(harness.controller.calls.changePage).toEqual([]);

      keydown("n", document.body);
      expect(harness.controller.calls.changePage).toEqual([1]);
    } finally {
      harness.dispose();
    }
  });

  it("keyboard pagination focuses the results heading", () => {
    const harness = setup();
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(harness.controller.calls.changePage).toEqual([1]);
      expect(document.activeElement).toBe(harness.dom.resultsHeading);
    } finally {
      harness.dispose();
    }
  });

  it("pager button clicks focus the results heading", () => {
    const harness = setup();
    try {
      harness.dom.bottomNext.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      harness.dom.stickyNext.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(harness.controller.calls.changePage).toEqual([1, 1]);
      expect(document.activeElement).toBe(harness.dom.resultsHeading);
    } finally {
      harness.dispose();
    }
  });
});
