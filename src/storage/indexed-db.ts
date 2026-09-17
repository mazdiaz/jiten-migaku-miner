import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../domain/anki";
import type { Entry, QueryState, ViewState, WordDecision } from "../domain/types";
import type { SyncMutationKind } from "../sync/contracts";
import type {
  AnkiSyncStore,
  AppStore,
  DatasetMetadata,
  DatasetStore,
  KnownWordStore,
  KnownWordsSaveReceipt,
  PreferencesStore,
  RestoreUserStateSnapshot,
  WordDecisionStore,
} from "./contracts";
import { DatasetNotCachedError } from "./contracts";
import {
  INDEXED_DB_NAME,
  INDEXED_DB_VERSION,
  type IndexedDbStoreName,
  runTransaction,
  withDatabase,
} from "./indexed-db-core";
import type { LocalSyncMeta, SyncOutboxRecord } from "./local-sync";

export { INDEXED_DB_NAME, INDEXED_DB_VERSION };

export interface IndexedDbAppStoreOptions {
  databaseName?: string;
  recordSyncMutations?: boolean;
  now?: () => string;
  createMutationId?: () => string;
}

interface InternalStoreOptions {
  recordSyncMutations: boolean;
  now: () => string;
  createMutationId: () => string;
}

function outboxIdentity(kind: SyncMutationKind, resourceId: string | null): string {
  if (kind === "dataset.activate") return "activeDataset";
  if (kind === "known.replace") return "known";
  if (kind === "preferences.replace") return "preferences";
  if (kind === "anki.replace") return "anki";
  if (kind === "decision.set" || kind === "decision.remove") return `decision:${resourceId}`;
  if (kind === "queue.replace" || kind === "queue.remove") return `queue:${resourceId}`;
  return `dataset:${resourceId}`;
}

function writeOutboxRecord(
  transaction: IDBTransaction,
  kind: SyncMutationKind,
  resourceId: string | null,
  now: () => string,
  createMutationId: () => string,
): void {
  const dedupeKey = outboxIdentity(kind, resourceId);
  const metaStore = transaction.objectStore("syncMeta");
  const metaReq = metaStore.get("current") as IDBRequest<LocalSyncMeta | undefined>;
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
    const record: SyncOutboxRecord = {
      dedupeKey,
      mutationId: createMutationId(),
      kind,
      resourceId,
      createdAt: now(),
      sequence: currentSeq,
    };
    transaction.objectStore("syncOutbox").put(record);
  };
}

const DATASETS_STORE = "datasets";
const ENTRY_CHUNKS_STORE = "entryChunks";
const KNOWN_WORD_SETS_STORE = "knownWordSets";
const PREFERENCES_STORE = "preferences";
const META_STORE = "meta";
const WORD_DECISIONS_STORE = "wordDecisions";
const ANKI_SYNC_STORE = "ankiSync";
const ACTIVE_DATASET_KEY = "activeDatasetId";
const ACTIVE_KNOWN_WORD_SET_KEY = "activeKnownWordSetId";
const PREFERENCES_KEY = "current";
const ANKI_SYNC_KEY = "current";
const READ_BATCH_SIZE = 32;

interface DatasetRecord extends DatasetMetadata {
  ready: boolean;
  cacheState: "metadata-only" | "ready";
}

interface EntryChunkRecord {
  datasetId: string;
  chunkIndex: number;
  entries: Entry[];
}

interface KnownWordSetRecord {
  id: string;
  name: string;
  words: string[];
}

interface PreferencesRecord {
  id: typeof PREFERENCES_KEY;
  query: QueryState;
  view: ViewState;
  page: number;
}

interface MetaRecord {
  key: string;
  value: string;
}

interface AnkiSyncRecord {
  id: typeof ANKI_SYNC_KEY;
  config: AnkiSyncConfig | null;
  snapshot: AnkiSyncSnapshot | null;
}

function cloneEntry(value: Entry): Entry {
  return {
    ...value,
    furiganaRuns: value.furiganaRuns.map((run) => ({ ...run })),
  };
}

function cloneMetadata(value: DatasetMetadata): DatasetMetadata {
  return { ...value, headers: [...value.headers] };
}

function cloneDecision(value: WordDecision): WordDecision {
  return { ...value };
}

function cloneConfig(value: AnkiSyncConfig | null): AnkiSyncConfig | null {
  return value === null ? null : { ...value, deckScope: { ...value.deckScope } };
}

function cloneSnapshot(value: AnkiSyncSnapshot | null): AnkiSyncSnapshot | null {
  return value === null
    ? null
    : {
        ...value,
        statuses: value.statuses.map(
          ([normalizedWord, status]) => [normalizedWord, status] as [string, typeof status],
        ),
      };
}

