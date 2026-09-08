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

  it("keeps wrapped ConstraintError out of the storage-unavailable fallback", async () => {
    const store = createIndexedDbAppStore(databaseName);
    const decision = {
      normalizedWord: "ねこ",
      status: "known" as const,
      updatedAt: "2026-09-08T00:00:00.000Z",
    };
    await store.wordDecisions.set(decision);

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
    expect((caught as StorageUnavailableError).cause).toBeInstanceOf(DOMException);
    expect(((caught as StorageUnavailableError).cause as DOMException).name).toBe("ConstraintError");
    expect(isStorageUnavailableError(caught)).toBe(false);
  });
});
