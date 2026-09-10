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

describe("IndexedDB v2 to v3 upgrade", () => {
  it("creates Anki store while preserving real v2 state", async () => {
    const databaseName = `anki-upgrade-${crypto.randomUUID()}`;
    try {
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
      const transaction = database.transaction(["wordDecisions"], "readwrite");
      transaction
        .objectStore("wordDecisions")
        .put({ normalizedWord: "word", status: "later", updatedAt: "now" });
      await transactionToPromise(transaction);
      database.close();
      const upgraded = new IndexedDbAppStore(databaseName);
      expect(await upgraded.wordDecisions.get("word")).toEqual({
        normalizedWord: "word",
        status: "later",
        updatedAt: "now",
      });
      expect(await upgraded.ankiSync.loadConfig()).toBeNull();
      expect(await upgraded.ankiSync.loadSnapshot()).toBeNull();
    } finally {
      await deleteDatabase(databaseName);
    }
  });
});
