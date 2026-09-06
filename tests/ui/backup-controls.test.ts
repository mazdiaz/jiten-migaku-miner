// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindControls, RESTORE_CONFIRM_MESSAGE } from "../../src/ui/controls";
import { getDomMap, type DomMap } from "../../src/ui/dom";
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
  add("clearData", "button");
  add("exportBackup", "button");
  add("restoreBackup", "button");
  add("restoreBackupInput", "input").setAttribute("type", "file");
  add("backupStatus", "span");
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
  withOptions("decisionFilter", [["all", "All decisions"]]);
  withOptions("stickyDecision", [["all", "All"]]);

  add("results", "section");
  add("resultsHeading", "h2");
  add("resultStats", "p");
  add("resultsList", "div");
  add("reviewButton", "button");
  const reviewOverlay = add("reviewOverlay", "div");
  reviewOverlay.setAttribute("role", "dialog");
  const reviewPanel = add("reviewPanel", "div");
  reviewPanel.setAttribute("tabindex", "-1");
  reviewOverlay.appendChild(reviewPanel);
  for (const id of ["reviewHeading", "reviewProgress", "reviewContent", "reviewComplete", "reviewReturn", "reviewExit", "reviewKnown", "reviewMined", "reviewSkip", "reviewLater"]) {
    intoPanel(add, reviewPanel, id);
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
  add("topPrev", "button");
  add("topNext", "button");
  add("topPage", "span");
  add("bottomPrev", "button");
  add("bottomNext", "button");
  add("bottomPage", "span");

  return getDomMap();
}

function intoPanel(add: (id: string, tag: string) => HTMLElement, panel: HTMLElement, id: string): void {
  panel.appendChild(add(id, "div"));
}

interface FakeController extends MinerController {
  calls: {
    exportBackup: number;
    exportJson: string;
    restoreBackup: string[];
    restoreError: Error | null;
  };
  publishState(patch: Partial<AppState>): void;
}

function createFakeController(initial?: Partial<AppState>): FakeController {
  let state: AppState = { ...createInitialAppState("memory"), ...initial };
  const listeners = new Set<Listener>();
  const calls = {
    exportBackup: 0,
    exportJson: "{}",
    restoreBackup: [] as string[],
    restoreError: null as Error | null,
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
    updateQuery: vi.fn((_patch: Partial<QueryState>) => {}),
    updateView: vi.fn(),
    updateViewport: vi.fn(),
    changePage: vi.fn(),
    setWordDecision: vi.fn(async () => {}),
    startReview: vi.fn(async () => {}),
    stopReview: vi.fn(),
    reviewDecision: vi.fn(async () => {}),
    toggleQueued: vi.fn(),
    removeQueued: vi.fn(),
    clearQueue: vi.fn(),
    startQueueMode: vi.fn(async () => {}),
    stopQueueMode: vi.fn(),
    exportBackup: vi.fn(async () => {
      calls.exportBackup += 1;
      return calls.exportJson;
    }),
    restoreBackup: vi.fn(async (text: string) => {
      calls.restoreBackup.push(text);
      if (calls.restoreError !== null) throw calls.restoreError;
    }),
    clearSavedData: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
  };
  return controller;
}

function backupFile(text: string, name = "backup.json"): File {
  return new File([text], name, { type: "application/json" });
}

