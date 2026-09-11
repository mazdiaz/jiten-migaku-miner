// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppState,
  createInitialAppState,
  DEFAULT_VIEW,
  type FileSource,
  type MinerController,
} from "../../src/app/state";
import type { QueryState, ViewState } from "../../src/domain/types";
import { bindControls } from "../../src/ui/controls";
import type { DomMap } from "../../src/ui/dom";
import { getDomMap } from "../../src/ui/dom";
import { createRenderer } from "../../src/ui/renderer";

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
  add("ankiSection", "section");
  add("ankiDescription", "p");
  add("ankiStatusLine", "p").hidden = true;
  add("ankiError", "p").hidden = true;
  add("ankiConnect", "button");
  add("ankiSetup", "div").hidden = true;
  add("ankiDeckScope", "select");
  add("ankiNoteType", "select");
  add("ankiTargetField", "select");
  add("ankiCheckConfig", "button");
  add("ankiActions", "div").hidden = true;
  add("ankiSyncNow", "button");
  add("ankiSettings", "button");
  add("ankiClear", "button");
  add("ankiPreview", "div").hidden = true;
  add("ankiPreviewCounts", "p");
  add("ankiPreviewWarning", "p").hidden = true;
  add("ankiApply", "button");
  add("ankiCancelPreview", "button");
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
  for (const id of [
    "hideKnown",
    "hideKanaOnly",
    "showFurigana",
    "pillHighlight",
    "showHighlight",
    "showDefinitions",
  ]) {
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

  withOptions("sentenceFilter", [
    ["any", "any"],
    ["has", "has"],
    ["none", "none"],
  ]);
  withOptions("sortSelect", [
    ["occ-desc", "occ-desc"],
    ["occ-asc", "occ-asc"],
    ["original", "original"],
  ]);
  withOptions("pageSize", [
    ["25", "25"],
    ["50", "50"],
    ["100", "100"],
    ["all", "all"],
  ]);
  withOptions("decisionFilter", [["all", "All decisions"]]);
  withOptions("sentenceSize", [
    ["medium", "Medium"],
    ["large", "Large"],
  ]);
  withOptions("density", [
    ["comfortable", "Comfortable"],
    ["compact", "Compact"],
  ]);

  add("results", "section");
  add("resultsHeading", "h2");
  add("resultStats", "p");
  add("decisionSummary", "p");
  add("resultsList", "div");
  add("undoButton", "button");
  add("filterChips", "div");
  add("reviewButton", "button");
  const reviewOverlay = add("reviewOverlay", "div");
  reviewOverlay.setAttribute("role", "dialog");
  const reviewPanel = add("reviewPanel", "div");
  reviewPanel.setAttribute("tabindex", "-1");
  reviewOverlay.appendChild(reviewPanel);
  for (const id of [
    "reviewHeading",
    "reviewProgress",
    "reviewContent",
    "reviewComplete",
    "reviewReturn",
    "reviewExit",
    "reviewKnown",
    "reviewMined",
    "reviewSkip",
    "reviewLater",
    "reviewUndo",
  ]) {
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
  for (const id of [
    "coverageUniqueWords",
    "coverageKnownOccurrences",
    "coveragePercent",
    "coverageTargets",
  ]) {
    coverageBody.appendChild(add(id, "div"));
  }
  const coverageError = add("coverageError", "p");
  coverageError.hidden = true;
  coverageBody.appendChild(coverageError);
  coverageBody.appendChild(add("coverageFocus", "button"));

  return getDomMap();
}

interface FakeController extends MinerController {
  calls: {
    updateView: Partial<ViewState>[];
    updateQuery: Partial<QueryState>[];
  };
  publishState(patch: Partial<AppState>): void;
}

function createFakeController(initial?: Partial<AppState>): FakeController {
  let state: AppState = { ...createInitialAppState("memory"), ...initial };
  const listeners = new Set<Listener>();
  const calls = {
    updateView: [] as Partial<ViewState>[],
    updateQuery: [] as Partial<QueryState>[],
  };
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
    updateView(patch: Partial<ViewState>) {
      calls.updateView.push(patch);
    },
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
    connectAnki: vi.fn(async () => ({ decks: [], models: [] })),
    loadAnkiModelFields: vi.fn(async () => []),
    validateAndSaveAnkiConfig: vi.fn(async () => {}),
    previewAnkiSync: vi.fn(async () => {}),
    applyAnkiSync: vi.fn(async () => {}),
    cancelAnkiSyncPreview: vi.fn(),
    clearAnkiSyncData: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
  };
  return controller;
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
  const bindings = bindControls(dom, controller);
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
  document.body.className = "";
});