function datasetRange(datasetId: string): IDBKeyRange {
  return IDBKeyRange.bound([datasetId, 0], [datasetId, Number.MAX_SAFE_INTEGER]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metadataFromRecord(record: DatasetRecord): DatasetMetadata {
  return {
    id: record.id,
    name: record.name,
    sourceType: record.sourceType,
    sourceName: record.sourceName,
    headers: [...record.headers],
    entryCount: record.entryCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    schemaVersion: record.schemaVersion,
  };
}

async function readMeta(database: IDBDatabase, key: string): Promise<string | null> {
  return runTransaction<string | null>(
    database,
    [META_STORE],
    "readonly",
    (transaction, resolveResult) => {
      const request = transaction.objectStore(META_STORE).get(key) as IDBRequest<
        MetaRecord | undefined
      >;
      request.onsuccess = () => {
        resolveResult(request.result?.value ?? null);
      };
    },
  );
}

async function readDataset(
  database: IDBDatabase,
  datasetId: string,
): Promise<DatasetRecord | undefined> {
  return runTransaction<DatasetRecord | undefined>(
    database,
    [DATASETS_STORE],
    "readonly",
    (transaction, resolveResult) => {
      const request = transaction.objectStore(DATASETS_STORE).get(datasetId) as IDBRequest<
        DatasetRecord | undefined
      >;
      request.onsuccess = () => {
        resolveResult(request.result);
      };
    },
  );
}

async function cleanupDataset(database: IDBDatabase, datasetId: string): Promise<void> {
  await runTransaction<void>(
    database,
    [DATASETS_STORE, ENTRY_CHUNKS_STORE, META_STORE],
    "readwrite",
    (transaction, resolveResult) => {
      transaction.objectStore(DATASETS_STORE).delete(datasetId);
      transaction.objectStore(ENTRY_CHUNKS_STORE).delete(datasetRange(datasetId));
      const request = transaction.objectStore(META_STORE).get(ACTIVE_DATASET_KEY) as IDBRequest<
        MetaRecord | undefined
      >;
      request.onsuccess = () => {
        if (request.result?.value === datasetId) {
          transaction.objectStore(META_STORE).delete(ACTIVE_DATASET_KEY);
        }
        resolveResult(undefined);
      };
    },
  );
}

class IndexedDbDatasetStore implements DatasetStore {
  private readonly stagingIds = new Set<string>();

  constructor(
    private readonly databaseName: string,
    private readonly options?: InternalStoreOptions,
  ) {}

  async stage(metadata: DatasetMetadata, chunks: AsyncIterable<readonly Entry[]>): Promise<void> {
    if (this.stagingIds.has(metadata.id)) {
      throw new Error(`Dataset already exists: ${metadata.id}`);
    }

    this.stagingIds.add(metadata.id);
    try {
      await withDatabase(this.databaseName, async (database) => {
        const existing = await readDataset(database, metadata.id);
        if (existing?.ready) {
          throw new Error(`Dataset already exists: ${metadata.id}`);
        }
        if (existing) {
          await cleanupDataset(database, metadata.id);
        }

        await runTransaction<void>(
          database,
          [DATASETS_STORE, ENTRY_CHUNKS_STORE],
          "readwrite",
          (transaction, resolveResult) => {
            transaction.objectStore(ENTRY_CHUNKS_STORE).delete(datasetRange(metadata.id));
            transaction.objectStore(DATASETS_STORE).put({
              ...cloneMetadata(metadata),
              ready: false,
              cacheState: "metadata-only",
            } satisfies DatasetRecord);
            resolveResult(undefined);
          },
        );

        let chunkIndex = 0;
        try {
          for await (const chunk of chunks) {
            const record: EntryChunkRecord = {
              datasetId: metadata.id,
              chunkIndex,
              entries: chunk.map(cloneEntry),
            };
            chunkIndex += 1;

            await runTransaction<void>(
              database,
              [ENTRY_CHUNKS_STORE],
              "readwrite",
              (transaction, resolveResult) => {
                transaction.objectStore(ENTRY_CHUNKS_STORE).put(record);
                resolveResult(undefined);
              },
            );
          }

          const commitStores: IndexedDbStoreName[] = this.options?.recordSyncMutations
            ? [DATASETS_STORE, "syncOutbox", "syncMeta"]
            : [DATASETS_STORE];

          await runTransaction<void>(
            database,
            commitStores,
            "readwrite",
            (transaction, resolveResult, abort) => {
              const request = transaction
                .objectStore(DATASETS_STORE)
                .get(metadata.id) as IDBRequest<DatasetRecord | undefined>;
              request.onsuccess = () => {
                const current = request.result;
                if (!current) {
                  abort(new Error(`Dataset not found: ${metadata.id}`));
                  return;
                }
                transaction.objectStore(DATASETS_STORE).put({
                  ...current,
                  ready: true,
                  cacheState: "ready",
                } satisfies DatasetRecord);
                if (this.options?.recordSyncMutations) {
                  writeOutboxRecord(
                    transaction,
                    "dataset.upload",
                    metadata.id,
                    this.options.now,
                    this.options.createMutationId,
                  );
                }
                resolveResult(undefined);
              };
            },
          );
        } catch (stageError) {
          try {
            await cleanupDataset(database, metadata.id);
          } catch (cleanupError) {
            throw new Error(
              `Dataset staging failed: ${errorMessage(stageError)}; cleanup failed: ${errorMessage(cleanupError)}`,
            );
          }
          throw stageError;
        }
      });
    } finally {
      this.stagingIds.delete(metadata.id);
    }
  }

  async activate(datasetId: string): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [DATASETS_STORE, META_STORE, "syncOutbox", "syncMeta"]
        : [DATASETS_STORE, META_STORE];

      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult, abort) => {
          const request = transaction.objectStore(DATASETS_STORE).get(datasetId) as IDBRequest<
            DatasetRecord | undefined
          >;
          request.onsuccess = () => {
            const record = request.result;
            if (!record?.ready) {
              abort(new Error(`Dataset not ready: ${datasetId}`));
              return;
            }
            transaction.objectStore(META_STORE).put({
              key: ACTIVE_DATASET_KEY,
              value: datasetId,
            } satisfies MetaRecord);
            if (this.options?.recordSyncMutations) {
              writeOutboxRecord(
                transaction,
                "dataset.activate",
                datasetId,
                this.options.now,
                this.options.createMutationId,
              );
            }
            resolveResult(undefined);
          };
        },
      );
    });
  }

  async getActive(): Promise<DatasetMetadata | null> {
    return withDatabase(this.databaseName, async (database) => {
      const activeId = await readMeta(database, ACTIVE_DATASET_KEY);
      if (activeId === null) {
        return null;
      }

      const record = await readDataset(database, activeId);
      return record?.ready ? metadataFromRecord(record) : null;
    });
  }

  async list(): Promise<DatasetMetadata[]> {
    return withDatabase(this.databaseName, async (database) => {
      const records = await runTransaction<DatasetRecord[]>(
        database,
        [DATASETS_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction.objectStore(DATASETS_STORE).getAll() as IDBRequest<
            DatasetRecord[]
          >;
          request.onsuccess = () => resolveResult(request.result);
        },
      );

      return records
        .filter((record) => record.ready || record.cacheState === "metadata-only")
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(metadataFromRecord);
    });
  }

  async cacheState(datasetId: string): Promise<"metadata-only" | "ready" | null> {
    return withDatabase(this.databaseName, async (database) => {
      const record = await readDataset(database, datasetId);
      if (!record) {
        return null;
      }
      return record.cacheState ?? (record.ready ? "ready" : "metadata-only");
    });
  }

  async upsertMetadata(metadata: DatasetMetadata): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [DATASETS_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          const store = transaction.objectStore(DATASETS_STORE);
          const req = store.get(metadata.id) as IDBRequest<DatasetRecord | undefined>;
          req.onsuccess = () => {
            const existing = req.result;
            const isReady = existing?.ready ?? false;
            const cacheState = existing?.cacheState ?? (isReady ? "ready" : "metadata-only");
            const record: DatasetRecord = {
              ...cloneMetadata(metadata),
              ready: isReady,
              cacheState,
            };
            store.put(record);
            resolveResult(undefined);
          };
        },
      );
    });
  }

  async *readChunks(datasetId: string, chunkSize: number): AsyncGenerator<Entry[], void, unknown> {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError("chunkSize must be a positive integer");
    }

    const dataset = await withDatabase(this.databaseName, async (database) => {
      const dataset = await readDataset(database, datasetId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${datasetId}`);
      }
      const state = dataset.cacheState ?? (dataset.ready ? "ready" : "metadata-only");
      if (state === "metadata-only") {
        throw new DatasetNotCachedError(datasetId);
      }
      if (!dataset.ready) {
        throw new Error(`Dataset not found: ${datasetId}`);
      }
      return dataset;
    });

    let pending: Entry[] = [];
    let range = datasetRange(dataset.id);
    while (true) {
      const records = await withDatabase(this.databaseName, async (database) =>
        runTransaction<EntryChunkRecord[]>(
          database,
          [ENTRY_CHUNKS_STORE],
          "readonly",
          (transaction, resolveResult) => {
            const request = transaction
              .objectStore(ENTRY_CHUNKS_STORE)
              .getAll(range, READ_BATCH_SIZE) as IDBRequest<EntryChunkRecord[]>;
            request.onsuccess = () => resolveResult(request.result);
          },
        ),
      );
      records.sort((left, right) => left.chunkIndex - right.chunkIndex);
      if (records.length === 0) {
        break;
      }

      for (const record of records) {
        for (const value of record.entries) {
          pending.push(cloneEntry(value));
          if (pending.length === chunkSize) {
            yield pending;
            pending = [];
          }
        }
      }

      if (records.length < READ_BATCH_SIZE) {
        break;
      }
      const lastRecord = records[records.length - 1];
      if (!lastRecord) {
        break;
      }
      range = IDBKeyRange.bound(
        [datasetId, lastRecord.chunkIndex],
        [datasetId, Number.MAX_SAFE_INTEGER],
        true,
        false,
      );
    }

    if (pending.length > 0) {
      yield pending;
    }
  }

  async remove(datasetId: string): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [DATASETS_STORE, ENTRY_CHUNKS_STORE, META_STORE, "syncOutbox", "syncMeta"]
        : [DATASETS_STORE, ENTRY_CHUNKS_STORE, META_STORE];

      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(DATASETS_STORE).delete(datasetId);
          transaction.objectStore(ENTRY_CHUNKS_STORE).delete(datasetRange(datasetId));
          const request = transaction.objectStore(META_STORE).get(ACTIVE_DATASET_KEY) as IDBRequest<
            MetaRecord | undefined
          >;
          request.onsuccess = () => {
            if (request.result?.value === datasetId) {
              transaction.objectStore(META_STORE).delete(ACTIVE_DATASET_KEY);
            }
            if (this.options?.recordSyncMutations) {
              writeOutboxRecord(
                transaction,
                "dataset.remove",
                datasetId,
                this.options.now,
                this.options.createMutationId,
              );
            }
            resolveResult(undefined);
          };
        },
      );
    });
  }
}

class IndexedDbKnownWordStore implements KnownWordStore {
  constructor(
    private readonly databaseName: string,
    private readonly options?: InternalStoreOptions,
  ) {}

  async save(id: string, name: string, words: Iterable<string>): Promise<KnownWordsSaveReceipt> {
    const uniqueWords = [...new Set(words)];
    const record: KnownWordSetRecord = { id, name, words: uniqueWords };
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [KNOWN_WORD_SETS_STORE, META_STORE, "syncOutbox", "syncMeta"]
        : [KNOWN_WORD_SETS_STORE, META_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(KNOWN_WORD_SETS_STORE).put(record);
          transaction.objectStore(META_STORE).put({
            key: ACTIVE_KNOWN_WORD_SET_KEY,
            value: id,
          } satisfies MetaRecord);
          if (this.options?.recordSyncMutations) {
            writeOutboxRecord(
              transaction,
              "known.replace",
              null,
              this.options.now,
              this.options.createMutationId,
            );
          }
          resolveResult(undefined);
        },
      );
    });
    return { id, name, wordCount: uniqueWords.length };
  }

  async getActive(): Promise<{
    id: string;
    name: string;
    words: Set<string>;
  } | null> {
    return withDatabase(this.databaseName, async (database) => {
      const activeId = await readMeta(database, ACTIVE_KNOWN_WORD_SET_KEY);
      if (activeId === null) {
        return null;
      }

      const record = await runTransaction<KnownWordSetRecord | undefined>(
        database,
        [KNOWN_WORD_SETS_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction
            .objectStore(KNOWN_WORD_SETS_STORE)
            .get(activeId) as IDBRequest<KnownWordSetRecord | undefined>;
          request.onsuccess = () => resolveResult(request.result);
        },
      );
      if (!record) {
        return null;
      }

      return { id: record.id, name: record.name, words: new Set(record.words) };
    });
  }

  async remove(id: string): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [KNOWN_WORD_SETS_STORE, META_STORE, "syncOutbox", "syncMeta"]
        : [KNOWN_WORD_SETS_STORE, META_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(KNOWN_WORD_SETS_STORE).delete(id);
          const request = transaction
            .objectStore(META_STORE)
            .get(ACTIVE_KNOWN_WORD_SET_KEY) as IDBRequest<MetaRecord | undefined>;
          request.onsuccess = () => {
            if (request.result?.value === id) {
              transaction.objectStore(META_STORE).delete(ACTIVE_KNOWN_WORD_SET_KEY);
            }
            if (this.options?.recordSyncMutations) {
              writeOutboxRecord(
                transaction,
                "known.replace",
                null,
                this.options.now,
                this.options.createMutationId,
              );
            }
            resolveResult(undefined);
          };
        },
      );
    });
  }

  async clear(): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [KNOWN_WORD_SETS_STORE, META_STORE, "syncOutbox", "syncMeta"]
        : [KNOWN_WORD_SETS_STORE, META_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(KNOWN_WORD_SETS_STORE).clear();
          transaction.objectStore(META_STORE).delete(ACTIVE_KNOWN_WORD_SET_KEY);
          if (this.options?.recordSyncMutations) {
            writeOutboxRecord(
              transaction,
              "known.replace",
              null,
              this.options.now,
              this.options.createMutationId,
            );
          }
          resolveResult(undefined);
        },
      );
    });
  }
}

class IndexedDbPreferencesStore implements PreferencesStore {
  constructor(
    private readonly databaseName: string,
    private readonly options?: InternalStoreOptions,
  ) {}

  async load(): Promise<{
    query: QueryState;
    view: ViewState;
    page: number;
  } | null> {
    return withDatabase(this.databaseName, async (database) => {
      const record = await runTransaction<PreferencesRecord | undefined>(
        database,
        [PREFERENCES_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction
            .objectStore(PREFERENCES_STORE)
            .get(PREFERENCES_KEY) as IDBRequest<PreferencesRecord | undefined>;
          request.onsuccess = () => resolveResult(request.result);
        },
      );
      if (!record) {
        return null;
      }

      return {
        query: { ...record.query },
        view: { ...record.view },
        page: record.page,
      };
    });
  }

  async save(value: { query: QueryState; view: ViewState; page: number }): Promise<void> {
    const record: PreferencesRecord = {
      id: PREFERENCES_KEY,
      query: { ...value.query },
      view: { ...value.view },
      page: value.page,
    };
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [PREFERENCES_STORE, "syncOutbox", "syncMeta"]
        : [PREFERENCES_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(PREFERENCES_STORE).put(record);
          if (this.options?.recordSyncMutations) {
            writeOutboxRecord(
              transaction,
              "preferences.replace",
              null,
              this.options.now,
              this.options.createMutationId,
            );
          }
          resolveResult(undefined);
        },
      );
    });
  }

  async clear(): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [PREFERENCES_STORE, "syncOutbox", "syncMeta"]
        : [PREFERENCES_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(PREFERENCES_STORE).clear();
          if (this.options?.recordSyncMutations) {
            writeOutboxRecord(
              transaction,
              "preferences.replace",
              null,
              this.options.now,
              this.options.createMutationId,
            );
          }
          resolveResult(undefined);
        },
      );
    });
  }
}

class IndexedDbWordDecisionStore implements WordDecisionStore {
  constructor(
    private readonly databaseName: string,
    private readonly options?: InternalStoreOptions,
  ) {}

  async get(normalizedWord: string): Promise<WordDecision | null> {
    return withDatabase(this.databaseName, async (database) => {
      const record = await runTransaction<WordDecision | undefined>(
        database,
        [WORD_DECISIONS_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction
            .objectStore(WORD_DECISIONS_STORE)
            .get(normalizedWord) as IDBRequest<WordDecision | undefined>;
          request.onsuccess = () => resolveResult(request.result);
        },
      );
      return record ? cloneDecision(record) : null;
    });
  }

  async list(): Promise<WordDecision[]> {
    return withDatabase(this.databaseName, async (database) => {
      const records = await runTransaction<WordDecision[]>(
        database,
        [WORD_DECISIONS_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction.objectStore(WORD_DECISIONS_STORE).getAll() as IDBRequest<
            WordDecision[]
          >;
          request.onsuccess = () => resolveResult(request.result);
        },
      );

      return records.map(cloneDecision);
    });
  }

  async set(decision: WordDecision): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [WORD_DECISIONS_STORE, "syncOutbox", "syncMeta"]
        : [WORD_DECISIONS_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(WORD_DECISIONS_STORE).put(cloneDecision(decision));
          if (this.options?.recordSyncMutations) {
            writeOutboxRecord(
              transaction,
              "decision.set",
              decision.normalizedWord,
              this.options.now,
              this.options.createMutationId,
            );
          }
          resolveResult(undefined);
        },
      );
    });
  }

  async remove(normalizedWord: string): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [WORD_DECISIONS_STORE, "syncOutbox", "syncMeta"]
        : [WORD_DECISIONS_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(WORD_DECISIONS_STORE).delete(normalizedWord);
          if (this.options?.recordSyncMutations) {
            writeOutboxRecord(
              transaction,
              "decision.remove",
              normalizedWord,
              this.options.now,
              this.options.createMutationId,
            );
          }
          resolveResult(undefined);
        },
      );
    });
  }

  async replaceAll(decisions: readonly WordDecision[]): Promise<void> {
    const records = decisions.map(cloneDecision);
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [WORD_DECISIONS_STORE, "syncOutbox", "syncMeta"]
        : [WORD_DECISIONS_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult, abort) => {
          const store = transaction.objectStore(WORD_DECISIONS_STORE);
          const seen = new Set<string>();
          for (const record of records) {
            if (seen.has(record.normalizedWord)) {
              abort(new Error(`Duplicate word decision: ${record.normalizedWord}`));
              return;
            }
            seen.add(record.normalizedWord);
          }

          const options = this.options;
          if (options?.recordSyncMutations) {
            const keysRequest = store.getAllKeys() as IDBRequest<IDBValidKey[]>;
            keysRequest.onsuccess = () => {
              const oldKeys = new Set(keysRequest.result.map(String));
              const newMap = new Map(records.map((r) => [r.normalizedWord, r]));
              for (const oldKey of oldKeys) {
                if (!newMap.has(oldKey)) {
                  writeOutboxRecord(
                    transaction,
                    "decision.remove",
                    oldKey,
                    options.now,
                    options.createMutationId,
                  );
                }
              }
              for (const decision of newMap.values()) {
                writeOutboxRecord(
                  transaction,
                  "decision.set",
                  decision.normalizedWord,
                  options.now,
                  options.createMutationId,
                );
              }
              store.clear();
              for (const record of records) {
                store.put(record);
              }
              resolveResult(undefined);
            };
          } else {
            store.clear();
            for (const record of records) {
              store.put(record);
            }
            resolveResult(undefined);
          }
        },
      );
    });
  }

  async clear(): Promise<void> {
    const options = this.options;
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = options?.recordSyncMutations
        ? [WORD_DECISIONS_STORE, "syncOutbox", "syncMeta"]
        : [WORD_DECISIONS_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          const store = transaction.objectStore(WORD_DECISIONS_STORE);
          if (options?.recordSyncMutations) {
            const keysRequest = store.getAllKeys() as IDBRequest<IDBValidKey[]>;
            keysRequest.onsuccess = () => {
              for (const oldKey of keysRequest.result) {
                writeOutboxRecord(
                  transaction,
                  "decision.remove",
                  String(oldKey),
                  options.now,
                  options.createMutationId,
                );
              }
              store.clear();
              resolveResult(undefined);
            };
          } else {
            store.clear();
            resolveResult(undefined);
          }
        },
      );
    });
  }
}

class IndexedDbAnkiSyncStore implements AnkiSyncStore {
  constructor(
    private readonly databaseName: string,
    private readonly options?: InternalStoreOptions,
  ) {}

  async loadConfig(): Promise<AnkiSyncConfig | null> {
    return withDatabase(this.databaseName, async (database) => {
      const record = await runTransaction<AnkiSyncRecord | undefined>(
        database,
        [ANKI_SYNC_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction.objectStore(ANKI_SYNC_STORE).get(ANKI_SYNC_KEY) as IDBRequest<
            AnkiSyncRecord | undefined
          >;
          request.onsuccess = () => resolveResult(request.result);
        },
      );
      return cloneConfig(record?.config ?? null);
    });
  }

  async saveConfig(config: AnkiSyncConfig): Promise<void> {
    const nextConfig = cloneConfig(config);
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [ANKI_SYNC_STORE, "syncOutbox", "syncMeta"]
        : [ANKI_SYNC_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          const store = transaction.objectStore(ANKI_SYNC_STORE);
          const request = store.get(ANKI_SYNC_KEY) as IDBRequest<AnkiSyncRecord | undefined>;
          request.onsuccess = () => {
            store.put({
              id: ANKI_SYNC_KEY,
              config: nextConfig,
              snapshot: cloneSnapshot(request.result?.snapshot ?? null),
            } satisfies AnkiSyncRecord);
            if (this.options?.recordSyncMutations) {
              writeOutboxRecord(
                transaction,
                "anki.replace",
                null,
                this.options.now,
                this.options.createMutationId,
              );
            }
            resolveResult(undefined);
          };
        },
      );
    });
  }

  async loadSnapshot(): Promise<AnkiSyncSnapshot | null> {
    return withDatabase(this.databaseName, async (database) => {
      const record = await runTransaction<AnkiSyncRecord | undefined>(
        database,
        [ANKI_SYNC_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction.objectStore(ANKI_SYNC_STORE).get(ANKI_SYNC_KEY) as IDBRequest<
            AnkiSyncRecord | undefined
          >;
          request.onsuccess = () => resolveResult(request.result);
        },
      );
      return cloneSnapshot(record?.snapshot ?? null);
    });
  }

  async replaceSnapshot(snapshot: AnkiSyncSnapshot | null): Promise<void> {
    const nextSnapshot = cloneSnapshot(snapshot);
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [ANKI_SYNC_STORE, "syncOutbox", "syncMeta"]
        : [ANKI_SYNC_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          const store = transaction.objectStore(ANKI_SYNC_STORE);
          const request = store.get(ANKI_SYNC_KEY) as IDBRequest<AnkiSyncRecord | undefined>;
          request.onsuccess = () => {
            store.put({
              id: ANKI_SYNC_KEY,
              config: cloneConfig(request.result?.config ?? null),
              snapshot: nextSnapshot,
            } satisfies AnkiSyncRecord);
            if (this.options?.recordSyncMutations) {
              writeOutboxRecord(
                transaction,
                "anki.replace",
                null,
                this.options.now,
                this.options.createMutationId,
              );
            }
            resolveResult(undefined);
          };
        },
      );
    });
  }

  async clear(): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      const storeNames: IndexedDbStoreName[] = this.options?.recordSyncMutations
        ? [ANKI_SYNC_STORE, "syncOutbox", "syncMeta"]
        : [ANKI_SYNC_STORE];
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(ANKI_SYNC_STORE).delete(ANKI_SYNC_KEY);
          if (this.options?.recordSyncMutations) {
            writeOutboxRecord(
              transaction,
              "anki.replace",
              null,
              this.options.now,
              this.options.createMutationId,
            );
          }
          resolveResult(undefined);
        },
      );
    });
  }
}

export class IndexedDbAppStore implements AppStore {
  readonly datasets: DatasetStore;
  readonly knownWords: KnownWordStore;
  readonly wordDecisions: WordDecisionStore;
  readonly preferences: PreferencesStore;
  readonly ankiSync: AnkiSyncStore;

  readonly databaseName: string;
  private readonly internalOptions: InternalStoreOptions;

  constructor(databaseNameOrOptions: string | IndexedDbAppStoreOptions = INDEXED_DB_NAME) {
    const opts: IndexedDbAppStoreOptions =
      typeof databaseNameOrOptions === "string"
        ? { databaseName: databaseNameOrOptions }
        : databaseNameOrOptions;

    this.databaseName = opts.databaseName ?? INDEXED_DB_NAME;
    this.internalOptions = {
      recordSyncMutations: opts.recordSyncMutations ?? false,
      now: opts.now ?? (() => new Date().toISOString()),
      createMutationId: opts.createMutationId ?? (() => crypto.randomUUID()),
    };

    this.datasets = new IndexedDbDatasetStore(this.databaseName, this.internalOptions);
    this.knownWords = new IndexedDbKnownWordStore(this.databaseName, this.internalOptions);
    this.wordDecisions = new IndexedDbWordDecisionStore(this.databaseName, this.internalOptions);
    this.preferences = new IndexedDbPreferencesStore(this.databaseName, this.internalOptions);
    this.ankiSync = new IndexedDbAnkiSyncStore(this.databaseName, this.internalOptions);
  }

  async restoreUserState(snapshot: RestoreUserStateSnapshot): Promise<void> {
    const knownRecord: KnownWordSetRecord | null =
      snapshot.knownWords === null
        ? null
        : {
            id: snapshot.knownWords.id,
            name: snapshot.knownWords.name,
            words: [...new Set(snapshot.knownWords.words)],
          };
    const decisionRecords = snapshot.decisions.map(cloneDecision);
    const preferencesRecord: PreferencesRecord = {
      id: PREFERENCES_KEY,
      query: { ...snapshot.preferences.query },
      view: { ...snapshot.preferences.view },
      page: snapshot.preferences.page,
    };
    const requestedAnkiSync = snapshot.ankiSync ?? { config: null, snapshot: null };
    const ankiSyncRecord: AnkiSyncRecord = {
      id: ANKI_SYNC_KEY,
      config: cloneConfig(requestedAnkiSync.config),
      snapshot: cloneSnapshot(requestedAnkiSync.snapshot),
    };

    const storeNames: IndexedDbStoreName[] = this.internalOptions.recordSyncMutations
      ? [
          KNOWN_WORD_SETS_STORE,
          META_STORE,
          WORD_DECISIONS_STORE,
          PREFERENCES_STORE,
          ANKI_SYNC_STORE,
          "syncOutbox",
          "syncMeta",
        ]
      : [
          KNOWN_WORD_SETS_STORE,
          META_STORE,
          WORD_DECISIONS_STORE,
          PREFERENCES_STORE,
          ANKI_SYNC_STORE,
        ];

    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        storeNames,
        "readwrite",
        (transaction, resolveResult, abort) => {
          const decisions = transaction.objectStore(WORD_DECISIONS_STORE);
          const seen = new Set<string>();
          for (const record of decisionRecords) {
            if (seen.has(record.normalizedWord)) {
              abort(new Error(`Duplicate word decision: ${record.normalizedWord}`));
              return;
            }
            seen.add(record.normalizedWord);
          }

          const applyRest = () => {
            const knownSets = transaction.objectStore(KNOWN_WORD_SETS_STORE);
            knownSets.clear();
            if (knownRecord === null) {
              transaction.objectStore(META_STORE).delete(ACTIVE_KNOWN_WORD_SET_KEY);
            } else {
              knownSets.put(knownRecord);
              transaction.objectStore(META_STORE).put({
                key: ACTIVE_KNOWN_WORD_SET_KEY,
                value: knownRecord.id,
              } satisfies MetaRecord);
            }

            decisions.clear();
            for (const record of decisionRecords) {
              decisions.put(record);
            }

            transaction.objectStore(PREFERENCES_STORE).put(preferencesRecord);
            transaction.objectStore(ANKI_SYNC_STORE).put(ankiSyncRecord);
            resolveResult(undefined);
          };

          if (this.internalOptions.recordSyncMutations) {
            const keysReq = decisions.getAllKeys() as IDBRequest<IDBValidKey[]>;
            keysReq.onsuccess = () => {
              const oldKeys = new Set(keysReq.result.map(String));
              const newMap = new Map(decisionRecords.map((d) => [d.normalizedWord, d]));
              for (const oldKey of oldKeys) {
                if (!newMap.has(oldKey)) {
                  writeOutboxRecord(
                    transaction,
                    "decision.remove",
                    oldKey,
                    this.internalOptions.now,
                    this.internalOptions.createMutationId,
                  );
                }
              }
              for (const decision of newMap.values()) {
                writeOutboxRecord(
                  transaction,
                  "decision.set",
                  decision.normalizedWord,
                  this.internalOptions.now,
                  this.internalOptions.createMutationId,
                );
              }
              writeOutboxRecord(
                transaction,
                "known.replace",
                null,
                this.internalOptions.now,
                this.internalOptions.createMutationId,
              );
              writeOutboxRecord(
                transaction,
                "preferences.replace",
                null,
                this.internalOptions.now,
                this.internalOptions.createMutationId,
              );
              writeOutboxRecord(
                transaction,
                "anki.replace",
                null,
                this.internalOptions.now,
                this.internalOptions.createMutationId,
              );
              applyRest();
            };
          } else {
            applyRest();
          }
        },
      );
    });
  }

  async clearDomainCache(): Promise<void> {
    return withDatabase(this.databaseName, async (database) => {
      return runTransaction<void>(
        database,
        [
          DATASETS_STORE,
          ENTRY_CHUNKS_STORE,
          KNOWN_WORD_SETS_STORE,
          PREFERENCES_STORE,
          META_STORE,
          WORD_DECISIONS_STORE,
          ANKI_SYNC_STORE,
        ],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(DATASETS_STORE).clear();
          transaction.objectStore(ENTRY_CHUNKS_STORE).clear();
          transaction.objectStore(KNOWN_WORD_SETS_STORE).clear();
          transaction.objectStore(PREFERENCES_STORE).clear();
          transaction.objectStore(META_STORE).clear();
          transaction.objectStore(WORD_DECISIONS_STORE).clear();
          transaction.objectStore(ANKI_SYNC_STORE).clear();
          resolveResult(undefined);
        },
      );
    });
  }

  async clearAll(): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [
          DATASETS_STORE,
          ENTRY_CHUNKS_STORE,
          KNOWN_WORD_SETS_STORE,
          PREFERENCES_STORE,
          META_STORE,
          WORD_DECISIONS_STORE,
          ANKI_SYNC_STORE,
          "syncOutbox",
          "queues",
          "workspace",
          "syncMeta",
        ],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(DATASETS_STORE).clear();
          transaction.objectStore(ENTRY_CHUNKS_STORE).clear();
          transaction.objectStore(KNOWN_WORD_SETS_STORE).clear();
          transaction.objectStore(PREFERENCES_STORE).clear();
          transaction.objectStore(META_STORE).clear();
          transaction.objectStore(WORD_DECISIONS_STORE).clear();
          transaction.objectStore(ANKI_SYNC_STORE).clear();
          transaction.objectStore("syncOutbox").clear();
          transaction.objectStore("queues").clear();
          transaction.objectStore("workspace").clear();
          transaction.objectStore("syncMeta").clear();
          resolveResult(undefined);
        },
      );
    });
  }
}

export function createIndexedDbAppStore(
  databaseNameOrOptions?: string | IndexedDbAppStoreOptions,
): IndexedDbAppStore {
  return new IndexedDbAppStore(databaseNameOrOptions);
}
