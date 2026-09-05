import type { Entry, QueryState, ViewState } from "../domain/types";
import { WORKER_IMPORT_CHUNK_SIZE } from "../worker/protocol";
import { hasMigrationMarker, readLegacyState, writeMigrationMarker } from "../storage/legacy";
import type { AppStore, DatasetMetadata } from "../storage/contracts";
import type { WorkerClient } from "./worker-client";

const MIGRATION_VERSION = 1;
const LEGACY_STATE_KEY = "jitenMiner.v1";

export interface LegacyMigrationOptions {
  storage: Storage;
  store: AppStore;
  worker: WorkerClient;
  query: QueryState;
  view: ViewState;
  now?: () => string;
  createId?: (kind: "media" | "known") => string;
}

export interface LegacyMigrationResult {
  migrated: boolean;
  warning: string | null;
  storageFailure: boolean;
  page: number;
  dataset: DatasetMetadata | null;
  knownWords: Set<string>;
}

interface PreviousRecords {
  dataset: DatasetMetadata | null;
  known: { id: string; name: string; words: Set<string> } | null;
  preferences: { query: QueryState; view: ViewState; page: number } | null;
}

interface ReversibleStore {
  remove?: (id: string) => Promise<void> | void;
  clear?: () => Promise<void> | void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultId(kind: "media" | "known"): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `legacy-${kind}-${globalThis.crypto.randomUUID()}`;
  }
  return `legacy-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function malformedLegacyRecord(storage: Storage): boolean {
  const raw = storage.getItem(LEGACY_STATE_KEY);
  if (raw === null) return false;

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed !== "object" || parsed === null || Array.isArray(parsed);
  } catch {
    return true;
  }
}

async function* entryChunks(chunks: readonly Entry[][]): AsyncIterable<readonly Entry[]> {
  for (const chunk of chunks) yield chunk;
}

async function readPreviousRecords(store: AppStore): Promise<PreviousRecords> {
  const getDataset = store.datasets.getActive;
  const getKnown = store.knownWords.getActive;
  const loadPreferences = store.preferences.load;
  const [dataset, known, preferences] = await Promise.all([
    typeof getDataset === "function" ? getDataset.call(store.datasets) : null,
    typeof getKnown === "function" ? getKnown.call(store.knownWords) : null,
    typeof loadPreferences === "function" ? loadPreferences.call(store.preferences) : null,
  ]);
  return {
    dataset,
    known: known === null ? null : { id: known.id, name: known.name, words: new Set(known.words) },
    preferences: preferences === null
      ? null
      : { query: { ...preferences.query }, view: { ...preferences.view }, page: preferences.page },
  };
}

async function countEntries(store: AppStore, datasetId: string): Promise<number> {
  let count = 0;
  for await (const chunk of store.datasets.readChunks(datasetId, WORKER_IMPORT_CHUNK_SIZE)) count += chunk.length;
  return count;
}

async function verifyStagedDataset(store: AppStore, metadata: DatasetMetadata): Promise<void> {
  const count = await countEntries(store, metadata.id);
  if (count !== metadata.entryCount) {
    throw new Error(`Migrated dataset verification failed: expected ${metadata.entryCount} entries, found ${count}`);
  }
}

async function verifyActiveDataset(store: AppStore, metadata: DatasetMetadata): Promise<void> {
  const active = await store.datasets.getActive();
  if (active?.id !== metadata.id) throw new Error(`Migrated dataset was not activated: ${metadata.id}`);
  await verifyStagedDataset(store, metadata);
}

async function verifyKnownWords(store: AppStore, id: string, words: ReadonlySet<string>): Promise<void> {
  const active = await store.knownWords.getActive();
  if (active?.id !== id || active.words.size !== words.size || [...words].some((word) => !active.words.has(word))) {
    throw new Error("Migrated known-word set verification failed");
  }
}

async function verifyPreferences(
  store: AppStore,
  expected: { query: QueryState; view: ViewState; page: number },
): Promise<void> {
  const saved = await store.preferences.load();
  if (
    saved === null ||
    saved.page !== expected.page ||
    saved.query.page !== expected.query.page ||
    JSON.stringify(saved.query) !== JSON.stringify(expected.query) ||
    JSON.stringify(saved.view) !== JSON.stringify(expected.view)
  ) {
    throw new Error("Migrated preferences verification failed");
  }
}

async function clearIfSupported(value: ReversibleStore, label: string): Promise<void> {
  if (typeof value.clear !== "function") throw new Error(`Cannot restore empty ${label} store`);
  await value.clear();
}

async function removeIfSupported(value: ReversibleStore, id: string, label: string): Promise<void> {
  if (typeof value.remove !== "function") throw new Error(`Cannot remove migrated ${label} record`);
  await value.remove(id);
}

async function rollback(
  store: AppStore,
  previous: PreviousRecords,
  datasetId: string | null,
  datasetActivationAttempted: boolean,
  knownId: string | null,
  knownSaveAttempted: boolean,
  preferencesSaveAttempted: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  const attempt = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  };

  if (preferencesSaveAttempted) {
    await attempt("preferences rollback", async () => {
      if (previous.preferences !== null) {
        await store.preferences.save(previous.preferences);
      } else {
        await clearIfSupported(store.preferences, "preferences");
      }
    });
  }

  if (knownSaveAttempted) {
    await attempt("known-word rollback", async () => {
      if (previous.known !== null) {
        await store.knownWords.save(previous.known.id, previous.known.name, previous.known.words);
      } else {
        await clearIfSupported(store.knownWords, "known-word");
      }
    });
    if (knownId !== null && knownId !== previous.known?.id) {
      await attempt("known-word cleanup", () => removeIfSupported(store.knownWords, knownId!, "known-word"));
    }
  }

  if (datasetActivationAttempted && previous.dataset !== null) {
    await attempt("dataset activation rollback", () => store.datasets.activate(previous.dataset!.id));
  }
  if (datasetId !== null) {
    await attempt("staged dataset cleanup", () => store.datasets.remove(datasetId));
  }

  return failures;
}

export async function migrateLegacy(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const emptyResult = (
    page: number,
    warning: string | null = null,
    storageFailure = false,
  ): LegacyMigrationResult => ({
    migrated: false,
    warning,
    storageFailure,
    page,
    dataset: null,
    knownWords: new Set<string>(),
  });

  try {
    if (hasMigrationMarker(options.storage, MIGRATION_VERSION)) return emptyResult(options.query.page);
    const legacy = readLegacyState(options.storage);
    if (legacy === null) return emptyResult(options.query.page);
    if (legacy.warning !== undefined) {
      return emptyResult(legacy.page, `${legacy.warning} Legacy keys were preserved.`);
    }
    if (malformedLegacyRecord(options.storage)) {
      return emptyResult(legacy.page, "Legacy migration could not parse saved data; legacy keys were preserved.");
    }

    let previous: PreviousRecords;
    try {
      previous = await readPreviousRecords(options.store);
    } catch (error) {
      return emptyResult(
        legacy.page,
        `Legacy migration failed: ${errorMessage(error)}. Legacy keys were preserved.`,
        true,
      );
    }
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? defaultId;
    let dataset: DatasetMetadata | null = null;
    let datasetChunks: Entry[][] = [];
    const knownWords = new Set<string>();

    // Parse every legacy payload before changing any persistent active pointer.
    if (legacy.mediaText !== null) {
      const name = legacy.mediaFileName || "Jiten CSV";
      const chunks: Entry[][] = [];
      const complete = await options.worker.importJiten(name, legacy.mediaText, (chunk) => {
        chunks.push(chunk.entries);
      });
      const receivedCount = chunks.reduce((count, chunk) => count + chunk.length, 0);
      if (receivedCount !== complete.entryCount) {
        throw new Error(`Migrated dataset count mismatch: expected ${complete.entryCount}, found ${receivedCount}`);
      }
      const timestamp = now();
      datasetChunks = chunks;
      dataset = {
        id: createId("media"),
        name,
        sourceType: "file",
        sourceName: name,
        headers: [...complete.headers],
        entryCount: complete.entryCount,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: 1,
      };
    }

    if (legacy.knownText !== null) {
      const name = legacy.knownFileName || "Migaku known words";
      const chunks: string[][] = [];
      const complete = await options.worker.importKnown(name, legacy.knownText, (chunk) => {
        chunks.push(chunk.words);
      });
      for (const chunk of chunks) for (const word of chunk) knownWords.add(word);
      if (knownWords.size !== complete.wordCount) {
        throw new Error(`Migrated known-word count mismatch: expected ${complete.wordCount}, found ${knownWords.size}`);
      }
    }

    const page = legacy.page;
    const migratedPreferences = {
      query: { ...options.query, page },
      view: { ...options.view },
      page,
    };
    let stagedDatasetId: string | null = null;
    let datasetActivationAttempted = false;
    let knownId: string | null = null;
    let knownSaveAttempted = false;
    let preferencesSaveAttempted = false;

    try {
      if (dataset !== null) {
        stagedDatasetId = dataset.id;
        await options.store.datasets.stage(dataset, entryChunks(datasetChunks));
        await verifyStagedDataset(options.store, dataset);
      }

      if (dataset !== null) {
        datasetActivationAttempted = true;
        await options.store.datasets.activate(dataset.id);
        await verifyActiveDataset(options.store, dataset);
      }

      if (legacy.knownText !== null) {
        knownSaveAttempted = true;
        knownId = createId("known");
        await options.store.knownWords.save(knownId, legacy.knownFileName || "Migaku known words", knownWords);
        const activeKnown = await options.store.knownWords.getActive();
        if (activeKnown === null) throw new Error("Migrated known-word set was not activated");
        await verifyKnownWords(options.store, knownId, knownWords);
      }

      preferencesSaveAttempted = true;
      await options.store.preferences.save(migratedPreferences);
      await verifyPreferences(options.store, migratedPreferences);
      writeMigrationMarker(options.storage, MIGRATION_VERSION);

      return { migrated: true, warning: null, storageFailure: false, page, dataset, knownWords };
    } catch (error) {
      const rollbackFailures = await rollback(
        options.store,
        previous,
        stagedDatasetId,
        datasetActivationAttempted,
        knownId,
        knownSaveAttempted,
        preferencesSaveAttempted,
      );
      const rollbackMessage = rollbackFailures.length > 0
        ? ` Rollback warnings: ${rollbackFailures.join("; ")}.`
        : "";
      return emptyResult(
        page,
        `Legacy migration failed: ${errorMessage(error)}.${rollbackMessage} Legacy keys were preserved.`,
        true,
      );
    }
  } catch (error) {
    const page = (() => {
      try {
        return readLegacyState(options.storage)?.page ?? options.query.page;
      } catch {
        return options.query.page;
      }
    })();
    return emptyResult(page, `Legacy migration failed: ${errorMessage(error)}. Legacy keys were preserved.`);
  }
}
