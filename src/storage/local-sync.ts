import type { SessionQueueSnapshot, SyncMutationKind } from "../sync/contracts";
import { INDEXED_DB_NAME, requestError, runTransaction, withDatabase } from "./indexed-db-core";

export interface SyncOutboxRecord {
  dedupeKey: string;
  mutationId: string;
  kind: SyncMutationKind;
  resourceId: string | null;
  createdAt: string;
  sequence: number;
}

export interface LocalSyncMeta {
  id: "current";
  deviceId: string;
  bootstrapComplete: boolean;
  serverEventId: number;
  lastSyncAt: string | null;
  nextOutboxSequence?: number;
}

export interface WorkspaceResumeState {
  id: "current";
  activeDatasetId: string | null;
  viewportStart: number;
  queueMode: "normal" | "queue";
  updatedAt: string;
}

export interface LocalSyncStore {
  getMeta(): Promise<LocalSyncMeta>;
  setMeta(value: LocalSyncMeta): Promise<void>;
  listOutbox(limit: number): Promise<SyncOutboxRecord[]>;
  acknowledge(dedupeKey: string, mutationId: string): Promise<void>;
  loadWorkspace(): Promise<WorkspaceResumeState | null>;
  saveWorkspace(value: WorkspaceResumeState): Promise<void>;
  loadQueue(datasetId: string): Promise<SessionQueueSnapshot | null>;
  listQueues(): Promise<SessionQueueSnapshot[]>;
  saveQueue(
    snapshot: SessionQueueSnapshot | null,
    datasetId: string,
    recordMutation: boolean,
  ): Promise<void>;
  clearLocalData(): Promise<void>;
  clearCachedDomainState?(): Promise<void>;
}

