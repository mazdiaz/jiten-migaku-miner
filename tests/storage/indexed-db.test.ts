import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexedDbAppStore } from "../../src/storage/indexed-db";
import type { AppStore, DatasetMetadata } from "../../src/storage/contracts";
import type { Entry, QueryState, ViewState } from "../../src/domain/types";

const databaseName = "jiten-migaku-miner-task-4-test";

const metadata = (id: string): DatasetMetadata => ({
  id,
  name: `${id} dataset`,
  sourceType: "file",
  sourceName: `${id}.csv`,
  headers: ["Word", "Occurrences"],
  entryCount: 3,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  schemaVersion: 1,
});

const entry = (id: string, originalIndex: number): Entry => ({
  id,
  originalIndex,
  word: `word-${originalIndex}`,
  normalizedWord: `word-${originalIndex}`,
  occurrences: originalIndex + 1,
  sentenceRaw: "",
  hasSentence: false,
  definitions: "",
  furiganaRuns: [],
});

async function* chunks(values: readonly (readonly Entry[])[]): AsyncIterable<readonly Entry[]> {
  for (const value of values) {
    yield value;
  }
}

async function* failingChunks(first: Entry): AsyncIterable<readonly Entry[]> {
  yield [first];
  throw new Error("import failed");
}

async function collectChunks(source: AsyncIterable<Entry[]>): Promise<Entry[][]> {
  const result: Entry[][] = [];
  for await (const chunk of source) {
    result.push(chunk);
  }
  return result;
}

const query: QueryState = {
  search: "word",
  hideKnown: true,
  hideKanaOnly: false,
  sentence: "any",
  minOccurrences: 1,
  sort: "occ-desc",
  pageSize: 50,
  page: 2,
  decision: "all",
};

const view: ViewState = {
  showFurigana: true,
  pillHighlight: false,
  showHighlight: true,
  showDefinitions: false,
};

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not delete test database"));
    request.onblocked = () => reject(new Error("Test database deletion was blocked"));
  });
}

