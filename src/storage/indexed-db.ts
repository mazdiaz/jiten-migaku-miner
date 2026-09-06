import type {
  Entry,
  QueryState,
  ViewState,
  WordDecision,
} from "../domain/types";
import type {
  AppStore,
  DatasetMetadata,
  DatasetStore,
  KnownWordStore,
  PreferencesStore,
  WordDecisionStore,
} from "./contracts";

export const INDEXED_DB_NAME = "jiten-migaku-miner";
export const INDEXED_DB_VERSION = 2;

const DATASETS_STORE = "datasets";
const ENTRY_CHUNKS_STORE = "entryChunks";
const KNOWN_WORD_SETS_STORE = "knownWordSets";
const PREFERENCES_STORE = "preferences";
const META_STORE = "meta";
const WORD_DECISIONS_STORE = "wordDecisions";
const ACTIVE_DATASET_KEY = "activeDatasetId";
const ACTIVE_KNOWN_WORD_SET_KEY = "activeKnownWordSetId";
const PREFERENCES_KEY = "current";
const READ_BATCH_SIZE = 32;

type StoreName =
  | typeof DATASETS_STORE
  | typeof ENTRY_CHUNKS_STORE
  | typeof KNOWN_WORD_SETS_STORE
  | typeof PREFERENCES_STORE
  | typeof META_STORE
  | typeof WORD_DECISIONS_STORE;

interface DatasetRecord extends DatasetMetadata {
  ready: boolean;
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

function datasetRange(datasetId: string): IDBKeyRange {
  return IDBKeyRange.bound(
    [datasetId, 0],
    [datasetId, Number.MAX_SAFE_INTEGER],
  );
}

function requestError(request: { error: DOMException | null }): Error {
  return request.error ?? new Error("IndexedDB request failed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openDatabase(name: string): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }

  return new Promise((resolve, reject) => {
    const request = factory.open(name, INDEXED_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATASETS_STORE)) {
        database.createObjectStore(DATASETS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(ENTRY_CHUNKS_STORE)) {
        database.createObjectStore(ENTRY_CHUNKS_STORE, {
          keyPath: ["datasetId", "chunkIndex"],
        });
      }
      if (!database.objectStoreNames.contains(KNOWN_WORD_SETS_STORE)) {
        database.createObjectStore(KNOWN_WORD_SETS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PREFERENCES_STORE)) {
        database.createObjectStore(PREFERENCES_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(WORD_DECISIONS_STORE)) {
        database.createObjectStore(WORD_DECISIONS_STORE, {
          keyPath: "normalizedWord",
        });
      }
    };
    request.onerror = () => reject(requestError(request));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function withDatabase<T>(
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

function runTransaction<T>(
  database: IDBDatabase,
  storeNames: readonly StoreName[],
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
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    };
    transaction.onabort = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        hasAbortReason
          ? abortReason
          : transaction.error ?? new Error("IndexedDB transaction aborted"),
      );
    };

    try {
      operation(transaction, resolveResult, abort);
    } catch (error) {
      abort(error);
    }
  });
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

async function readMeta(
  database: IDBDatabase,
  key: string,
): Promise<string | null> {
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

async function cleanupDataset(
  database: IDBDatabase,
  datasetId: string,
): Promise<void> {
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

  constructor(private readonly databaseName: string) {}

  async stage(
    metadata: DatasetMetadata,
    chunks: AsyncIterable<readonly Entry[]>,
  ): Promise<void> {
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

          await runTransaction<void>(
            database,
            [DATASETS_STORE],
            "readwrite",
            (transaction, resolveResult, abort) => {
              const request = transaction.objectStore(DATASETS_STORE).get(metadata.id) as IDBRequest<
                DatasetRecord | undefined
              >;
              request.onsuccess = () => {
                const current = request.result;
                if (!current) {
                  abort(new Error(`Dataset not found: ${metadata.id}`));
                  return;
                }
                transaction.objectStore(DATASETS_STORE).put({
                  ...current,
                  ready: true,
                } satisfies DatasetRecord);
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
      await runTransaction<void>(
        database,
        [DATASETS_STORE, META_STORE],
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
        .filter((record) => record.ready)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(metadataFromRecord);
    });
  }

  async *readChunks(
    datasetId: string,
    chunkSize: number,
  ): AsyncGenerator<Entry[], void, unknown> {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError("chunkSize must be a positive integer");
    }

    const dataset = await withDatabase(this.databaseName, async (database) => {
      const dataset = await readDataset(database, datasetId);
      if (!dataset?.ready) {
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
            const request = transaction.objectStore(ENTRY_CHUNKS_STORE).getAll(
              range,
              READ_BATCH_SIZE,
            ) as IDBRequest<EntryChunkRecord[]>;
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
      range = IDBKeyRange.lowerBound(
        [datasetId, lastRecord.chunkIndex],
        true,
      );
    }

    if (pending.length > 0) {
      yield pending;
    }
  }

  async remove(datasetId: string): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
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
    });
  }
}

class IndexedDbKnownWordStore implements KnownWordStore {
  constructor(private readonly databaseName: string) {}

  async save(id: string, name: string, words: Iterable<string>): Promise<void> {
    const record: KnownWordSetRecord = { id, name, words: [...new Set(words)] };
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [KNOWN_WORD_SETS_STORE, META_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(KNOWN_WORD_SETS_STORE).put(record);
          transaction.objectStore(META_STORE).put({
            key: ACTIVE_KNOWN_WORD_SET_KEY,
            value: id,
          } satisfies MetaRecord);
          resolveResult(undefined);
        },
      );
    });
  }

