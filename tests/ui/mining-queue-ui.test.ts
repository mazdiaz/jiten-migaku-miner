// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindControls } from "../../src/ui/controls";
import { getDomMap, type DomMap } from "../../src/ui/dom";
import { createRenderer, renderEntryNode } from "../../src/ui/renderer";
import type { AppState, FileSource, MinerController } from "../../src/app/state";
import { createInitialAppState } from "../../src/app/state";
import type { EntryWithKnown, QueryState } from "../../src/domain/types";

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
  withOptions("decisionFilter", [["all", "All decisions"], ["unreviewed", "Unreviewed"]]);
  withOptions("stickyDecision", [["all", "All"], ["unreviewed", "Unreviewed"]]);

  add("results", "section");
  add("resultsHeading", "h2");
  add("resultStats", "p");
  add("resultsList", "div");
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
  intoPanel("reviewComplete", "div");
  intoPanel("reviewReturn", "button");
  intoPanel("reviewExit", "button");
  intoPanel("reviewKnown", "button");
  intoPanel("reviewMined", "button");
  intoPanel("reviewSkip", "button");
  intoPanel("reviewLater", "button");
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
    setWordDecision: Array<[string, string]>;
    toggleQueued: string[];
    removeQueued: string[];
    clearQueue: number;
    startQueueMode: number;
    stopQueueMode: number;
    updateQuery: Partial<QueryState>[];
  };
  publishState(patch: Partial<AppState>): void;
}