describe("IndexedDbAppStore", () => {
  afterEach(async () => {
    await deleteDatabase(databaseName);
  });

  it("keeps staged data inactive until an explicit activation", async () => {
    const store: AppStore = createIndexedDbAppStore(databaseName);

    await store.datasets.stage(
      metadata("first"),
      chunks([[entry("entry-0", 0), entry("entry-1", 1)]]),
    );

    expect(await store.datasets.getActive()).toBeNull();
    expect(await store.datasets.list()).toEqual([metadata("first")]);

    await store.datasets.activate("first");

    expect(await store.datasets.getActive()).toEqual(metadata("first"));
  });

  it("creates version 1 schema with required object stores", async () => {
    const store = createIndexedDbAppStore(databaseName);
    await store.datasets.list();

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open test database"));
    });

    expect(database.version).toBe(1);
    expect([...database.objectStoreNames]).toEqual(
      expect.arrayContaining([
        "datasets",
        "entryChunks",
        "knownWordSets",
        "preferences",
        "meta",
      ]),
    );
    expect(database.objectStoreNames.length).toBe(5);
    database.close();
  });

  it("round-trips entries in order and requested chunk sizes", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const values = [entry("entry-0", 0), entry("entry-1", 1), entry("entry-2", 2)];

    await store.datasets.stage(
      metadata("ordered"),
      chunks([[values[0]!], [values[1]!, values[2]!]]),
    );

    await expect(
      collectChunks(store.datasets.readChunks("ordered", 2)),
    ).resolves.toEqual([[values[0]!, values[1]!], [values[2]!]]);
  });

  it("keeps multiple datasets and removes only the requested dataset", async () => {
    const store = createIndexedDbAppStore(databaseName);

    await store.datasets.stage(metadata("one"), chunks([[entry("one-entry", 0)]]));
    await store.datasets.stage(metadata("two"), chunks([[entry("two-entry", 1)]]));
    await store.datasets.activate("two");
    await store.datasets.remove("one");

    expect(await store.datasets.list()).toEqual([metadata("two")]);
    expect(await store.datasets.getActive()).toEqual(metadata("two"));
    await expect(
      collectChunks(store.datasets.readChunks("two", 10)),
    ).resolves.toEqual([[entry("two-entry", 1)]]);
  });

  it("rejects same-ID staging without replacing the active dataset", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const active = metadata("same-id");

    await store.datasets.stage(active, chunks([[entry("old-entry", 0)]]));
    await store.datasets.activate(active.id);

    await expect(
      store.datasets.stage(active, chunks([[entry("new-entry", 1)]])),
    ).rejects.toThrow("Dataset already exists");

    expect(await store.datasets.getActive()).toEqual(active);
    await expect(
      collectChunks(store.datasets.readChunks(active.id, 10)),
    ).resolves.toEqual([[entry("old-entry", 0)]]);
  });

  it("reads entry chunks with bounded IndexedDB batches", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const values = Array.from({ length: 40 }, (_, index) => entry(`entry-${index}`, index));
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");

    await store.datasets.stage(
      metadata("batched"),
      chunks(values.map((value) => [value])),
    );
    await expect(
      collectChunks(store.datasets.readChunks("batched", 7)),
    ).resolves.toEqual([
      values.slice(0, 7),
      values.slice(7, 14),
      values.slice(14, 21),
      values.slice(21, 28),
      values.slice(28, 35),
      values.slice(35),
    ]);

    const counts = getAll.mock.calls.map((call) => call[1]);
    getAll.mockRestore();
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((count) => typeof count === "number" && count > 0 && count <= 32)).toBe(
      true,
    );
  });

  it("round-trips known words and preferences", async () => {
    const store = createIndexedDbAppStore(databaseName);

    await store.knownWords.save("known", "Known words", ["alpha", "beta", "alpha"]);
    await store.preferences.save({ query, view, page: 3 });

    expect(await store.knownWords.getActive()).toEqual({
      id: "known",
      name: "Known words",
      words: new Set(["alpha", "beta"]),
    });
    expect(await store.preferences.load()).toEqual({ query, view, page: 3 });
  });

  it("removes every store on clearAll", async () => {
    const store = createIndexedDbAppStore(databaseName);

    await store.datasets.stage(metadata("clear-me"), chunks([[entry("entry-0", 0)]]));
    await store.datasets.activate("clear-me");
    await store.knownWords.save("known", "Known words", ["alpha"]);
    await store.preferences.save({ query, view, page: 1 });

    await store.clearAll();

    expect(await store.datasets.list()).toEqual([]);
    expect(await store.datasets.getActive()).toBeNull();
    expect(await store.knownWords.getActive()).toBeNull();
    expect(await store.preferences.load()).toBeNull();
  });

  it("does not leave partial data or replace active data when staging fails", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const previous = metadata("previous");

    await store.datasets.stage(previous, chunks([[entry("previous-entry", 0)]]));
    await store.datasets.activate(previous.id);

    await expect(
      store.datasets.stage(metadata("failed"), failingChunks(entry("partial", 1))),
    ).rejects.toThrow("import failed");

    expect(await store.datasets.getActive()).toEqual(previous);
    expect(await store.datasets.list()).toEqual([previous]);
    await expect(
      collectChunks(store.datasets.readChunks("failed", 10)),
    ).rejects.toThrow("Dataset not found");
  });

  it("surfaces cleanup failures after a failed import", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const previous = metadata("previous");

    await store.datasets.stage(previous, chunks([[entry("previous-entry", 0)]]));
    await store.datasets.activate(previous.id);

    const originalDelete = IDBObjectStore.prototype.delete;
    let deleteCalls = 0;
    const deleteSpy = vi
      .spyOn(IDBObjectStore.prototype, "delete")
      .mockImplementation(function (
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ) {
        deleteCalls += 1;
        if (deleteCalls >= 2) {
          throw new Error("cleanup failed");
        }
        return originalDelete.call(this, query);
      });

    await expect(
      store.datasets.stage(metadata("failed"), failingChunks(entry("partial", 1))),
    ).rejects.toThrow("cleanup failed");

    deleteSpy.mockRestore();
    expect(await store.datasets.getActive()).toEqual(previous);
  });
});
