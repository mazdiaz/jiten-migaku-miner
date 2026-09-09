import { describe, expect, it } from "vitest";
import type { MinerControllerOptions } from "../../src/app/controller";
import { createMinerController } from "../../src/app/controller";
import type { AppState } from "../../src/app/state";
import type {
  WorkerClient,
  WorkerCoverageInput,
  WorkerQueryInput,
} from "../../src/app/worker-client";
import type { Entry, QueryResult } from "../../src/domain/types";
import { createSessionQueueStore } from "../../src/platform/session-queue";
import type { AppStore } from "../../src/storage/contracts";
import { isStorageUnavailableError, StorageUnavailableError } from "../../src/storage/fallback";
import { createMemoryAppStore } from "../../src/storage/memory-store";
import type { ImportCompleteResponse } from "../../src/worker/protocol";

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

function withKnown(value: Entry): Entry & {
  known: boolean;
  knownByMigaku: boolean;
  knownByDecision: boolean;
  decision: "unreviewed";
} {
  return {
    ...value,
    known: false,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed",
  };
}

function metadata(id: string): {
  id: string;
  name: string;
  sourceType: "file";
  sourceName: string;
  headers: string[];
  entryCount: number;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
} {
  return {
    id,
    name: id,
    sourceType: "file",
    sourceName: `${id}.csv`,
    headers: ["Word"],
    entryCount: 1,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
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
    knownCount: 0,
    windowed: false,
  };
}

class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
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

class FakeWorkerClient implements WorkerClient {
  async importJiten(name: string): Promise<Extract<ImportCompleteResponse, { kind: "jiten" }>> {
    return {
      protocolVersion: 2,
      type: "import-complete",
      requestId: "import",
      kind: "jiten",
      name,
      headers: ["Word"],
      entryCount: 1,
      skippedRows: 0,
    };
  }

  async importKnown(name: string): Promise<Extract<ImportCompleteResponse, { kind: "known" }>> {
    return {
      protocolVersion: 2,
      type: "import-complete",
      requestId: "known",
      kind: "known",
      name,
      wordCount: 0,
    };
  }

  async loadDataset(_datasetId: string, chunks: AsyncIterable<readonly Entry[]>): Promise<void> {
    for await (const chunk of chunks) void chunk;
  }

  async query(_request: WorkerQueryInput): Promise<QueryResult> {
    return result([withKnown(entry("one", "ねこ", 0))]);
  }

  async coverage(_request: WorkerCoverageInput): Promise<ReturnType<typeof coverageStats>> {
    return coverageStats();
  }

  dispose(): void {}
}

function coverageStats() {
  return {
    totalUniqueWords: 1,
    knownUniqueWords: 0,
    unknownUniqueWords: 1,
    totalTrackedOccurrences: 3,
    knownTrackedOccurrences: 0,
    unknownTrackedOccurrences: 3,
    coveragePercent: 0,
    targets: [],
  };
}

async function seedActive(store: AppStore): Promise<void> {
  await store.datasets.stage(
    metadata("dataset-1"),
    (async function* () {
      yield [entry("one", "ねこ", 0)];
    })(),
  );
  await store.datasets.activate("dataset-1");
}

function capture(controller: ReturnType<typeof createMinerController>): Readonly<AppState> {
  let captured: Readonly<AppState> | null = null;
  const unsubscribe = controller.subscribe((state) => {
    captured = state;
  });
  unsubscribe();
  if (captured === null) throw new Error("controller did not publish state");
  return captured;
}

function options(store: AppStore, worker: WorkerClient, storage: Storage): MinerControllerOptions {
  return {
    indexedDbStoreFactory: () => store,
    worker,
    legacyStorage: storage,
    sessionQueueStore: createSessionQueueStore(storage),
  };
}

