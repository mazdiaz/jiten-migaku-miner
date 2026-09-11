// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, FileSource, MinerController } from "../../src/app/state";
import { createInitialAppState } from "../../src/app/state";
import { bindControls } from "../../src/ui/controls";
import type { DomMap } from "../../src/ui/dom";
import { getDomMap } from "../../src/ui/dom";
import { renderAnkiSection } from "../../src/ui/views/anki-view";

function makeDom(): DomMap {
  const add = <T extends HTMLElement>(id: string, tag: string): T => {
    const element = document.createElement(tag) as T;
    element.id = id;
    document.body.appendChild(element);
    return element;
  };

  add<HTMLInputElement>("jitenInput", "input").type = "file";
  add<HTMLInputElement>("knownInput", "input").type = "file";
  for (const id of [
    "jitenDropzone",
    "knownDropzone",
    "jitenStatus",
    "knownStatus",
    "importSummary",
    "importGrid",
    "errorBox",
    "advancedPanel",
    "results",
    "resultsList",
    "decisionSummary",
    "filterChips",
    "reviewOverlay",
    "reviewPanel",
    "queueHeader",
    "stickyToolbar",
    "stickyTitle",
    "coveragePanel",
    "coverageBody",
    "coverageTargets",
    "coverageError",
    "ankiSection",
    "ankiDescription",
    "ankiStatusLine",
    "ankiError",
    "ankiSetup",
    "ankiActions",
    "ankiPreview",
    "ankiPreviewCounts",
    "ankiPreviewWarning",
  ]) {
    add(id, "div");
  }
  for (const id of [
    "changeFiles",
    "clearData",
    "exportBackup",
    "restoreBackup",
    "advancedToggle",
    "coverageToggle",
    "coverageFocus",
    "undoButton",
    "reviewButton",
    "reviewReturn",
    "reviewExit",
    "reviewKnown",
    "reviewMined",
    "reviewSkip",
    "reviewLater",
    "reviewUndo",
    "queueToggle",
    "exitQueue",
    "clearQueue",
    "stickyPrev",
    "stickyNext",
    "bottomPrev",
    "bottomNext",
    "ankiConnect",
    "ankiCheckConfig",
    "ankiSyncNow",
    "ankiSettings",
    "ankiClear",
    "ankiApply",
    "ankiCancelPreview",
  ]) {
    add(id, "button");
  }
  add<HTMLInputElement>("restoreBackupInput", "input").type = "file";
  add<HTMLInputElement>("stickySearch", "input").type = "search";
  add<HTMLInputElement>("hideKnown", "input").type = "checkbox";
  add<HTMLInputElement>("hideKanaOnly", "input").type = "checkbox";
  add<HTMLInputElement>("showFurigana", "input").type = "checkbox";
  add<HTMLInputElement>("pillHighlight", "input").type = "checkbox";
  add<HTMLInputElement>("showHighlight", "input").type = "checkbox";
  add<HTMLInputElement>("showDefinitions", "input").type = "checkbox";
  add<HTMLInputElement>("minOccurrences", "input").type = "number";
  for (const id of [
    "sentenceFilter",
    "decisionFilter",
    "sentenceSize",
    "density",
    "sortSelect",
    "pageSize",
    "ankiDeckScope",
    "ankiNoteType",
    "ankiTargetField",
  ]) {
    add(id, "select");
  }
  for (const id of [
    "backupStatus",
    "backupFreshness",
    "resultsHeading",
    "resultStats",
    "coverageSummary",
    "coverageUniqueWords",
    "coverageKnownOccurrences",
    "coveragePercent",
    "queueHeading",
    "queueStats",
    "stickyPage",
    "bottomPage",
    "reviewHeading",
    "reviewProgress",
    "reviewContent",
    "reviewComplete",
  ]) {
    add(id, "span");
  }
  return getDomMap();
}

interface FakeController extends MinerController {
  state: AppState;
}

