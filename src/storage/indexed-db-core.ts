import { StorageUnavailableError } from "./fallback";

export const INDEXED_DB_NAME = "jiten-migaku-miner-local-first";
export const INDEXED_DB_VERSION = 4;

export type IndexedDbStoreName =
  | "datasets"
  | "entryChunks"
  | "knownWordSets"
  | "preferences"
  | "meta"
  | "wordDecisions"
  | "ankiSync"
  | "queues"
  | "workspace"
  | "syncOutbox"
  | "syncMeta";

export function requestError(request: { error: DOMException | null }): Error {
  return request.error === null
    ? new StorageUnavailableError("IndexedDB request failed")
    : new StorageUnavailableError(`IndexedDB request failed: ${request.error.message}`, {
        cause: request.error,
      });
}

export function openDatabase(name: string = INDEXED_DB_NAME): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(new StorageUnavailableError("IndexedDB is unavailable"));
  }

  return new Promise((resolve, reject) => {
    const request = factory.open(name, INDEXED_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("datasets")) {
        database.createObjectStore("datasets", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("entryChunks")) {
        database.createObjectStore("entryChunks", {
          keyPath: ["datasetId", "chunkIndex"],
        });
      }
      if (!database.objectStoreNames.contains("knownWordSets")) {
        database.createObjectStore("knownWordSets", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("preferences")) {
        database.createObjectStore("preferences", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("meta")) {
        database.createObjectStore("meta", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("wordDecisions")) {
        database.createObjectStore("wordDecisions", {
          keyPath: "normalizedWord",
        });
      }
      if (!database.objectStoreNames.contains("ankiSync")) {
        database.createObjectStore("ankiSync", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("queues")) {
        database.createObjectStore("queues", { keyPath: "datasetId" });
      }
      if (!database.objectStoreNames.contains("workspace")) {
        database.createObjectStore("workspace", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("syncOutbox")) {
        database.createObjectStore("syncOutbox", { keyPath: "dedupeKey" });
      }
      if (!database.objectStoreNames.contains("syncMeta")) {
        database.createObjectStore("syncMeta", { keyPath: "id" });
      }
    };
    request.onerror = () => reject(requestError(request));
    request.onblocked = () => reject(new StorageUnavailableError("IndexedDB open was blocked"));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export async function withDatabase<T>(
  name: string,
  action: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await openDatabase(name);
  try {
    return await action(database);
  } finally {
    database.close();
  }
}

export function runTransaction<T>(
  database: IDBDatabase,
  storeNames: readonly IndexedDbStoreName[],
  mode: IDBTransactionMode,
  operation: (
    transaction: IDBTransaction,
    resolveResult: (value: T) => void,
    abort: (reason: unknown) => void,
  ) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([...storeNames], mode);
    let result: T | undefined;
    let hasResult = false;
    let abortReason: unknown;
    let hasAbortReason = false;
    let settled = false;

    const resolveResult = (value: T): void => {
      result = value;
      hasResult = true;
    };

    const abort = (reason: unknown): void => {
      abortReason = reason;
      hasAbortReason = true;
      try {
        transaction.abort();
      } catch {
        if (!settled) {
          settled = true;
          reject(reason);
        }
      }
    };

    transaction.oncomplete = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve((hasResult ? result : undefined) as T);
    };
    transaction.onerror = () => {
      if (settled || hasAbortReason) {
        return;
      }
      settled = true;
      reject(
        transaction.error === null
          ? new StorageUnavailableError("IndexedDB transaction failed")
          : new StorageUnavailableError(
              `IndexedDB transaction failed: ${transaction.error.message}`,
              {
                cause: transaction.error,
              },
            ),
      );
    };
    transaction.onabort = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        hasAbortReason
          ? abortReason
          : transaction.error === null
            ? new StorageUnavailableError("IndexedDB transaction aborted")
            : new StorageUnavailableError(
                `IndexedDB transaction aborted: ${transaction.error.message}`,
                {
                  cause: transaction.error,
                },
              ),
      );
    };

    try {
      operation(transaction, resolveResult, abort);
    } catch (error) {
      abort(error);
    }
  });
}