describe("backup and restore controls", () => {
  let dom: DomMap;

  beforeEach(() => {
    dom = seedDom();
  });

  it("exports a backup through the injected downloader with the dated filename", async () => {
    const controller = createFakeController();
    controller.calls.exportJson = '{"format":"jiten-migaku-miner-backup"}';
    const downloads: Array<{ filename: string; contents: string }> = [];
    bindControls(dom, controller, {
      downloadBackup: (filename, contents) => downloads.push({ filename, contents }),
    });
    const before = Date.now();

    dom.exportBackup.click();
    await vi.waitFor(() => expect(downloads).toHaveLength(1));

    const download = downloads[0]!;
    expect(download.contents).toBe('{"format":"jiten-migaku-miner-backup"}');
    const year = new Date(before).getFullYear();
    expect(download.filename).toMatch(
      new RegExp(`^jiten-migaku-miner-backup-${year}-\\d{2}-\\d{2}\\.json$`),
    );
    expect(dom.backupStatus.textContent).toBe("Backup exported.");
  });

  it("reports export failures without downloading", async () => {
    const controller = createFakeController();
    controller.exportBackup = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    const downloads: unknown[] = [];
    bindControls(dom, controller, {
      downloadBackup: (filename) => downloads.push(filename),
    });

    dom.exportBackup.click();
    await vi.waitFor(() => expect(dom.backupStatus.textContent).toContain("storage unavailable"));

    expect(downloads).toHaveLength(0);
  });

  it("opens the file picker when Restore is clicked", () => {
    const controller = createFakeController();
    bindControls(dom, controller, {});
    const clickSpy = vi.spyOn(dom.restoreBackupInput, "click");

    dom.restoreBackup.click();

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before restoring and skips restore when cancelled", async () => {
    const controller = createFakeController();
    const confirmations: string[] = [];
    bindControls(dom, controller, {
      confirmRestore: (message) => {
        confirmations.push(message);
        return false;
      },
    });

    Object.defineProperty(dom.restoreBackupInput, "files", {
      value: [backupFile("{}")],
      configurable: true,
    });
    dom.restoreBackupInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(dom.backupStatus.textContent).toBe("Restore cancelled."));

    expect(confirmations).toEqual([RESTORE_CONFIRM_MESSAGE]);
    expect(controller.calls.restoreBackup).toHaveLength(0);
  });

  it("sends the backup text to the controller and reports restored counts", async () => {
    const controller = createFakeController();
    const confirmations: string[] = [];
    bindControls(dom, controller, {
      confirmRestore: (message) => {
        confirmations.push(message);
        return true;
      },
    });
    const text = JSON.stringify({
      format: "jiten-migaku-miner-backup",
      version: 1,
      knownWords: { name: "known.txt", words: ["犬", "猫", "鳥"] },
      wordDecisions: Array.from({ length: 486 }, (_, index) => ({
        normalizedWord: `w${index}`,
        status: "mined",
        updatedAt: "2026-09-06T00:00:00.000Z",
      })),
    });
    const restoredDecisions = new Map(
      Array.from({ length: 486 }, (_, index) => [
        `w${index}`,
        { normalizedWord: `w${index}`, status: "mined" as const, updatedAt: "" },
      ]),
    );
    const inner = controller.restoreBackup.bind(controller);
    controller.restoreBackup = vi.fn(async (backupText: string) => {
      await inner(backupText);
      controller.publishState({
        knownWords: new Set(["犬", "猫", "鳥"]),
        wordDecisions: restoredDecisions,
      });
    });

    Object.defineProperty(dom.restoreBackupInput, "files", {
      value: [backupFile(text)],
      configurable: true,
    });
    dom.restoreBackupInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(controller.calls.restoreBackup).toEqual([text]));

    expect(dom.backupStatus.textContent).toBe(
      "Backup restored: 3 Migaku-known words · 486 decisions.",
    );
  });

  it("does not report success when the restore fails", async () => {
    const controller = createFakeController();
    controller.calls.restoreError = new Error("Backup could not be restored: nope");
    bindControls(dom, controller, { confirmRestore: () => true });

    Object.defineProperty(dom.restoreBackupInput, "files", {
      value: [backupFile("{}")],
      configurable: true,
    });
    dom.restoreBackupInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(controller.calls.restoreBackup).toHaveLength(1));

    expect(dom.backupStatus.textContent).toBe("");
  });

  it("clears the file input after handling a selection", async () => {
    const controller = createFakeController();
    bindControls(dom, controller, { confirmRestore: () => false });

    Object.defineProperty(dom.restoreBackupInput, "files", {
      value: [backupFile("{}")],
      configurable: true,
    });
    dom.restoreBackupInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(dom.backupStatus.textContent).toBe("Restore cancelled."));

    expect(dom.restoreBackupInput.value).toBe("");
  });

  it("ignores a change event with no selected file", () => {
    const controller = createFakeController();
    bindControls(dom, controller, {});

    Object.defineProperty(dom.restoreBackupInput, "files", {
      value: [],
      configurable: true,
    });
    dom.restoreBackupInput.dispatchEvent(new Event("change"));

    expect(controller.calls.restoreBackup).toHaveLength(0);
    expect(dom.backupStatus.textContent).toBe("");
  });
});
