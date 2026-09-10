import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbAppStore } from "../../src/storage/indexed-db";

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
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

function readRawRecords(name: string): Promise<{
  datasets: unknown[];
  entryChunks: unknown[];
  knownWordSets: unknown[];
  preferences: unknown[];
  meta: unknown[];
  wordDecisions: unknown[];
  ankiSync: unknown[];
}> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error ?? new Error("Could not open test database"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(
        [
          "datasets",
          "entryChunks",
          "knownWordSets",
          "preferences",
          "meta",
          "wordDecisions",
          "ankiSync",
        ],
        "readonly",
      );
      const datasets = transaction.objectStore("datasets").getAll();
      const entryChunks = transaction.objectStore("entryChunks").getAll();
      const knownWordSets = transaction.objectStore("knownWordSets").getAll();
      const preferences = transaction.objectStore("preferences").getAll();
      const meta = transaction.objectStore("meta").getAll();
      const wordDecisions = transaction.objectStore("wordDecisions").getAll();
      const ankiSync = transaction.objectStore("ankiSync").getAll();
      transaction.oncomplete = () => {
        database.close();
        resolve({
          datasets: datasets.result,
          entryChunks: entryChunks.result,
          knownWordSets: knownWordSets.result,
          preferences: preferences.result,
          meta: meta.result,
          wordDecisions: wordDecisions.result,
          ankiSync: ankiSync.result,
        });
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("Could not read test database"));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("Could not read test database"));
      };
    };
  });
}

describe("IndexedDB v2 to v3 upgrade", () => {
  it("creates Anki store while preserving real v2 state", async () => {
    const databaseName = `anki-upgrade-${crypto.randomUUID()}`;
    try {
      const dataset = {
        id: "legacy",
        name: "legacy dataset",
        sourceType: "file",
        sourceName: "legacy.csv",
        headers: ["Word", "Occurrences"],
        entryCount: 1,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        schemaVersion: 1,
        ready: true,
      };
      const entryChunk = {
        datasetId: "legacy",
        chunkIndex: 0,
        entries: [
          {
            id: "legacy-entry",
            originalIndex: 0,
            word: "word-0",
            normalizedWord: "word-0",
            occurrences: 1,
            sentenceRaw: "",
            hasSentence: false,
            definitions: "",
            furiganaRuns: [],
          },
        ],
      };
      const knownWordSet = {
        id: "migaku",
        name: "Migaku known words",
        words: ["透過"],
      };
      const query = {
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
      const view = {
        showFurigana: true,
        pillHighlight: false,
        showHighlight: true,
        showDefinitions: false,
        sentenceSize: "large",
        density: "compact",
      };
      const preferences = { id: "current", query, view, page: 1 };
      const activeDataset = { key: "activeDatasetId", value: "legacy" };
      const activeKnownWordSet = { key: "activeKnownWordSetId", value: "migaku" };
      const wordDecision = {
        normalizedWord: "word",
        status: "later",
        updatedAt: "now",
      };
      const request = indexedDB.open(databaseName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("datasets", { keyPath: "id" });
        db.createObjectStore("entryChunks", { keyPath: ["datasetId", "chunkIndex"] });
        db.createObjectStore("knownWordSets", { keyPath: "id" });
        db.createObjectStore("preferences", { keyPath: "id" });
        db.createObjectStore("meta", { keyPath: "key" });
        db.createObjectStore("wordDecisions", { keyPath: "normalizedWord" });
      };
      const database = await requestToPromise(request);
      const transaction = database.transaction(
        ["datasets", "entryChunks", "knownWordSets", "preferences", "meta", "wordDecisions"],
        "readwrite",
      );
      transaction.objectStore("datasets").put(dataset);
      transaction.objectStore("entryChunks").put(entryChunk);
      transaction.objectStore("knownWordSets").put(knownWordSet);
      transaction.objectStore("preferences").put(preferences);
      transaction.objectStore("meta").put(activeDataset);
      transaction.objectStore("meta").put(activeKnownWordSet);
      transaction.objectStore("wordDecisions").put(wordDecision);
      await transactionToPromise(transaction);
      database.close();
      const upgraded = new IndexedDbAppStore(databaseName);
      expect(await upgraded.datasets.getActive()).toEqual({
        id: "legacy",
        name: "legacy dataset",
        sourceType: "file",
        sourceName: "legacy.csv",
        headers: ["Word", "Occurrences"],
        entryCount: 1,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        schemaVersion: 1,
      });
      const restoredChunks: unknown[][] = [];
      for await (const chunk of upgraded.datasets.readChunks("legacy", 10)) {
        restoredChunks.push(chunk);
      }
      expect(restoredChunks).toEqual([[entryChunk.entries[0]]]);
      expect(await upgraded.knownWords.getActive()).toEqual({
        id: "migaku",
        name: "Migaku known words",
        words: new Set(["透過"]),
      });
      expect(await upgraded.preferences.load()).toEqual({ query, view, page: 1 });
      expect(await upgraded.wordDecisions.get("word")).toEqual(wordDecision);
      expect(await upgraded.ankiSync.loadConfig()).toBeNull();
      expect(await upgraded.ankiSync.loadSnapshot()).toBeNull();

      const raw = await readRawRecords(databaseName);
      expect(raw.datasets).toEqual([dataset]);
      expect(raw.entryChunks).toEqual([entryChunk]);
      expect(raw.knownWordSets).toEqual([knownWordSet]);
      expect(raw.preferences).toEqual([preferences]);
      expect(raw.meta).toEqual(expect.arrayContaining([activeDataset, activeKnownWordSet]));
      expect(raw.meta).toHaveLength(2);
      expect(raw.wordDecisions).toEqual([wordDecision]);
      expect(raw.ankiSync).toEqual([]);
    } finally {
      await deleteDatabase(databaseName);
    }
  });
});
