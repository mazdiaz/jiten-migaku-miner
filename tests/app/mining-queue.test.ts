import { describe, expect, it } from "vitest";
import type { Entry, EntryWithKnown, QueryResult, QueryState } from "../../src/domain/types";
import type { AppState, FileSource } from "../../src/app/state";
import { createMinerController } from "../../src/app/controller";
import type { MinerControllerOptions } from "../../src/app/controller";
import type { WorkerClient, WorkerQueryInput } from "../../src/app/worker-client";
import { createSessionQueueStore, SESSION_QUEUE_STORAGE_KEY } from "../../src/platform/session-queue";
import { createMemoryAppStore } from "../../src/storage/memory-store";
import type { AppStore, DatasetMetadata } from "../../src/storage/contracts";
import type {
  ImportCompleteResponse,
  ImportChunkResponse,
} from "../../src/worker/protocol";

const baseQuery: QueryState = {
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

function entry(id: string, word: string, originalIndex = 0, occurrences = 3): Entry {
  return {
    id,
    originalIndex,
    word,
    normalizedWord: word,
    occurrences,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
  };
}

function withKnown(value: Entry): EntryWithKnown {
  return { ...value, known: false, knownByMigaku: false, knownByDecision: false, decision: "unreviewed" };
}

function metadata(id: string, name = id): DatasetMetadata {
  return {
    id,
    name,
    sourceType: "file",
    sourceName: `${name}.csv`,
    headers: ["Word"],
    entryCount: 1,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    schemaVersion: 1,
  };
}

function result(items: EntryWithKnown[] = []): QueryResult {
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

class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class FakeWorkerClient implements WorkerClient {
  readonly loadCalls: Array<{ datasetId: string; chunks: Entry[][] }> = [];
  readonly queryCalls: WorkerQueryInput[] = [];
  nextJiten: {
    chunks: Entry[][];
    complete: Extract<ImportCompleteResponse, { kind: "jiten" }>;
  } | null = null;
  queryResult: QueryResult = result();
  queryHandler: ((request: WorkerQueryInput) => Promise<QueryResult>) | null = null;

  async importJiten(
    name: string,
    _text: string,
    onChunk?: (chunk: Extract<ImportChunkResponse, { kind: "jiten" }>) => void,
  ): Promise<Extract<ImportCompleteResponse, { kind: "jiten" }>> {
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

  async importKnown(name: string): Promise<Extract<ImportCompleteResponse, { kind: "known" }>> {
    return {
      protocolVersion: 1,
      type: "import-complete",
      requestId: "known",
      kind: "known",
      name,
      wordCount: 0,
    };
  }

  async loadDataset(datasetId: string, chunks: AsyncIterable<readonly Entry[]>): Promise<void> {
    const loaded: Entry[][] = [];
    for await (const chunk of chunks) loaded.push([...chunk]);
    this.loadCalls.push({ datasetId, chunks: loaded });
  }

  async query(request: WorkerQueryInput): Promise<QueryResult> {
    this.queryCalls.push(request);
    if (this.queryHandler !== null) return this.queryHandler(request);
    return this.queryResult;
  }

  dispose(): void {}
}

function fileSource(name = "book.csv"): FileSource {
  return { name, text: async () => "Word,Occurences\n一,1\n" };
}

interface Setup {
  store: AppStore;
  worker: FakeWorkerClient;
  storage: FakeStorage;
  options(): MinerControllerOptions;
}

async function setup(activeDatasetId: string | null = "dataset-1"): Promise<Setup> {
  const store = createMemoryAppStore();
  if (activeDatasetId !== null) {
    await store.datasets.stage(metadata(activeDatasetId), (async function* () {
      yield [entry("one", "一", 0, 5)];
    })());
    await store.datasets.activate(activeDatasetId);
  }
  const storage = new FakeStorage();
  const worker = new FakeWorkerClient();
  return {
    store,
    worker,
    storage,
    options: () => ({
      store,
      worker,
      legacyStorage: new FakeStorage(),
      sessionQueueStore: createSessionQueueStore(storage),
    }),
  };
}

function lastState(controller: ReturnType<typeof createMinerController>): Readonly<AppState> {
  let captured: Readonly<AppState> | null = null;
  const unsubscribe = controller.subscribe((state) => {
    captured = state;
  });
  unsubscribe();
  if (captured === null) throw new Error("controller did not publish state");
  return captured;
}

describe("mining queue controller operations", () => {
  it("adds, dedupes, removes, and clears in insertion order", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();

    controller.toggleQueued("A");
    expect(lastState(controller).queue.normalizedWords).toEqual(["a"]);

    controller.toggleQueued("B");
    expect(lastState(controller).queue.normalizedWords).toEqual(["a", "b"]);

    controller.toggleQueued("A");
    expect(lastState(controller).queue.normalizedWords).toEqual(["a", "b"]);

    controller.removeQueued("A");
    expect(lastState(controller).queue.normalizedWords).toEqual(["b"]);

    controller.clearQueue();
    expect(lastState(controller).queue.normalizedWords).toEqual([]);
  });

  it("persists a snapshot after each mutation", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();

    controller.toggleQueued("A");
    const afterAdd = env.storage.getItem(SESSION_QUEUE_STORAGE_KEY);
    expect(JSON.parse(afterAdd ?? "{}")).toMatchObject({
      version: 1,
      datasetId: "dataset-1",
      normalizedWords: ["a"],
    });

    controller.removeQueued("A");
    const afterRemove = env.storage.getItem(SESSION_QUEUE_STORAGE_KEY);
    expect(JSON.parse(afterRemove ?? "{}")).toMatchObject({ normalizedWords: [] });
  });

  it("restores the queue for the same dataset on a fresh controller", async () => {
    const env = await setup();
    const first = createMinerController(env.options());
    await first.init();
    first.toggleQueued("A");
    first.toggleQueued("B");

    const second = createMinerController(env.options());
    await second.init();

    const queue = lastState(second).queue;
    expect(queue.datasetId).toBe("dataset-1");
    expect(queue.normalizedWords).toEqual(["a", "b"]);
    expect(queue.mode).toBe("normal");
  });

  it("ignores a stored queue belonging to a different dataset", async () => {
    const env = await setup();
    const elsewhere = createSessionQueueStore(env.storage);
    elsewhere.save({ version: 1, datasetId: "another-dataset", normalizedWords: ["x", "y"] });

    const controller = createMinerController(env.options());
    await controller.init();

    expect(lastState(controller).queue).toMatchObject({ datasetId: "dataset-1", normalizedWords: [] });
  });

  it("starts a fresh queue association when a new dataset is imported", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();
    controller.toggleQueued("A");

    env.worker.nextJiten = {
      chunks: [[entry("new", "新しい", 0, 9)]],
      complete: {
        protocolVersion: 1,
        type: "import-complete",
        requestId: "import",
        kind: "jiten",
        name: "next.csv",
        headers: ["Word"],
        entryCount: 1,
        skippedRows: 0,
      },
    };
    await controller.importJiten(fileSource("next.csv"));

    const queue = lastState(controller).queue;
    expect(queue.datasetId).toBe(lastState(controller).dataset?.id);
    expect(queue.datasetId).not.toBe("dataset-1");
    expect(queue.normalizedWords).toEqual([]);
    expect(env.storage.getItem(SESSION_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it("ignores queue toggles when no dataset is active", async () => {
    const env = await setup(null);
    const controller = createMinerController(env.options());
    await controller.init();

    controller.toggleQueued("A");

    expect(lastState(controller).queue.normalizedWords).toEqual([]);
    expect(env.storage.getItem(SESSION_QUEUE_STORAGE_KEY)).toBeNull();
  });
});

describe("queue mode", () => {
  it("refuses to start with an empty queue", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();

    await controller.startQueueMode();

    expect(lastState(controller).queue.mode).toBe("normal");
    expect(env.worker.queryCalls).toHaveLength(1); // only the init query
  });

  it("renders queued words in add order regardless of worker sort", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();
    controller.toggleQueued("C");
    controller.toggleQueued("A");
    controller.toggleQueued("B");

    env.worker.queryHandler = async () => result([withKnown(entry("a", "a")), withKnown(entry("b", "b")), withKnown(entry("c", "c"))]);

    await controller.startQueueMode();

    const state = lastState(controller);
    expect(state.queue.mode).toBe("queue");
    expect(state.result?.items.map((item) => item.normalizedWord)).toEqual(["c", "a", "b"]);

    const queueQuery = env.worker.queryCalls.at(-1);
    expect(queueQuery?.queryChannel).toBe("queue");
    expect(queueQuery?.includeNormalizedWords).toEqual(["c", "a", "b"]);
    expect(queueQuery?.query.pageSize).toBe("all");
    expect(queueQuery?.query.page).toBe(1);
  });

  it("omits queued words that no longer exist in the dataset", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();
    controller.toggleQueued("A");
    controller.toggleQueued(" ghost ");

    env.worker.queryHandler = async () => result([withKnown(entry("a", "a"))]);

    await controller.startQueueMode();

    expect(lastState(controller).result?.items.map((item) => item.normalizedWord)).toEqual(["a"]);
  });

  it("keeps normal query and page state intact and restores it on exit", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();
    controller.updateQuery({ search: "一", page: 1, minOccurrences: 2 });
    const queryBefore = lastState(controller).query;

    controller.toggleQueued("A");
    await controller.startQueueMode();
    expect(lastState(controller).result?.totalEntries).toBe(0); // fake default empty result

    env.worker.queryHandler = async () => result([withKnown(entry("one", "一", 0, 9))]);
    controller.stopQueueMode();
    await Promise.resolve();
    await Promise.resolve();

    const state = lastState(controller);
    expect(state.queue.mode).toBe("normal");
    expect(state.query).toEqual(queryBefore);
    const restoreQuery = env.worker.queryCalls.at(-1);
    expect(restoreQuery?.queryChannel).toBe("user");
    expect(restoreQuery?.query).toMatchObject({ search: "一", minOccurrences: 2 });
  });

  it("keeps worker paging instead of mounting everything past the safety threshold", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();

    const many = Array.from({ length: 5_001 }, (_, index) => `word-${index}`);
    for (const word of many) controller.toggleQueued(word);

    await controller.startQueueMode();

    const queueQuery = env.worker.queryCalls.at(-1);
    expect(queueQuery?.includeNormalizedWords).toHaveLength(5_001);
    expect(queueQuery?.query.pageSize).toBe(50);
    expect(queueQuery?.queryChannel).toBe("queue");
  });
});

