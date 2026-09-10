import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMinerController,
  MAX_BACKUP_BYTES,
  type MinerControllerOptions,
} from "../../src/app/controller";
import type { AppState, MinerController } from "../../src/app/state";
import { DEFAULT_QUERY, DEFAULT_VIEW } from "../../src/app/state";
import type {
  WorkerAnkiPreviewInput,
  WorkerClient,
  WorkerCoverageInput,
  WorkerQueryInput,
} from "../../src/app/worker-client";
import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../../src/domain/anki";
import { serializeBackup } from "../../src/domain/backup";
import { computeCoverage } from "../../src/domain/coverage";
import type {
  CoverageStats,
  Entry,
  QueryResult,
  QueryState,
  ViewState,
  WordDecisionStatus,
} from "../../src/domain/types";
import type { AnkiConnectPort } from "../../src/platform/anki-connect";
import { createFileSource } from "../../src/platform/file-source";
import { createFolderSource } from "../../src/platform/folder-source";
import { createSessionQueueStore } from "../../src/platform/session-queue";
import type { AppStore, DatasetMetadata } from "../../src/storage/contracts";
import { createMemoryAppStore } from "../../src/storage/memory-store";
import type { ImportChunkResponse, ImportCompleteResponse } from "../../src/worker/protocol";

const query: QueryState = {
  search: "",
  hideKnown: false,
  hideKanaOnly: false,
  sentence: "any",
  minOccurrences: 1,
  sort: "occ-desc",
  pageSize: 50,
  page: 1,
  decision: "all",
};

const view: ViewState = {
  showFurigana: false,
  pillHighlight: false,
  showHighlight: false,
  showDefinitions: true,
  sentenceSize: "medium",
  density: "comfortable",
};

const ankiConfig: AnkiSyncConfig = {
  deckScope: { kind: "deck", name: "MAIN::Mining" },
  noteType: "Diaz Custom Mine",
  targetField: "Target Word (no syntax)",
};

const ankiSnapshot: AnkiSyncSnapshot = {
  syncedAt: "2026-09-10T10:00:00.000Z",
  statuses: [["古い", "known"]],
};

function entry(id: string, word: string, originalIndex = 0): Entry {
  return {
    id,
    originalIndex,
    word,
    normalizedWord: word,
    occurrences: 3,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
  };
}

function metadata(id: string, name = id): DatasetMetadata {
  return {
    id,
    name,
    sourceType: "file",
    sourceName: `${name}.csv`,
    headers: ["Word"],
    entryCount: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    schemaVersion: 1,
  };
}

function result(items: QueryResult["items"] = []): QueryResult {
  return {
    items,
    page: 1,
    totalPages: 1,
    totalEntries: items.length,
    startIndex: items.length ? 1 : 0,
    endIndex: items.length,
    pageSize: 50,
    knownCount: items.filter((item) => item.known).length,
    windowed: false,
  };
}

function ankiPort(): AnkiConnectPort {
  return {
    requestPermission: vi.fn(async () => {}),
    deckNames: vi.fn(async () => ["MAIN::Mining"]),
    modelNames: vi.fn(async () => ["Diaz Custom Mine"]),
    modelFieldNames: vi.fn(async () => ["Target Word (no syntax)"]),
    findCards: vi.fn(async (search: string) => (search.includes("is:new") ? [] : [1])),
    cardsInfo: vi.fn(async () => [{ cardId: 1, fields: { "Target Word (no syntax)": "古い" } }]),
  };
}

class FakeWorkerClient implements WorkerClient {
  readonly loadCalls: Array<{ datasetId: string; chunks: Entry[][] }> = [];
  readonly queryCalls: WorkerQueryInput[] = [];
  readonly events: string[] = [];
  nextJiten: {
    chunks: Entry[][];
    complete: Extract<ImportCompleteResponse, { kind: "jiten" }>;
  } | null = null;
  nextKnown: {
    chunks: string[][];
    complete: Extract<ImportCompleteResponse, { kind: "known" }>;
  } | null = null;
  importError: Error | null = null;
  knownImportError: Error | null = null;
  loadError: Error | null = null;
  queryErrors: Error[] = [];
  queryResult: QueryResult = result();
  queryHandler: ((request: WorkerQueryInput) => Promise<QueryResult>) | null = null;
  coverageErrors: Error[] = [];
  coverageEntries: readonly Entry[] = [entry("old-entry", "古い")];
  coverageHandler: ((request: WorkerCoverageInput) => Promise<CoverageStats>) | null = null;
  readonly coverageCalls: WorkerCoverageInput[] = [];
  readonly ankiPreviewCalls: WorkerAnkiPreviewInput[] = [];

  async importJiten(
    name: string,
    _text: string,
    onChunk?: (chunk: Extract<ImportChunkResponse, { kind: "jiten" }>) => void,
  ): Promise<Extract<ImportCompleteResponse, { kind: "jiten" }>> {
    this.events.push("import");
    if (this.importError) throw this.importError;
    const importing = this.nextJiten ?? {
      chunks: [[entry("new-entry", "新しい")]],
      complete: {
        protocolVersion: 2 as const,
        type: "import-complete" as const,
        requestId: "import",
        kind: "jiten" as const,
        name,
        headers: ["Word"],
        entryCount: 1,
        skippedRows: 0,
      },
    };
    importing.chunks.forEach((entries, chunkIndex) => {
      onChunk?.({
        protocolVersion: 2,
        type: "import-chunk",
        requestId: importing.complete.requestId,
        kind: "jiten",
        name,
        chunkIndex,
        entries,
      });
    });
    return { ...importing.complete, name };
  }

  async importKnown(
    name: string,
    _text: string,
    onChunk?: (chunk: Extract<ImportChunkResponse, { kind: "known" }>) => void,
  ): Promise<Extract<ImportCompleteResponse, { kind: "known" }>> {
    this.events.push("known-import");
    if (this.knownImportError) throw this.knownImportError;
    const importing = this.nextKnown ?? {
      chunks: [["新しい"]],
      complete: {
        protocolVersion: 2 as const,
        type: "import-complete" as const,
        requestId: "known-import",
        kind: "known" as const,
        name,
        wordCount: 1,
      },
    };
    importing.chunks.forEach((words, chunkIndex) => {
      onChunk?.({
        protocolVersion: 2,
        type: "import-chunk",
        requestId: importing.complete.requestId,
        kind: "known",
        name,
        chunkIndex,
        words,
      });
    });
    return { ...importing.complete, name };
  }

  async loadDataset(datasetId: string, chunks: AsyncIterable<readonly Entry[]>): Promise<void> {
    if (this.loadError) throw this.loadError;
    const loaded: Entry[][] = [];
    for await (const chunk of chunks) loaded.push([...chunk]);
    this.events.push("load");
    this.loadCalls.push({ datasetId, chunks: loaded });
  }

  async query(request: WorkerQueryInput): Promise<QueryResult> {
    this.events.push("query");
    this.queryCalls.push(request);
    const error = this.queryErrors.shift();
    if (error) throw error;
    if (this.queryHandler !== null) return this.queryHandler(request);
    return this.queryResult;
  }

  async coverage(request: WorkerCoverageInput): Promise<CoverageStats> {
    this.events.push("coverage");
    this.coverageCalls.push(request);
    const error = this.coverageErrors.shift();
    if (error) throw error;
    if (this.coverageHandler !== null) return this.coverageHandler(request);
    // Cheap real math over a configurable fixture keeps refresh assertions
    // (upward/downward/unchanged) meaningful without a worker.
    return computeCoverage(
      this.coverageEntries,
      new Set(request.knownWords),
      new Map(request.decisions ?? []),
      request.targets,
    );
  }

  async previewAnkiMatch(request: WorkerAnkiPreviewInput) {
    this.ankiPreviewCalls.push(request);
    return { matchedWords: 1, knownCount: 1, minedCount: 0, manualProtected: 0 };
  }

  dispose(): void {
    this.events.push("dispose");
  }
}

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function seedActive(store: AppStore, id = "old-dataset"): Promise<void> {
  await store.datasets.stage(
    metadata(id),
    (async function* () {
      yield [entry("old-entry", "古い")];
    })(),
  );
  await store.datasets.activate(id);
}

function controllerOptions(
  store: AppStore,
  worker: FakeWorkerClient,
  storage?: Storage,
  ankiConnect?: AnkiConnectPort,
): MinerControllerOptions {
  return {
    store,
    worker,
    legacyStorage: storage ?? new TestStorage(),
    ...(ankiConnect === undefined ? {} : { ankiConnect }),
  };
}

function flakyAppStore(inner: AppStore, shouldFail: () => boolean): AppStore {
  const failure = () => new DOMException("simulated late storage failure", "SecurityError");
  // Methods are bound to their owner objects; detaching them would lose `this`
  // and turn every call into a spurious fallback-triggering failure.
  const guard =
    <A extends unknown[], R>(operation: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (shouldFail()) throw failure();
      return operation(...args);
    };
  const guardIterable = <A extends unknown[], R>(operation: (...args: A) => AsyncIterable<R>) =>
    async function* (...args: A): AsyncGenerator<R> {
      if (shouldFail()) throw failure();
      yield* operation(...args);
    };
  return {
    datasets: {
      stage: guard(inner.datasets.stage.bind(inner.datasets)),
      activate: guard(inner.datasets.activate.bind(inner.datasets)),
      getActive: guard(inner.datasets.getActive.bind(inner.datasets)),
      list: guard(inner.datasets.list.bind(inner.datasets)),
      readChunks: guardIterable(inner.datasets.readChunks.bind(inner.datasets)),
      remove: guard(inner.datasets.remove.bind(inner.datasets)),
    },
    knownWords: {
      save: guard(inner.knownWords.save.bind(inner.knownWords)),
      getActive: guard(inner.knownWords.getActive.bind(inner.knownWords)),
    },
    wordDecisions: {
      get: guard(inner.wordDecisions.get.bind(inner.wordDecisions)),
      list: guard(inner.wordDecisions.list.bind(inner.wordDecisions)),
      set: guard(inner.wordDecisions.set.bind(inner.wordDecisions)),
      remove: guard(inner.wordDecisions.remove.bind(inner.wordDecisions)),
      replaceAll: guard(inner.wordDecisions.replaceAll.bind(inner.wordDecisions)),
    },
    preferences: {
      load: guard(inner.preferences.load.bind(inner.preferences)),
      save: guard(inner.preferences.save.bind(inner.preferences)),
    },
    ankiSync: {
      loadConfig: guard(inner.ankiSync.loadConfig.bind(inner.ankiSync)),
      saveConfig: guard(inner.ankiSync.saveConfig.bind(inner.ankiSync)),
      loadSnapshot: guard(inner.ankiSync.loadSnapshot.bind(inner.ankiSync)),
      replaceSnapshot: guard(inner.ankiSync.replaceSnapshot.bind(inner.ankiSync)),
      clear: async () => {
        if (shouldFail()) throw failure();
        await inner.ankiSync.clear();
      },
    },
    clearAll: guard(inner.clearAll.bind(inner)),
    ...(inner.restoreUserState !== undefined
      ? { restoreUserState: guard(inner.restoreUserState.bind(inner)) }
      : {}),
  };
}

function createDelayedAppStore(
  inner: AppStore,
  options: { forwardRestoreUserState?: boolean } = {},
): {
  store: AppStore;
  started(method: string): Promise<void>;
  release(method: string): void;
  gate(method: string): void;
  failNext(method: string): void;
} {
  interface GateState {
    blocking: boolean;
    failNext: boolean;
    startedWaiters: Array<() => void>;
    releaseWaiter: (() => void) | null;
  }
  const gates = new Map<string, GateState>();
  const gateState = (method: string): GateState => {
    const existing = gates.get(method);
    if (existing !== undefined) return existing;
    const created: GateState = {
      blocking: false,
      failNext: false,
      startedWaiters: [],
      releaseWaiter: null,
    };
    gates.set(method, created);
    return created;
  };
  const gate = (method: string): void => {
    gateState(method).blocking = true;
  };
  const failNext = (method: string): void => {
    gateState(method).failNext = true;
  };
  const started = (method: string): Promise<void> =>
    new Promise((resolve) => {
      gateState(method).startedWaiters.push(resolve);
    });
  const release = (method: string): void => {
    const state = gates.get(method);
    if (state === undefined) return;
    const waiter = state.releaseWaiter;
    state.releaseWaiter = null;
    waiter?.();
  };
  // Methods are bound to their owner objects; detaching them would lose `this`
  // and turn every call into a spurious fallback-triggering failure.
  const delay =
    <A extends unknown[], R>(method: string, operation: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const state = gates.get(method);
      if (state !== undefined && (state.blocking || state.failNext)) {
        const shouldFail = state.failNext;
        state.failNext = false;
        if (state.blocking) {
          state.blocking = false;
          for (const waiter of state.startedWaiters.splice(0)) waiter();
          await new Promise<void>((resolve) => {
            state.releaseWaiter = resolve;
          });
        }
        if (shouldFail) throw new Error(`${method} failed as requested`);
      }
      return operation(...args);
    };
  const delayIterable = <A extends unknown[], R>(operation: (...args: A) => AsyncIterable<R>) =>
    async function* (...args: A): AsyncGenerator<R> {
      yield* operation(...args);
    };
  return {
    store: {
      datasets: {
        stage: delay("datasets.stage", inner.datasets.stage.bind(inner.datasets)),
        activate: delay("datasets.activate", inner.datasets.activate.bind(inner.datasets)),
        getActive: delay("datasets.getActive", inner.datasets.getActive.bind(inner.datasets)),
        list: delay("datasets.list", inner.datasets.list.bind(inner.datasets)),
        readChunks: delayIterable(inner.datasets.readChunks.bind(inner.datasets)),
        remove: delay("datasets.remove", inner.datasets.remove.bind(inner.datasets)),
      },
      knownWords: {
        save: delay("knownWords.save", inner.knownWords.save.bind(inner.knownWords)),
        getActive: delay("knownWords.getActive", inner.knownWords.getActive.bind(inner.knownWords)),
      },
      wordDecisions: {
        get: delay("wordDecisions.get", inner.wordDecisions.get.bind(inner.wordDecisions)),
        list: delay("wordDecisions.list", inner.wordDecisions.list.bind(inner.wordDecisions)),
        set: delay("wordDecisions.set", inner.wordDecisions.set.bind(inner.wordDecisions)),
        remove: delay("wordDecisions.remove", inner.wordDecisions.remove.bind(inner.wordDecisions)),
        replaceAll: delay(
          "wordDecisions.replaceAll",
          inner.wordDecisions.replaceAll.bind(inner.wordDecisions),
        ),
      },
      preferences: {
        load: delay("preferences.load", inner.preferences.load.bind(inner.preferences)),
        save: delay("preferences.save", inner.preferences.save.bind(inner.preferences)),
      },
      ankiSync: {
        loadConfig: delay("ankiSync.loadConfig", inner.ankiSync.loadConfig.bind(inner.ankiSync)),
        saveConfig: delay("ankiSync.saveConfig", inner.ankiSync.saveConfig.bind(inner.ankiSync)),
        loadSnapshot: delay(
          "ankiSync.loadSnapshot",
          inner.ankiSync.loadSnapshot.bind(inner.ankiSync),
        ),
        replaceSnapshot: delay(
          "ankiSync.replaceSnapshot",
          inner.ankiSync.replaceSnapshot.bind(inner.ankiSync),
        ),
        clear: delay("ankiSync.clear", async () => {
          await inner.ankiSync.clear();
        }),
      },
      clearAll: delay("clearAll", inner.clearAll.bind(inner)),
      ...(options.forwardRestoreUserState === false || inner.restoreUserState === undefined
        ? {}
        : {
            restoreUserState: delay("restoreUserState", inner.restoreUserState.bind(inner)),
          }),
    },
    started,
    release,
    gate,
    failNext,
  };
}

