// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryWithKnown, QueryState, ViewState } from "../../src/domain/types";
import {
  type AppState,
  createInitialAppState,
  DEFAULT_VIEW,
  type FileSource,
  type MinerController,
} from "../../src/miner/state";
import { createHighlightAdapter } from "../../src/ui/highlight-adapter";
import { createPracticeMode } from "../../src/ui/practice-mode";
import { renderMinerShell } from "../support/shell";

type Listener = (state: Readonly<AppState>) => void;

interface FakeController extends MinerController {
  calls: {
    updateView: Partial<ViewState>[];
    updateQuery: Partial<QueryState>[];
  };
  state: AppState;
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
    get state() {
      return state;
    },
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
      state = { ...state, query: { ...state.query, ...patch } };
      for (const listener of listeners) listener(state);
    },
    updateView(patch: Partial<ViewState>) {
      calls.updateView.push(patch);
      state = { ...state, view: { ...state.view, ...patch } };
      for (const listener of listeners) listener(state);
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

function makeDataset(
  overrides: Partial<NonNullable<AppState["dataset"]>> = {},
): NonNullable<AppState["dataset"]> {
  return {
    id: "d1",
    name: "test",
    sourceType: "file",
    sourceName: "test.csv",
    headers: ["Word"],
    entryCount: 1,
    createdAt: "x",
    updatedAt: "x",
    schemaVersion: 1,
    ...overrides,
  };
}

function makeResult(items: EntryWithKnown[]): NonNullable<AppState["result"]> {
  return {
    items,
    page: 1,
    totalPages: 1,
    totalEntries: items.length,
    startIndex: 1,
    endIndex: items.length,
    pageSize: 50,
    knownCount: 0,
    windowed: false,
  };
}

const SAMPLE_ENTRY: EntryWithKnown = {
  id: "e1",
  originalIndex: 0,
  word: "漢字",
  normalizedWord: "漢字",
  furiganaRuns: [{ text: "漢字", reading: "かんじ" }],
  sentenceRaw: "これは**漢字**です。",
  hasSentence: true,
  definitions: "Chinese characters",
  occurrences: 5,
  known: false,
  knownByMigaku: false,
  knownByDecision: false,
  decision: "unreviewed",
};

beforeEach(() => {
  document.body.innerHTML = renderMinerShell();
  document.body.className = "";
});

describe("Practice Mode view toggles", () => {
  it("mounts practice controls with Furigana, Highlight, Pill, and Definitions checkboxes", () => {
    const controller = createFakeController();
    const resultsList = document.getElementById("resultsList")!;
    const practice = createPracticeMode({ controller, resultsList });

    expect(document.getElementById("practiceControls")).not.toBeNull();
    expect(document.getElementById("practiceShowFurigana")).toBeInstanceOf(HTMLInputElement);
    expect(document.getElementById("practiceShowHighlight")).toBeInstanceOf(HTMLInputElement);
    expect(document.getElementById("practicePillHighlight")).toBeInstanceOf(HTMLInputElement);
    expect(document.getElementById("practiceShowDefinitions")).toBeInstanceOf(HTMLInputElement);

    practice.destroy();
    expect(document.getElementById("practiceControls")).toBeNull();
  });

  it("syncs toggle checkboxes with state.view upon launch", () => {
    const controller = createFakeController({
      status: "ready",
      dataset: makeDataset(),
      result: makeResult([SAMPLE_ENTRY]),
      view: {
        ...DEFAULT_VIEW,
        showFurigana: true,
        showHighlight: true,
        pillHighlight: true,
        showDefinitions: false,
      },
    });
    const resultsList = document.getElementById("resultsList")!;
    const practice = createPracticeMode({ controller, resultsList });
    practice.sync(controller.state);

    const practiceButton = document.getElementById("practiceButton") as HTMLButtonElement;
    practiceButton.click();

    const furigana = document.getElementById("practiceShowFurigana") as HTMLInputElement;
    const highlight = document.getElementById("practiceShowHighlight") as HTMLInputElement;
    const pill = document.getElementById("practicePillHighlight") as HTMLInputElement;
    const definitions = document.getElementById("practiceShowDefinitions") as HTMLInputElement;

    expect(furigana.checked).toBe(true);
    expect(highlight.checked).toBe(true);
    expect(pill.checked).toBe(true);
    expect(definitions.checked).toBe(false);
    expect(document.body.classList.contains("hl-pill")).toBe(true);

    practice.destroy();
  });

  it("updates controller view and re-renders card when toggles change", () => {
    const onContentChanged = vi.fn();
    const controller = createFakeController({
      status: "ready",
      dataset: makeDataset(),
      result: makeResult([SAMPLE_ENTRY]),
      view: {
        ...DEFAULT_VIEW,
        showFurigana: false,
        showHighlight: false,
        pillHighlight: false,
        showDefinitions: true,
      },
    });
    const resultsList = document.getElementById("resultsList")!;
    const practice = createPracticeMode({ controller, resultsList, onContentChanged });
    practice.sync(controller.state);

    const practiceButton = document.getElementById("practiceButton") as HTMLButtonElement;
    practiceButton.click();

    const furigana = document.getElementById("practiceShowFurigana") as HTMLInputElement;
    const highlight = document.getElementById("practiceShowHighlight") as HTMLInputElement;
    const pill = document.getElementById("practicePillHighlight") as HTMLInputElement;
    const definitions = document.getElementById("practiceShowDefinitions") as HTMLInputElement;

    // Initially furigana is off -> no rt element
    expect(resultsList.querySelector("rt")).toBeNull();
    // Initially highlight is off -> no target-highlight
    expect(resultsList.querySelector(".target-highlight")).toBeNull();
    // Initially definitions is on -> definitions exist
    expect(resultsList.querySelector(".entry-definitions")).not.toBeNull();

    // Toggle Furigana on
    furigana.checked = true;
    furigana.dispatchEvent(new Event("change"));
    expect(controller.calls.updateView).toContainEqual({ showFurigana: true });
    practice.sync(controller.state);
    expect(resultsList.querySelector("rt")).not.toBeNull();
    // Card should still be concealed before reveal
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(true);

    // Toggle Highlight on
    highlight.checked = true;
    highlight.dispatchEvent(new Event("change"));
    expect(controller.calls.updateView).toContainEqual({ showHighlight: true });
    practice.sync(controller.state);
    expect(resultsList.querySelector(".target-highlight")).not.toBeNull();

    // Toggle Pill on
    pill.checked = true;
    pill.dispatchEvent(new Event("change"));
    expect(controller.calls.updateView).toContainEqual({ pillHighlight: true });
    practice.sync(controller.state);
    expect(document.body.classList.contains("hl-pill")).toBe(true);

    // Toggle Definitions off
    definitions.checked = false;
    definitions.dispatchEvent(new Event("change"));
    expect(controller.calls.updateView).toContainEqual({ showDefinitions: false });
    practice.sync(controller.state);
    expect(resultsList.querySelector(".entry-definitions")).toBeNull();

    practice.destroy();
  });

  it("preserves revealed state when toggling view options on a revealed card", () => {
    const controller = createFakeController({
      status: "ready",
      dataset: makeDataset(),
      result: makeResult([SAMPLE_ENTRY]),
      view: {
        ...DEFAULT_VIEW,
        showFurigana: false,
        showHighlight: false,
      },
    });
    const resultsList = document.getElementById("resultsList")!;
    const practice = createPracticeMode({ controller, resultsList });
    practice.sync(controller.state);

    const practiceButton = document.getElementById("practiceButton") as HTMLButtonElement;
    practiceButton.click();

    const revealButton = document.getElementById("practiceReveal") as HTMLButtonElement;
    expect(revealButton.textContent).toBe("Reveal");

    // Reveal card
    revealButton.click();
    expect(revealButton.textContent).toBe("Next");
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(false);

    // Now toggle Furigana while revealed
    const furigana = document.getElementById("practiceShowFurigana") as HTMLInputElement;
    furigana.checked = true;
    furigana.dispatchEvent(new Event("change"));
    practice.sync(controller.state);

    // Should remain revealed
    expect(resultsList.querySelector("rt")).not.toBeNull();
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(false);
    expect(revealButton.textContent).toBe("Next");

    // Toggle Highlight on while revealed
    const highlight = document.getElementById("practiceShowHighlight") as HTMLInputElement;
    highlight.checked = true;
    highlight.dispatchEvent(new Event("change"));
    practice.sync(controller.state);

    expect(resultsList.querySelector(".target-highlight")).not.toBeNull();
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(false);
    expect(revealButton.textContent).toBe("Next");

    // Toggle Highlight off while revealed
    highlight.checked = false;
    highlight.dispatchEvent(new Event("change"));
    practice.sync(controller.state);

    expect(resultsList.querySelector(".target-highlight")).toBeNull();
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(false);
    expect(revealButton.textContent).toBe("Next");

    practice.destroy();
  });

  it("applies highlight adapter reconciliation when Highlight is toggled before and after reveal", () => {
    const onContentChanged = vi.fn();
    const controller = createFakeController({
      status: "ready",
      dataset: makeDataset(),
      result: makeResult([SAMPLE_ENTRY]),
      view: {
        ...DEFAULT_VIEW,
        showFurigana: false,
        showHighlight: false,
      },
    });
    const resultsList = document.getElementById("resultsList")!;
    const highlightAdapter = createHighlightAdapter(resultsList);
    const practice = createPracticeMode({
      controller,
      resultsList,
      onContentChanged: () => {
        highlightAdapter.reconcile(resultsList);
        onContentChanged();
      },
    });
    practice.sync(controller.state);

    const practiceButton = document.getElementById("practiceButton") as HTMLButtonElement;
    practiceButton.click();

    const highlight = document.getElementById("practiceShowHighlight") as HTMLInputElement;
    const revealButton = document.getElementById("practiceReveal") as HTMLButtonElement;

    // Initially concealed and unhighlighted
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(true);
    expect(resultsList.querySelector(".target-highlight")).toBeNull();
    expect(resultsList.querySelector(".th-wrap")).toBeNull();

    // 1. Toggle Highlight ON before reveal
    highlight.checked = true;
    highlight.dispatchEvent(new Event("change"));
    practice.sync(controller.state);

    expect(resultsList.querySelector(".target-highlight")).not.toBeNull();
    expect(resultsList.querySelector(".th-wrap")).not.toBeNull();
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(true);
    expect(onContentChanged).toHaveBeenCalled();
    onContentChanged.mockClear();

    // 2. Toggle Highlight OFF before reveal
    highlight.checked = false;
    highlight.dispatchEvent(new Event("change"));
    practice.sync(controller.state);

    expect(resultsList.querySelector(".target-highlight")).toBeNull();
    expect(resultsList.querySelector(".th-wrap")).toBeNull();
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(true);
    expect(onContentChanged).toHaveBeenCalled();
    onContentChanged.mockClear();

    // 3. Reveal the card
    revealButton.click();
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(false);
    expect(revealButton.textContent).toBe("Next");
    expect(onContentChanged).toHaveBeenCalled();
    onContentChanged.mockClear();

    // 4. Toggle Highlight ON after reveal
    highlight.checked = true;
    highlight.dispatchEvent(new Event("change"));
    practice.sync(controller.state);

    expect(resultsList.querySelector(".target-highlight")).not.toBeNull();
    expect(resultsList.querySelector(".th-wrap")).not.toBeNull();
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(false);
    expect(revealButton.textContent).toBe("Next");
    expect(onContentChanged).toHaveBeenCalled();
    onContentChanged.mockClear();

    // 5. Toggle Highlight OFF after reveal
    highlight.checked = false;
    highlight.dispatchEvent(new Event("change"));
    practice.sync(controller.state);

    expect(resultsList.querySelector(".target-highlight")).toBeNull();
    expect(resultsList.querySelector(".th-wrap")).toBeNull();
    expect(
      resultsList.querySelector(".practice-entry")?.classList.contains("practice-concealed"),
    ).toBe(false);
    expect(revealButton.textContent).toBe("Next");

    practice.destroy();
    highlightAdapter.destroy();
  });
});
