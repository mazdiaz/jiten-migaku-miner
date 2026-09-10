// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { AnkiPreviewState, AnkiUiState, AppState } from "../../src/app/state";
import { createInitialAppState } from "../../src/app/state";
import type { DomMap } from "../../src/ui/dom";
import { renderAnkiSection } from "../../src/ui/views/anki-view";

type AnkiDom = Pick<
  DomMap,
  | "ankiSection"
  | "ankiDescription"
  | "ankiStatusLine"
  | "ankiError"
  | "ankiConnect"
  | "ankiSetup"
  | "ankiDeckScope"
  | "ankiNoteType"
  | "ankiTargetField"
  | "ankiCheckConfig"
  | "ankiActions"
  | "ankiSyncNow"
  | "ankiSettings"
  | "ankiClear"
  | "ankiPreview"
  | "ankiPreviewCounts"
  | "ankiPreviewWarning"
  | "ankiApply"
  | "ankiCancelPreview"
>;

function makeAnkiDom(): AnkiDom {
  const add = <T extends HTMLElement>(id: string, tag: string): T => {
    const element = document.createElement(tag) as T;
    element.id = id;
    document.body.appendChild(element);
    return element;
  };

  const dom = {
    ankiSection: add<HTMLElement>("ankiSection", "section"),
    ankiDescription: add<HTMLElement>("ankiDescription", "p"),
    ankiStatusLine: add<HTMLElement>("ankiStatusLine", "p"),
    ankiError: add<HTMLElement>("ankiError", "p"),
    ankiConnect: add<HTMLButtonElement>("ankiConnect", "button"),
    ankiSetup: add<HTMLElement>("ankiSetup", "div"),
    ankiDeckScope: add<HTMLSelectElement>("ankiDeckScope", "select"),
    ankiNoteType: add<HTMLSelectElement>("ankiNoteType", "select"),
    ankiTargetField: add<HTMLSelectElement>("ankiTargetField", "select"),
    ankiCheckConfig: add<HTMLButtonElement>("ankiCheckConfig", "button"),
    ankiActions: add<HTMLElement>("ankiActions", "div"),
    ankiSyncNow: add<HTMLButtonElement>("ankiSyncNow", "button"),
    ankiSettings: add<HTMLButtonElement>("ankiSettings", "button"),
    ankiClear: add<HTMLButtonElement>("ankiClear", "button"),
    ankiPreview: add<HTMLElement>("ankiPreview", "div"),
    ankiPreviewCounts: add<HTMLElement>("ankiPreviewCounts", "p"),
    ankiPreviewWarning: add<HTMLElement>("ankiPreviewWarning", "p"),
    ankiApply: add<HTMLButtonElement>("ankiApply", "button"),
    ankiCancelPreview: add<HTMLButtonElement>("ankiCancelPreview", "button"),
  } satisfies AnkiDom;

  dom.ankiSetup.hidden = true;
  dom.ankiActions.hidden = true;
  dom.ankiPreview.hidden = true;
  dom.ankiStatusLine.hidden = true;
  dom.ankiError.hidden = true;
  dom.ankiPreviewWarning.hidden = true;
  return dom;
}

function stateWithAnki(patch: Partial<AnkiUiState> = {}): AppState {
  const state = createInitialAppState("memory");
  state.anki = { ...state.anki, ...patch };
  return state;
}

function stateWithPreview(patch: Partial<AnkiPreviewState> = {}): AppState {
  const state = stateWithAnki({
    configured: true,
    status: "preview",
    deckScopeLabel: "All decks",
    noteType: "Mine",
    targetField: "Word",
  });
  state.ankiPreview = {
    scannedCards: 12,
    uniqueWords: 10,
    matchedWords: 8,
    knownCount: 5,
    minedCount: 3,
    manualProtected: 2,
    emptyTargetFields: 0,
    queueRemovals: 1,
    zeroCards: false,
    datasetAvailable: true,
    ...patch,
  };
  return state;
}

describe("renderAnkiSection", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders unconfigured and configured states", () => {
    const dom = makeAnkiDom();
    renderAnkiSection(dom, stateWithAnki({ configured: false }));
    expect(dom.ankiConnect.hidden).toBe(false);
    expect(dom.ankiActions.hidden).toBe(true);

    renderAnkiSection(
      dom,
      stateWithAnki({
        configured: true,
        deckScopeLabel: "MAIN::Mining",
        noteType: "Diaz Custom Mine",
        targetField: "Target Word (no syntax)",
        wordCount: 3900,
        knownCount: 3120,
        minedCount: 780,
      }),
    );
    expect(dom.ankiStatusLine.textContent).toContain("3,900 words");
    expect(dom.ankiStatusLine.textContent).toContain("3,120 Known");
    expect(dom.ankiSetup.hidden).toBe(true);
    expect(dom.ankiActions.hidden).toBe(false);
  });

  it("renders preview counts and zero-card warning", () => {
    const dom = makeAnkiDom();
    renderAnkiSection(dom, stateWithPreview({ zeroCards: true }));
    expect(dom.ankiPreview.hidden).toBe(false);
    expect(dom.ankiPreviewWarning.hidden).toBe(false);
    expect(dom.ankiApply.disabled).toBe(false);
  });

  it("warns before applying a snapshot with no dataset matches", () => {
    const dom = makeAnkiDom();
    renderAnkiSection(dom, stateWithPreview({ uniqueWords: 3, matchedWords: 0 }));
    expect(dom.ankiPreviewWarning.hidden).toBe(false);
    expect(dom.ankiPreviewWarning.textContent).toContain("future datasets");
  });

  it("renders syncing and error states without showing stale preview", () => {
    const dom = makeAnkiDom();
    renderAnkiSection(dom, stateWithAnki({ configured: true, status: "syncing" }));
    expect(dom.ankiStatusLine.textContent).toContain("Syncing");
    expect(dom.ankiSyncNow.disabled).toBe(true);

    renderAnkiSection(
      dom,
      stateWithAnki({
        configured: true,
        status: "error",
        errorMessage: "Connection refused",
      }),
    );
    expect(dom.ankiError.hidden).toBe(false);
    expect(dom.ankiError.textContent).toContain("Connection refused");
    expect(dom.ankiPreview.hidden).toBe(true);
  });

  it("keeps Apply enabled when failed Apply retains preview", () => {
    const dom = makeAnkiDom();
    const state = stateWithPreview();
    state.anki = { ...state.anki, status: "error", errorMessage: "Storage failed" };

    renderAnkiSection(dom, state);

    expect(dom.ankiApply.disabled).toBe(false);
  });
});
