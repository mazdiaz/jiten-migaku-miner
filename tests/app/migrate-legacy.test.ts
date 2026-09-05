import { describe, expect, it } from "vitest";
import type { Entry, QueryState, ViewState } from "../../src/domain/types";
import { migrateLegacy } from "../../src/app/migrate-legacy";
import type { WorkerClient } from "../../src/app/worker-client";
import { createMemoryAppStore } from "../../src/storage/memory-store";
import type { AppStore, DatasetMetadata } from "../../src/storage/contracts";
import type {
  ImportCompleteResponse,
  ImportChunkResponse,
  QueryRequest,
} from "../../src/worker/protocol";

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const query: QueryState = {
  search: "",
  hideKnown: false,
  hideKanaOnly: false,
  sentence: "any",
  minOccurrences: 1,
  sort: "occ-desc",
  pageSize: 50,
  page: 1,
};

const view: ViewState = {
  showFurigana: false,
  pillHighlight: false,
  showHighlight: false,
  showDefinitions: true,
};

const oldEntry: Entry = {
  id: "entry-0",
  originalIndex: 0,
  word: "猫",
  normalizedWord: "猫",
  occurrences: 2,
  sentenceRaw: "",
  hasSentence: false,
  definitions: "cat",
  furiganaRuns: [],
};

class FakeWorkerClient implements WorkerClient {
  async importJiten(
    name: string,
    _text: string,
    onChunk?: (chunk: Extract<ImportChunkResponse, { kind: "jiten" }>) => void,
  ): Promise<Extract<ImportCompleteResponse, { kind: "jiten" }>> {
    onChunk?.({
      protocolVersion: 1,
      type: "import-chunk",
      requestId: "legacy-jiten",
      kind: "jiten",
      name,
      chunkIndex: 0,
      entries: [oldEntry],
    });
    return {
      protocolVersion: 1,
      type: "import-complete",
      requestId: "legacy-jiten",
      kind: "jiten",
      name,
      headers: ["Word"],
      entryCount: 1,
      skippedRows: 0,
    };
  }

  async importKnown(
    name: string,
    _text: string,
    onChunk?: (chunk: Extract<ImportChunkResponse, { kind: "known" }>) => void,
  ): Promise<Extract<ImportCompleteResponse, { kind: "known" }>> {
    onChunk?.({
      protocolVersion: 1,
      type: "import-chunk",
      requestId: "legacy-known",
      kind: "known",
      name,
      chunkIndex: 0,
      words: ["猫"],
    });
    return {
      protocolVersion: 1,
      type: "import-complete",
      requestId: "legacy-known",
      kind: "known",
      name,
      wordCount: 1,
    };
  }

  async loadDataset(_datasetId: string, _chunks: AsyncIterable<readonly Entry[]>): Promise<void> {}
  async query(_request: QueryRequest): Promise<never> { throw new Error("not used"); }
  dispose(): void {}
}

function legacyStorage(): TestStorage {
  const storage = new TestStorage();
  storage.setItem("jitenMiner.v1", JSON.stringify({
    mediaFileName: "legacy.csv",
    mediaText: "Word\n猫",
    knownFileName: "known.txt",
    knownText: "猫\n",
  }));
  storage.setItem("jitenMiner.page", "7");
  return storage;
}

function previousMetadata(): DatasetMetadata {
  return {
    id: "previous",
    name: "previous",
    sourceType: "file",
    sourceName: "previous.csv",
    headers: ["Word"],
    entryCount: 1,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    schemaVersion: 1,
  };
}

