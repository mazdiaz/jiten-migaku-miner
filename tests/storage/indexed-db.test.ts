import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../../src/domain/anki";
import type { Entry, QueryState, ViewState, WordDecision } from "../../src/domain/types";
import type { AppStore, DatasetMetadata } from "../../src/storage/contracts";
import { createIndexedDbAppStore } from "../../src/storage/indexed-db";

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
  sentenceSize: "large",
  density: "compact",
};

const decision = (
  normalizedWord: string,
  status: WordDecision["status"],
  updatedAt: string,
): WordDecision => ({
  normalizedWord,
  status,
  updatedAt,
});

function openVersion1Database(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("datasets", { keyPath: "id" });
      database.createObjectStore("entryChunks", {
        keyPath: ["datasetId", "chunkIndex"],
      });
      database.createObjectStore("knownWordSets", { keyPath: "id" });
      database.createObjectStore("preferences", { keyPath: "id" });
      database.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(
        ["datasets", "entryChunks", "knownWordSets", "preferences", "meta"],
        "readwrite",
      );
      transaction.objectStore("datasets").put({
        ...metadata("legacy"),
        ready: true,
      });
      transaction.objectStore("entryChunks").put({
        datasetId: "legacy",
        chunkIndex: 0,
        entries: [entry("legacy-entry", 0)],
      });
      transaction.objectStore("knownWordSets").put({
        id: "migaku",
        name: "Migaku known words",
        words: ["透過"],
      });
      transaction.objectStore("preferences").put({
        id: "current",
        query,
        view,
        page: 1,
      });
      transaction.objectStore("meta").put({
        key: "activeDatasetId",
        value: "legacy",
      });
      transaction.objectStore("meta").put({
        key: "activeKnownWordSetId",
        value: "migaku",
      });
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Could not create version 1 database"));
  });
}

function openRawDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open test database"));
  });
}

function readAnkiSyncRecord(name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["ankiSync"], "readonly");
      const record = transaction.objectStore("ankiSync").get("current");
      transaction.oncomplete = () => {
        database.close();
        resolve(record.result);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open test database"));
  });
}