  async getActive(): Promise<{ id: string; name: string; words: Set<string> } | null> {
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
          const request = transaction.objectStore(KNOWN_WORD_SETS_STORE).get(activeId) as IDBRequest<
            KnownWordSetRecord | undefined
          >;
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
      await runTransaction<void>(
        database,
        [KNOWN_WORD_SETS_STORE, META_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(KNOWN_WORD_SETS_STORE).delete(id);
          const request = transaction.objectStore(META_STORE).get(ACTIVE_KNOWN_WORD_SET_KEY) as IDBRequest<MetaRecord | undefined>;
          request.onsuccess = () => {
            if (request.result?.value === id) transaction.objectStore(META_STORE).delete(ACTIVE_KNOWN_WORD_SET_KEY);
            resolveResult(undefined);
          };
        },
      );
    });
  }

  async clear(): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [KNOWN_WORD_SETS_STORE, META_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(KNOWN_WORD_SETS_STORE).clear();
          transaction.objectStore(META_STORE).delete(ACTIVE_KNOWN_WORD_SET_KEY);
          resolveResult(undefined);
        },
      );
    });
  }
}

class IndexedDbPreferencesStore implements PreferencesStore {
  constructor(private readonly databaseName: string) {}

  async load(): Promise<{ query: QueryState; view: ViewState; page: number } | null> {
    return withDatabase(this.databaseName, async (database) => {
      const record = await runTransaction<PreferencesRecord | undefined>(
        database,
        [PREFERENCES_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction.objectStore(PREFERENCES_STORE).get(
            PREFERENCES_KEY,
          ) as IDBRequest<PreferencesRecord | undefined>;
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

  async save(value: {
    query: QueryState;
    view: ViewState;
    page: number;
  }): Promise<void> {
    const record: PreferencesRecord = {
      id: PREFERENCES_KEY,
      query: { ...value.query },
      view: { ...value.view },
      page: value.page,
    };
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [PREFERENCES_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(PREFERENCES_STORE).put(record);
          resolveResult(undefined);
        },
      );
    });
  }

  async clear(): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [PREFERENCES_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(PREFERENCES_STORE).clear();
          resolveResult(undefined);
        },
      );
    });
  }
}

class IndexedDbWordDecisionStore implements WordDecisionStore {
  constructor(private readonly databaseName: string) {}

  async get(normalizedWord: string): Promise<WordDecision | null> {
    return withDatabase(this.databaseName, async (database) => {
      const record = await runTransaction<WordDecision | undefined>(
        database,
        [WORD_DECISIONS_STORE],
        "readonly",
        (transaction, resolveResult) => {
          const request = transaction.objectStore(WORD_DECISIONS_STORE).get(
            normalizedWord,
          ) as IDBRequest<WordDecision | undefined>;
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
      await runTransaction<void>(
        database,
        [WORD_DECISIONS_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(WORD_DECISIONS_STORE).put(cloneDecision(decision));
          resolveResult(undefined);
        },
      );
    });
  }

  async remove(normalizedWord: string): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [WORD_DECISIONS_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(WORD_DECISIONS_STORE).delete(normalizedWord);
          resolveResult(undefined);
        },
      );
    });
  }

  async replaceAll(decisions: readonly WordDecision[]): Promise<void> {
    const records = decisions.map(cloneDecision);
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [WORD_DECISIONS_STORE],
        "readwrite",
        (transaction, resolveResult, abort) => {
          const store = transaction.objectStore(WORD_DECISIONS_STORE);
          store.clear();
          const seen = new Set<string>();
          for (const record of records) {
            if (seen.has(record.normalizedWord)) {
              abort(new Error(`Duplicate word decision: ${record.normalizedWord}`));
              return;
            }
            seen.add(record.normalizedWord);
            store.put(record);
          }
          resolveResult(undefined);
        },
      );
    });
  }

  async clear(): Promise<void> {
    await withDatabase(this.databaseName, async (database) => {
      await runTransaction<void>(
        database,
        [WORD_DECISIONS_STORE],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(WORD_DECISIONS_STORE).clear();
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

  private readonly databaseName: string;

  constructor(databaseName: string = INDEXED_DB_NAME) {
    this.databaseName = databaseName;
    this.datasets = new IndexedDbDatasetStore(databaseName);
    this.knownWords = new IndexedDbKnownWordStore(databaseName);
    this.wordDecisions = new IndexedDbWordDecisionStore(databaseName);
    this.preferences = new IndexedDbPreferencesStore(databaseName);
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
        ],
        "readwrite",
        (transaction, resolveResult) => {
          transaction.objectStore(DATASETS_STORE).clear();
          transaction.objectStore(ENTRY_CHUNKS_STORE).clear();
          transaction.objectStore(KNOWN_WORD_SETS_STORE).clear();
          transaction.objectStore(PREFERENCES_STORE).clear();
          transaction.objectStore(META_STORE).clear();
          transaction.objectStore(WORD_DECISIONS_STORE).clear();
          resolveResult(undefined);
        },
      );
    });
  }
}

export function createIndexedDbAppStore(
  databaseName: string = INDEXED_DB_NAME,
): IndexedDbAppStore {
  return new IndexedDbAppStore(databaseName);
}