describe("legacy migration", () => {
  it("stages and verifies migrated records before marking migration complete", async () => {
    const storage = legacyStorage();
    const store = createMemoryAppStore();

    const result = await migrateLegacy({
      storage,
      store,
      worker: new FakeWorkerClient(),
      query,
      view,
      now: () => "2026-09-04T00:00:00.000Z",
      createId: (kind) => `migrated-${kind}`,
    });

    expect(result.migrated).toBe(true);
    expect(result.warning).toBeNull();
    expect(storage.getItem("jitenMiner.v1")).toContain("legacy.csv");
    expect(storage.getItem("jitenMiner.page")).toBe("7");
    expect(storage.getItem("jitenMiner.migration")).toBe("1");
    expect(await store.datasets.getActive()).toMatchObject({
      id: "migrated-media",
      sourceName: "legacy.csv",
      entryCount: 1,
    });
    expect(await store.knownWords.getActive()).toMatchObject({
      id: "migrated-known",
      words: new Set(["猫"]),
    });
    expect(await store.preferences.load()).toEqual({ query: { ...query, page: 7 }, view, page: 7 });
  });

  it("rejects migration when saved known-word record has an unexpected identity", async () => {
    const storage = legacyStorage();
    const store = createMemoryAppStore();
    const originalSave = store.knownWords.save.bind(store.knownWords);
    store.knownWords.save = async (_id, name, words) => originalSave("wrong-known-id", name, words);

    const result = await migrateLegacy({
      storage,
      store,
      worker: new FakeWorkerClient(),
      query,
      view,
      createId: (kind) => `migrated-${kind}`,
    });

    expect(result.migrated).toBe(false);
    expect(result.warning).toContain("verification");
    expect(storage.getItem("jitenMiner.migration")).toBeNull();
    expect(await store.knownWords.getActive()).toBeNull();
  });

  it("retains legacy keys and warning when migration parsing fails", async () => {
    const storage = legacyStorage();
    storage.setItem("jitenMiner.v1", "{broken");
    const store = createMemoryAppStore();

    const result = await migrateLegacy({
      storage,
      store,
      worker: new FakeWorkerClient(),
      query,
      view,
    });

    expect(result.migrated).toBe(false);
    expect(result.warning).toContain("migration");
    expect(storage.getItem("jitenMiner.v1")).toBe("{broken");
    expect(storage.getItem("jitenMiner.page")).toBe("7");
    expect(storage.getItem("jitenMiner.migration")).toBeNull();
  });

  it("retains legacy keys when persistence fails after parsing", async () => {
    const storage = legacyStorage();
    const base = createMemoryAppStore();
    const store: AppStore = {
      ...base,
      datasets: {
        ...base.datasets,
        stage: async () => { throw new Error("storage unavailable"); },
      },
      clearAll: () => base.clearAll(),
    };

    const result = await migrateLegacy({
      storage,
      store,
      worker: new FakeWorkerClient(),
      query,
      view,
    });

    expect(result.warning).toContain("storage unavailable");
    expect(storage.getItem("jitenMiner.migration")).toBeNull();
    expect(storage.getItem("jitenMiner.v1")).not.toBeNull();
  });

  it("rolls back dataset, known words, and preferences when commit fails", async () => {
    const storage = legacyStorage();
    const store = createMemoryAppStore();
    const previous = previousMetadata();
    await store.datasets.stage(previous, (async function* () {
      yield [oldEntry];
    })());
    await store.datasets.activate(previous.id);
    await store.knownWords.save("old-known", "old-known.txt", ["犬"]);
    await store.preferences.save({ query: { ...query, page: 3 }, view, page: 3 });
    const savePreferences = store.preferences.save.bind(store.preferences);
    store.preferences.save = async (value) => {
      if (value.page === 7) throw new Error("preference commit failed");
      return savePreferences(value);
    };

    const result = await migrateLegacy({
      storage,
      store,
      worker: new FakeWorkerClient(),
      query,
      view,
      createId: (kind) => `migrated-${kind}`,
    });

    expect(result.migrated).toBe(false);
    expect(result.warning).toContain("preference commit failed");
    expect(await store.datasets.getActive()).toEqual(previous);
    expect((await store.datasets.list()).map((dataset) => dataset.id)).toEqual(["previous"]);
    expect(await store.knownWords.getActive()).toMatchObject({ id: "old-known", words: new Set(["犬"]) });
    expect(await store.preferences.load()).toEqual({ query: { ...query, page: 3 }, view, page: 3 });
    expect(storage.getItem("jitenMiner.migration")).toBeNull();
  });

  it("does not mark migration complete when legacy fields have invalid types", async () => {
    const storage = legacyStorage();
    storage.setItem("jitenMiner.v1", JSON.stringify({ mediaText: 42, knownText: { words: [] } }));
    const store = createMemoryAppStore();

    const result = await migrateLegacy({
      storage,
      store,
      worker: new FakeWorkerClient(),
      query,
      view,
    });

    expect(result.migrated).toBe(false);
    expect(result.warning).toContain("mediaText");
    expect(storage.getItem("jitenMiner.migration")).toBeNull();
    expect(storage.getItem("jitenMiner.v1")).toContain("mediaText");
  });
});
