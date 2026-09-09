import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isStorageUnavailableError, StorageUnavailableError } from "../../src/storage/fallback";
import { createIndexedDbAppStore } from "../../src/storage/indexed-db";

const databaseName = "jiten-migaku-miner-fallback-classification-test";

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not delete test database"));
    request.onblocked = () => reject(new Error("Test database deletion was blocked"));
  });
}

describe("IndexedDB transaction failure classification", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await deleteDatabase(databaseName);
  });

  it("keeps an opaque duplicate-key transaction failure out of the storage fallback", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const decision = {
      normalizedWord: "ねこ",
      status: "known" as const,
      updatedAt: "2026-09-08T00:00:00.000Z",
    };
    await store.wordDecisions.set(decision);

    // Force put() to behave like add(), so writing the same decision again
    // triggers the IndexedDB duplicate-key (ConstraintError) transaction path.
    const originalAdd = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
    });

    let caught: unknown;
    try {
      await store.wordDecisions.set(decision);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StorageUnavailableError);
    // fake-indexeddb dispatches this transaction error before transaction.error
    // is populated, so the adapter cannot recover the concrete ConstraintError.
    // The classifier must fail closed rather than silently switching stores.
    expect((caught as StorageUnavailableError).cause).toBeUndefined();
    expect((caught as StorageUnavailableError).message).toContain("IndexedDB transaction failed");
    expect(isStorageUnavailableError(caught)).toBe(false);
  });
});