describe("reading display preference defaults", () => {
  it("defaults sentenceSize to medium and density to comfortable", () => {
    expect(DEFAULT_VIEW.sentenceSize).toBe("medium");
    expect(DEFAULT_VIEW.density).toBe("comfortable");
  });

  it("seeds initial app state with the default display preferences", () => {
    expect(createInitialAppState("memory").view).toEqual(DEFAULT_VIEW);
  });
});

describe("reading display body classes and select sync", () => {
  it("mounts no display body classes at the default preferences", () => {
    const harness = setup();
    try {
      expect(document.body.classList.contains("sent-size-lg")).toBe(false);
      expect(document.body.classList.contains("density-compact")).toBe(false);
      expect(harness.dom.sentenceSize.value).toBe("medium");
      expect(harness.dom.density.value).toBe("comfortable");
    } finally {
      harness.dispose();
    }
  });

  it("toggles sent-size-lg only when sentenceSize is large", () => {
    const harness = setup();
    try {
      harness.controller.publishState({
        view: { ...DEFAULT_VIEW, sentenceSize: "large" },
      });
      expect(document.body.classList.contains("sent-size-lg")).toBe(true);
      expect(document.body.classList.contains("density-compact")).toBe(false);
      expect(harness.dom.sentenceSize.value).toBe("large");

      harness.controller.publishState({ view: { ...DEFAULT_VIEW } });
      expect(document.body.classList.contains("sent-size-lg")).toBe(false);
      expect(harness.dom.sentenceSize.value).toBe("medium");
    } finally {
      harness.dispose();
    }
  });

  it("toggles density-compact only when density is compact", () => {
    const harness = setup();
    try {
      harness.controller.publishState({
        view: { ...DEFAULT_VIEW, density: "compact" },
      });
      expect(document.body.classList.contains("density-compact")).toBe(true);
      expect(document.body.classList.contains("sent-size-lg")).toBe(false);
      expect(harness.dom.density.value).toBe("compact");

      harness.controller.publishState({ view: { ...DEFAULT_VIEW } });
      expect(document.body.classList.contains("density-compact")).toBe(false);
      expect(harness.dom.density.value).toBe("comfortable");
    } finally {
      harness.dispose();
    }
  });

  it("supports both display preferences at once", () => {
    const harness = setup();
    try {
      harness.controller.publishState({
        view: { ...DEFAULT_VIEW, sentenceSize: "large", density: "compact" },
      });
      expect(document.body.classList.contains("sent-size-lg")).toBe(true);
      expect(document.body.classList.contains("density-compact")).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});

describe("reading display controls binding", () => {
  it("patches updateView with sentenceSize when the select changes", () => {
    const harness = setup();
    try {
      harness.dom.sentenceSize.value = "large";
      harness.dom.sentenceSize.dispatchEvent(new Event("change"));
      expect(harness.controller.calls.updateView).toEqual([{ sentenceSize: "large" }]);

      harness.dom.sentenceSize.value = "medium";
      harness.dom.sentenceSize.dispatchEvent(new Event("change"));
      expect(harness.controller.calls.updateView).toEqual([
        { sentenceSize: "large" },
        { sentenceSize: "medium" },
      ]);
    } finally {
      harness.dispose();
    }
  });

  it("patches updateView with density when the select changes", () => {
    const harness = setup();
    try {
      harness.dom.density.value = "compact";
      harness.dom.density.dispatchEvent(new Event("change"));
      expect(harness.controller.calls.updateView).toEqual([{ density: "compact" }]);
    } finally {
      harness.dispose();
    }
  });
});

describe("reading display controls markup", () => {
  it("ships both selects in the Display group with default-selected options", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const displayStart = html.indexOf("<legend>Display</legend>");
    const displayEnd = html.indexOf("</fieldset>", displayStart);
    expect(displayStart).toBeGreaterThan(-1);
    const displayHtml = html.slice(displayStart, displayEnd);
    expect(displayHtml).toContain('id="sentenceSize"');
    expect(displayHtml).toContain('value="medium" selected');
    expect(displayHtml).toContain('id="density"');
    expect(displayHtml).toContain('value="comfortable" selected');
  });
});