function readRestoreDiagnostics(name: string): Promise<{
  knownSets: Array<{ id: string }>;
  activeKnown: string | null;
}> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["knownWordSets", "meta"], "readonly");
      const knownSets: Array<{ id: string }> = [];
      const knownRequest = transaction.objectStore("knownWordSets").getAll();
      knownRequest.onsuccess = () => {
        for (const record of knownRequest.result as Array<{ id: string }>) {
          knownSets.push({ id: record.id });
        }
      };
      const metaRequest = transaction.objectStore("meta").get("activeKnownWordSetId");
      metaRequest.onsuccess = () => {
        const value = (metaRequest.result as { value: string } | undefined)?.value ?? null;
        database.close();
        resolve({ knownSets, activeKnown: value });
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open test database"));
  });
}

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

  it("creates version 3 schema with required object stores", async () => {
    const store = createIndexedDbAppStore(databaseName);
    await store.datasets.list();

    const database = await openRawDatabase(databaseName);
    try {
      expect(database.version).toBe(3);
      expect([...database.objectStoreNames]).toEqual(
        expect.arrayContaining([
          "datasets",
          "entryChunks",
          "knownWordSets",
          "preferences",
          "meta",
          "wordDecisions",
          "ankiSync",
        ]),
      );
      expect(database.objectStoreNames.length).toBe(7);
      expect(database.transaction(["ankiSync"], "readonly").objectStore("ankiSync").keyPath).toBe(
        "id",
      );
    } finally {
      database.close();
    }
  });

  it("upgrades a version 1 database in place without losing data", async () => {
    await openVersion1Database(databaseName);

    const store = createIndexedDbAppStore(databaseName);

    expect(await store.datasets.list()).toEqual([metadata("legacy")]);
    expect(await store.datasets.getActive()).toEqual(metadata("legacy"));
    await expect(collectChunks(store.datasets.readChunks("legacy", 10))).resolves.toEqual([
      [entry("legacy-entry", 0)],
    ]);
    expect(await store.knownWords.getActive()).toEqual({
      id: "migaku",
      name: "Migaku known words",
      words: new Set(["透過"]),
    });
    expect(await store.preferences.load()).toEqual({ query, view, page: 1 });

    const database = await openRawDatabase(databaseName);
    try {
      expect(database.version).toBe(3);
      expect(database.objectStoreNames.length).toBe(7);
      expect([...database.objectStoreNames]).toContain("wordDecisions");
      expect([...database.objectStoreNames]).toContain("ankiSync");
    } finally {
      database.close();
    }
  });

  it("round-trips entries in order and requested chunk sizes", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const values = [entry("entry-0", 0), entry("entry-1", 1), entry("entry-2", 2)];

    await store.datasets.stage(
      metadata("ordered"),
      chunks([[values[0]!], [values[1]!, values[2]!]]),
    );

    await expect(collectChunks(store.datasets.readChunks("ordered", 2))).resolves.toEqual([
      [values[0]!, values[1]!],
      [values[2]!],
    ]);
  });

  it("keeps multiple datasets and removes only the requested dataset", async () => {
    const store = createIndexedDbAppStore(databaseName);

    await store.datasets.stage(metadata("one"), chunks([[entry("one-entry", 0)]]));
    await store.datasets.stage(metadata("two"), chunks([[entry("two-entry", 1)]]));
    await store.datasets.activate("two");
    await store.datasets.remove("one");

    expect(await store.datasets.list()).toEqual([metadata("two")]);
    expect(await store.datasets.getActive()).toEqual(metadata("two"));
    await expect(collectChunks(store.datasets.readChunks("two", 10))).resolves.toEqual([
      [entry("two-entry", 1)],
    ]);
  });

  it("rejects same-ID staging without replacing the active dataset", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const active = metadata("same-id");

    await store.datasets.stage(active, chunks([[entry("old-entry", 0)]]));
    await store.datasets.activate(active.id);

    await expect(store.datasets.stage(active, chunks([[entry("new-entry", 1)]]))).rejects.toThrow(
      "Dataset already exists",
    );

    expect(await store.datasets.getActive()).toEqual(active);
    await expect(collectChunks(store.datasets.readChunks(active.id, 10))).resolves.toEqual([
      [entry("old-entry", 0)],
    ]);
  });

  it("reads entry chunks with bounded IndexedDB batches", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const values = Array.from({ length: 40 }, (_, index) => entry(`entry-${index}`, index));
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");

    await store.datasets.stage(metadata("batched"), chunks(values.map((value) => [value])));
    await expect(collectChunks(store.datasets.readChunks("batched", 7))).resolves.toEqual([
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

  it("round-trips and replaces Anki config and snapshot independently", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const config: AnkiSyncConfig = {
      deckScope: { kind: "deck", name: "MAIN::Mining" },
      noteType: "Mine",
      targetField: "Word",
    };
    const snapshot: AnkiSyncSnapshot = {
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [
        ["word", "mined"],
        ["known-word", "known"],
      ],
    };

    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);

    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);

    await store.ankiSync.replaceSnapshot({
      syncedAt: "2026-09-10T11:00:00.000Z",
      statuses: [],
    });
    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T11:00:00.000Z",
      statuses: [],
    });

    await store.ankiSync.saveConfig({
      deckScope: { kind: "all-decks" },
      noteType: "Updated",
      targetField: "Expression",
    });
    expect(await store.ankiSync.loadConfig()).toEqual({
      deckScope: { kind: "all-decks" },
      noteType: "Updated",
      targetField: "Expression",
    });
    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T11:00:00.000Z",
      statuses: [],
    });

    expect(await readAnkiSyncRecord(databaseName)).toEqual({
      id: "current",
      config: {
        deckScope: { kind: "all-decks" },
        noteType: "Updated",
        targetField: "Expression",
      },
      snapshot: {
        syncedAt: "2026-09-10T11:00:00.000Z",
        statuses: [],
      },
    });
    await store.ankiSync.replaceSnapshot(null);
    expect(await store.ankiSync.loadConfig()).toEqual({
      deckScope: { kind: "all-decks" },
      noteType: "Updated",
      targetField: "Expression",
    });
    expect(await store.ankiSync.loadSnapshot()).toBeNull();
    await store.ankiSync.clear();
    expect(await store.ankiSync.loadConfig()).toBeNull();
    expect(await store.ankiSync.loadSnapshot()).toBeNull();
    expect(await readAnkiSyncRecord(databaseName)).toBeUndefined();
  });

  it("defaults config to null when replacing a snapshot in a fresh store", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const snapshot: AnkiSyncSnapshot = {
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [["word", "mined"]],
    };

    await store.ankiSync.replaceSnapshot(snapshot);

    expect(await store.ankiSync.loadConfig()).toBeNull();
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
  });

  it("defaults snapshot to null when saving config in a fresh store", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const config: AnkiSyncConfig = {
      deckScope: { kind: "all-decks" },
      noteType: "Mine",
      targetField: "Word",
    };

    await store.ankiSync.saveConfig(config);

    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toBeNull();
  });

  it("returns defensive copies of nested Anki config and snapshot values", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const config: AnkiSyncConfig = {
      deckScope: { kind: "deck", name: "MAIN::Mining" },
      noteType: "Mine",
      targetField: "Word",
    };
    const snapshot: AnkiSyncSnapshot = {
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [["word", "mined"]],
    };

    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);

    config.deckScope = { kind: "deck", name: "MUTATED" };
    config.noteType = "Changed";
    snapshot.statuses[0]![0] = "changed-word";
    snapshot.statuses.push(["added-word", "known"]);

    expect(await store.ankiSync.loadConfig()).toEqual({
      deckScope: { kind: "deck", name: "MAIN::Mining" },
      noteType: "Mine",
      targetField: "Word",
    });
    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [["word", "mined"]],
    });

    const loadedConfig = await store.ankiSync.loadConfig();
    const loadedSnapshot = await store.ankiSync.loadSnapshot();
    if (loadedConfig?.deckScope.kind === "deck") {
      loadedConfig.deckScope.name = "READ-MUTATED";
    }
    if (loadedSnapshot !== null) {
      loadedSnapshot.statuses[0]![1] = "known";
    }

    expect(await store.ankiSync.loadConfig()).toEqual({
      deckScope: { kind: "deck", name: "MAIN::Mining" },
      noteType: "Mine",
      targetField: "Word",
    });
    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [["word", "mined"]],
    });
  });

  it("removes every store on clearAll", async () => {
    const store = createIndexedDbAppStore(databaseName);

    await store.datasets.stage(metadata("clear-me"), chunks([[entry("entry-0", 0)]]));
    await store.datasets.activate("clear-me");
    await store.knownWords.save("known", "Known words", ["alpha"]);
    await store.preferences.save({ query, view, page: 1 });
    await store.wordDecisions.set(decision("透過", "known", "2026-09-05T00:00:00.000Z"));
    await store.ankiSync.saveConfig({
      deckScope: { kind: "all-decks" },
      noteType: "Mine",
      targetField: "Word",
    });
    await store.ankiSync.replaceSnapshot({
      syncedAt: "2026-09-05T00:00:00.000Z",
      statuses: [["透過", "known"]],
    });

    await store.clearAll();

    expect(await store.datasets.list()).toEqual([]);
    expect(await store.datasets.getActive()).toBeNull();
    expect(await store.knownWords.getActive()).toBeNull();
    expect(await store.preferences.load()).toBeNull();
    expect(await store.wordDecisions.list()).toEqual([]);
    expect(await store.ankiSync.loadConfig()).toBeNull();
    expect(await store.ankiSync.loadSnapshot()).toBeNull();
  });

  it("round-trips word decisions and removes them by word", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const record = decision("透過", "known", "2026-09-05T00:00:00.000Z");

    await store.wordDecisions.set(record);

    expect(await store.wordDecisions.get("透過")).toEqual(record);
    expect(await store.wordDecisions.get("unknown-word")).toBeNull();
    expect(await store.wordDecisions.list()).toEqual([record]);

    await store.wordDecisions.set(decision("透過", "mined", "2026-09-05T01:00:00.000Z"));

    expect(await store.wordDecisions.get("透過")).toEqual(
      decision("透過", "mined", "2026-09-05T01:00:00.000Z"),
    );

    await store.wordDecisions.remove("透過");

    expect(await store.wordDecisions.get("透過")).toBeNull();
    expect(await store.wordDecisions.list()).toEqual([]);
  });

  it("keeps decisions and other data intact across reopen", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const record = decision("遠い", "later", "2026-09-05T00:00:00.000Z");

    await store.wordDecisions.set(record);
    await store.knownWords.save("known", "Known words", ["alpha"]);
    await store.preferences.save({ query, view, page: 2 });

    const reopened = createIndexedDbAppStore(databaseName);

    expect(await reopened.wordDecisions.get("遠い")).toEqual(record);
    expect(await reopened.knownWords.getActive()).toEqual({
      id: "known",
      name: "Known words",
      words: new Set(["alpha"]),
    });
    expect(await reopened.preferences.load()).toEqual({ query, view, page: 2 });
  });

  it("replaceAll removes old decisions and inserts the new set", async () => {
    const store = createIndexedDbAppStore(databaseName);

    await store.wordDecisions.set(decision("古い", "known", "2026-09-01T00:00:00.000Z"));
    await store.wordDecisions.set(decision("消える", "skip", "2026-09-02T00:00:00.000Z"));

    await store.wordDecisions.replaceAll([
      decision("新しい", "mined", "2026-09-05T00:00:00.000Z"),
      decision("透過", "later", "2026-09-05T01:00:00.000Z"),
    ]);

    expect(await store.wordDecisions.list()).toEqual([
      decision("新しい", "mined", "2026-09-05T00:00:00.000Z"),
      decision("透過", "later", "2026-09-05T01:00:00.000Z"),
    ]);
    expect(await store.wordDecisions.get("古い")).toBeNull();
    expect(await store.wordDecisions.get("消える")).toBeNull();
  });

  it("replaceAll with an empty array clears all decisions", async () => {
    const store = createIndexedDbAppStore(databaseName);

    await store.wordDecisions.set(decision("透過", "known", "2026-09-05T00:00:00.000Z"));
    await store.wordDecisions.replaceAll([]);

    expect(await store.wordDecisions.list()).toEqual([]);
  });

  it("replaceAll leaves existing decisions untouched when the replacement has duplicates", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const original = decision("透過", "known", "2026-09-05T00:00:00.000Z");
    await store.wordDecisions.set(original);

    await expect(
      store.wordDecisions.replaceAll([
        decision("新しい", "mined", "2026-09-05T00:00:00.000Z"),
        decision("新しい", "skip", "2026-09-05T01:00:00.000Z"),
      ]),
    ).rejects.toThrow("Duplicate word decision");

    expect(await store.wordDecisions.list()).toEqual([original]);
  });

  it("restoreUserState commits all categories atomically and removes orphaned known sets", async () => {
    const store: AppStore = createIndexedDbAppStore(databaseName);
    await store.knownWords.save("set-a", "Set A", ["alpha"]);
    await store.wordDecisions.set(decision("古い", "skip", "2026-09-01T00:00:00.000Z"));
    await store.preferences.save({ query, view, page: 1 });

    await store.restoreUserState?.({
      knownWords: {
        id: "set-b",
        name: "Set B",
        words: ["beta", "gamma", "beta"],
      },
      decisions: [
        decision("新しい", "mined", "2026-09-05T00:00:00.000Z"),
        decision("透過", "later", "2026-09-05T01:00:00.000Z"),
      ],
      preferences: { query, view, page: 4 },
      ankiSync: {
        config: { deckScope: { kind: "all-decks" }, noteType: "Mine", targetField: "Word" },
        snapshot: { syncedAt: "2026-09-05T00:00:00.000Z", statuses: [["新しい", "mined"]] },
      },
    });

    expect(await store.knownWords.getActive()).toEqual({
      id: "set-b",
      name: "Set B",
      words: new Set(["beta", "gamma"]),
    });
    expect(await store.wordDecisions.list()).toEqual([
      decision("新しい", "mined", "2026-09-05T00:00:00.000Z"),
      decision("透過", "later", "2026-09-05T01:00:00.000Z"),
    ]);
    expect(await store.preferences.load()).toEqual({ query, view, page: 4 });
    expect(await store.ankiSync.loadConfig()).toEqual({
      deckScope: { kind: "all-decks" },
      noteType: "Mine",
      targetField: "Word",
    });
    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-05T00:00:00.000Z",
      statuses: [["新しい", "mined"]],
    });
    const diagnostics = await readRestoreDiagnostics(databaseName);
    expect(diagnostics.knownSets).toEqual([{ id: "set-b" }]);
    expect(diagnostics.activeKnown).toBe("set-b");
  });

  it("restoreUserState with null knownWords removes the prior set and clears the pointer", async () => {
    const store: AppStore = createIndexedDbAppStore(databaseName);
    await store.knownWords.save("set-a", "Set A", ["alpha"]);
    await store.wordDecisions.set(decision("古い", "skip", "2026-09-01T00:00:00.000Z"));
    await store.preferences.save({ query, view, page: 1 });
    await store.ankiSync.saveConfig({
      deckScope: { kind: "all-decks" },
      noteType: "Mine",
      targetField: "Word",
    });
    await store.ankiSync.replaceSnapshot({
      syncedAt: "2026-09-01T00:00:00.000Z",
      statuses: [["古い", "known"]],
    });

    await store.restoreUserState?.({
      knownWords: null,
      decisions: [],
      preferences: { query, view, page: 1 },
    });

    expect(await store.knownWords.getActive()).toBeNull();
    expect(await store.wordDecisions.list()).toEqual([]);
    expect(await store.ankiSync.loadConfig()).toBeNull();
    expect(await store.ankiSync.loadSnapshot()).toBeNull();
    const diagnostics = await readRestoreDiagnostics(databaseName);
    expect(diagnostics.knownSets).toEqual([]);
    expect(diagnostics.activeKnown).toBeNull();
  });

  it("restoreUserState leaves all prior state intact when a request fails mid-transaction", async () => {
    const store: AppStore = createIndexedDbAppStore(databaseName);
    await store.knownWords.save("set-a", "Set A", ["alpha"]);
    const priorDecision = decision("古い", "skip", "2026-09-01T00:00:00.000Z");
    await store.wordDecisions.set(priorDecision);
    await store.preferences.save({ query, view, page: 1 });
    const priorAnkiConfig: AnkiSyncConfig = {
      deckScope: { kind: "deck", name: "MAIN" },
      noteType: "Mine",
      targetField: "Word",
    };
    const priorAnkiSnapshot: AnkiSyncSnapshot = {
      syncedAt: "2026-09-01T00:00:00.000Z",
      statuses: [["古い", "known"]],
    };
    await store.ankiSync.saveConfig(priorAnkiConfig);
    await store.ankiSync.replaceSnapshot(priorAnkiSnapshot);

    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "ankiSync") {
        throw new Error("injected Anki failure");
      }
      return originalPut.call(this, value, key);
    });

    await expect(
      store.restoreUserState?.({
        knownWords: { id: "set-b", name: "Set B", words: ["beta"] },
        decisions: [decision("新しい", "mined", "2026-09-05T00:00:00.000Z")],
        preferences: { query, view, page: 4 },
        ankiSync: {
          config: { deckScope: { kind: "all-decks" }, noteType: "New", targetField: "Word" },
          snapshot: { syncedAt: "2026-09-05T00:00:00.000Z", statuses: [["新しい", "mined"]] },
        },
      }),
    ).rejects.toThrow("injected Anki failure");

    putSpy.mockRestore();
    expect(await store.knownWords.getActive()).toEqual({
      id: "set-a",
      name: "Set A",
      words: new Set(["alpha"]),
    });
    expect(await store.wordDecisions.list()).toEqual([priorDecision]);
    expect(await store.preferences.load()).toEqual({ query, view, page: 1 });
    expect(await store.ankiSync.loadConfig()).toEqual(priorAnkiConfig);
    expect(await store.ankiSync.loadSnapshot()).toEqual(priorAnkiSnapshot);
    const diagnostics = await readRestoreDiagnostics(databaseName);
    expect(diagnostics.knownSets).toEqual([{ id: "set-a" }]);
    expect(diagnostics.activeKnown).toBe("set-a");
  });

  it("restoreUserState aborts the whole transaction on duplicate decisions", async () => {
    const store: AppStore = createIndexedDbAppStore(databaseName);
    await store.knownWords.save("set-a", "Set A", ["alpha"]);
    const priorDecision = decision("古い", "skip", "2026-09-01T00:00:00.000Z");
    await store.wordDecisions.set(priorDecision);
    await store.preferences.save({ query, view, page: 1 });

    await expect(
      store.restoreUserState?.({
        knownWords: { id: "set-b", name: "Set B", words: ["beta"] },
        decisions: [
          decision("新しい", "mined", "2026-09-05T00:00:00.000Z"),
          decision("新しい", "skip", "2026-09-05T01:00:00.000Z"),
        ],
        preferences: { query, view, page: 4 },
      }),
    ).rejects.toThrow("Duplicate word decision");

    expect(await store.knownWords.getActive()).toEqual({
      id: "set-a",
      name: "Set A",
      words: new Set(["alpha"]),
    });
    expect(await store.wordDecisions.list()).toEqual([priorDecision]);
    expect(await store.preferences.load()).toEqual({ query, view, page: 1 });
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
    await expect(collectChunks(store.datasets.readChunks("failed", 10))).rejects.toThrow(
      "Dataset not found",
    );
  });

  it("surfaces cleanup failures after a failed import", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const previous = metadata("previous");

    await store.datasets.stage(previous, chunks([[entry("previous-entry", 0)]]));
    await store.datasets.activate(previous.id);

    const originalDelete = IDBObjectStore.prototype.delete;
    let deleteCalls = 0;
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
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

describe("readChunks dataset bounds", () => {
  afterEach(async () => {
    await deleteDatabase(databaseName);
  });

  it("never reads another dataset's chunks after the first pagination batch", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const datasetId = `${databaseName}-pagination-a`;
    const otherId = `${databaseName}-pagination-b`;

    // 40 single-entry chunk records > READ_BATCH_SIZE (32) forces pagination.
    const firstChunks = Array.from({ length: 40 }, (_, index) => [
      entry(`${datasetId}-entry-${index}`, index),
    ]);
    await store.datasets.stage({ ...metadata(datasetId), entryCount: 40 }, chunks(firstChunks));

    const otherChunks = Array.from({ length: 5 }, (_, index) => [
      entry(`${otherId}-entry-${index}`, index),
    ]);
    await store.datasets.stage({ ...metadata(otherId), entryCount: 5 }, chunks(otherChunks));

    const read = await collectChunks(store.datasets.readChunks(datasetId, 1));
    const words = read.flat().map((value) => value.id);
    expect(words).toHaveLength(40);
    for (const id of words) {
      expect(id.startsWith(`${datasetId}-entry-`)).toBe(true);
    }
  });
});