describe("MinerController", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  it("restores active records, loads worker, queries, and publishes isolated snapshots", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.knownWords.save("known", "known.txt", ["古い"]);
    await store.preferences.save({
      query: { ...query, page: 2 },
      view,
      page: 2,
    });
    const worker = new FakeWorkerClient();
    worker.queryResult = { ...result(), page: 2, totalPages: 2 };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    const ready = states.at(-1)!;
    expect(ready).toMatchObject({
      dataset: metadata("old-dataset"),
      query: { ...query, page: 2 },
      status: "ready",
      persistence: "memory",
    });
    expect(ready.knownWords).toEqual(new Set(["古い"]));
    expect(worker.loadCalls[0]).toMatchObject({ datasetId: "old-dataset" });
    expect(worker.queryCalls[0]).toMatchObject({
      datasetId: "old-dataset",
      knownWords: ["古い"],
    });

    controller.updateView({ showDefinitions: false });
    expect(states[0]?.view.showDefinitions).toBe(true);
    expect(states.at(-1)?.view.showDefinitions).toBe(false);
    expect(states[0]).not.toBe(states.at(-1));
  });

  it("keeps saved Anki classifications active when Anki is unavailable", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.ankiSync.saveConfig(ankiConfig);
    await store.ankiSync.replaceSnapshot(ankiSnapshot);
    const worker = new FakeWorkerClient();
    worker.queryResult = result([
      {
        ...entry("old-entry", "古い"),
        known: true,
        knownByMigaku: false,
        knownByDecision: false,
        knownByAnki: true,
        decision: "known",
        decisionSource: "anki",
      },
    ]);
    const port = ankiPort();
    vi.mocked(port.requestPermission).mockRejectedValue(new Error("Anki is not running"));
    const controller = createMinerController(controllerOptions(store, worker, undefined, port));
    let latest: Readonly<AppState> | null = null;
    controller.subscribe((state) => {
      latest = state;
    });

    await controller.init();

    expect(latest?.anki.wordCount).toBe(1);
    expect(latest?.result?.items[0]?.decisionSource).toBe("anki");
    expect(worker.queryCalls[0]?.ankiStatuses).toEqual(ankiSnapshot.statuses);
    expect(port.requestPermission).not.toHaveBeenCalled();
  });

  it("forwards Anki state through normal, preview, apply, hide-known, and review flows", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const port = ankiPort();
    const controller = createMinerController(controllerOptions(store, worker, undefined, port));
    await controller.init();

    await controller.validateAndSaveAnkiConfig(ankiConfig);
    await controller.previewAnkiSync();
    await controller.applyAnkiSync();
    expect(worker.ankiPreviewCalls[0]?.ankiStatuses).toEqual([["古い", "known"]]);
    expect(worker.queryCalls.at(-1)?.ankiStatuses).toEqual([["古い", "known"]]);

    controller.updateQuery({ hideKnown: true });
    await flushMicrotasks();
    expect(worker.queryCalls.at(-1)).toMatchObject({
      ankiStatuses: [["古い", "known"]],
      query: { hideKnown: true },
    });

    await controller.startReview();
    const reviewQuery = worker.queryCalls.find((request) => request.queryChannel === "review");
    expect(reviewQuery).toMatchObject({
      ankiStatuses: [["古い", "known"]],
      query: { decision: "unreviewed", hideKnown: true },
    });
  });

  it("fills display-preference defaults when stored preferences predate the fields", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    // A preference record written before the display controls shipped lacks
    // sentenceSize/density entirely; initialize must restore it to defaults.
    const legacyView = { ...view } as Partial<ViewState>;
    delete legacyView.sentenceSize;
    delete legacyView.density;
    await store.preferences.save({
      query: { ...query, page: 1 },
      view: legacyView as ViewState,
      page: 1,
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    const final = states.at(-1)!;
    expect(final.view.sentenceSize).toBe("medium");
    expect(final.view.density).toBe("comfortable");
    expect(final.view.showDefinitions).toBe(true);
  });

  it("persists and restores the display preferences through updateView", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    controller.updateView({ sentenceSize: "large", density: "compact" });
    // persistPreferences is fire-and-forget; flush the lock chain before reading the store.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states.at(-1)?.view.sentenceSize).toBe("large");
    expect(states.at(-1)?.view.density).toBe("compact");
    const saved = await store.preferences.load();
    expect(saved?.view.sentenceSize).toBe("large");
    expect(saved?.view.density).toBe("compact");
  });

  it("rejects persisted datasets whose stored entry count is incomplete", async () => {
    const store = createMemoryAppStore();
    const broken = metadata("broken-dataset");
    broken.entryCount = 2;
    await store.datasets.stage(
      broken,
      (async function* () {
        yield [entry("only-entry", "一つ")];
      })(),
    );
    await store.datasets.activate(broken.id);
    const worker = new FakeWorkerClient();
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    expect(states.at(-1)?.status).toBe("error");
    expect(states.at(-1)?.errorMessage).toContain("count");
    expect(worker.queryCalls).toHaveLength(0);
  });

  it("keeps current dataset and visible data when replacement import fails", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.preferences.save({
      query: { ...query, page: 2 },
      view,
      page: 2,
    });
    const worker = new FakeWorkerClient();
    worker.importError = new Error("bad replacement");
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();
    const before = states.at(-1)!;

    await controller.importJiten({
      name: "broken.csv",
      text: async () => "broken",
    });

    const after = states.at(-1)!;
    expect(after.dataset).toEqual(before.dataset);
    expect(after.knownWords).toEqual(before.knownWords);
    expect(after.query).toEqual(before.query);
    expect(after.view).toEqual(before.view);
    expect(after.status).toBe("error");
    expect(after.errorMessage).toContain("bad replacement");
    expect(await store.datasets.getActive()).toEqual(metadata("old-dataset"));
    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["old-dataset"]);
  });

  it("stages replacement before activation and resets page after success", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.preferences.save({
      query: { ...query, page: 2 },
      view,
      page: 2,
    });
    const worker = new FakeWorkerClient();
    worker.nextJiten = {
      chunks: [[entry("new-entry", "新しい")]],
      complete: {
        protocolVersion: 2,
        type: "import-complete",
        requestId: "import-new",
        kind: "jiten",
        name: "new.csv",
        headers: ["Word"],
        entryCount: 1,
        skippedRows: 0,
      },
    };
    const order: string[] = [];
    const originalStage = store.datasets.stage.bind(store.datasets);
    const originalActivate = store.datasets.activate.bind(store.datasets);
    store.datasets.stage = async (...args) => {
      order.push("stage");
      return originalStage(...args);
    };
    store.datasets.activate = async (...args) => {
      order.push("activate");
      return originalActivate(...args);
    };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    const active = await store.datasets.getActive();
    expect(order).toEqual(["stage", "activate"]);
    expect(active?.sourceName).toBe("new.csv");
    expect(states.at(-1)).toMatchObject({
      dataset: active,
      query: { page: 1 },
      status: "ready",
      errorMessage: null,
    });
    expect(worker.loadCalls.at(-1)?.datasetId).toBe(active?.id);
    expect(worker.queryCalls).toHaveLength(3);
    expect(worker.queryCalls[0]?.queryChannel).toBe("user");
    expect(worker.queryCalls[1]).toMatchObject({
      datasetId: active?.id,
      queryChannel: "candidate",
    });
    expect(worker.queryCalls[2]).toMatchObject({
      datasetId: active?.id,
      queryChannel: "user",
    });
  });

  it("refreshes the user query on the activated dataset after committing a replacement", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const originalImport = worker.importJiten.bind(worker);
    let releaseImport: (() => void) | undefined;
    let importStarted: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const importReady = new Promise<void>((resolve) => {
      importStarted = resolve;
    });
    worker.importJiten = async (name, text, onChunk) => {
      importStarted?.();
      await importGate;
      return originalImport(name, text, onChunk);
    };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    const importing = controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });
    await importReady;
    controller.updateQuery({ search: "最新" });
    releaseImport?.();
    await importing;

    const active = await store.datasets.getActive();
    expect(worker.queryCalls.at(-1)).toMatchObject({
      datasetId: active?.id,
      queryChannel: "user",
    });
    expect(worker.queryCalls.at(-1)?.query.search).toBe("最新");
    expect(states.at(-1)?.dataset?.id).toBe(active?.id);
    expect(states.at(-1)?.query.search).toBe("最新");
  });

  it("restores the previous known-word record when verification fails", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.knownWords.save("old-known", "old.txt", ["古い"]);
    const originalSave = store.knownWords.save.bind(store.knownWords);
    let corrupted = false;
    store.knownWords.save = async (id, name, words) => {
      if (!corrupted) {
        corrupted = true;
        return originalSave(id, name, ["別の語"]);
      }
      return originalSave(id, name, words);
    };
    const worker = new FakeWorkerClient();
    worker.nextKnown = {
      chunks: [["新しい"]],
      complete: {
        protocolVersion: 2,
        type: "import-complete",
        requestId: "known-new",
        kind: "known",
        name: "known.txt",
        wordCount: 1,
      },
    };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importKnown({
      name: "known.txt",
      text: async () => "新しい\n",
    });

    expect(states.at(-1)?.status).toBe("error");
    expect(states.at(-1)?.knownWords).toEqual(new Set(["古い"]));
    const active = await store.knownWords.getActive();
    expect(active?.id).toBe("old-known");
    expect(active?.words).toEqual(new Set(["古い"]));
  });

  it("keeps active dataset unchanged when staged replacement cannot load into worker", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();
    worker.loadError = new Error("worker load failed");

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    expect(await store.datasets.getActive()).toEqual(metadata("old-dataset"));
    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["old-dataset"]);
    expect(states.at(-1)?.dataset).toEqual(metadata("old-dataset"));
    expect(states.at(-1)?.errorMessage).toContain("worker load failed");
  });

  it("queries replacement before committing and preserves previous result after query failure", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    worker.queryResult = { ...result(), totalPages: 2 };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();
    worker.queryErrors.push(new Error("candidate query failed"));

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    expect(await store.datasets.getActive()).toEqual(metadata("old-dataset"));
    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["old-dataset"]);
    expect(states.at(-1)?.dataset).toEqual(metadata("old-dataset"));
    expect(states.at(-1)?.query.page).toBe(1);

    controller.changePage(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.queryCalls.at(-1)).toMatchObject({
      datasetId: "old-dataset",
      query: { page: 2 },
    });
  });

  it("cleans stale replacement candidates after a later import supersedes them", async () => {
    const store = createMemoryAppStore();
    const worker = new FakeWorkerClient();
    const originalLoad = worker.loadDataset.bind(worker);
    let releaseFirstLoad: (() => void) | undefined;
    let firstLoadStarted: (() => void) | undefined;
    const firstLoad = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    const firstLoadReady = new Promise<void>((resolve) => {
      firstLoadStarted = resolve;
    });
    let isFirstLoad = true;
    worker.loadDataset = async (datasetId, chunks) => {
      if (isFirstLoad) {
        isFirstLoad = false;
        firstLoadStarted?.();
        await firstLoad;
      }
      return originalLoad(datasetId, chunks);
    };
    const originalQuery = worker.query.bind(worker);
    worker.query = async (request) => {
      if (request.datasetId === "dataset-1") throw new Error("stale candidate query failed");
      return originalQuery(request);
    };
    let nextDatasetId = 0;
    const controller = createMinerController({
      store,
      worker,
      legacyStorage: new TestStorage(),
      createId: (kind) => (kind === "dataset" ? `dataset-${++nextDatasetId}` : "known-1"),
    });

    const first = controller.importJiten({
      name: "first.csv",
      text: async () => "Word\n一つ",
    });
    await firstLoadReady;
    const second = controller.importJiten({
      name: "second.csv",
      text: async () => "Word\n二つ",
    });
    releaseFirstLoad?.();
    await Promise.all([first, second]);

    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["dataset-2"]);
    expect((await store.datasets.getActive())?.id).toBe("dataset-2");
  });

  it("does not publish a stale replacement after activation yields to a newer import", async () => {
    const store = createMemoryAppStore();
    const worker = new FakeWorkerClient();
    let releaseFirstActivation: (() => void) | undefined;
    let firstActivationStarted: (() => void) | undefined;
    const firstActivation = new Promise<void>((resolve) => {
      releaseFirstActivation = resolve;
    });
    const firstActivationReady = new Promise<void>((resolve) => {
      firstActivationStarted = resolve;
    });
    const originalActivate = store.datasets.activate.bind(store.datasets);
    store.datasets.activate = async (datasetId) => {
      if (datasetId === "dataset-1") {
        firstActivationStarted?.();
        await firstActivation;
      }
      return originalActivate(datasetId);
    };
    const states: Readonly<AppState>[] = [];
    const controller = createMinerController({
      store,
      worker,
      legacyStorage: new TestStorage(),
      createId: (kind) => (kind === "dataset" ? `dataset-${nextDatasetId++}` : "known-1"),
    });
    let nextDatasetId = 1;
    controller.subscribe((state) => states.push(state));

    const first = controller.importJiten({
      name: "first.csv",
      text: async () => "Word\n一つ",
    });
    await firstActivationReady;
    const second = controller.importJiten({
      name: "second.csv",
      text: async () => "Word\n二つ",
    });
    releaseFirstActivation?.();
    await Promise.all([first, second]);

    expect(states.some((state) => state.dataset?.id === "dataset-1")).toBe(false);
    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["dataset-2"]);
    expect((await store.datasets.getActive())?.id).toBe("dataset-2");
  });

  it("rejects replacement when received entry count differs from completion metadata", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    worker.nextJiten = {
      chunks: [[entry("new-entry", "新しい")]],
      complete: {
        protocolVersion: 2,
        type: "import-complete",
        requestId: "import-count",
        kind: "jiten",
        name: "new.csv",
        headers: ["Word"],
        entryCount: 2,
        skippedRows: 0,
      },
    };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    expect(await store.datasets.getActive()).toEqual(metadata("old-dataset"));
    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["old-dataset"]);
    expect(states.at(-1)?.errorMessage).toContain("count");
  });

  it("saves known-word imports and sends words for known-status queries", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    worker.nextKnown = {
      chunks: [["古い"]],
      complete: {
        protocolVersion: 2,
        type: "import-complete",
        requestId: "known-new",
        kind: "known",
        name: "known.txt",
        wordCount: 1,
      },
    };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importKnown({
      name: "known.txt",
      text: async () => "古い\n",
    });

    expect(states.at(-1)?.knownWords).toEqual(new Set(["古い"]));
    expect(worker.queryCalls.at(-1)?.knownWords).toEqual(["古い"]);
    expect(worker.queryCalls.at(-1)?.query.hideKnown).toBe(true);
    expect((await store.knownWords.getActive())?.words).toEqual(new Set(["古い"]));
  });

  it("rejects known-word imports when saved contents differ despite matching size", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.knownWords.save("old-known", "old.txt", ["古い"]);
    const originalSave = store.knownWords.save.bind(store.knownWords);
    store.knownWords.save = async (id, name) => originalSave(id, name, ["別の語"]);
    const worker = new FakeWorkerClient();
    worker.nextKnown = {
      chunks: [["新しい"]],
      complete: {
        protocolVersion: 2,
        type: "import-complete",
        requestId: "known-new",
        kind: "known",
        name: "known.txt",
        wordCount: 1,
      },
    };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importKnown({
      name: "known.txt",
      text: async () => "新しい\n",
    });

    expect(states.at(-1)?.status).toBe("error");
    expect(states.at(-1)?.errorMessage).toContain("verification");
  });

  it("falls back to memory persistence with visible warning when IndexedDB fails", async () => {
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      worker,
      legacyStorage: new TestStorage(),
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    expect(states.at(-1)?.persistence).toBe("memory");
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: original,
    });
  });

  it("switches to memory and keeps warning after a later IndexedDB stage failure", async () => {
    const failingStore = createMemoryAppStore();
    failingStore.datasets.stage = async () => {
      throw new DOMException("IndexedDB stage failed", "SecurityError");
    };
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      indexedDbStoreFactory: () => failingStore,
      worker,
      legacyStorage: new TestStorage(),
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    expect(states.at(-1)?.persistence).toBe("memory");
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
    controller.updateView({ showDefinitions: false });
    await Promise.resolve();
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
  });

  it("switches to memory when preference persistence fails after initialization", async () => {
    const failingStore = createMemoryAppStore();
    failingStore.preferences.save = async () => {
      throw new DOMException("IndexedDB preferences failed", "SecurityError");
    };
    const controller = createMinerController({
      indexedDbStoreFactory: () => failingStore,
      worker: new FakeWorkerClient(),
      legacyStorage: new TestStorage(),
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    expect(states.at(-1)?.persistence).toBe("memory");
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
  });

  it("preserves known words and decisions in exports after a late storage failure", async () => {
    const inner = createMemoryAppStore();
    let failing = false;
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      indexedDbStoreFactory: () => flakyAppStore(inner, () => failing),
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
    });
    await controller.init();

    await controller.importKnown({
      name: "known.txt",
      text: async () => "新しい\n",
    });
    failing = true;
    await controller.setWordDecision("新しい", "known").catch(() => undefined);
    failing = false;

    const backup = JSON.parse(await controller.exportBackup());
    expect(backup.knownWords).not.toBeNull();
    expect(backup.knownWords.words).toContain("新しい");
    // The retried decision write succeeds against the replacement store, so the
    // export reflects the real post-fallback state; nothing is fabricated.
    expect(backup.wordDecisions.map((d: { normalizedWord: string }) => d.normalizedWord)).toEqual([
      "新しい",
    ]);
  });

  it("clears abandoned persistent data and keeps fallback warning after clear", async () => {
    const persistent = createMemoryAppStore();
    await seedActive(persistent);
    persistent.datasets.stage = async () => {
      throw new DOMException("persistent stage failed", "SecurityError");
    };
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      indexedDbStoreFactory: () => persistent,
      worker,
      legacyStorage: new TestStorage(),
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });
    await controller.clearSavedData();

    expect(await persistent.datasets.getActive()).toBeNull();
    expect(await persistent.datasets.list()).toEqual([]);
    expect(states.at(-1)?.persistence).toBe("memory");
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
  });

  it("reports partial clear failure in final state", async () => {
    const failing = flakyAppStore(createMemoryAppStore(), () => true);
    const controller = createMinerController({
      store: failing,
      worker: new FakeWorkerClient(),
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init().catch(() => undefined);

    await controller.clearSavedData();

    expect(states.at(-1)?.wordDecisions.size).toBe(0);
    expect(states.at(-1)?.errorMessage).toMatch(/could not be fully cleared/i);
  });

  it("preserves a newer user query when candidate query failure rolls back import", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    let candidateStarted: (() => void) | undefined;
    let rejectCandidate: ((reason: unknown) => void) | undefined;
    const candidateReady = new Promise<void>((resolve) => {
      candidateStarted = resolve;
    });
    worker.queryHandler = async (request) => {
      if (request.datasetId === "candidate") {
        candidateStarted?.();
        return new Promise<QueryResult>((_resolve, reject) => {
          rejectCandidate = reject;
        });
      }
      return result();
    };
    const controller = createMinerController({
      store,
      worker,
      legacyStorage: new TestStorage(),
      createId: (kind) => (kind === "dataset" ? "candidate" : "known-1"),
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    const importing = controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });
    await candidateReady;
    controller.updateQuery({ search: "最新" });
    rejectCandidate?.(new Error("candidate query superseded"));
    await importing;
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)?.dataset).toEqual(metadata("old-dataset"));
    expect(states.at(-1)?.query.search).toBe("最新");
    expect(states.at(-1)?.errorMessage).toContain("candidate query superseded");
  });

  it("retries legacy migration in memory after a later persistence failure", async () => {
    const failingStore = createMemoryAppStore();
    failingStore.datasets.stage = async () => {
      throw new DOMException("IndexedDB migration stage failed", "SecurityError");
    };
    const storage = new TestStorage();
    storage.setItem(
      "jitenMiner.v1",
      JSON.stringify({ mediaFileName: "legacy.csv", mediaText: "Word\n猫" }),
    );
    const controller = createMinerController({
      indexedDbStoreFactory: () => failingStore,
      worker: new FakeWorkerClient(),
      legacyStorage: storage,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    expect(states.at(-1)?.persistence).toBe("memory");
    expect(states.at(-1)?.dataset?.sourceName).toBe("legacy.csv");
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
    // Memory fallback is not durable: no completion marker, so a later reload
    // with working storage retries the migration instead of skipping it.
    expect(storage.getItem("jitenMiner.migration")).toBeNull();
  });

  it("requests viewport windows for all-results queries and scrolls without status flashes", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    worker.queryResult = {
      ...result(),
      pageSize: "all",
      totalEntries: 10_000,
      startIndex: 1,
      endIndex: 100,
      windowed: true,
    };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    controller.updateQuery({ pageSize: "all" });
    await flushMicrotasks();
    expect(worker.queryCalls.at(-1)?.window).toEqual({ start: 0, size: 100 });

    controller.updateViewport(4_500);
    await flushMicrotasks();
    expect(worker.queryCalls.at(-1)?.window).toEqual({
      start: 4_500,
      size: 100,
    });
    expect(worker.queryCalls.at(-1)?.query.pageSize).toBe("all");
    expect(states.at(-1)?.status).toBe("ready");

    controller.updateQuery({ search: "最新" });
    await flushMicrotasks();
    expect(worker.queryCalls.at(-1)?.window).toEqual({ start: 0, size: 100 });
  });

  it("ignores viewport updates while a numeric page size is active", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const controller = createMinerController(controllerOptions(store, worker));
    await controller.init();
    const before = worker.queryCalls.length;

    controller.updateViewport(900);

    expect(worker.queryCalls.length).toBe(before);
    expect(worker.queryCalls.at(-1)?.window).toBeUndefined();
    expect(worker.queryCalls.at(-1)?.query.pageSize).not.toBe("all");
  });

  it("clamps viewport starts to the known result total", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    worker.queryResult = {
      ...result(),
      pageSize: "all",
      totalEntries: 250,
      startIndex: 1,
      endIndex: 100,
      windowed: true,
    };
    const controller = createMinerController(controllerOptions(store, worker));
    await controller.init();

    controller.updateQuery({ pageSize: "all" });
    await flushMicrotasks();
    controller.updateViewport(10_000);
    await flushMicrotasks();

    expect(worker.queryCalls.at(-1)?.window).toEqual({ start: 249, size: 100 });
  });
});