describe("isStorageUnavailableError", () => {
  it("classifies engine-level failures as unavailable", () => {
    expect(isStorageUnavailableError(new StorageUnavailableError("db gone"))).toBe(true);
    expect(isStorageUnavailableError(new DOMException("denied", "SecurityError"))).toBe(true);
    expect(isStorageUnavailableError(new DOMException("quota", "QuotaExceededError"))).toBe(true);
    expect(isStorageUnavailableError(new DOMException("closed", "InvalidStateError"))).toBe(true);
    expect(isStorageUnavailableError(new TypeError("indexedDB is not defined"))).toBe(true);
  });

  it("classifies application and invariant failures as NOT unavailable", () => {
    expect(isStorageUnavailableError(new Error("import count did not match"))).toBe(false);
    expect(isStorageUnavailableError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isStorageUnavailableError(new TypeError("cannot read properties of undefined"))).toBe(
      false,
    );
    expect(isStorageUnavailableError("plain string failure")).toBe(false);
  });
});

describe("storage fallback classification", () => {
  it("falls back to memory on a simulated backend failure and transfers user state", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    await store.knownWords.save("known", "known.txt", new Set(["いぬ"]));
    let fail = false;
    store.wordDecisions.set = async (decision) => {
      if (fail) throw new DOMException("backend vanished", "SecurityError");
      await store.wordDecisions.replaceAll([decision]);
    };
    const storage = new FakeStorage();
    const controller = createMinerController(options(store, new FakeWorkerClient(), storage));
    await controller.init();

    fail = true;
    await controller.setWordDecision("ねこ", "mined");

    const state = capture(controller);
    expect(state.persistence).toBe("memory");
    // The fallback warning is user-visible.
    expect(state.errorMessage).toContain("IndexedDB unavailable");
    // The retried write landed on the replacement store and the decision is live.
    expect(state.wordDecisions.get("ねこ")?.status).toBe("mined");
    // Known words were transferred into the replacement store.
    const replacementKnown = await store.knownWords.getActive();
    expect(replacementKnown?.words).toEqual(new Set(["いぬ"]));
  });

  it("does not silently switch to memory on an application error", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    store.wordDecisions.set = async () => {
      throw new Error("decision write invariant violated");
    };
    const controller = createMinerController(
      options(store, new FakeWorkerClient(), new FakeStorage()),
    );
    await controller.init();

    await controller.setWordDecision("ねこ", "mined");

    const state = capture(controller);
    expect(state.persistence).toBe("indexeddb");
    expect(state.errorMessage).toContain("Word decision could not be saved");
    expect(state.errorMessage).toContain("decision write invariant violated");
    // No silent success: the decision is not present.
    expect(state.wordDecisions.has("ねこ")).toBe(false);
  });

  it("does not retry an operation that failed with an invariant error", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    let writes = 0;
    store.wordDecisions.set = async (decision) => {
      writes += 1;
      await store.wordDecisions.replaceAll([decision]);
      throw new Error("post-write verification failed");
    };
    const controller = createMinerController(
      options(store, new FakeWorkerClient(), new FakeStorage()),
    );
    await controller.init();

    await controller.setWordDecision("ねこ", "known");

    // Exactly one execution: the failed attempt is never re-run on a
    // replacement store, so side effects cannot double-apply.
    expect(writes).toBe(1);
    expect(capture(controller).persistence).toBe("indexeddb");
  });

  it("keeps the fallback warning visible across subsequent publishes", async () => {
    const store = createMemoryAppStore();
    await seedActive(store);
    const memoryPreferences = store.preferences.save.bind(store.preferences);
    let fail = false;
    store.preferences.save = async (value) => {
      if (fail) throw new DOMException("storage reset", "UnknownError");
      await memoryPreferences(value);
    };
    const controller = createMinerController(
      options(store, new FakeWorkerClient(), new FakeStorage()),
    );
    await controller.init();

    fail = true;
    controller.updateView({ showDefinitions: false });
    for (let round = 0; round < 8; round += 1) await Promise.resolve();
    const state = capture(controller);
    expect(state.persistence).toBe("memory");
    expect(state.errorMessage?.toLowerCase()).toContain("memory");
  });
});