describe("queue decision integration", () => {
  it.each(["mined", "known", "later", "skip"] as const)(
    "removes a queued word only after a successful %s decision",
    async (status) => {
      const env = await setup();
      const controller = createMinerController(env.options());
      await controller.init();
      controller.toggleQueued("A");

      await controller.setWordDecision("A", status);

      const state = lastState(controller);
      expect(state.queue.normalizedWords).toEqual([]);
      expect(state.wordDecisions.get("a")?.status).toBe(status);
    },
  );

  it("does not mutate decisions on remove-only queue actions", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();
    controller.toggleQueued("A");
    controller.toggleQueued("B");

    controller.removeQueued("A");

    const state = lastState(controller);
    expect(state.queue.normalizedWords).toEqual(["b"]);
    expect(state.wordDecisions.size).toBe(0);
  });

  it("keeps the word queued and surfaces an error when decision persistence fails", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();
    controller.toggleQueued("A");

    env.store.wordDecisions.set = async () => {
      throw new Error("disk full");
    };

    await controller.setWordDecision("A", "mined");

    const state = lastState(controller);
    expect(state.queue.normalizedWords).toEqual(["a"]);
    expect(state.errorMessage).toContain("could not be saved");
  });

  it("refreshes the queue view after a decision in queue mode", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();
    controller.toggleQueued("A");
    controller.toggleQueued("B");
    env.worker.queryHandler = async (request) =>
      result((request.includeNormalizedWords ?? []).map((word, index) => withKnown(entry(word, word, index))));

    await controller.startQueueMode();
    await controller.setWordDecision("a", "mined");

    const state = lastState(controller);
    expect(state.queue.normalizedWords).toEqual(["b"]);
    expect(state.result?.items.map((item) => item.normalizedWord)).toEqual(["b"]);
  });
});