function responseLike(
  url: string,
  body: string,
  options: { ok?: boolean; lastModified?: string } = {},
): Response {
  return {
    ok: options.ok ?? true,
    redirected: false,
    url,
    headers: new Headers(
      options.lastModified ? { "Last-Modified": options.lastModified } : undefined,
    ),
    text: async () => body,
  } as Response;
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

const FIXED_NOW = "2026-09-05T00:00:00.000Z";

function decisionOptions(
  store: AppStore,
  worker: FakeWorkerClient,
  storage?: Storage,
): MinerControllerOptions {
  return { ...controllerOptions(store, worker, storage), now: () => FIXED_NOW };
}

describe("MinerController word decisions", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  it("restores persisted decisions on initialization and defaults missing preference decision to all", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({
      normalizedWord: "猫",
      status: "known",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    await store.wordDecisions.set({
      normalizedWord: "犬",
      status: "later",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const legacyQuery: Record<string, unknown> = { ...query };
    delete legacyQuery.decision;
    await store.preferences.save({
      query: legacyQuery as unknown as QueryState,
      view,
      page: 1,
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    const final = states.at(-1)!;
    expect(final.wordDecisions.get("猫")).toMatchObject({ status: "known" });
    expect(final.wordDecisions.get("犬")).toMatchObject({ status: "later" });
    expect(final.query.decision).toBe("all");
    expect(worker.queryCalls[0]?.decisions).toEqual(
      expect.arrayContaining([
        ["猫", "known"],
        ["犬", "later"],
      ]),
    );
  });

  it("marks known, persists the record, and sends the decision on the next query", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.setWordDecision("猫", "known");

    expect(await store.wordDecisions.get("猫")).toEqual({
      normalizedWord: "猫",
      status: "known",
      updatedAt: FIXED_NOW,
    });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({
      status: "known",
    });
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "known"]]);
  });

  it("marks mined without making the entry known", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.setWordDecision("猫", "mined");

    expect(await store.wordDecisions.get("猫")).toMatchObject({
      status: "mined",
    });
    expect(states.at(-1)?.knownWords.size).toBe(0);
    expect(worker.queryCalls.at(-1)?.knownWords).toEqual([]);
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "mined"]]);
  });

  it("removes the store record when resetting to unreviewed", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({
      normalizedWord: "猫",
      status: "known",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.setWordDecision("猫", "unreviewed");
    await expect(controller.setWordDecision("", "known")).rejects.toThrow();

    expect(await store.wordDecisions.get("猫")).toBeNull();
    expect(states.at(-1)?.wordDecisions.has("猫")).toBe(false);
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([]);
  });

  it("keeps prior state and surfaces an error when the decision write fails", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    store.wordDecisions.set = async () => {
      throw new Error("decision write failed");
    };
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.setWordDecision("猫", "known");

    const final = states.at(-1)!;
    expect(final.wordDecisions.has("猫")).toBe(false);
    expect(await store.wordDecisions.get("猫")).toBeNull();
    expect(final.status).toBe("ready");
    expect(final.errorMessage).toContain("decision write failed");
  });

  it("keeps decisions when a new Jiten CSV is imported", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({
      normalizedWord: "猫",
      status: "known",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    expect(await store.wordDecisions.get("猫")).toMatchObject({
      status: "known",
    });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({
      status: "known",
    });
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "known"]]);
  });

  it("keeps decisions when the Migaku known file is replaced", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({
      normalizedWord: "猫",
      status: "mined",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const worker = new FakeWorkerClient();
    worker.nextKnown = {
      chunks: [["犬"]],
      complete: {
        protocolVersion: 2,
        type: "import-complete",
        requestId: "known-new",
        kind: "known",
        name: "known.txt",
        wordCount: 1,
      },
    };
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importKnown({
      name: "known.txt",
      text: async () => "犬\n",
    });

    expect(await store.wordDecisions.get("猫")).toMatchObject({
      status: "mined",
    });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({
      status: "mined",
    });
    expect(states.at(-1)?.knownWords).toEqual(new Set(["犬"]));
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "mined"]]);
  });

  it("removes decisions when saved data is cleared", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({
      normalizedWord: "猫",
      status: "known",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.clearSavedData();

    expect(await store.wordDecisions.list()).toEqual([]);
    expect(states.at(-1)?.wordDecisions.size).toBe(0);
  });

  it("preserves the current page when the changed row stays in the result set", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.preferences.save({
      query: { ...query, page: 2 },
      view,
      page: 2,
    });
    const worker = new FakeWorkerClient();
    worker.queryResult = {
      ...result(),
      page: 2,
      totalPages: 2,
      totalEntries: 100,
    };
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.setWordDecision("猫", "known");

    expect(states.at(-1)?.query.page).toBe(2);
    expect(worker.queryCalls.at(-1)?.query.page).toBe(2);
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "known"]]);
  });

  it("clamps the page when the decision filter drops the last item on the last page", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.preferences.save({
      query: { ...query, page: 2 },
      view,
      page: 2,
    });
    const worker = new FakeWorkerClient();
    worker.queryHandler = async (request) => {
      if ((request.decisions ?? []).some(([word]) => word === "猫")) {
        return { ...result(), page: 1, totalPages: 1, totalEntries: 50 };
      }
      return { ...result(), page: 2, totalPages: 2, totalEntries: 100 };
    };
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();
    expect(states.at(-1)?.query.page).toBe(2);

    await controller.setWordDecision("猫", "known");

    expect(states.at(-1)?.query.page).toBe(1);
    expect(worker.queryCalls.at(-1)?.query.page).toBe(2);
  });

  it("resolves rapid clicks deterministically in submission order", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await Promise.all([
      controller.setWordDecision("猫", "known"),
      controller.setWordDecision("猫", "mined"),
    ]);

    expect(await store.wordDecisions.get("猫")).toMatchObject({
      status: "mined",
      updatedAt: FIXED_NOW,
    });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({
      status: "mined",
    });
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "mined"]]);
  });
});

