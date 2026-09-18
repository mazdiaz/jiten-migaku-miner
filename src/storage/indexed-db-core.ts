import { StorageUnavailableError } from "./fallback";

export const INDEXED_DB_NAME = "jiten-migaku-miner-local-first";
export const INDEXED_DB_VERSION = 5;

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
    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
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
      let outboxStore: IDBObjectStore;
      if (!database.objectStoreNames.contains("syncOutbox")) {
        outboxStore = database.createObjectStore("syncOutbox", { keyPath: "dedupeKey" });
      } else {
        outboxStore = request.transaction!.objectStore("syncOutbox");
      }
      if (!outboxStore.indexNames.contains("sequence")) {
        outboxStore.createIndex("sequence", "sequence", { unique: false });
      }
      let metaStore: IDBObjectStore;
      if (!database.objectStoreNames.contains("syncMeta")) {
        metaStore = database.createObjectStore("syncMeta", { keyPath: "id" });
      } else {
        metaStore = request.transaction!.objectStore("syncMeta");
      }

      const oldVersion = event.oldVersion;
      if (oldVersion < 5 && oldVersion > 0) {
        const cursorReq = outboxStore.openCursor();
        const unsequenced: Array<Record<string, unknown>> = [];
        let maxExistingSeq = 0;

        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const record = cursor.value as Record<string, unknown>;
            if (typeof record.sequence === "number" && Number.isFinite(record.sequence)) {
              if (record.sequence > maxExistingSeq) {
                maxExistingSeq = record.sequence;
              }
            } else {
              unsequenced.push(record);
            }
            cursor.continue();
          } else {
            if (unsequenced.length > 0) {
              unsequenced.sort((a, b) => {
                const timeA = typeof a.createdAt === "string" ? a.createdAt : "";
                const timeB = typeof b.createdAt === "string" ? b.createdAt : "";
                if (timeA !== timeB) return timeA.localeCompare(timeB);
                return String(a.dedupeKey).localeCompare(String(b.dedupeKey));
              });
              let nextSeq = maxExistingSeq + 1;
              for (const record of unsequenced) {
                record.sequence = nextSeq++;
                outboxStore.put(record);
              }
              maxExistingSeq = nextSeq - 1;
            }

            const targetSeq = Math.max(1, maxExistingSeq + 1);
            const metaReq = metaStore.get("current");
            metaReq.onsuccess = () => {
              const meta = metaReq.result as Record<string, unknown> | undefined;
              if (meta) {
                if (
                  typeof meta.nextOutboxSequence !== "number" ||
                  meta.nextOutboxSequence < targetSeq
                ) {
                  meta.nextOutboxSequence = targetSeq;
                  metaStore.put(meta);
                }
              } else {
                metaStore.put({
                  id: "current",
                  deviceId: crypto.randomUUID(),
                  bootstrapComplete: false,
                  serverEventId: 0,
                  lastSyncAt: null,
                  nextOutboxSequence: targetSeq,
                });
              }
            };
          }
        };
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