export function createLocalSyncStore(databaseName: string = INDEXED_DB_NAME): LocalSyncStore {
  return {
    async getMeta(): Promise<LocalSyncMeta> {
      return withDatabase(databaseName, async (database) => {
        return runTransaction<LocalSyncMeta>(
          database,
          ["syncMeta"],
          "readwrite",
          (transaction, resolveResult, abort) => {
            const store = transaction.objectStore("syncMeta");
            const request = store.get("current") as IDBRequest<LocalSyncMeta | undefined>;
            request.onerror = () => abort(requestError(request));
            request.onsuccess = () => {
              if (request.result) {
                resolveResult(request.result);
                return;
              }
              const initial: LocalSyncMeta = {
                id: "current",
                deviceId: crypto.randomUUID(),
                bootstrapComplete: false,
                serverEventId: 0,
                lastSyncAt: null,
                nextOutboxSequence: 1,
              };
              const putRequest = store.put(initial);
              putRequest.onerror = () => abort(requestError(putRequest));
              putRequest.onsuccess = () => resolveResult(initial);
            };
          },
        );
      });
    },

    async setMeta(value: LocalSyncMeta): Promise<void> {
      return withDatabase(databaseName, async (database) => {
        return runTransaction<void>(
          database,
          ["syncMeta"],
          "readwrite",
          (transaction, resolveResult, abort) => {
            const store = transaction.objectStore("syncMeta");
            const request = store.put(value);
            request.onerror = () => abort(requestError(request));
            request.onsuccess = () => resolveResult(undefined);
          },
        );
      });
    },

    async listOutbox(limit: number): Promise<SyncOutboxRecord[]> {
      return withDatabase(databaseName, async (database) => {
        return runTransaction<SyncOutboxRecord[]>(
          database,
          ["syncOutbox"],
          "readonly",
          (transaction, resolveResult, abort) => {
            const store = transaction.objectStore("syncOutbox");
            const records: SyncOutboxRecord[] = [];
            const index = store.index("sequence");
            const request = index.openCursor();
            request.onerror = () => abort(requestError(request));
            request.onsuccess = () => {
              const cursor = request.result;
              if (cursor && records.length < limit) {
                records.push(cursor.value as SyncOutboxRecord);
                cursor.continue();
              } else {
                resolveResult(records);
              }
            };
          },
        );
      });
    },

    async acknowledge(dedupeKey: string, mutationId: string): Promise<void> {
      return withDatabase(databaseName, async (database) => {
        return runTransaction<void>(
          database,
          ["syncOutbox"],
          "readwrite",
          (transaction, resolveResult, abort) => {
            const store = transaction.objectStore("syncOutbox");
            const request = store.get(dedupeKey) as IDBRequest<SyncOutboxRecord | undefined>;
            request.onerror = () => abort(requestError(request));
            request.onsuccess = () => {
              if (request.result?.mutationId === mutationId) {
                const delRequest = store.delete(dedupeKey);
                delRequest.onerror = () => abort(requestError(delRequest));
                delRequest.onsuccess = () => resolveResult(undefined);
              } else {
                resolveResult(undefined);
              }
            };
          },
        );
      });
    },

    async loadWorkspace(): Promise<WorkspaceResumeState | null> {
      return withDatabase(databaseName, async (database) => {
        return runTransaction<WorkspaceResumeState | null>(
          database,
          ["workspace"],
          "readonly",
          (transaction, resolveResult, abort) => {
            const store = transaction.objectStore("workspace");
            const request = store.get("current") as IDBRequest<WorkspaceResumeState | undefined>;
            request.onerror = () => abort(requestError(request));
            request.onsuccess = () => resolveResult(request.result ?? null);
          },
        );
      });
    },

    async saveWorkspace(value: WorkspaceResumeState): Promise<void> {
      return withDatabase(databaseName, async (database) => {
        return runTransaction<void>(
          database,
          ["workspace"],
          "readwrite",
          (transaction, resolveResult, abort) => {
            const store = transaction.objectStore("workspace");
            const request = store.put(value);
            request.onerror = () => abort(requestError(request));
            request.onsuccess = () => resolveResult(undefined);
          },
        );
      });
    },

    async loadQueue(datasetId: string): Promise<SessionQueueSnapshot | null> {
      return withDatabase(databaseName, async (database) => {
        return runTransaction<SessionQueueSnapshot | null>(
          database,
          ["queues"],
          "readonly",
          (transaction, resolveResult, abort) => {
            const store = transaction.objectStore("queues");
            const request = store.get(datasetId) as IDBRequest<SessionQueueSnapshot | undefined>;
            request.onerror = () => abort(requestError(request));
            request.onsuccess = () => {
              if (!request.result) {
                resolveResult(null);
                return;
              }
              const { version, datasetId: id, normalizedWords } = request.result;
              resolveResult({ version, datasetId: id, normalizedWords });
            };
          },
        );
      });
    },

    async listQueues(): Promise<SessionQueueSnapshot[]> {
      return withDatabase(databaseName, async (database) => {
        return runTransaction<SessionQueueSnapshot[]>(
          database,
          ["queues"],
          "readonly",
          (transaction, resolveResult, abort) => {
            const store = transaction.objectStore("queues");
            const request = store.getAll() as IDBRequest<SessionQueueSnapshot[]>;
            request.onerror = () => abort(requestError(request));
            request.onsuccess = () => {
              const items = (request.result ?? []).map((q) => ({
                version: q.version,
                datasetId: q.datasetId,
                normalizedWords: q.normalizedWords,
              }));
              resolveResult(items);
            };
          },
        );
      });
    },

    async saveQueue(
      snapshot: SessionQueueSnapshot | null,
      datasetId: string,
      recordMutation: boolean,
    ): Promise<void> {
      return withDatabase(databaseName, async (database) => {
        const storeNames = recordMutation
          ? (["queues", "syncOutbox", "syncMeta"] as const)
          : (["queues"] as const);

        return runTransaction<void>(
          database,
          storeNames,
          "readwrite",
          (transaction, resolveResult, _abort) => {
            const queuesStore = transaction.objectStore("queues");
            if (snapshot) {
              queuesStore.put({ ...snapshot, datasetId });
            } else {
              queuesStore.delete(datasetId);
            }

            if (recordMutation) {
              const outboxStore = transaction.objectStore("syncOutbox");
              const metaStore = transaction.objectStore("syncMeta");
              const metaReq = metaStore.get("current") as IDBRequest<LocalSyncMeta | undefined>;
              metaReq.onerror = () => _abort(requestError(metaReq));
              metaReq.onsuccess = () => {
                const meta = metaReq.result;
                const currentSeq = meta?.nextOutboxSequence ?? 1;
                if (meta) {
                  meta.nextOutboxSequence = currentSeq + 1;
                  metaStore.put(meta);
                } else {
                  metaStore.put({
                    id: "current",
                    deviceId: crypto.randomUUID(),
                    bootstrapComplete: false,
                    serverEventId: 0,
                    lastSyncAt: null,
                    nextOutboxSequence: currentSeq + 1,
                  });
                }
                const dedupeKey = `queue:${datasetId}`;
                const outboxRecord: SyncOutboxRecord = {
                  dedupeKey,
                  mutationId: crypto.randomUUID(),
                  kind: snapshot ? "queue.replace" : "queue.remove",
                  resourceId: datasetId,
                  createdAt: new Date().toISOString(),
                  sequence: currentSeq,
                };
                outboxStore.put(outboxRecord);
                resolveResult(undefined);
              };
              return;
            }

            resolveResult(undefined);
          },
        );
      });
    },

    async clearCachedDomainState(): Promise<void> {
      const storeNames = [
        "datasets",
        "entryChunks",
        "knownWordSets",
        "preferences",
        "meta",
        "wordDecisions",
        "ankiSync",
        "queues",
        "workspace",
      ] as const;

      return withDatabase(databaseName, async (database) => {
        return runTransaction<void>(
          database,
          storeNames,
          "readwrite",
          (transaction, resolveResult) => {
            for (const name of storeNames) {
              transaction.objectStore(name).clear();
            }
            resolveResult(undefined);
          },
        );
      });
    },

    async clearLocalData(): Promise<void> {
      const storeNames = [
        "datasets",
        "entryChunks",
        "knownWordSets",
        "preferences",
        "meta",
        "wordDecisions",
        "ankiSync",
        "queues",
        "workspace",
        "syncOutbox",
        "syncMeta",
      ] as const;

      return withDatabase(databaseName, async (database) => {
        return runTransaction<void>(
          database,
          storeNames,
          "readwrite",
          (transaction, resolveResult) => {
            for (const name of storeNames) {
              transaction.objectStore(name).clear();
            }
            resolveResult(undefined);
          },
        );
      });
    },
  };
}