describe("MinerController one-step undo", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  function undoSetup(): {
    store: ReturnType<typeof createMemoryAppStore>;
    worker: FakeWorkerClient;
    controller: ReturnType<typeof createMinerController>;
    states: Readonly<AppState>[];
  } {
    const store = createMemoryAppStore();
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    return { store, worker, controller, states };
  }

  async function readyUndoSetup(): Promise<ReturnType<typeof undoSetup>> {
    const env = undoSetup();
    await seedActive(env.store);
    await env.controller.init();
    return env;
  }

  it("undoes a known decision back to unreviewed in state and store", async () => {
    const { store, worker, controller, states } = await readyUndoSetup();
    await controller.setWordDecision("猫", "known");

    await controller.undoLastDecision();

    expect(await store.wordDecisions.get("猫")).toBeNull();
    expect(states.at(-1)?.wordDecisions.has("猫")).toBe(false);
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([]);
  });

  it("exposes the record via state.undo with a status + word label", async () => {
    const { controller, states } = await readyUndoSetup();

    expect(states.at(-1)?.undo).toEqual({ available: false, label: null });

    await controller.setWordDecision("新しい", "known");
    expect(states.at(-1)?.undo).toEqual({
      available: true,
      label: "Undo Known — 新しい",
    });

    await controller.setWordDecision("新しい", "later");
    expect(states.at(-1)?.undo).toEqual({
      available: true,
      label: "Undo Later — 新しい",
    });

    await controller.undoLastDecision();
    expect(states.at(-1)?.undo).toEqual({ available: false, label: null });
  });

  it("no-ops without a record", async () => {
    const { controller, states } = await readyUndoSetup();
    const publishes = states.length;

    await controller.undoLastDecision();

    expect(states.length).toBe(publishes);
  });

  it("restores queue membership lost to the decision by appending to the end", async () => {
    const { controller, states } = await readyUndoSetup();

    controller.toggleQueued("a");
    controller.toggleQueued("b");
    expect(states.at(-1)?.queue.normalizedWords).toEqual(["a", "b"]);

    await controller.setWordDecision("a", "known");
    expect(states.at(-1)?.queue.normalizedWords).toEqual(["b"]);

    await controller.undoLastDecision();

    // Appended at the END: the original position is not tracked, and
    // one-step undo only promises the word returns to the queue.
    expect(states.at(-1)?.queue.normalizedWords).toEqual(["b", "a"]);
    expect(states.at(-1)?.wordDecisions.has("a")).toBe(false);
  });

  it("re-adds queue membership only when the word actually left the queue", async () => {
    const { controller, states } = await readyUndoSetup();

    controller.toggleQueued("a");
    controller.toggleQueued("b");
    // Decide an UNQUEUED word: previousQueueMembership false, so undo must
    // not inject it into the queue.
    await controller.setWordDecision("b", "known");
    controller.toggleQueued("b");
    expect(states.at(-1)?.queue.normalizedWords).toEqual(["a", "b"]);

    await controller.undoLastDecision();

    expect(states.at(-1)?.queue.normalizedWords).toEqual(["a", "b"]);
  });

  it("undoes a mined decision back to the prior known status", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({
      normalizedWord: "猫",
      status: "known",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.setWordDecision("猫", "mined");
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({
      status: "mined",
    });

    await controller.undoLastDecision();

    expect(await store.wordDecisions.get("猫")).toEqual({
      normalizedWord: "猫",
      status: "known",
      updatedAt: FIXED_NOW,
    });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({
      status: "known",
    });
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "known"]]);
  });

  it("consumes the record: a second undo no-ops", async () => {
    const { controller, states } = await readyUndoSetup();
    await controller.setWordDecision("猫", "known");
    await controller.undoLastDecision();
    expect(states.at(-1)?.wordDecisions.has("猫")).toBe(false);
    const publishes = states.length;

    await controller.undoLastDecision();

    expect(states.length).toBe(publishes);
    expect(states.at(-1)?.wordDecisions.has("猫")).toBe(false);
  });

  it("clears the record when saved data is cleared", async () => {
    const { controller, states } = await readyUndoSetup();
    await controller.setWordDecision("猫", "known");
    expect(states.at(-1)?.undo.available).toBe(true);

    await controller.clearSavedData();

    expect(states.at(-1)?.undo).toEqual({ available: false, label: null });
    const publishes = states.length;
    await controller.undoLastDecision();
    expect(states.length).toBe(publishes);
  });

  it("clears the record after a backup restore commits", async () => {
    const { controller, states } = await readyUndoSetup();
    await controller.setWordDecision("猫", "known");
    expect(states.at(-1)?.undo.available).toBe(true);

    await controller.restoreBackup(
      JSON.stringify({
        format: "jiten-migaku-miner-backup",
        version: 1,
        exportedAt: "2026-09-06T00:00:00.000Z",
        knownWords: null,
        wordDecisions: [],
        preferences: null,
      }),
    );

    expect(states.at(-1)?.undo).toEqual({ available: false, label: null });
  });

  it("clears the record when a new dataset import commits", async () => {
    const { controller, states } = await readyUndoSetup();
    await controller.setWordDecision("猫", "known");
    expect(states.at(-1)?.undo.available).toBe(true);

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    expect(states.at(-1)?.undo).toEqual({ available: false, label: null });
  });

  it("keeps the record and surfaces an error when the undo re-apply fails", async () => {
    const { store, controller, states } = await readyUndoSetup();
    await controller.setWordDecision("猫", "known");
    const originalRemove = store.wordDecisions.remove.bind(store.wordDecisions);
    store.wordDecisions.remove = async () => {
      throw new Error("undo write failed");
    };

    await controller.undoLastDecision();
    store.wordDecisions.remove = originalRemove;

    // The decision is still known everywhere and the undo stays retryable.
    expect(await store.wordDecisions.get("猫")).toMatchObject({
      status: "known",
    });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({
      status: "known",
    });
    expect(states.at(-1)?.undo).toEqual({
      available: true,
      label: "Undo Known — 猫",
    });
    expect(states.at(-1)?.errorMessage).toContain("undo write failed");
  });

  it("drops the queue re-add when a concurrent restore wins the lock", async () => {
    const inner = createMemoryAppStore();
    await seedActive(inner);
    const delayed = createDelayedAppStore(inner, {
      forwardRestoreUserState: false,
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      store: delayed.store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      now: () => FIXED_NOW,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    controller.toggleQueued("a");
    controller.toggleQueued("b");
    await controller.setWordDecision("a", "known");
    expect(states.at(-1)?.queue.normalizedWords).toEqual(["b"]);

    const backup = JSON.stringify({
      format: "jiten-migaku-miner-backup",
      version: 1,
      exportedAt: "2026-09-06T00:00:00.000Z",
      knownWords: { name: "list.csv", words: ["b"] },
      wordDecisions: [],
      preferences: null,
    });

    // The restore blocks on its known-write while holding the user-state
    // lock. The undo starts before the restore's epoch bump becomes
    // observable, so its re-apply queues behind the restore and must be
    // dropped — and the queue re-add must be dropped with it.
    delayed.gate("knownWords.save");
    const restoring = controller.restoreBackup(backup);
    const undoing = controller.undoLastDecision();
    await delayed.started("knownWords.save");
    delayed.release("knownWords.save");
    await Promise.all([restoring, undoing]);

    expect(states.at(-1)?.queue.normalizedWords).toEqual(["b"]);
    expect(states.at(-1)?.wordDecisions.has("a")).toBe(false);
    expect(states.at(-1)?.undo).toEqual({ available: false, label: null });
  });
});

describe("MinerController preference persistence", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  it("a clear racing a decision-triggered persist leaves the preference store empty", async () => {
    const inner = createMemoryAppStore();
    const delayed = createDelayedAppStore(inner);
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      store: delayed.store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      now: () => FIXED_NOW,
    });
    await seedActive(inner);
    await controller.init();

    // Gate the preference write the decision's re-query triggers so the
    // in-flight persist overlaps the clear.
    delayed.gate("preferences.save");
    const decision = controller.setWordDecision("古い", "known");
    await delayed.started("preferences.save");

    // Let the clear run to completion while the persist is still gated. In
    // the lock-free controller the clear finishes here and the released save
    // then lands post-clear, repopulating the store with cleared-era
    // defaults; under the user-state lock the clear cannot overtake the
    // in-flight write.
    const cleared = controller.clearSavedData();
    await flushMicrotasks(30);
    delayed.release("preferences.save");
    await Promise.all([decision, cleared]);

    // The stale default-snapshot write must not survive the clear: the
    // preference store ends empty, not repopulated with cleared-era values.
    expect(await inner.preferences.load()).toBeNull();
  });
});