function createFakeController(initial?: Partial<AppState>): FakeController {
  let state: AppState = { ...createInitialAppState("memory"), ...initial };
  const listeners = new Set<Listener>();
  const calls = {
    setWordDecision: [] as Array<[string, string]>,
    toggleQueued: [] as string[],
    removeQueued: [] as string[],
    clearQueue: 0,
    startQueueMode: 0,
    stopQueueMode: 0,
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
    updateQuery: vi.fn((patch: Partial<QueryState>) => {
      calls.updateQuery.push(patch);
    }),
    updateView: vi.fn(),
    updateViewport: vi.fn(),
    changePage: vi.fn(),
    setWordDecision: vi.fn(async (word: string, status: string) => {
      calls.setWordDecision.push([word, status]);
    }),
    startReview: vi.fn(async () => {}),
    stopReview: vi.fn(),
    reviewDecision: vi.fn(async () => {}),
    toggleQueued: vi.fn((word: string) => {
      calls.toggleQueued.push(word);
    }),
    removeQueued: vi.fn((word: string) => {
      calls.removeQueued.push(word);
    }),
    clearQueue: vi.fn(() => {
      calls.clearQueue += 1;
    }),
    startQueueMode: vi.fn(async () => {
      calls.startQueueMode += 1;
    }),
    stopQueueMode: vi.fn(() => {
      calls.stopQueueMode += 1;
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
    definitions: "word",
    furiganaRuns: [],
    known: false,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed",
    ...overrides,
  };
}

function queueState(words: string[], mode: "normal" | "queue" = "normal"): Partial<AppState> {
  return { queue: { datasetId: "dataset-1", normalizedWords: words, mode } };
}

function datasetState(): Partial<AppState> {
  return {
    dataset: {
      id: "dataset-1", name: "book.csv", sourceType: "file", sourceName: "book.csv",
      headers: ["Word"], entryCount: 3, createdAt: "x", updatedAt: "x", schemaVersion: 1,
    },
    status: "ready",
  };
}

interface Harness {
  dom: DomMap;
  controller: FakeController;
  dispose(): void;
}

function setup(initial?: Partial<AppState>, confirmResult = true): Harness {
  const dom = seedDom();
  const controller = createFakeController(initial);
  const renderer = createRenderer(dom);
  const unsubscribe = controller.subscribe((state) => renderer.render(state));
  const bindings = bindControls(dom, controller, {
    confirmQueueClear: (message: string) => confirmResult,
  });
  return {
    dom,
    controller,
    dispose() {
      unsubscribe();
      bindings.dispose();
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("entry queue controls", () => {
  it("queue button toggles membership via controller", () => {
    const harness = setup();
    harness.dom.resultsList.appendChild(renderEntryNode(makeEntry(), 1, createInitialAppState("memory").view));

    const button = harness.dom.resultsList.querySelector<HTMLButtonElement>("[data-queue-action]")!;
    expect(button.textContent).toBe("+ Queue");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(harness.controller.calls.toggleQueued).toEqual(["言葉"]);
    expect(harness.controller.calls.removeQueued).toEqual([]);
  });

  it("clicking a pressed queue button removes the word instead", () => {
    const harness = setup(queueState(["言葉"]));
    harness.dom.resultsList.appendChild(
      renderEntryNode(makeEntry(), 1, createInitialAppState("memory").view, { queued: true }),
    );

    const button = harness.dom.resultsList.querySelector<HTMLButtonElement>("[data-queue-action]")!;
    expect(button.textContent).toBe("✓ Queued");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(harness.controller.calls.removeQueued).toEqual(["言葉"]);
    expect(harness.controller.calls.toggleQueued).toEqual([]);
  });

  it("queue count reflects membership and disables Start Mining at zero", () => {
    const harness = setup(datasetState());
    expect(harness.dom.queueToggle.textContent).toBe("Queue (0)");
    expect(harness.dom.queueToggle.disabled).toBe(true);

    harness.controller.publishState(queueState(["いぬ", "ねこ", "とり"]));
    expect(harness.dom.queueToggle.textContent).toBe("Queue (3)");
    expect(harness.dom.queueToggle.disabled).toBe(false);
  });

  it("queue toggle button enters and exits queue mode", () => {
    const harness = setup(datasetState());
    harness.dom.queueToggle.dispatchEvent(new Event("click"));
    expect(harness.controller.calls.startQueueMode).toBe(1);

    harness.controller.publishState(queueState(["いぬ"], "queue"));
    expect(harness.dom.queueToggle.getAttribute("aria-pressed")).toBe("true");
    harness.dom.queueToggle.dispatchEvent(new Event("click"));
    expect(harness.controller.calls.stopQueueMode).toBe(1);
  });

  it("decision buttons still call the controller and sentence DOM stays button-free", () => {
    const harness = setup();
    const view = { ...createInitialAppState("memory").view, showHighlight: true };
    const plain = renderEntryNode(makeEntry(), 1, view);
    const queued = renderEntryNode(makeEntry(), 1, view, { queued: true });

    expect(queued.querySelector(".sentence")?.innerHTML).toBe(plain.querySelector(".sentence")?.innerHTML);
    expect(queued.querySelector(".sentence")?.querySelectorAll("button")).toHaveLength(0);
    expect(queued.querySelector(".sentence")?.textContent).toContain("が好き。");
    harness.dom.resultsList.appendChild(queued);
    harness.dom.resultsList
      .querySelector<HTMLButtonElement>('[data-decision-action="mined"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(harness.controller.calls.setWordDecision).toEqual([["言葉", "mined"]]);
  });
});

describe("queue mode view", () => {
  it("renders queued rows with decision and remove actions in queue mode", () => {
    const dom = seedDom();
    const renderer = createRenderer(dom);
    const base = createInitialAppState("memory");
    renderer.render({
      ...base,
      ...datasetState(),
      ...queueState(["言葉", "いぬ"], "queue"),
      result: {
        items: [makeEntry(), makeEntry({ id: "e2", word: "いぬ", normalizedWord: "いぬ" })],
        page: 1, totalPages: 1, totalEntries: 2, startIndex: 1, endIndex: 2,
        pageSize: "all", knownCount: 0, windowed: false,
      },
    });

    expect(dom.queueHeader.hidden).toBe(false);
    expect(dom.queueHeading.textContent).toBe("Mining Queue — 2 words");
    const actions = [...dom.resultsList.querySelectorAll(".entry-queue-actions")];
    expect(actions).toHaveLength(2);
    expect(dom.resultsList.querySelectorAll('[data-queue-action="remove"]')).toHaveLength(2);
    expect(dom.resultsList.querySelectorAll(".entry-queue")).toHaveLength(0);
  });

  it("shows the completion message when the queue empties", () => {
    const dom = seedDom();
    const renderer = createRenderer(dom);
    const base = createInitialAppState("memory");
    renderer.render({
      ...base,
      ...datasetState(),
      ...queueState([], "queue"),
      result: {
        items: [], page: 0, totalPages: 0, totalEntries: 0,
        startIndex: 0, endIndex: 0, pageSize: "all", knownCount: 0, windowed: false,
      },
    });

    expect(dom.queueHeading.textContent).toBe("Mining Queue — 0 words");
    expect(dom.queueStats.textContent).toBe("Mining queue complete.");
    expect(dom.resultsList.querySelector(".empty-state")?.textContent).toBe("Mining queue complete.");
  });

  it("exit button leaves queue mode", () => {
    const harness = setup({ ...datasetState(), ...queueState(["いぬ"], "queue") });
    harness.dom.exitQueue.dispatchEvent(new Event("click"));
    expect(harness.controller.calls.stopQueueMode).toBe(1);
  });

  it("clear button requires confirmation and reports the count", () => {
    const harness = setup({ ...datasetState(), ...queueState(["いぬ", "ねこ", "とり"]) }, false);
    harness.dom.clearQueue.dispatchEvent(new Event("click"));
    expect(harness.controller.calls.clearQueue).toBe(0);

    harness.controller.publishState({});
    const harnessYes = setup({ ...datasetState(), ...queueState(["いぬ", "ねこ", "とり"]) }, true);
    harnessYes.dom.clearQueue.dispatchEvent(new Event("click"));
    expect(harnessYes.controller.calls.clearQueue).toBe(1);
  });

  it("list paging shortcuts are suppressed in queue mode", () => {
    const harness = setup({ ...datasetState(), ...queueState(["いぬ"], "queue") });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(harness.controller.calls.updateQuery).toEqual([]);
  });
});