function makeController(): FakeController {
  const state = createInitialAppState("memory");
  return {
    state,
    subscribe(listener) {
      listener(state);
      return () => {};
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
    restoreBackup: vi.fn(async (_text: string) => {}),
    clearSavedData: vi.fn(async () => {}),
    connectAnki: vi.fn(async () => ({ decks: ["Main"], models: ["Diaz Custom Mine"] })),
    loadAnkiModelFields: vi.fn(async () => ["Target Word (no syntax)", "Back"]),
    validateAndSaveAnkiConfig: vi.fn(async () => {}),
    previewAnkiSync: vi.fn(async () => {}),
    applyAnkiSync: vi.fn(async () => {}),
    cancelAnkiSyncPreview: vi.fn(),
    clearAnkiSyncData: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Anki sync controls", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("connects, discovers fields, validates config, previews, applies, and clears", async () => {
    const dom = makeDom();
    const controller = makeController();
    const bindings = bindControls(dom, controller, { confirmAnkiClear: () => true });

    dom.ankiConnect.click();
    await flush();
    expect(controller.connectAnki).toHaveBeenCalledTimes(1);
    expect(dom.ankiDeckScope.options.length).toBe(2);
    expect(dom.ankiDeckScope.options[0]?.textContent).toBe("All decks");

    dom.ankiNoteType.value = "Diaz Custom Mine";
    dom.ankiNoteType.dispatchEvent(new Event("change"));
    await flush();
    expect(controller.loadAnkiModelFields).toHaveBeenCalledWith("Diaz Custom Mine");
    expect(dom.ankiTargetField.options.length).toBe(2);

    dom.ankiDeckScope.value = "Main";
    dom.ankiNoteType.value = "Diaz Custom Mine";
    dom.ankiTargetField.value = "Target Word (no syntax)";
    dom.ankiCheckConfig.click();
    await flush();
    expect(controller.validateAndSaveAnkiConfig).toHaveBeenCalledWith({
      deckScope: { kind: "deck", name: "Main" },
      noteType: "Diaz Custom Mine",
      targetField: "Target Word (no syntax)",
    });

    dom.ankiSyncNow.click();
    await flush();
    expect(controller.previewAnkiSync).toHaveBeenCalledTimes(1);
    dom.ankiApply.click();
    await flush();
    expect(controller.applyAnkiSync).toHaveBeenCalledTimes(1);
    dom.ankiCancelPreview.click();
    expect(controller.cancelAnkiSyncPreview).toHaveBeenCalledTimes(1);
    dom.ankiSettings.click();
    expect(dom.ankiSetup.hidden).toBe(false);
    dom.ankiClear.click();
    await flush();
    expect(controller.clearAnkiSyncData).toHaveBeenCalledTimes(1);

    bindings.dispose();
  });

  it("keeps initial setup open while unconfigured state publishes during discovery", async () => {
    const dom = makeDom();
    const controller = makeController();
    const bindings = bindControls(dom, controller);

    dom.ankiConnect.click();
    await flush();
    renderAnkiSection(dom, controller.state);

    expect(dom.ankiSetup.hidden).toBe(false);
    expect(dom.ankiSetup.dataset.editing).toBe("true");

    bindings.dispose();
  });

  it("reconnects and restores saved configuration when settings opens", async () => {
    const dom = makeDom();
    const controller = makeController();
    controller.state.anki = {
      ...controller.state.anki,
      configured: true,
      deckScopeLabel: "Main",
      noteType: "Diaz Custom Mine",
      targetField: "Target Word (no syntax)",
    };
    const bindings = bindControls(dom, controller);

    dom.ankiSettings.click();
    await flush();

    expect(controller.connectAnki).toHaveBeenCalledTimes(1);
    expect(dom.ankiDeckScope.value).toBe("Main");
    expect(dom.ankiNoteType.value).toBe("Diaz Custom Mine");
    expect(controller.loadAnkiModelFields).toHaveBeenCalledWith("Diaz Custom Mine");
    expect(dom.ankiTargetField.value).toBe("Target Word (no syntax)");

    bindings.dispose();
  });

  it("keeps settings open while configured state publishes during discovery", () => {
    const dom = makeDom();
    const controller = makeController();
    controller.state.anki = { ...controller.state.anki, configured: true };
    const bindings = bindControls(dom, controller);

    dom.ankiSettings.click();
    renderAnkiSection(dom, controller.state);

    expect(dom.ankiSetup.hidden).toBe(false);
    expect(dom.ankiSetup.dataset.editing).toBe("true");

    bindings.dispose();
  });

  it("preserves a real deck named All decks when reopening settings", async () => {
    const dom = makeDom();
    const controller = makeController();
    controller.connectAnki = vi.fn(async () => ({ decks: ["All decks"], models: ["Mine"] }));
    controller.state.anki = {
      ...controller.state.anki,
      configured: true,
      deckScopeKind: "deck",
      deckScopeLabel: "All decks",
      noteType: "Mine",
      targetField: "Word",
    };
    const bindings = bindControls(dom, controller);

    dom.ankiSettings.click();
    await flush();

    expect(dom.ankiDeckScope.value).toBe("All decks");
    expect(dom.ankiDeckScope.value).not.toBe("__all-decks__");

    bindings.dispose();
  });
});