describe("MinerController review mode", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  function reviewPool(): Entry[] {
    return [
      { ...entry("a", "A", 0), occurrences: 3 },
      { ...entry("b", "B", 1), occurrences: 2 },
      { ...entry("c", "C", 2), occurrences: 1 },
    ];
  }

  function decorated(value: Entry): QueryResult["items"][number] {
    return {
      ...value,
      known: false,
      decision: "unreviewed",
      knownByMigaku: false,
      knownByDecision: false,
    };
  }

  function installPool(worker: FakeWorkerClient, pool: Entry[]): void {
    worker.queryHandler = async (request) => {
      // The real worker matches decisions against entries case-insensitively.
      const decided = new Set((request.decisions ?? []).map(([word]) => word.toLocaleLowerCase()));
      const remaining = pool.filter(
        (value) => !decided.has(value.normalizedWord.toLocaleLowerCase()),
      );
      const numericSize =
        request.query.pageSize === "all"
          ? Math.max(1, remaining.length)
          : Number(request.query.pageSize);
      const page = Math.max(1, request.query.page);
      const items = remaining.slice((page - 1) * numericSize, page * numericSize).map(decorated);
      return {
        ...result(items),
        totalEntries: remaining.length,
        totalPages: Math.max(1, Math.ceil(remaining.length / numericSize)),
      };
    };
  }

  function setup() {
    const store = createMemoryAppStore();
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    return { store, worker, controller, states };
  }

  it("startReview queries unreviewed-only with page size 1 and leaves normal query state untouched", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    await store.preferences.save({
      query: {
        ...query,
        search: "猫",
        sort: "occ-asc",
        page: 3,
        hideKanaOnly: true,
        decision: "mined",
      },
      view,
      page: 3,
    });
    installPool(worker, reviewPool());
    await controller.init();
    const before = states.at(-1)!;

    await controller.startReview();

    const final = states.at(-1)!;
    expect(final.review.active).toBe(true);
    expect(final.review.status).toBe("ready");
    expect(final.review.current?.normalizedWord).toBe("A");
    expect(final.review.initialTotal).toBe(3);
    expect(final.review.remaining).toBe(3);
    expect(final.query).toEqual(before.query);

    const reviewCall = worker.queryCalls.find((call) => call.queryChannel === "review");
    expect(reviewCall).toBeDefined();
    expect(reviewCall?.query.decision).toBe("unreviewed");
    expect(reviewCall?.query.hideKnown).toBe(true);
    expect(reviewCall?.query.pageSize).toBe(1);
    expect(reviewCall?.query.page).toBe(1);
    expect(reviewCall?.query.search).toBe("猫");
    expect(reviewCall?.query.sort).toBe("occ-asc");
    expect(reviewCall?.query.hideKanaOnly).toBe(true);
  });

  it("advances through decisions and reaches complete without skipping entries", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();

    await controller.startReview();
    expect(states.at(-1)?.review.current?.normalizedWord).toBe("A");

    await controller.reviewDecision("mined");
    expect(states.at(-1)?.review.current?.normalizedWord).toBe("B");
    expect(states.at(-1)?.review.processed).toBe(1);
    expect(states.at(-1)?.review.remaining).toBe(2);

    await controller.reviewDecision("later");
    expect(states.at(-1)?.review.current?.normalizedWord).toBe("C");
    expect(states.at(-1)?.review.processed).toBe(2);

    await controller.reviewDecision("known");
    const final = states.at(-1)!.review;
    expect(final.status).toBe("complete");
    expect(final.current).toBeNull();
    expect(final.processed).toBe(3);
    expect(final.remaining).toBe(0);

    // Every review query asked for page 1 so the shifted queue is never skipped.
    const reviewCalls = worker.queryCalls.filter((call) => call.queryChannel === "review");
    expect(reviewCalls.length).toBe(4);
    for (const call of reviewCalls) expect(call.query.page).toBe(1);
    expect(reviewCalls[1]?.decisions).toEqual([["a", "mined"]]);
    expect(reviewCalls[2]?.decisions).toEqual([
      ["a", "mined"],
      ["b", "later"],
    ]);
    expect(reviewCalls[3]?.decisions).toEqual([
      ["a", "mined"],
      ["b", "later"],
      ["c", "known"],
    ]);
  });

  it("keeps mined separate from known while reviewing", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();
    await controller.startReview();

    await controller.reviewDecision("mined");

    expect(await store.wordDecisions.get("a")).toMatchObject({
      status: "mined",
    });
    expect(states.at(-1)?.knownWords.size).toBe(0);
    expect(states.at(-1)?.wordDecisions.get("a")).toMatchObject({
      status: "mined",
    });
  });

  it("keeps the current entry and surfaces an error when the decision write fails", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();
    await controller.startReview();
    expect(states.at(-1)?.review.current?.normalizedWord).toBe("A");

    store.wordDecisions.set = async () => {
      throw new Error("decision write failed");
    };
    await controller.reviewDecision("mined");

    const review = states.at(-1)!.review;
    expect(review.status).toBe("ready");
    expect(review.current?.normalizedWord).toBe("A");
    expect(review.processed).toBe(0);
    expect(review.errorMessage).toContain("decision write failed");
    const reviewCalls = worker.queryCalls.filter((call) => call.queryChannel === "review");
    expect(reviewCalls.length).toBe(1);
  });

  it("ignores a rapid duplicate decision while one is in flight", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();
    await controller.startReview();

    let releaseReviewQuery: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseReviewQuery = resolve;
    });
    const originalHandler = worker.queryHandler;
    if (originalHandler === null) throw new Error("review pool handler missing");
    worker.queryHandler = async (request) => {
      const outcome = await originalHandler(request);
      if (request.queryChannel === "review" && (request.decisions ?? []).length > 0) await gate;
      return outcome;
    };

    const first = controller.reviewDecision("mined");
    const second = controller.reviewDecision("later");
    releaseReviewQuery();
    await Promise.all([first, second]);

    const review = states.at(-1)!.review;
    expect(await store.wordDecisions.get("a")).toMatchObject({
      status: "mined",
    });
    expect(review.current?.normalizedWord).toBe("B");
    expect(review.processed).toBe(1);
  });

  it("stopReview exits and leaves durable decisions in place", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();
    await controller.startReview();
    await controller.reviewDecision("mined");

    controller.stopReview();

    const final = states.at(-1)!;
    expect(final.review.active).toBe(false);
    expect(final.review.status).toBe("idle");
    expect(await store.wordDecisions.get("a")).toMatchObject({
      status: "mined",
    });
    expect(final.query.decision).toBe("all");
  });

  it("does not advance when review is not ready or already busy", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();

    await controller.reviewDecision("known");
    expect(states.at(-1)?.review.active).toBe(false);

    await controller.startReview();
    const reviewCallsBefore = worker.queryCalls.filter(
      (call) => call.queryChannel === "review",
    ).length;
    await controller.startReview();
    expect(worker.queryCalls.filter((call) => call.queryChannel === "review").length).toBe(
      reviewCallsBefore,
    );
  });

  it("review decisions share identity with list decisions on mixed-case words", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, [entry("nhk-entry", "NHK", 0)]);
    await controller.init();

    await controller.startReview();
    expect(states.at(-1)?.review.current?.normalizedWord).toBe("NHK");

    await controller.reviewDecision("known");

    const final = states.at(-1)!;
    expect(final.wordDecisions.size).toBe(1);
    expect(final.wordDecisions.get("nhk")).toMatchObject({ status: "known" });
    expect(await store.wordDecisions.list()).toEqual([
      { normalizedWord: "nhk", status: "known", updatedAt: FIXED_NOW },
    ]);

    // The list path converges on the same canonical key instead of adding a second one.
    await controller.setWordDecision("NHK", "mined");
    expect(states.at(-1)?.wordDecisions.size).toBe(1);
    expect(states.at(-1)?.wordDecisions.get("nhk")).toMatchObject({
      status: "mined",
    });
  });

  it("stops review when a new dataset commits", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();
    await controller.startReview();
    expect(states.at(-1)?.review.active).toBe(true);

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    const review = states.at(-1)!.review;
    expect(review.active).toBe(false);
    expect(review.status).toBe("idle");
    expect(review.current).toBeNull();
    expect(review.errorMessage).toBeNull();
  });

  it("review restart invalidates in-flight continuations", async () => {
    const inner = createMemoryAppStore();
    const delayed = createDelayedAppStore(inner);
    const worker = new FakeWorkerClient();
    installPool(worker, reviewPool());
    const controller = createMinerController({
      store: delayed.store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      now: () => FIXED_NOW,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await seedActive(inner);
    await controller.init();
    await controller.startReview();
    expect(states.at(-1)?.review.current?.normalizedWord).toBe("A");

    // Block the decision write so reviewDecision's continuation is in flight
    // across the restart.
    delayed.gate("wordDecisions.set");
    const decision = controller.reviewDecision("known");
    await delayed.started("wordDecisions.set");

    controller.stopReview();
    await controller.startReview();

    delayed.release("wordDecisions.set");
    await decision;

    const review = states.at(-1)!.review;
    expect(review.active).toBe(true);
    expect(review.processed).toBe(0);
    expect(review.initialTotal).toBe(3);
    expect(review.remaining).toBe(3);
    expect(review.current?.normalizedWord).toBe("A");
  });

  it("a restarted review session does not inherit busy from an in-flight decision", async () => {
    const inner = createMemoryAppStore();
    const delayed = createDelayedAppStore(inner);
    const worker = new FakeWorkerClient();
    installPool(worker, reviewPool());
    const controller = createMinerController({
      store: delayed.store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      now: () => FIXED_NOW,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await seedActive(inner);
    await controller.init();
    await controller.startReview();
    expect(states.at(-1)?.review.current?.normalizedWord).toBe("A");

    // Hold the old session's decision write open across a stop/start cycle.
    delayed.gate("wordDecisions.set");
    const stale = controller.reviewDecision("known");
    await delayed.started("wordDecisions.set");

    controller.stopReview();
    await controller.startReview();
    expect(states.at(-1)?.review.status).toBe("ready");

    // Triage on the new session must be accepted immediately — the busy flag
    // belongs to the superseded generation, not this one.
    const fresh = controller.reviewDecision("mined");
    await flushMicrotasks();
    expect(states.at(-1)?.review.status).toBe("loading");

    delayed.release("wordDecisions.set");
    await Promise.all([stale, fresh]);

    const review = states.at(-1)!.review;
    expect(review.active).toBe(true);
    expect(review.processed).toBe(1);
    expect(review.current?.normalizedWord).toBe("B");
    expect(await inner.wordDecisions.get("a")).toMatchObject({
      status: "mined",
    });
  });

  it("abandons a superseded review query after restart", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();

    // Hold the first review query (issued by startReview) unresolved.
    let held = false;
    let resolveHeld: ((value: QueryResult) => void) | undefined;
    const heldQuery = new Promise<QueryResult>((resolve) => {
      resolveHeld = resolve;
    });
    const originalHandler = worker.queryHandler;
    if (originalHandler === null) throw new Error("review pool handler missing");
    worker.queryHandler = async (request) => {
      if (request.queryChannel === "review" && !held) {
        held = true;
        return heldQuery;
      }
      return originalHandler(request);
    };

    const started = controller.startReview();
    await flushMicrotasks();
    // The held query was requested before this decision existed.
    await controller.setWordDecision("A", "known");
    controller.stopReview();
    await controller.startReview();

    resolveHeld?.({
      ...result([decorated(reviewPool()[0]!)]),
      totalEntries: 3,
    });
    await started;

    const review = states.at(-1)!.review;
    expect(review.active).toBe(true);
    expect(review.current?.normalizedWord).toBe("B");
    expect(review.remaining).toBe(2);
    expect(review.initialTotal).toBe(2);
    expect(review.processed).toBe(0);
  });

  it("removes a mixed-case queued word after a review decision", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, [entry("nhk-entry", "NHK", 0)]);
    await controller.init();

    controller.toggleQueued("NHK");
    expect(states.at(-1)?.queue.normalizedWords).toEqual(["nhk"]);

    await controller.startReview();
    await controller.reviewDecision("known");

    expect(states.at(-1)?.queue.normalizedWords).toEqual([]);
    expect(states.at(-1)?.wordDecisions.get("nhk")).toMatchObject({
      status: "known",
    });
    expect(await store.wordDecisions.get("nhk")).toMatchObject({
      status: "known",
    });
  });
});

