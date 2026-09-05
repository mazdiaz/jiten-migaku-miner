import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { Entry, QueryResult, QueryState, ViewState, WordDecisionStatus } from "../../src/domain/types";
import type { AppState, FileSource } from "../../src/app/state";
import {
  createMinerController,
  type MinerControllerOptions,
} from "../../src/app/controller";
import type { WorkerClient, WorkerQueryInput } from "../../src/app/worker-client";
import { createFileSource } from "../../src/platform/file-source";
import { createFolderSource } from "../../src/platform/folder-source";
import { createMemoryAppStore } from "../../src/storage/memory-store";
import type {
  DatasetMetadata,
  AppStore,
} from "../../src/storage/contracts";
import type {
  ImportCompleteResponse,
  ImportChunkResponse,
} from "../../src/worker/protocol";

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
        protocolVersion: 1 as const,
        type: "import-complete" as const,
        requestId: "import",
        kind: "jiten" as const,
        name,
        headers: ["Word"],
        entryCount: 1,
        skippedRows: 0,
      },
    };
    importing.chunks.forEach((entries, chunkIndex) => onChunk?.({
      protocolVersion: 1,
      type: "import-chunk",
      requestId: importing.complete.requestId,
      kind: "jiten",
      name,
      chunkIndex,
      entries,
    }));
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
        protocolVersion: 1 as const,
        type: "import-complete" as const,
        requestId: "known-import",
        kind: "known" as const,
        name,
        wordCount: 1,
      },
    };
    importing.chunks.forEach((words, chunkIndex) => onChunk?.({
      protocolVersion: 1,
      type: "import-chunk",
      requestId: importing.complete.requestId,
      kind: "known",
      name,
      chunkIndex,
      words,
    }));
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

  dispose(): void {
    this.events.push("dispose");
  }
}

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

async function seedActive(store: AppStore, id = "old-dataset"): Promise<void> {
  await store.datasets.stage(metadata(id), (async function* () {
    yield [entry("old-entry", "古い")];
  })());
  await store.datasets.activate(id);
}

function controllerOptions(store: AppStore, worker: FakeWorkerClient, storage?: Storage): MinerControllerOptions {
  return { store, worker, legacyStorage: storage ?? new TestStorage() };
}

