// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, MinerController } from "../../src/app/state";
import { createInitialAppState } from "../../src/app/state";
import type { DomMap } from "../../src/ui/dom";
import { getDomMap } from "../../src/ui/dom";
import type { Renderer } from "../../src/ui/renderer";
import { createRenderer, formatBackupFreshness } from "../../src/ui/renderer";

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
  withOptions("decisionFilter", [
    ["all", "All decisions"],
    ["unreviewed", "Unreviewed"],
    ["known", "Known"],
    ["mined", "Mined"],
    ["skip", "Skipped"],
    ["later", "Later"],
  ]);

  withOptions("sentenceSize", [
    ["medium", "medium"],
    ["large", "large"],
  ]);
  withOptions("density", [
    ["comfortable", "comfortable"],
    ["compact", "compact"],
  ]);
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

const NOW = new Date("2026-09-06T20:00:00.000Z");
const SAME_DAY_EXPORT = new Date(NOW.getTime() - 60_000).toISOString();
const OLDER_EXPORT = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();

function expectedTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function expectedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  document.body.innerHTML = "";
});

describe("backup freshness formatting", () => {
  it("shows the no-export message when lastExportAt is null", () => {
    expect(formatBackupFreshness(null, 0)).toBe("No export this session");
    expect(formatBackupFreshness(null, 7)).toBe("No export this session");
  });

  it("formats a same-day export as time only with the change count", () => {
    expect(formatBackupFreshness(SAME_DAY_EXPORT, 3, NOW)).toBe(
      `Last export: ${expectedTime(SAME_DAY_EXPORT)} · 3 changes since export`,
    );
  });

  it("formats an older export as short date + time", () => {
    expect(formatBackupFreshness(OLDER_EXPORT, 12, NOW)).toBe(
      `Last export: ${expectedDate(OLDER_EXPORT)}, ${expectedTime(OLDER_EXPORT)} · 12 changes since export`,
    );
  });

  it("uses the singular 'change' for exactly one", () => {
    expect(formatBackupFreshness(SAME_DAY_EXPORT, 1, NOW)).toBe(
      `Last export: ${expectedTime(SAME_DAY_EXPORT)} · 1 change since export`,
    );
  });

  it("shows zero changes immediately after an export", () => {
    expect(formatBackupFreshness(NOW.toISOString(), 0, NOW)).toBe(
      `Last export: ${expectedTime(NOW.toISOString())} · 0 changes since export`,
    );
  });
});

describe("backup freshness line", () => {
  it("resolves the element via getDomMap", () => {
    const dom = seedDom();
    expect(dom.backupFreshness.id).toBe("backupFreshness");
  });

  it("renders the no-export message before any export this session", () => {
    const harness = setup();
    try {
      expect(harness.dom.backupFreshness.textContent).toBe("No export this session");
    } finally {
      harness.dispose();
    }
  });

  it("carries the no-retention title tooltip", () => {
    const harness = setup();
    try {
      expect(harness.dom.backupFreshness.getAttribute("title")).toBe(
        "Exporting does not guarantee the downloaded file was kept.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("re-derives on every publish as exports land and changes accumulate", () => {
    const harness = setup();
    try {
      expect(harness.dom.backupFreshness.textContent).toBe("No export this session");

      harness.controller.publishState({
        lastExportAt: SAME_DAY_EXPORT,
        changesSinceExport: 0,
      });
      expect(harness.dom.backupFreshness.textContent).toBe(
        `Last export: ${expectedTime(SAME_DAY_EXPORT)} · 0 changes since export`,
      );

      harness.controller.publishState({ changesSinceExport: 1 });
      expect(harness.dom.backupFreshness.textContent).toBe(
        `Last export: ${expectedTime(SAME_DAY_EXPORT)} · 1 change since export`,
      );

      harness.controller.publishState({ changesSinceExport: 4 });
      expect(harness.dom.backupFreshness.textContent).toBe(
        `Last export: ${expectedTime(SAME_DAY_EXPORT)} · 4 changes since export`,
      );
    } finally {
      harness.dispose();
    }
  });

  it("returns to the no-export message after clear saved data", () => {
    const harness = setup({
      lastExportAt: SAME_DAY_EXPORT,
      changesSinceExport: 2,
    });
    try {
      expect(harness.dom.backupFreshness.textContent).toContain("changes since export");
      harness.controller.publishState({
        lastExportAt: null,
        changesSinceExport: 0,
      });
      expect(harness.dom.backupFreshness.textContent).toBe("No export this session");
    } finally {
      harness.dispose();
    }
  });
});