describe("MinerController backup and restore", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  const backupQuery: QueryState = { ...query, decision: "all" };
  const restoredQuery: QueryState = {
    search: "犬",
    hideKnown: true,
    hideKanaOnly: true,
    sentence: "has",
    minOccurrences: 2,
    sort: "original",
    pageSize: 25,
    page: 2,
    decision: "mined",
  };
  const restoredView: ViewState = {
    showFurigana: true,
    pillHighlight: true,
    showHighlight: false,
    showDefinitions: false,
    sentenceSize: "large",
    density: "compact",
  };

  function backupText(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      format: "jiten-migaku-miner-backup",
      version: 1,
      exportedAt: "2026-09-06T00:00:00.000Z",
      knownWords: { name: "known.txt", words: ["犬", "猫"] },
      wordDecisions: [
        {
          normalizedWord: "犬",
          status: "mined",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          normalizedWord: "鳥",
          status: "later",
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
      preferences: { query: restoredQuery, view: restoredView, page: 2 },
      ...overrides,
    });
  }

  async function seedForRestore(store: AppStore): Promise<void> {
    await seedActive(store);
    await store.knownWords.save("old-known", "old.txt", new Set(["古い"]));
    await store.wordDecisions.set({
      normalizedWord: "古い",
      status: "skip",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    await store.preferences.save({
      query: { ...backupQuery, search: "古い", page: 1 },
      view,
      page: 1,
    });
  }

  // Wave-1 rollback tests pin the sequential fallback path: strip the optional
  // atomic method so stores without restoreUserState stay covered.
  function withoutRestoreUserState(inner: AppStore): AppStore {
    return {
      datasets: inner.datasets,
      knownWords: inner.knownWords,
      wordDecisions: inner.wordDecisions,
      preferences: inner.preferences,
      ankiSync: inner.ankiSync,
      clearAll: inner.clearAll.bind(inner),
    };
  }

  function restoreSetup(store: AppStore) {
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    return { worker, controller, states };
  }

  it("exports known words, decisions, and preferences without dataset rows or queue state", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { controller } = restoreSetup(store);
    await controller.init();

    const json = await controller.exportBackup();
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed.format).toBe("jiten-migaku-miner-backup");
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe(FIXED_NOW);
    expect(parsed.knownWords).toEqual({ name: "old.txt", words: ["古い"] });
    expect(parsed.wordDecisions).toEqual([
      {
        normalizedWord: "古い",
        status: "skip",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(parsed.preferences).toMatchObject({ page: 1 });
    expect(json).not.toContain("entryCount");
    expect(json).not.toContain("normalizedWords");
    expect(json).not.toContain("old-entry");
  });

  it("exports an empty backup when nothing is stored", async () => {
    const store = createMemoryAppStore();
    const { controller } = restoreSetup(store);
    await controller.init();

    const json = await controller.exportBackup();
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed.knownWords).toBeNull();
    expect(parsed.wordDecisions).toEqual([]);
    expect(parsed.preferences).toMatchObject({ page: 1 });
  });

  it("restores all three categories, keeps the dataset, and requeries", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { worker, controller, states } = restoreSetup(store);
    worker.queryResult = { ...result(), page: 2, totalPages: 2 };
    await controller.init();
    const datasetBefore = states.at(-1)!.dataset;
    const queryCallsBefore = worker.queryCalls.length;

    await controller.restoreBackup(backupText());

    const final = states.at(-1)!;
    expect(final.knownWords).toEqual(new Set(["犬", "猫"]));
    expect(final.knownWordsName).toBe("known.txt");
    expect(final.wordDecisions.get("犬")).toMatchObject({ status: "mined" });
    expect(final.wordDecisions.get("鳥")).toMatchObject({ status: "later" });
    expect(final.wordDecisions.has("古い")).toBe(false);
    expect(final.query).toEqual(restoredQuery);
    expect(final.view).toEqual(restoredView);
    expect(final.dataset).toEqual(datasetBefore);
    expect(final.status).toBe("ready");
    expect(final.errorMessage).toBeNull();
    expect(worker.queryCalls.length).toBeGreaterThan(queryCallsBefore);
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([
      ["犬", "mined"],
      ["鳥", "later"],
    ]);
    expect(await store.preferences.load()).toEqual({
      query: restoredQuery,
      view: restoredView,
      page: 2,
    });
  });

  it("clears the imported known list when knownWords is null", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { controller, states } = restoreSetup(store);
    await controller.init();

    await controller.restoreBackup(backupText({ knownWords: null }));

    const final = states.at(-1)!;
    expect(final.knownWords.size).toBe(0);
    expect(final.knownWordsName).toBeNull();
    expect(await store.knownWords.getActive()).toBeNull();
  });

  it("resets preferences to defaults when preferences is null", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { controller, states } = restoreSetup(store);
    await controller.init();

    await controller.restoreBackup(backupText({ preferences: null }));

    const final = states.at(-1)!;
    expect(final.query).toEqual({ ...DEFAULT_QUERY });
    expect(final.view).toEqual({ ...DEFAULT_VIEW });
    expect(await store.preferences.load()).toEqual({
      query: { ...DEFAULT_QUERY },
      view: { ...DEFAULT_VIEW },
      page: 1,
    });
  });

  it("performs zero writes when the backup fails to parse", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { controller, states } = restoreSetup(store);
    await controller.init();
    const before = states.at(-1)!;

    await expect(controller.restoreBackup("{not json")).rejects.toThrow();

    expect(await store.knownWords.getActive()).toMatchObject({
      id: "old-known",
    });
    expect(await store.wordDecisions.list()).toEqual([
      {
        normalizedWord: "古い",
        status: "skip",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(await store.preferences.load()).toMatchObject({ page: 1 });
    expect(states.at(-1)?.knownWords).toEqual(before.knownWords);
    expect(states.at(-1)?.wordDecisions.size).toBe(before.wordDecisions.size);
    expect(states.at(-1)?.errorMessage).toContain("Backup could not be restored");
  });

  it("rejects oversized backups before any write", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { controller } = restoreSetup(store);
    await controller.init();

    const oversized = " ".repeat(MAX_BACKUP_BYTES + 1);
    await expect(controller.restoreBackup(oversized)).rejects.toThrow("too large");
    expect(await store.knownWords.getActive()).toMatchObject({
      id: "old-known",
    });
  });

  it("rolls back all three categories when the decision replacement fails", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { controller, states } = restoreSetup(withoutRestoreUserState(store));
    await controller.init();

    store.wordDecisions.replaceAll = async () => {
      throw new Error("decision replacement failed");
    };

    await expect(controller.restoreBackup(backupText())).rejects.toThrow(
      "decision replacement failed",
    );

    expect(await store.knownWords.getActive()).toMatchObject({
      id: "old-known",
    });
    expect(await store.wordDecisions.list()).toEqual([
      {
        normalizedWord: "古い",
        status: "skip",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(await store.preferences.load()).toMatchObject({ page: 1 });

    const final = states.at(-1)!;
    expect(final.knownWords).toEqual(new Set(["古い"]));
    expect(final.errorMessage).toContain("decision replacement failed");
    expect(final.status).toBe("ready");
  });

  it("rolls back and warns when the preferences write fails", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { controller, states } = restoreSetup(withoutRestoreUserState(store));
    await controller.init();

    store.preferences.save = async () => {
      throw new Error("preferences write failed");
    };

    await expect(controller.restoreBackup(backupText())).rejects.toThrow(
      "preferences write failed",
    );

    expect(await store.knownWords.getActive()).toMatchObject({
      id: "old-known",
    });
    expect(await store.wordDecisions.list()).toEqual([
      {
        normalizedWord: "古い",
        status: "skip",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(states.at(-1)?.errorMessage).toContain("preferences write failed");
    expect(states.at(-1)?.knownWords).toEqual(new Set(["古い"]));
  });

  it("reports rollback failures instead of reporting success", async () => {
    const store = createMemoryAppStore();
    await seedForRestore(store);
    const { controller, states } = restoreSetup(withoutRestoreUserState(store));
    await controller.init();

    store.wordDecisions.replaceAll = async () => {
      throw new Error("decision replacement failed");
    };
    store.knownWords.save = async () => {
      throw new Error("known rollback failed");
    };

    await expect(controller.restoreBackup(backupText())).rejects.toThrow();

    expect(states.at(-1)?.errorMessage).toContain("Known-word rollback failed");
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("restoreBackup uses the single-transaction path when the store provides it", async () => {
    const inner = createMemoryAppStore();
    await seedForRestore(inner);
    // Spies live on a wrapper layer, not on inner: the atomic implementation
    // may legitimately use inner's own category methods internally, and only
    // direct controller traffic through the wrapper proves the fast path.
    const knownSave = vi.fn(inner.knownWords.save.bind(inner.knownWords));
    const replaceAll = vi.fn(inner.wordDecisions.replaceAll.bind(inner.wordDecisions));
    const preferencesSave = vi.fn(inner.preferences.save.bind(inner.preferences));
    const restoreUserState = vi.fn(inner.restoreUserState?.bind(inner));
    const store: AppStore = {
      datasets: inner.datasets,
      knownWords: {
        save: knownSave,
        getActive: inner.knownWords.getActive.bind(inner.knownWords),
        ...(inner.knownWords.remove !== undefined
          ? { remove: inner.knownWords.remove.bind(inner.knownWords) }
          : {}),
        ...(inner.knownWords.clear !== undefined
          ? { clear: inner.knownWords.clear.bind(inner.knownWords) }
          : {}),
      },
      wordDecisions: {
        get: inner.wordDecisions.get.bind(inner.wordDecisions),
        list: inner.wordDecisions.list.bind(inner.wordDecisions),
        set: inner.wordDecisions.set.bind(inner.wordDecisions),
        remove: inner.wordDecisions.remove.bind(inner.wordDecisions),
        replaceAll: replaceAll,
        ...(inner.wordDecisions.clear !== undefined
          ? { clear: inner.wordDecisions.clear.bind(inner.wordDecisions) }
          : {}),
      },
      preferences: {
        load: inner.preferences.load.bind(inner.preferences),
        save: preferencesSave,
        ...(inner.preferences.clear !== undefined
          ? { clear: inner.preferences.clear.bind(inner.preferences) }
          : {}),
      },
      clearAll: inner.clearAll.bind(inner),
      restoreUserState,
    };
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      ...decisionOptions(store, worker),
      createId: (kind) => `${kind}-restored`,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    worker.queryResult = { ...result(), page: 2, totalPages: 2 };
    await controller.init();

    await controller.restoreBackup(backupText());

    expect(restoreUserState).toHaveBeenCalledTimes(1);
    expect(restoreUserState.mock.calls[0]?.[0]).toEqual({
      knownWords: {
        id: "known-restored",
        name: "known.txt",
        words: new Set(["犬", "猫"]),
      },
      decisions: [
        {
          normalizedWord: "犬",
          status: "mined",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          normalizedWord: "鳥",
          status: "later",
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
      preferences: { query: restoredQuery, view: restoredView, page: 2 },
    });
    expect(knownSave).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    // The only preferences write is the post-restore persist, never a
    // restore-phase sequential write.
    expect(preferencesSave.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      restoreUserState.mock.invocationCallOrder[0]!,
    );
    expect(await inner.knownWords.getActive()).toMatchObject({
      id: "known-restored",
    });
    expect(await inner.wordDecisions.list()).toHaveLength(2);
    expect(await inner.preferences.load()).toMatchObject({ page: 2 });
    const final = states.at(-1)!;
    expect(final.knownWords).toEqual(new Set(["犬", "猫"]));
    expect(final.knownWordsName).toBe("known.txt");
    expect(final.wordDecisions.get("犬")).toMatchObject({ status: "mined" });
    expect(final.query).toEqual(restoredQuery);
    expect(final.errorMessage).toBeNull();
  });

  it("restoreBackup falls back to sequential writes and rolls back without the method", async () => {
    const inner = createMemoryAppStore();
    await seedForRestore(inner);
    const delayed = createDelayedAppStore(inner, {
      forwardRestoreUserState: false,
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      store: delayed.store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      now: () => FIXED_NOW,
      createId: (kind) => `${kind}-restored`,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    delayed.failNext("wordDecisions.replaceAll");
    await expect(controller.restoreBackup(backupText())).rejects.toThrow(
      "wordDecisions.replaceAll failed as requested",
    );

    expect(await inner.knownWords.getActive()).toMatchObject({
      id: "old-known",
      name: "old.txt",
    });
    expect(await inner.wordDecisions.list()).toEqual([
      {
        normalizedWord: "古い",
        status: "skip",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(await inner.preferences.load()).toMatchObject({ page: 1 });
    const final = states.at(-1)!;
    expect(final.knownWords).toEqual(new Set(["古い"]));
    expect(final.wordDecisions.has("犬")).toBe(false);
    expect(final.errorMessage).toContain("wordDecisions.replaceAll failed as requested");
  });

  it("a failing restore invalidates in-flight query renders so a late completion cannot clear the error", async () => {
    const inner = createMemoryAppStore();
    await seedForRestore(inner);
    const delayed = createDelayedAppStore(inner, {
      forwardRestoreUserState: false,
    });
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      store: delayed.store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      createId: (kind) => `${kind}-restored`,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();
    const resultBefore = states.at(-1)!.result;

    // A user query is in flight when the restore fails; its late resolution
    // must not be allowed to publish a ready render over the restore error.
    let resolveStale: ((value: QueryResult) => void) | undefined;
    const staleGate = new Promise<QueryResult>((resolve) => {
      resolveStale = resolve;
    });
    let staleStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    worker.queryHandler = async () => {
      staleStarted?.();
      return staleGate;
    };
    controller.updateQuery({ search: "最新" });
    await started;

    delayed.failNext("preferences.save");
    await expect(controller.restoreBackup(backupText())).rejects.toThrow(
      "preferences.save failed as requested",
    );
    expect(states.at(-1)?.errorMessage).toContain("Backup could not be restored");

    resolveStale?.(result([decoratedReviewItem(entry("stale-entry", "残"))]));
    await flushMicrotasks();

    const final = states.at(-1)!;
    expect(final.errorMessage).toContain("Backup could not be restored");
    expect(final.errorMessage).toContain("preferences.save failed as requested");
    expect(final.status).not.toBe("ready");
    expect(final.result?.items.some((item) => item.id === "stale-entry")).toBe(false);
    expect(final.result).toEqual(resultBefore);
  });

  function decoratedReviewItem(value: Entry): QueryResult["items"][number] {
    return {
      ...value,
      known: false,
      decision: "unreviewed",
      knownByMigaku: false,
      knownByDecision: false,
    };
  }

  // Wave-6 review-generation symmetry: every restore-failure exit must
  // invalidate an in-flight review continuation exactly like it invalidates
  // an in-flight query render (the test above). The review query issued by
  // startReview is held unresolved across the failed restore; its late
  // completion must not resurrect a card over the error surface.
  async function expectReviewHeldAcrossRestoreFailure(world: {
    store: AppStore;
    failRestore: (controller: MinerController) => Promise<void>;
  }): Promise<void> {
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      store: world.store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      now: () => FIXED_NOW,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    let held = false;
    let resolveHeld: ((value: QueryResult) => void) | undefined;
    const heldQuery = new Promise<QueryResult>((resolve) => {
      resolveHeld = resolve;
    });
    const unheld = worker.queryResult;
    worker.queryHandler = async (request) => {
      if (request.queryChannel === "review" && !held) {
        held = true;
        return heldQuery;
      }
      return unheld;
    };

    const started = controller.startReview();
    await flushMicrotasks();
    expect(held).toBe(true);
    expect(states.at(-1)?.review.active).toBe(true);
    expect(states.at(-1)?.review.status).toBe("loading");

    await world.failRestore(controller);
    expect(states.at(-1)?.errorMessage).toContain("Backup could not be restored");

    resolveHeld?.({
      ...result([decoratedReviewItem(entry("late-entry", "遅"))]),
      totalEntries: 1,
    });
    await started;
    await flushMicrotasks();

    const final = states.at(-1)!;
    expect(final.errorMessage).toContain("Backup could not be restored");
    expect(final.review.active).toBe(true);
    expect(final.review.status).toBe("loading");
    expect(final.review.current).toBeNull();
  }

  it("an oversized-backup rejection invalidates in-flight review continuations", async () => {
    const inner = createMemoryAppStore();
    await seedForRestore(inner);
    await expectReviewHeldAcrossRestoreFailure({
      store: inner,
      failRestore: async (controller) => {
        await expect(controller.restoreBackup("x".repeat(MAX_BACKUP_BYTES + 1))).rejects.toThrow(
          "too large",
        );
      },
    });
  });

  it("a parse-failure restore invalidates in-flight review continuations", async () => {
    const inner = createMemoryAppStore();
    await seedForRestore(inner);
    await expectReviewHeldAcrossRestoreFailure({
      store: inner,
      failRestore: async (controller) => {
        await expect(controller.restoreBackup("{not json")).rejects.toThrow();
      },
    });
  });

  it("an atomic-abort restore failure invalidates in-flight review continuations", async () => {
    const inner = createMemoryAppStore();
    await seedForRestore(inner);
    const store: AppStore = {
      ...withoutRestoreUserState(inner),
      restoreUserState: async () => {
        throw new Error("atomic restore failed");
      },
    };
    await expectReviewHeldAcrossRestoreFailure({
      store,
      failRestore: async (controller) => {
        await expect(controller.restoreBackup(backupText())).rejects.toThrow(
          "atomic restore failed",
        );
      },
    });
  });

  it("a sequential-rollback restore failure invalidates in-flight review continuations", async () => {
    const inner = createMemoryAppStore();
    await seedForRestore(inner);
    const delayed = createDelayedAppStore(inner, {
      forwardRestoreUserState: false,
    });
    await expectReviewHeldAcrossRestoreFailure({
      store: delayed.store,
      failRestore: async (controller) => {
        delayed.failNext("preferences.save");
        await expect(controller.restoreBackup(backupText())).rejects.toThrow(
          "preferences.save failed as requested",
        );
      },
    });
  });

  it("routes restoreUserState failures through the memory fallback and completes the restore", async () => {
    const inner = createMemoryAppStore();
    await inner.knownWords.save("old-known", "old.txt", new Set(["古い"]));
    await inner.wordDecisions.set({
      normalizedWord: "古い",
      status: "skip",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    await inner.preferences.save({
      query: { ...backupQuery, page: 1 },
      view,
      page: 1,
    });
    const sequentialReplaceAll = vi.fn(inner.wordDecisions.replaceAll.bind(inner.wordDecisions));
    inner.wordDecisions.replaceAll = sequentialReplaceAll;
    let atomicFailures = 0;
    const store: AppStore = {
      datasets: inner.datasets,
      knownWords: inner.knownWords,
      wordDecisions: inner.wordDecisions,
      preferences: inner.preferences,
      clearAll: inner.clearAll.bind(inner),
      restoreUserState: async (snapshot) => {
        atomicFailures += 1;
        if (atomicFailures === 1)
          throw new DOMException("IndexedDB restore failed", "SecurityError");
        await inner.restoreUserState?.(snapshot);
      },
    };
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      indexedDbStoreFactory: () => store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      now: () => FIXED_NOW,
      createId: (kind) => `${kind}-restored`,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.restoreBackup(backupText());

    expect(atomicFailures).toBe(1);
    expect(sequentialReplaceAll).not.toHaveBeenCalled();
    const final = states.at(-1)!;
    expect(final.persistence).toBe("memory");
    expect(final.knownWords).toEqual(new Set(["犬", "猫"]));
    expect(final.wordDecisions.get("犬")).toMatchObject({ status: "mined" });
    expect(final.wordDecisions.has("古い")).toBe(false);
    expect(final.status).toBe("empty");
    expect(final.errorMessage).toContain("memory");
    // The original store never received a successful atomic restore; the
    // backup lives in the replacement memory store.
    expect(await inner.knownWords.getActive()).toMatchObject({
      id: "old-known",
    });
    const exported = JSON.parse(await controller.exportBackup()) as {
      knownWords: { words: string[] } | null;
    };
    expect(exported.knownWords?.words).toEqual(expect.arrayContaining(["犬", "猫"]));
  });
});

describe("MinerController user-state serialization", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  function delayedSetup(store: ReturnType<typeof createMemoryAppStore> = createMemoryAppStore()) {
    const delayed = createDelayedAppStore(store);
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      store: delayed.store,
      worker,
      legacyStorage: null,
      sessionQueueStore: createSessionQueueStore(null),
      now: () => FIXED_NOW,
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    return { inner: store, delayed, worker, controller, states };
  }

  it("clear waits for an in-flight decision write and leaves no decisions durable", async () => {
    const { inner, delayed, controller } = delayedSetup();
    await controller.init();

    delayed.gate("wordDecisions.set");
    const decisionPromise = controller.setWordDecision("新しい", "known");
    await delayed.started("wordDecisions.set");

    const clearPromise = controller.clearSavedData();
    await new Promise((resolve) => setTimeout(resolve, 20));
    delayed.release("wordDecisions.set");
    await Promise.all([decisionPromise, clearPromise]);

    expect(await inner.wordDecisions.list()).toEqual([]);
    expect(await delayed.store.wordDecisions.list()).toEqual([]);
  });

  it("clear waits for an in-flight import commit and leaves no dataset durable", async () => {
    const { inner, delayed, controller, states } = delayedSetup();
    await controller.init();

    delayed.gate("datasets.activate");
    const importPromise = controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });
    await delayed.started("datasets.activate");

    const clearPromise = controller.clearSavedData();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Clear must be parked behind the import's locks, not run to completion
    // while the commit is mid-flight.
    let clearCompleted = false;
    void clearPromise.then(() => {
      clearCompleted = true;
    });
    await flushMicrotasks();
    expect(clearCompleted).toBe(false);

    delayed.release("datasets.activate");
    await Promise.all([importPromise, clearPromise]);

    expect(await inner.datasets.list()).toEqual([]);
    expect(states.at(-1)?.dataset).toBeNull();
    expect(states.at(-1)?.status).toBe("empty");
  });

  it("import commit user-state writes cannot resurrect durable records after clear", async () => {
    const { inner, delayed, controller, states } = delayedSetup();
    await controller.init();

    delayed.gate("preferences.save");
    const importPromise = controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });
    await delayed.started("preferences.save");

    const clearPromise = controller.clearSavedData();
    await new Promise((resolve) => setTimeout(resolve, 20));
    delayed.release("preferences.save");
    await Promise.all([importPromise, clearPromise]);

    expect(await inner.datasets.list()).toEqual([]);
    expect(await inner.preferences.load()).toBeNull();
    expect(states.at(-1)?.dataset).toBeNull();
    expect(states.at(-1)?.status).toBe("empty");
  });

  it("restore is atomic relative to queued decisions; rollback is not overwritten", async () => {
    const { inner, delayed, controller, states } = delayedSetup();
    await seedActive(inner);
    await controller.init();

    await controller.setWordDecision("古い", "skip");
    const backup = serializeBackup({
      exportedAt: "2026-09-06T00:00:00.000Z",
      knownWords: null,
      wordDecisions: [
        {
          normalizedWord: "透過",
          status: "known",
          updatedAt: "2026-09-06T00:00:00.000Z",
        },
      ],
      preferences: { query: { ...query, page: 1 }, view, page: 1 },
    });

    delayed.gate("restoreUserState");
    delayed.failNext("restoreUserState");
    const restorePromise = controller.restoreBackup(backup);
    await delayed.started("restoreUserState");

    const queuedDecision = controller.setWordDecision("新しい", "mined");
    await new Promise((resolve) => setTimeout(resolve, 20));
    delayed.release("restoreUserState");
    await expect(restorePromise).rejects.toThrow("restoreUserState failed as requested");
    await queuedDecision;

    const durable = (await inner.wordDecisions.list())
      .map((decision) => `${decision.status}:${decision.normalizedWord}`)
      .sort();
    expect(durable).toEqual(["mined:新しい", "skip:古い"]);
    const final = states.at(-1)!;
    expect(final.wordDecisions.get("新しい")).toMatchObject({
      status: "mined",
    });
    expect(final.wordDecisions.has("透過")).toBe(false);
  });

  it("known-import failure landing after a completed restore does not overwrite restored state", async () => {
    const { inner, delayed, controller, states } = delayedSetup();
    await seedActive(inner);
    await controller.init();

    const backup = serializeBackup({
      exportedAt: "2026-09-06T00:00:00.000Z",
      knownWords: null,
      wordDecisions: [
        {
          normalizedWord: "透過",
          status: "known",
          updatedAt: "2026-09-06T00:00:00.000Z",
        },
      ],
      preferences: { query: { ...query, page: 1 }, view, page: 1 },
    });

    delayed.gate("restoreUserState");
    const importPromise = controller.importKnown({
      name: "known.csv",
      text: async () => "新しい",
    });
    const restorePromise = controller.restoreBackup(backup);
    await delayed.started("restoreUserState");
    await new Promise((resolve) => setTimeout(resolve, 20));
    delayed.failNext("knownWords.save");
    delayed.release("restoreUserState");
    await Promise.all([restorePromise, importPromise]);

    const final = states.at(-1)!;
    expect(final.knownWords).toEqual(new Set());
    expect(final.wordDecisions.has("透過")).toBe(true);
    expect(final.status).toBe("ready");
    expect(final.errorMessage).toBeNull();
    expect(await inner.knownWords.getActive()).toBeNull();
  });

  it("stale continuations skip publication after clear", async () => {
    const { inner, delayed, worker, controller, states } = delayedSetup();
    await controller.init();

    delayed.gate("wordDecisions.set");
    const decisionPromise = controller.setWordDecision("新しい", "known");
    await delayed.started("wordDecisions.set");

    const clearPromise = controller.clearSavedData();
    await new Promise((resolve) => setTimeout(resolve, 20));
    delayed.release("wordDecisions.set");
    await Promise.all([decisionPromise, clearPromise]);

    const afterWriteRace = states.at(-1)!;
    expect(afterWriteRace.wordDecisions.size).toBe(0);
    expect(afterWriteRace.result).toBeNull();
    expect(afterWriteRace.status).toBe("empty");
    expect(afterWriteRace.review.active).toBe(false);
    expect(afterWriteRace.errorMessage).toBeNull();
    expect(await inner.wordDecisions.list()).toEqual([]);

    let resolveQuery: ((value: QueryResult) => void) | undefined;
    const queryGate = new Promise<QueryResult>((resolve) => {
      resolveQuery = resolve;
    });
    worker.queryHandler = async () => queryGate;
    const blockedDecision = controller.setWordDecision("猫", "known");
    await new Promise((resolve) => setTimeout(resolve, 20));

    await controller.clearSavedData();

    resolveQuery?.(result());
    await blockedDecision;
    const final = states.at(-1)!;
    expect(final.wordDecisions.size).toBe(0);
    expect(final.result).toBeNull();
    expect(final.status).toBe("empty");
    expect(final.errorMessage).toBeNull();
  });
});

describe("MinerController coverage lifecycle", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  const coverageFixture: Entry[] = [
    { ...entry("cov-1", "新しい", 0), occurrences: 50 },
    { ...entry("cov-2", "犬", 1), occurrences: 30 },
    { ...entry("cov-3", "猫", 2), occurrences: 20 },
  ];

  function fixtureStats(
    knownWords: Iterable<string> = [],
    decisions: Array<[string, WordDecisionStatus]> = [],
  ): CoverageStats {
    return computeCoverage(coverageFixture, new Set(knownWords), new Map(decisions));
  }

  async function flushMicrotasks(rounds = 6): Promise<void> {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  }

  async function untilReady(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 1_000 && !predicate(); index += 1) await Promise.resolve();
  }

  async function coverageSetup(active = true): Promise<{
    store: AppStore;
    worker: FakeWorkerClient;
    controller: MinerController;
    states: Readonly<AppState>[];
  }> {
    const store = createMemoryAppStore();
    if (active) await seedActive(store);
    const worker = new FakeWorkerClient();
    worker.coverageEntries = coverageFixture;
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    return { store, worker, controller, states };
  }

  it("loads coverage after dataset initialization with inputs and omitted targets", async () => {
    const { worker, controller, states } = await coverageSetup();
    await controller.init();

    const final = states.at(-1)!;
    expect(final.status).toBe("ready");
    expect(final.coverageStatus).toBe("ready");
    expect(final.coverage).toEqual(fixtureStats());
    expect(worker.coverageCalls).toHaveLength(1);
    expect(worker.coverageCalls[0]).toMatchObject({
      datasetId: "old-dataset",
      knownWords: [],
      decisions: [],
    });
    // Worker-side defaults apply when the controller omits targets.
    expect(worker.coverageCalls[0]?.targets).toBeUndefined();
  });

  it("keeps coverage null and idle when no dataset is active", async () => {
    const { worker, controller, states } = await coverageSetup(false);
    await controller.init();

    expect(states.at(-1)?.dataset).toBeNull();
    expect(states.at(-1)?.coverage).toBeNull();
    expect(states.at(-1)?.coverageStatus).toBe("idle");
    expect(worker.coverageCalls).toHaveLength(0);

    await controller.importKnown({
      name: "known.txt",
      text: async () => "新しい\n",
    });

    expect(worker.coverageCalls).toHaveLength(0);
    expect(states.at(-1)?.coverage).toBeNull();
    expect(states.at(-1)?.coverageStatus).toBe("idle");
  });

  it("refreshes coverage after a known-word import with updated inputs", async () => {
    const { worker, controller, states } = await coverageSetup();
    await controller.init();
    worker.nextKnown = {
      chunks: [["新しい"]],
      complete: {
        protocolVersion: 2,
        type: "import-complete",
        requestId: "known-new",
        kind: "known",
        name: "known.txt",
        wordCount: 1,
      },
    };

    await controller.importKnown({
      name: "known.txt",
      text: async () => "新しい\n",
    });

    expect(worker.coverageCalls).toHaveLength(2);
    expect(worker.coverageCalls.at(-1)).toMatchObject({
      datasetId: "old-dataset",
      knownWords: ["新しい"],
    });
    expect(states.at(-1)?.coverageStatus).toBe("ready");
    expect(states.at(-1)?.coverage).toEqual(fixtureStats(["新しい"]));
  });

  it("refreshes coverage upward after a local Known decision", async () => {
    const { worker, controller, states } = await coverageSetup();
    await controller.init();
    expect(states.at(-1)?.coverage?.coveragePercent).toBe(0);

    await controller.setWordDecision("新しい", "known");

    expect(worker.coverageCalls.at(-1)?.decisions).toEqual([["新しい", "known"]]);
    expect(states.at(-1)?.coverageStatus).toBe("ready");
    expect(states.at(-1)?.coverage).toEqual(fixtureStats([], [["新しい", "known"]]));
    expect(states.at(-1)?.coverage?.coveragePercent).toBe(50);
  });

  it("does not count a Mined decision toward coverage", async () => {
    const { worker, controller, states } = await coverageSetup();
    await controller.init();

    await controller.setWordDecision("新しい", "mined");

    expect(worker.coverageCalls.at(-1)?.decisions).toEqual([["新しい", "mined"]]);
    expect(states.at(-1)?.coverageStatus).toBe("ready");
    expect(states.at(-1)?.coverage).toEqual(fixtureStats([], [["新しい", "mined"]]));
    expect(states.at(-1)?.coverage?.coveragePercent).toBe(0);
  });

  it("refreshes coverage downward when a local Known is reset and the word is not in the Migaku list", async () => {
    const { worker, controller, states } = await coverageSetup();
    await controller.init();
    await controller.setWordDecision("新しい", "known");
    expect(states.at(-1)?.coverage?.coveragePercent).toBe(50);

    await controller.setWordDecision("新しい", "unreviewed");

    expect(worker.coverageCalls.at(-1)?.decisions).toEqual([]);
    expect(states.at(-1)?.coverageStatus).toBe("ready");
    expect(states.at(-1)?.coverage).toEqual(fixtureStats());
    expect(states.at(-1)?.coverage?.coveragePercent).toBe(0);
  });

  it("requests coverage for the new dataset after a Jiten import commits", async () => {
    const { worker, controller, states } = await coverageSetup();
    await controller.init();
    const importCount = worker.coverageCalls.length;

    await controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });

    const newDatasetId = states.at(-1)?.dataset?.id;
    expect(newDatasetId).not.toBe("old-dataset");
    expect(worker.coverageCalls.length).toBeGreaterThan(importCount);
    expect(worker.coverageCalls.at(-1)?.datasetId).toBe(newDatasetId);
    expect(states.at(-1)?.coverageStatus).toBe("ready");
  });

  it("ignores a stale coverage response after a dataset swap", async () => {
    const { worker, controller, states } = await coverageSetup();
    const resolvers: Array<(stats: CoverageStats) => void> = [];
    worker.coverageHandler = () =>
      new Promise<CoverageStats>((resolve) => {
        resolvers.push(resolve);
      });

    // Both the init load and the replacement import below block on their
    // gated coverage responses, so neither promise can be awaited directly
    // until its resolver fires.
    const initPromise = controller.init();
    await untilReady(() => resolvers.length === 1);
    expect(resolvers).toHaveLength(1);
    expect(states.at(-1)?.coverageStatus).toBe("loading");

    const importPromise = controller.importJiten({
      name: "new.csv",
      text: async () => "Word\n新しい",
    });
    await untilReady(() => resolvers.length === 2);
    expect(resolvers).toHaveLength(2);

    const staleStats = fixtureStats(["新しい", "犬", "猫"]);
    resolvers[0]?.(staleStats);
    await flushMicrotasks();

    expect(states.at(-1)?.coverage).not.toEqual(staleStats);
    expect(states.at(-1)?.coverageStatus).toBe("loading");

    const freshStats: CoverageStats = {
      ...fixtureStats(),
      totalUniqueWords: 1,
    };
    resolvers[1]?.(freshStats);
    await flushMicrotasks();

    expect(states.at(-1)?.coverage).toEqual(freshStats);
    expect(states.at(-1)?.coverageStatus).toBe("ready");
    await Promise.all([initPromise, importPromise]);
  });

  it("keeps the results list usable when coverage fails", async () => {
    const { worker, controller, states } = await coverageSetup();
    worker.queryResult = result([
      {
        ...entry("old-entry", "古い"),
        known: false,
        decision: "unreviewed",
        knownByMigaku: false,
        knownByDecision: false,
      },
    ]);
    worker.coverageErrors = [new Error("coverage worker failed")];
    await controller.init();

    const final = states.at(-1)!;
    expect(final.status).toBe("ready");
    expect(final.errorMessage).toBeNull();
    expect(final.result).not.toBeNull();
    expect(final.coverageStatus).toBe("error");
    expect(final.coverageErrorMessage).toContain("coverage worker failed");
    expect(final.coverage).toBeNull();
  });

  it("does not request coverage for view toggles, page changes, or search-only updates", async () => {
    const { worker, controller } = await coverageSetup();
    worker.queryResult = { ...result(), totalPages: 3, totalEntries: 3 };
    await controller.init();
    const coverageBefore = worker.coverageCalls.length;
    const queriesBefore = worker.queryCalls.length;

    controller.updateView({ showFurigana: true });
    controller.updateQuery({ search: "犬" });
    controller.changePage(1);

    // Queries ran for the search and page change, but no coverage request fired.
    expect(worker.queryCalls.length).toBeGreaterThan(queriesBefore);
    expect(worker.coverageCalls.length).toBe(coverageBefore);
  });

  it("resets coverage when saved data is cleared", async () => {
    const { controller, states } = await coverageSetup();
    await controller.init();
    expect(states.at(-1)?.coverageStatus).toBe("ready");
    expect(states.at(-1)?.coverage).not.toBeNull();

    await controller.clearSavedData();

    const final = states.at(-1)!;
    expect(final.coverage).toBeNull();
    expect(final.coverageStatus).toBe("idle");
    expect(final.coverageErrorMessage).toBeNull();
  });

  it("refreshes coverage after restoring a backup", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.knownWords.save("old-known", "old.txt", new Set(["古い"]));
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();
    // Seeded known 古い over the single 古い entry = full coverage.
    expect(states.at(-1)?.coverage?.coveragePercent).toBe(100);

    await controller.restoreBackup(
      serializeBackup({
        exportedAt: FIXED_NOW,
        knownWords: { name: "restored.txt", words: ["犬", "猫"] },
        wordDecisions: [
          {
            normalizedWord: "犬",
            status: "mined",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
          {
            normalizedWord: "鳥",
            status: "later",
            updatedAt: "2026-08-02T00:00:00.000Z",
          },
        ],
        preferences: { query: { ...query, page: 1 }, view, page: 1 },
      }),
    );

    const final = states.at(-1)!;
    expect(final.coverageStatus).toBe("ready");
    expect(worker.coverageCalls.at(-1)?.knownWords).toEqual(["犬", "猫"]);
    expect(worker.coverageCalls.at(-1)?.decisions).toEqual([
      ["犬", "mined"],
      ["鳥", "later"],
    ]);
    // Restored mined/later decisions do not count; 古い left the known list.
    expect(final.coverage?.coveragePercent).toBe(0);
    expect(final.coverage?.knownUniqueWords).toBe(0);
  });
});

describe("MinerController backup freshness", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  function freshnessSetup(store = createMemoryAppStore()) {
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    return { store, worker, controller, states };
  }

  async function readyFreshnessSetup(): Promise<ReturnType<typeof freshnessSetup>> {
    const env = freshnessSetup();
    await seedActive(env.store);
    await env.controller.init();
    return env;
  }

  it("starts a session with no export and zero changes", async () => {
    const { states } = await readyFreshnessSetup();
    expect(states.at(-1)?.lastExportAt).toBeNull();
    expect(states.at(-1)?.changesSinceExport).toBe(0);
  });

  it("increments once per applied decision, and undo's re-apply counts exactly once more", async () => {
    const { controller, states } = await readyFreshnessSetup();

    await controller.setWordDecision("猫", "known");
    expect(states.at(-1)?.changesSinceExport).toBe(1);

    await controller.undoLastDecision();
    expect(states.at(-1)?.changesSinceExport).toBe(2);
    expect(states.at(-1)?.wordDecisions.has("猫")).toBe(false);
  });

  it("increments once per known-word import", async () => {
    const { controller, states } = await readyFreshnessSetup();

    await controller.importKnown({
      name: "known.txt",
      text: async () => "新しい\n",
    });

    expect(states.at(-1)?.changesSinceExport).toBe(1);
  });

  it("increments once per restore backup, regardless of restored content size", async () => {
    const { controller, states } = await readyFreshnessSetup();

    await controller.restoreBackup(
      JSON.stringify({
        format: "jiten-migaku-miner-backup",
        version: 1,
        exportedAt: "2026-09-06T00:00:00.000Z",
        knownWords: { name: "known.txt", words: ["犬", "猫"] },
        wordDecisions: [
          {
            normalizedWord: "犬",
            status: "mined",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
          {
            normalizedWord: "鳥",
            status: "later",
            updatedAt: "2026-08-02T00:00:00.000Z",
          },
        ],
        preferences: null,
      }),
    );

    expect(states.at(-1)?.changesSinceExport).toBe(1);
  });

  it("does not increment when the decision write fails", async () => {
    const { store, controller, states } = await readyFreshnessSetup();
    store.wordDecisions.set = async () => {
      throw new Error("decision write failed");
    };

    await controller.setWordDecision("猫", "known");

    expect(states.at(-1)?.changesSinceExport).toBe(0);
  });

  it("does not increment for preference, page, or session-queue churn", async () => {
    const { controller, states } = await readyFreshnessSetup();

    controller.updateQuery({ search: "猫" });
    await flushMicrotasks();
    controller.updateView({ showFurigana: true });
    controller.changePage(1);
    controller.toggleQueued("猫");
    controller.removeQueued("猫");
    await flushMicrotasks();

    expect(states.at(-1)?.changesSinceExport).toBe(0);
  });

  it("exportBackup stamps lastExportAt and zeroes the counter", async () => {
    const { controller, states } = await readyFreshnessSetup();
    await controller.setWordDecision("猫", "known");
    await controller.setWordDecision("犬", "later");
    expect(states.at(-1)?.changesSinceExport).toBe(2);

    await controller.exportBackup();

    expect(states.at(-1)?.lastExportAt).toBe(FIXED_NOW);
    expect(states.at(-1)?.changesSinceExport).toBe(0);

    await controller.setWordDecision("鳥", "skip");
    expect(states.at(-1)?.changesSinceExport).toBe(1);
  });

  it("clearSavedData resets both fields", async () => {
    const { controller, states } = await readyFreshnessSetup();
    await controller.setWordDecision("猫", "known");
    await controller.exportBackup();
    await controller.setWordDecision("犬", "later");
    expect(states.at(-1)?.lastExportAt).toBe(FIXED_NOW);
    expect(states.at(-1)?.changesSinceExport).toBe(1);

    await controller.clearSavedData();

    expect(states.at(-1)?.lastExportAt).toBeNull();
    expect(states.at(-1)?.changesSinceExport).toBe(0);
  });

  it("is session-only: a new controller on the same store starts fresh", async () => {
    const store = createMemoryAppStore();
    const first = freshnessSetup(store);
    await seedActive(store);
    await first.controller.init();
    await first.controller.setWordDecision("猫", "known");
    await first.controller.exportBackup();
    await first.controller.setWordDecision("犬", "later");
    expect(first.states.at(-1)?.lastExportAt).toBe(FIXED_NOW);
    expect(first.states.at(-1)?.changesSinceExport).toBe(1);

    const second = freshnessSetup(store);
    await second.controller.init();

    expect(second.states.at(-1)?.lastExportAt).toBeNull();
    expect(second.states.at(-1)?.changesSinceExport).toBe(0);
    // The persisted user state itself survived; only freshness is session-only.
    expect(second.states.at(-1)?.wordDecisions.get("犬")).toMatchObject({
      status: "later",
    });
  });
});

describe("source adapters", () => {
  it("wraps browser File text reads", async () => {
    const file = { name: "media.csv", text: async () => "Word\n猫" } as File;
    const source = createFileSource(file);

    expect(source.name).toBe("media.csv");
    await expect(source.text()).resolves.toBe("Word\n猫");
  });

  it("selects newest same-origin folder file using bounded HEAD checks and encoded names", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const listingUrl = "https://app.example/miner/WORDS%20TO%20MINE/";
    const files = new Map<string, { body?: string; lastModified?: string }>([
      ["old%20file.csv", { lastModified: "Wed, 02 Sep 2026 00:00:00 GMT", body: "old" }],
      ["new%20file.csv", { lastModified: "Thu, 03 Sep 2026 00:00:00 GMT", body: "new" }],
    ]);
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url === listingUrl) {
        return responseLike(
          url,
          '<a href="old file.csv">old file.csv</a><a href="new file.csv">new file.csv</a>',
        );
      }
      const file = files.get(url.slice(listingUrl.length));
      if (file === undefined) return responseLike(url, "", { ok: false });
      return responseLike(
        url,
        file.body ?? "",
        file.lastModified === undefined ? {} : { lastModified: file.lastModified },
      );
    };
    const source = createFolderSource({
      fetch: fetcher,
      protocol: "http:",
      baseUrl: "https://app.example/miner/index.html",
    });

    const newest = await source.newest("WORDS TO MINE", ".csv");

    expect(newest?.name).toBe("new file.csv");
    await expect(newest?.text()).resolves.toBe("new");
    expect(requests).toEqual([
      { url: "https://app.example/miner/WORDS%20TO%20MINE/", method: "GET" },
      {
        url: "https://app.example/miner/WORDS%20TO%20MINE/old%20file.csv",
        method: "HEAD",
      },
      {
        url: "https://app.example/miner/WORDS%20TO%20MINE/new%20file.csv",
        method: "HEAD",
      },
      {
        url: "https://app.example/miner/WORDS%20TO%20MINE/new%20file.csv",
        method: "GET",
      },
    ]);
  });

  it("does not fetch folder listings from file URLs", async () => {
    let calls = 0;
    const source = createFolderSource({
      protocol: "file:",
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    });

    await expect(source.newest("WORDS TO MINE", ".csv")).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it("rejects folder targets outside configured page origin before fetching", async () => {
    let calls = 0;
    const source = createFolderSource({
      baseUrl: "https://app.example/miner/index.html",
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    });

    await expect(source.newest("https://evil.example/files", ".csv")).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it("rejects cross-origin redirects from folder responses", async () => {
    let calls = 0;
    const redirectedListing = {
      ok: true,
      redirected: true,
      url: "https://evil.example/files/",
      text: async () => '<a href="new.csv">new.csv</a>',
    } as Response;
    const source = createFolderSource({
      baseUrl: "https://app.example/miner/index.html",
      fetch: async () => {
        calls += 1;
        return redirectedListing;
      },
    });

    await expect(source.newest("files", ".csv")).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("rejects cross-origin final response URLs even without redirect metadata", async () => {
    const response = {
      ok: true,
      redirected: false,
      url: "https://evil.example/files/",
      text: async () => '<a href="new.csv">new.csv</a>',
    } as Response;
    const source = createFolderSource({
      baseUrl: "https://app.example/miner/index.html",
      fetch: async () => response,
    });

    await expect(source.newest("files", ".csv")).resolves.toBeNull();
  });

  it("does not fetch when page base URL is missing, invalid, or file-based", async () => {
    for (const baseUrl of [undefined, "not a URL", "file:///tmp/miner/index.html"] as const) {
      let calls = 0;
      const options = {
        protocol: "http:",
        fetch: async () => {
          calls += 1;
          return new Response('<a href="new.csv">new.csv</a>');
        },
        ...(baseUrl === undefined ? {} : { baseUrl }),
      };

      await expect(createFolderSource(options).newest("files", ".csv")).resolves.toBeNull();
      expect(calls).toBe(0);
    }
  });

  it("rejects cross-origin final file responses", async () => {
    const listingUrl = "https://app.example/miner/files/";
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (init?.method === "HEAD") {
        return responseLike(url, "", {
          lastModified: "Thu, 03 Sep 2026 00:00:00 GMT",
        });
      }
      if (url === listingUrl) return responseLike(url, '<a href="new.csv">new.csv</a>');
      return responseLike("https://evil.example/files/new.csv", "new");
    };
    const source = createFolderSource({
      fetch: fetcher,
      protocol: "http:",
      baseUrl: "https://app.example/miner/index.html",
    });

    await expect(source.newest("files", ".csv")).resolves.toBeNull();
  });

  it("rejects responses without a final URL instead of trusting the request URL", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return responseLike("", '<a href="new.csv">new.csv</a>');
    };
    const source = createFolderSource({
      fetch: fetcher,
      protocol: "http:",
      baseUrl: "https://app.example/miner/index.html",
    });

    await expect(source.newest("files", ".csv")).resolves.toBeNull();
    expect(calls).toBe(1);
  });
});