describe("MinerController", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  it("restores active records, loads worker, queries, and publishes isolated snapshots", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.knownWords.save("known", "known.txt", ["古い"]);
    await store.preferences.save({ query: { ...query, page: 2 }, view, page: 2 });
    const worker = new FakeWorkerClient();
    worker.queryResult = { ...result(), page: 2, totalPages: 2 };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    const ready = states.at(-1)!;
    expect(ready).toMatchObject({
      dataset: metadata("old-dataset"),
      page: 2,
      status: "ready",
      persistence: "memory",
    });
    expect(ready.knownWords).toEqual(new Set(["古い"]));
    expect(worker.loadCalls[0]).toMatchObject({ datasetId: "old-dataset" });
    expect(worker.queryCalls[0]).toMatchObject({ datasetId: "old-dataset", knownWords: ["古い"] });

    controller.updateView({ showDefinitions: false });
    expect(states[0]!.view.showDefinitions).toBe(true);
    expect(states.at(-1)!.view.showDefinitions).toBe(false);
    expect(states[0]).not.toBe(states.at(-1));
  });

  it("rejects persisted datasets whose stored entry count is incomplete", async () => {
    const store = createMemoryAppStore();
    const broken = metadata("broken-dataset");
    broken.entryCount = 2;
    await store.datasets.stage(broken, (async function* () {
      yield [entry("only-entry", "一つ")];
    })());
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
    await store.preferences.save({ query: { ...query, page: 2 }, view, page: 2 });
    const worker = new FakeWorkerClient();
    worker.importError = new Error("bad replacement");
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();
    const before = states.at(-1)!;

    await controller.importJiten({ name: "broken.csv", text: async () => "broken" });

    const after = states.at(-1)!;
    expect(after.dataset).toEqual(before.dataset);
    expect(after.knownWords).toEqual(before.knownWords);
    expect(after.query).toEqual(before.query);
    expect(after.view).toEqual(before.view);
    expect(after.page).toBe(before.page);
    expect(after.status).toBe("error");
    expect(after.errorMessage).toContain("bad replacement");
    expect(await store.datasets.getActive()).toEqual(metadata("old-dataset"));
    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["old-dataset"]);
  });

  it("stages replacement before activation and resets page after success", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.preferences.save({ query: { ...query, page: 2 }, view, page: 2 });
    const worker = new FakeWorkerClient();
    worker.nextJiten = {
      chunks: [[entry("new-entry", "新しい")]],
      complete: {
        protocolVersion: 1,
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

    await controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });

    const active = await store.datasets.getActive();
    expect(order).toEqual(["stage", "activate"]);
    expect(active?.sourceName).toBe("new.csv");
    expect(states.at(-1)).toMatchObject({
      dataset: active,
      page: 1,
      query: { page: 1 },
      status: "ready",
      errorMessage: null,
    });
    expect(worker.loadCalls.at(-1)?.datasetId).toBe(active?.id);
    expect(worker.queryCalls).toHaveLength(3);
    expect(worker.queryCalls[0]?.queryChannel).toBe("user");
    expect(worker.queryCalls[1]).toMatchObject({ datasetId: active?.id, queryChannel: "candidate" });
    expect(worker.queryCalls[2]).toMatchObject({ datasetId: active?.id, queryChannel: "user" });
  });

  it("refreshes the user query on the activated dataset after committing a replacement", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    const originalImport = worker.importJiten.bind(worker);
    let releaseImport: (() => void) | undefined;
    let importStarted: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
    const importReady = new Promise<void>((resolve) => { importStarted = resolve; });
    worker.importJiten = async (name, text, onChunk) => {
      importStarted?.();
      await importGate;
      return originalImport(name, text, onChunk);
    };
    const controller = createMinerController(controllerOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    const importing = controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });
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
        protocolVersion: 1,
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

    await controller.importKnown({ name: "known.txt", text: async () => "新しい\n" });

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

    await controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });

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

    await controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });

    expect(await store.datasets.getActive()).toEqual(metadata("old-dataset"));
    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["old-dataset"]);
    expect(states.at(-1)?.dataset).toEqual(metadata("old-dataset"));
    expect(states.at(-1)?.page).toBe(1);

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
    const firstLoad = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
    const firstLoadReady = new Promise<void>((resolve) => { firstLoadStarted = resolve; });
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
      createId: (kind) => kind === "dataset" ? `dataset-${++nextDatasetId}` : "known-1",
    });

    const first = controller.importJiten({ name: "first.csv", text: async () => "Word\n一つ" });
    await firstLoadReady;
    const second = controller.importJiten({ name: "second.csv", text: async () => "Word\n二つ" });
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
    const firstActivation = new Promise<void>((resolve) => { releaseFirstActivation = resolve; });
    const firstActivationReady = new Promise<void>((resolve) => { firstActivationStarted = resolve; });
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
      createId: (kind) => kind === "dataset" ? `dataset-${nextDatasetId++}` : "known-1",
    });
    let nextDatasetId = 1;
    controller.subscribe((state) => states.push(state));

    const first = controller.importJiten({ name: "first.csv", text: async () => "Word\n一つ" });
    await firstActivationReady;
    const second = controller.importJiten({ name: "second.csv", text: async () => "Word\n二つ" });
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
        protocolVersion: 1,
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

    await controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });

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
        protocolVersion: 1,
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

    await controller.importKnown({ name: "known.txt", text: async () => "古い\n" });

    expect(states.at(-1)!.knownWords).toEqual(new Set(["古い"]));
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
        protocolVersion: 1,
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

    await controller.importKnown({ name: "known.txt", text: async () => "新しい\n" });

    expect(states.at(-1)?.status).toBe("error");
    expect(states.at(-1)?.errorMessage).toContain("verification");
  });

  it("falls back to memory persistence with visible warning when IndexedDB fails", async () => {
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    const worker = new FakeWorkerClient();
    const controller = createMinerController({ worker, legacyStorage: new TestStorage() });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    expect(states.at(-1)!.persistence).toBe("memory");
    expect(states.at(-1)!.errorMessage?.toLowerCase()).toContain("memory");
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: original });
  });

  it("switches to memory and keeps warning after a later IndexedDB stage failure", async () => {
    const failingStore = createMemoryAppStore();
    failingStore.datasets.stage = async () => { throw new Error("IndexedDB stage failed"); };
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      indexedDbStoreFactory: () => failingStore,
      worker,
      legacyStorage: new TestStorage(),
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });

    expect(states.at(-1)?.persistence).toBe("memory");
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
    controller.updateView({ showDefinitions: false });
    await Promise.resolve();
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
  });

  it("switches to memory when preference persistence fails after initialization", async () => {
    const failingStore = createMemoryAppStore();
    failingStore.preferences.save = async () => { throw new Error("IndexedDB preferences failed"); };
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

  it("clears abandoned persistent data and keeps fallback warning after clear", async () => {
    const persistent = createMemoryAppStore();
    await seedActive(persistent);
    persistent.datasets.stage = async () => { throw new Error("persistent stage failed"); };
    const worker = new FakeWorkerClient();
    const controller = createMinerController({
      indexedDbStoreFactory: () => persistent,
      worker,
      legacyStorage: new TestStorage(),
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });
    await controller.clearSavedData();

    expect(await persistent.datasets.getActive()).toBeNull();
    expect(await persistent.datasets.list()).toEqual([]);
    expect(states.at(-1)?.persistence).toBe("memory");
    expect(states.at(-1)?.errorMessage?.toLowerCase()).toContain("memory");
  });

  it("preserves a newer user query when candidate query failure rolls back import", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const worker = new FakeWorkerClient();
    let candidateStarted: (() => void) | undefined;
    let rejectCandidate: ((reason: unknown) => void) | undefined;
    const candidateReady = new Promise<void>((resolve) => { candidateStarted = resolve; });
    worker.queryHandler = async (request) => {
      if (request.datasetId === "candidate") {
        candidateStarted?.();
        return new Promise<QueryResult>((_resolve, reject) => { rejectCandidate = reject; });
      }
      return result();
    };
    const controller = createMinerController({
      store,
      worker,
      legacyStorage: new TestStorage(),
      createId: (kind) => kind === "dataset" ? "candidate" : "known-1",
    });
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    const importing = controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });
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
    failingStore.datasets.stage = async () => { throw new Error("IndexedDB migration stage failed"); };
    const storage = new TestStorage();
    storage.setItem("jitenMiner.v1", JSON.stringify({ mediaFileName: "legacy.csv", mediaText: "Word\n猫" }));
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
    expect(storage.getItem("jitenMiner.migration")).toBe("1");
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
    expect(worker.queryCalls.at(-1)?.window).toEqual({ start: 4_500, size: 100 });
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
    headers: new Headers(options.lastModified ? { "Last-Modified": options.lastModified } : undefined),
    text: async () => body,
  } as Response;
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

const FIXED_NOW = "2026-09-05T00:00:00.000Z";

function decisionOptions(store: AppStore, worker: FakeWorkerClient, storage?: Storage): MinerControllerOptions {
  return { ...controllerOptions(store, worker, storage), now: () => FIXED_NOW };
}

describe("MinerController word decisions", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  it("restores persisted decisions on initialization and defaults missing preference decision to all", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({ normalizedWord: "猫", status: "known", updatedAt: "2026-09-01T00:00:00.000Z" });
    await store.wordDecisions.set({ normalizedWord: "犬", status: "later", updatedAt: "2026-09-01T00:00:00.000Z" });
    const legacyQuery: Record<string, unknown> = { ...query };
    delete legacyQuery.decision;
    await store.preferences.save({ query: legacyQuery as unknown as QueryState, view, page: 1 });
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.init();

    const final = states.at(-1)!;
    expect(final.wordDecisions.get("猫")).toMatchObject({ status: "known" });
    expect(final.wordDecisions.get("犬")).toMatchObject({ status: "later" });
    expect(final.query.decision).toBe("all");
    expect(worker.queryCalls[0]?.decisions).toEqual(expect.arrayContaining([["猫", "known"], ["犬", "later"]]));
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
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({ status: "known" });
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

    expect(await store.wordDecisions.get("猫")).toMatchObject({ status: "mined" });
    expect(states.at(-1)?.knownWords.size).toBe(0);
    expect(worker.queryCalls.at(-1)?.knownWords).toEqual([]);
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "mined"]]);
  });

  it("removes the store record when resetting to unreviewed", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({ normalizedWord: "猫", status: "known", updatedAt: "2026-09-01T00:00:00.000Z" });
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
    store.wordDecisions.set = async () => { throw new Error("decision write failed"); };
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
    await store.wordDecisions.set({ normalizedWord: "猫", status: "known", updatedAt: "2026-09-01T00:00:00.000Z" });
    const worker = new FakeWorkerClient();
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.importJiten({ name: "new.csv", text: async () => "Word\n新しい" });

    expect(await store.wordDecisions.get("猫")).toMatchObject({ status: "known" });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({ status: "known" });
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "known"]]);
  });

  it("keeps decisions when the Migaku known file is replaced", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({ normalizedWord: "猫", status: "mined", updatedAt: "2026-09-01T00:00:00.000Z" });
    const worker = new FakeWorkerClient();
    worker.nextKnown = {
      chunks: [["犬"]],
      complete: {
        protocolVersion: 1,
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

    await controller.importKnown({ name: "known.txt", text: async () => "犬\n" });

    expect(await store.wordDecisions.get("猫")).toMatchObject({ status: "mined" });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({ status: "mined" });
    expect(states.at(-1)?.knownWords).toEqual(new Set(["犬"]));
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "mined"]]);
  });

  it("removes decisions when saved data is cleared", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.wordDecisions.set({ normalizedWord: "猫", status: "known", updatedAt: "2026-09-01T00:00:00.000Z" });
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
    await store.preferences.save({ query: { ...query, page: 2 }, view, page: 2 });
    const worker = new FakeWorkerClient();
    worker.queryResult = { ...result(), page: 2, totalPages: 2, totalEntries: 100 };
    const controller = createMinerController(decisionOptions(store, worker));
    const states: Readonly<AppState>[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.init();

    await controller.setWordDecision("猫", "known");

    expect(states.at(-1)?.page).toBe(2);
    expect(worker.queryCalls.at(-1)?.query.page).toBe(2);
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "known"]]);
  });

  it("clamps the page when the decision filter drops the last item on the last page", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.preferences.save({ query: { ...query, page: 2 }, view, page: 2 });
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
    expect(states.at(-1)?.page).toBe(2);

    await controller.setWordDecision("猫", "known");

    expect(states.at(-1)?.page).toBe(1);
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

    expect(await store.wordDecisions.get("猫")).toMatchObject({ status: "mined", updatedAt: FIXED_NOW });
    expect(states.at(-1)?.wordDecisions.get("猫")).toMatchObject({ status: "mined" });
    expect(worker.queryCalls.at(-1)?.decisions).toEqual([["猫", "mined"]]);
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
      const decided = new Set((request.decisions ?? []).map(([word]) => word));
      const remaining = pool.filter((value) => !decided.has(value.normalizedWord));
      const numericSize = request.query.pageSize === "all" ? Math.max(1, remaining.length) : Number(request.query.pageSize);
      const page = Math.max(1, request.query.page);
      const items = remaining
        .slice((page - 1) * numericSize, page * numericSize)
        .map(decorated);
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
    await store.preferences.save({ query: { ...query, search: "猫", sort: "occ-asc", page: 3, hideKanaOnly: true, decision: "mined" }, view, page: 3 });
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
    expect(final.page).toBe(before.page);

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
    expect(states.at(-1)!.review.current?.normalizedWord).toBe("A");

    await controller.reviewDecision("mined");
    expect(states.at(-1)!.review.current?.normalizedWord).toBe("B");
    expect(states.at(-1)!.review.processed).toBe(1);
    expect(states.at(-1)!.review.remaining).toBe(2);

    await controller.reviewDecision("later");
    expect(states.at(-1)!.review.current?.normalizedWord).toBe("C");
    expect(states.at(-1)!.review.processed).toBe(2);

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
    expect(reviewCalls[1]?.decisions).toEqual([["A", "mined"]]);
    expect(reviewCalls[2]?.decisions).toEqual([["A", "mined"], ["B", "later"]]);
    expect(reviewCalls[3]?.decisions).toEqual([["A", "mined"], ["B", "later"], ["C", "known"]]);
  });

  it("keeps mined separate from known while reviewing", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();
    await controller.startReview();

    await controller.reviewDecision("mined");

    expect(await store.wordDecisions.get("A")).toMatchObject({ status: "mined" });
    expect(states.at(-1)!.knownWords.size).toBe(0);
    expect(states.at(-1)!.wordDecisions.get("A")).toMatchObject({ status: "mined" });
  });

  it("keeps the current entry and surfaces an error when the decision write fails", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();
    await controller.startReview();
    expect(states.at(-1)!.review.current?.normalizedWord).toBe("A");

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
    expect(await store.wordDecisions.get("A")).toMatchObject({ status: "mined" });
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
    expect(await store.wordDecisions.get("A")).toMatchObject({ status: "mined" });
    expect(final.query.decision).toBe("all");
  });

  it("does not advance when review is not ready or already busy", async () => {
    const { store, worker, controller, states } = setup();
    await seedActive(store);
    installPool(worker, reviewPool());
    await controller.init();

    await controller.reviewDecision("known");
    expect(states.at(-1)!.review.active).toBe(false);

    await controller.startReview();
    const reviewCallsBefore = worker.queryCalls.filter((call) => call.queryChannel === "review").length;
    await controller.startReview();
    expect(worker.queryCalls.filter((call) => call.queryChannel === "review").length).toBe(reviewCallsBefore);
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
        return responseLike(url, '<a href="old file.csv">old file.csv</a><a href="new file.csv">new file.csv</a>');
      }
      const file = files.get(url.slice(listingUrl.length));
      if (file === undefined) return responseLike(url, "", { ok: false });
      return responseLike(url, file.body ?? "", file.lastModified === undefined ? {} : { lastModified: file.lastModified });
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
       { url: "https://app.example/miner/WORDS%20TO%20MINE/old%20file.csv", method: "HEAD" },
       { url: "https://app.example/miner/WORDS%20TO%20MINE/new%20file.csv", method: "HEAD" },
       { url: "https://app.example/miner/WORDS%20TO%20MINE/new%20file.csv", method: "GET" },
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
        return responseLike(url, "", { lastModified: "Thu, 03 Sep 2026 00:00:00 GMT" });
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
