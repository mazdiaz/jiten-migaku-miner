import { randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Entry } from "../domain/types";
import { getDatabase } from "./db/client";
import {
  assertUnique,
  bytes,
  type CompleteBackup,
  completeBackupSchema,
  decisionSchema,
  knownSchema,
  MAX_CHUNK_BYTES,
  MAX_ROWS,
  MAX_UPLOAD_BYTES,
  type Operation,
  parseOperation,
  queueSchema,
  StoreError,
  snapshotSchema,
  userStateSchema,
} from "./storage/validation";

export { StoreError } from "./storage/validation";
/** Structural Drizzle interface shared by postgres-js and PGlite, including transactions. */
export interface StoreDatabase {
  execute(query: SQL): Promise<unknown>;
  transaction<T>(callback: (transaction: StoreDatabase) => Promise<T>): Promise<T>;
}
type Row = Record<string, unknown>;
async function rows<T extends Row = Row>(database: StoreDatabase, query: SQL): Promise<T[]> {
  const result = await database.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
const conflict = () =>
  new StoreError(
    "Data changed in another tab. Reload before saving or reading again.",
    409,
    "REVISION_CONFLICT",
  );
const notFound = (name: string) =>
  new StoreError(`${name} not found or not ready`, 404, "NOT_FOUND");
type StateRow = Row & {
  revision: string | number;
  active_dataset_id: string | null;
  known_metadata: { id: string; name: string } | null;
  preferences: unknown;
  anki_config: unknown;
  anki_synced_at: string | null;
};

export type SyncEventInput = {
  resource: string;
  resourceKey: string | null;
  action: string;
  originDeviceId?: string | null;
};

export async function recordSyncEvent(
  database: StoreDatabase,
  appRevision: number,
  event: SyncEventInput,
): Promise<number> {
  const inserted = await rows<{ id: string | number }>(
    database,
    sql`INSERT INTO sync_events(app_revision, resource, resource_key, action, origin_device_id)
        VALUES (${appRevision}, ${event.resource}, ${event.resourceKey}, ${event.action}, ${event.originDeviceId ?? null})
        RETURNING id`,
  );
  return Number(inserted[0]!.id);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new StoreError(
      `Invalid saved state: ${result.error.issues[0]?.message ?? "invalid value"}`,
    );
  return result.data;
}
function page<T>(
  items: T[],
  cursor: number,
  moreAvailable: boolean,
): { items: T[]; nextCursor: number | null } {
  let size = 100,
    length = 0;
  for (const item of items) {
    const itemSize = bytes(item) + 1;
    if (length > 0 && size + itemSize > MAX_CHUNK_BYTES) break;
    if (size + itemSize > 700_000)
      throw new StoreError("Stored item exceeds response limit", 413, "PAYLOAD_TOO_LARGE");
    size += itemSize;
    length++;
  }
  return {
    items: items.slice(0, length),
    nextCursor: moreAvailable || length < items.length ? cursor + length : null,
  };
}
async function batch<T>(values: readonly T[], apply: (chunk: readonly T[]) => Promise<unknown>) {
  for (let index = 0; index < values.length; index += 500)
    await apply(values.slice(index, index + 500));
}
function datasetParts(entries: readonly Entry[]): Entry[][] {
  const result: Entry[][] = [];
  let current: Entry[] = [];
  let size = 2;
  for (const entry of entries) {
    const length = bytes(entry) + 1;
    if (current.length && (size + length > 350_000 || current.length >= 2000)) {
      result.push(current);
      current = [];
      size = 2;
    }
    current.push(entry);
    size += length;
  }
  if (current.length) result.push(current);
  return result;
}
async function saveDatasetChunks(
  database: StoreDatabase,
  datasetId: string,
  entries: readonly Entry[],
) {
  const chunks = datasetParts(entries);
  for (const [index, values] of chunks.entries())
    await database.execute(sql`INSERT INTO dataset_chunks(dataset_id, ordinal, entries, row_count, byte_count)
    VALUES (${datasetId}, ${index}, ${json(values)}, ${values.length}, ${bytes(values)})`);
}
export const KNOWN_WORD_INSERT_BATCH_SIZE = 5_000;

async function replaceKnown(
  database: StoreDatabase,
  value: z.infer<typeof knownSchema> | null,
): Promise<{ id: string; name: string; wordCount: number } | null> {
  await database.execute(sql`DELETE FROM known_words`);
  await database.execute(
    sql`UPDATE app_state SET known_metadata = ${value === null ? sql`NULL` : json({ id: value.id, name: value.name })} WHERE id = 1`,
  );
  if (value) {
    const unique = [...new Set(value.words)];
    for (let index = 0; index < unique.length; index += KNOWN_WORD_INSERT_BATCH_SIZE) {
      const chunk = unique.slice(index, index + KNOWN_WORD_INSERT_BATCH_SIZE);
      await database.execute(
        sql`INSERT INTO known_words(word) SELECT value FROM jsonb_array_elements_text(${json(chunk)}) ON CONFLICT DO NOTHING`,
      );
    }
    return {
      id: value.id,
      name: value.name,
      wordCount: unique.length,
    };
  }
  return null;
}
async function replaceDecisions(database: StoreDatabase, values: z.infer<typeof decisionSchema>[]) {
  assertUnique(
    values.map((value) => value.normalizedWord),
    "word decision",
  );
  await database.execute(sql`DELETE FROM word_decisions`);
  await batch(values, (chunk) =>
    database.execute(
      sql`INSERT INTO word_decisions(word, decision) SELECT value->>'normalizedWord', value FROM jsonb_array_elements(${json(chunk)})`,
    ),
  );
}
async function replaceSnapshot(
  database: StoreDatabase,
  value: z.infer<typeof snapshotSchema> | null,
) {
  if (value)
    assertUnique(
      value.statuses.map(([word]) => word),
      "Anki word",
    );
  await database.execute(sql`DELETE FROM anki_statuses`);
  await database.execute(
    sql`UPDATE app_state SET anki_synced_at = ${value?.syncedAt ?? null} WHERE id = 1`,
  );
  if (value)
    await batch(value.statuses, (chunk) =>
      database.execute(
        sql`INSERT INTO anki_statuses(word, status) SELECT value->>0, value->>1 FROM jsonb_array_elements(${json(chunk)})`,
      ),
    );
}
async function replaceQueue(
  database: StoreDatabase,
  value: z.infer<typeof queueSchema> | null,
  activeId: string | null,
) {
  const id = value?.datasetId ?? activeId;
  if (!id) return;
  if (
    value &&
    !(await rows(database, sql`SELECT id FROM datasets WHERE id = ${id} AND status = 'ready'`))[0]
  )
    throw notFound("Queue dataset");
  await database.execute(sql`DELETE FROM queues WHERE dataset_id = ${id}`);
  if (!value) return;
  assertUnique(value.normalizedWords, "queue word");
  await database.execute(sql`INSERT INTO queues(dataset_id) VALUES (${id})`);
  const words = value.normalizedWords.map((word, ordinal) => ({ word, ordinal }));
  await batch(words, (chunk) =>
    database.execute(sql`INSERT INTO queue_words(dataset_id, word, ordinal)
    SELECT ${id}, value->>'word', (value->>'ordinal')::integer FROM jsonb_array_elements(${json(chunk)})`),
  );
}
async function restoreUser(database: StoreDatabase, value: z.infer<typeof userStateSchema>) {
  await replaceKnown(database, value.knownWords);
  await replaceDecisions(database, value.decisions);
  await database.execute(
    sql`UPDATE app_state SET preferences = ${json(value.preferences)}, anki_config = ${value.ankiSync?.config ? json(value.ankiSync.config) : sql`NULL`} WHERE id = 1`,
  );
  await replaceSnapshot(database, value.ankiSync?.snapshot ?? null);
}
async function clearAll(database: StoreDatabase) {
  await database.execute(sql`DELETE FROM datasets`);
  await database.execute(sql`DELETE FROM known_words`);
  await database.execute(sql`DELETE FROM word_decisions`);
  await database.execute(sql`DELETE FROM anki_statuses`);
  await database.execute(
    sql`UPDATE app_state SET active_dataset_id = NULL, known_metadata = NULL, preferences = NULL, anki_config = NULL, anki_synced_at = NULL WHERE id = 1`,
  );
  await database.execute(sql`DELETE FROM state_uploads`);
}
async function restoreComplete(database: StoreDatabase, value: CompleteBackup) {
  assertUnique(
    value.datasets.map((dataset) => dataset.metadata.id),
    "dataset ID",
  );
  assertUnique(
    value.queues.map((queue) => queue.datasetId),
    "dataset queue",
  );
  const ids = new Set(value.datasets.map((dataset) => dataset.metadata.id));
  if (value.activeDatasetId !== null && !ids.has(value.activeDatasetId))
    throw new StoreError("Active dataset is missing from backup");
  if (value.queues.some((queue) => !ids.has(queue.datasetId)))
    throw new StoreError("Queue dataset is missing from backup");
  for (const dataset of value.datasets) {
    if (dataset.metadata.entryCount !== dataset.entries.length)
      throw new StoreError("Dataset entry count does not match backup");
    assertUnique(
      dataset.entries.map((entry) => entry.id),
      "entry ID",
    );
  }
  await clearAll(database);
  for (const dataset of value.datasets) {
    await database.execute(
      sql`INSERT INTO datasets(id, upload_id, metadata, status, base_revision) VALUES (${dataset.metadata.id}, ${randomUUID()}, ${json(dataset.metadata)}, 'ready', 0)`,
    );
    await saveDatasetChunks(database, dataset.metadata.id, dataset.entries);
  }
  await replaceKnown(database, value.knownWords);
  await replaceDecisions(database, value.decisions);
  await replaceSnapshot(database, value.ankiSync.snapshot);
  await database.execute(sql`UPDATE app_state SET active_dataset_id = ${value.activeDatasetId}, preferences = ${value.preferences ? json(value.preferences) : sql`NULL`},
    anki_config = ${value.ankiSync.config ? json(value.ankiSync.config) : sql`NULL`} WHERE id = 1`);
  for (const queue of value.queues) await replaceQueue(database, queue, value.activeDatasetId);
}
async function readState(
  database: StoreDatabase,
  state: StateRow,
  operation: Extract<Operation, { operation: "state.read" }>,
): Promise<unknown> {
  const cursor = operation.cursor;
  if (operation.resource === "preferences") return state.preferences;
  if (operation.resource === "ankiConfig") return state.anki_config;
  if (operation.resource === "knownWords") {
    if (!state.known_metadata) return null;
    const values = await rows<{ word: string }>(
      database,
      sql`SELECT word FROM known_words ORDER BY word COLLATE "C" LIMIT 4096 OFFSET ${cursor}`,
    );
    return {
      ...state.known_metadata,
      ...page(
        values.map((item) => item.word),
        cursor,
        values.length === 4096,
      ),
    };
  }
  if (operation.resource === "decisions") {
    const values = await rows(
      database,
      sql`SELECT decision FROM word_decisions ORDER BY word COLLATE "C" LIMIT 1024 OFFSET ${cursor}`,
    );
    return page(
      values.map((item) => item.decision),
      cursor,
      values.length === 1024,
    );
  }
  if (operation.resource === "ankiSnapshot") {
    if (!state.anki_synced_at) return null;
    const values = await rows<{ word: string; status: string }>(
      database,
      sql`SELECT word, status FROM anki_statuses ORDER BY word COLLATE "C" LIMIT 4096 OFFSET ${cursor}`,
    );
    return {
      syncedAt: state.anki_synced_at,
      ...page(
        values.map((item) => [item.word, item.status]),
        cursor,
        values.length === 4096,
      ),
    };
  }
  if (operation.resource === "queues") {
    const values = await rows<{ dataset_id: string }>(
      database,
      sql`SELECT dataset_id FROM queues ORDER BY dataset_id COLLATE "C" LIMIT 512 OFFSET ${cursor}`,
    );
    return page(
      values.map((item) => item.dataset_id),
      cursor,
      values.length === 512,
    );
  }
  const id = operation.datasetId ?? state.active_dataset_id;
  if (
    !id ||
    !(await rows(database, sql`SELECT dataset_id FROM queues WHERE dataset_id = ${id}`))[0]
  )
    return null;
  const values = await rows<{ word: string }>(
    database,
    sql`SELECT word FROM queue_words WHERE dataset_id = ${id} ORDER BY ordinal LIMIT 4096 OFFSET ${cursor}`,
  );
  return {
    version: 1,
    datasetId: id,
    ...page(
      values.map((item) => item.word),
      cursor,
      values.length === 4096,
    ),
  };
}

export function createPostgresStore(database: StoreDatabase) {
  return async function dispatch(input: unknown): Promise<{ revision: number; value: unknown }> {
    const operation = parseOperation(input);
    return database.transaction(async (transaction) => {
      await transaction.execute(sql`INSERT INTO app_state(id) VALUES (1) ON CONFLICT DO NOTHING`);
      const state = (
        await rows<StateRow>(transaction, sql`SELECT * FROM app_state WHERE id = 1 FOR UPDATE`)
      )[0]!;
      const revision = Number(state.revision);
      if (operation.operation === "initialize") return { revision, value: null };
      if (revision !== operation.revision) throw conflict();
      let value: unknown = null,
        mutated = false,
        syncEvent: SyncEventInput | null = null;
      switch (operation.operation) {
        case "dataset.begin": {
          if (
            (
              await rows(
                transaction,
                sql`SELECT id FROM datasets WHERE id = ${operation.metadata.id}`,
              )
            )[0]
          )
            throw new StoreError("Dataset already exists", 409, "ALREADY_EXISTS");
          const uploadId = randomUUID();
          await transaction.execute(
            sql`INSERT INTO datasets(id, upload_id, metadata, base_revision) VALUES (${operation.metadata.id}, ${uploadId}, ${json(operation.metadata)}, ${revision})`,
          );
          value = { uploadId };
          break;
        }
        case "dataset.chunk": {
          const dataset = (
            await rows<{
              id: string;
              base_revision: string | number;
              uploaded_rows: string | number;
              uploaded_bytes: string | number;
              next_ordinal: number;
            }>(
              transaction,
              sql`SELECT id, base_revision, uploaded_rows, uploaded_bytes, next_ordinal FROM datasets WHERE upload_id = ${operation.uploadId} AND status = 'staging'`,
            )
          )[0];
          if (!dataset) throw notFound("Dataset upload");
          if (Number(dataset.base_revision) !== revision) throw conflict();
          const byteCount = bytes(operation.entries);
          if (byteCount > MAX_CHUNK_BYTES)
            throw new StoreError("Dataset chunk exceeds size limit", 413, "PAYLOAD_TOO_LARGE");

          const nextOrdinal = Number(dataset.next_ordinal);
          if (operation.index < nextOrdinal) {
            // PostgreSQL jsonb normalizes object property order; compare values in the database.
            const match = (
              await rows(
                transaction,
                sql`SELECT entries = ${json(operation.entries)} AS equal FROM dataset_chunks WHERE dataset_id = ${dataset.id} AND ordinal = ${operation.index}`,
              )
            )[0];
            if (!match?.equal)
              throw new StoreError("Chunk retry contains different data", 409, "CHUNK_CONFLICT");
          } else if (operation.index === nextOrdinal) {
            if (
              Number(dataset.uploaded_bytes) + byteCount > MAX_UPLOAD_BYTES ||
              Number(dataset.uploaded_rows) + operation.entries.length > MAX_ROWS
            )
              throw new StoreError(
                "Dataset upload exceeds total size or row limit",
                413,
                "PAYLOAD_TOO_LARGE",
              );
            await transaction.execute(
              sql`INSERT INTO dataset_chunks(dataset_id, ordinal, entries, row_count, byte_count) VALUES (${dataset.id}, ${operation.index}, ${json(operation.entries)}, ${operation.entries.length}, ${byteCount})`,
            );
            await transaction.execute(
              sql`UPDATE datasets SET uploaded_rows = uploaded_rows + ${operation.entries.length}, uploaded_bytes = uploaded_bytes + ${byteCount}, next_ordinal = next_ordinal + 1 WHERE id = ${dataset.id}`,
            );
          } else {
            throw new StoreError(
              `Non-contiguous chunk ordinal: expected ${nextOrdinal}, got ${operation.index}`,
              400,
              "BAD_REQUEST",
            );
          }
          break;
        }
        case "dataset.chunks": {
          const dataset = (
            await rows<{
              id: string;
              base_revision: string | number;
              uploaded_rows: string | number;
              uploaded_bytes: string | number;
              next_ordinal: number;
            }>(
              transaction,
              sql`SELECT id, base_revision, uploaded_rows, uploaded_bytes, next_ordinal FROM datasets WHERE upload_id = ${operation.uploadId} AND status = 'staging'`,
            )
          )[0];
          if (!dataset) throw notFound("Dataset upload");
          if (Number(dataset.base_revision) !== revision) throw conflict();

          for (const chunk of operation.chunks) {
            const byteCount = bytes(chunk.entries);
            if (byteCount > MAX_CHUNK_BYTES)
              throw new StoreError("Dataset chunk exceeds size limit", 413, "PAYLOAD_TOO_LARGE");
          }

          const seenIndices = new Set<number>();
          for (const chunk of operation.chunks) {
            if (seenIndices.has(chunk.index)) {
              throw new StoreError("Duplicate chunk ordinal in request", 400, "BAD_REQUEST");
            }
            seenIndices.add(chunk.index);
          }

          const sortedChunks = [...operation.chunks].sort((a, b) => a.index - b.index);
          const nextOrdinal = Number(dataset.next_ordinal);
          const retryChunks: typeof operation.chunks = [];
          const newChunks: typeof operation.chunks = [];

          for (const chunk of sortedChunks) {
            if (chunk.index < nextOrdinal) {
              retryChunks.push(chunk);
            } else {
              newChunks.push(chunk);
            }
          }

          for (const chunk of retryChunks) {
            const match = (
              await rows(
                transaction,
                sql`SELECT entries = ${json(chunk.entries)} AS equal FROM dataset_chunks WHERE dataset_id = ${dataset.id} AND ordinal = ${chunk.index}`,
              )
            )[0];
            if (!match?.equal)
              throw new StoreError("Chunk retry contains different data", 409, "CHUNK_CONFLICT");
          }

          let expectedOrdinal = nextOrdinal;
          for (const chunk of newChunks) {
            if (chunk.index !== expectedOrdinal) {
              throw new StoreError(
                `Non-contiguous chunk ordinal: expected ${expectedOrdinal}, got ${chunk.index}`,
                400,
                "BAD_REQUEST",
              );
            }
            expectedOrdinal++;
          }

          if (newChunks.length > 0) {
            let newBytes = 0;
            let newRows = 0;
            for (const chunk of newChunks) {
              newBytes += bytes(chunk.entries);
              newRows += chunk.entries.length;
            }
            if (
              Number(dataset.uploaded_bytes) + newBytes > MAX_UPLOAD_BYTES ||
              Number(dataset.uploaded_rows) + newRows > MAX_ROWS
            ) {
              throw new StoreError(
                "Dataset upload exceeds total size or row limit",
                413,
                "PAYLOAD_TOO_LARGE",
              );
            }
            const payload = newChunks.map(({ index, entries }) => ({
              ordinal: index,
              entries,
              rowCount: entries.length,
              byteCount: bytes(entries),
            }));
            await transaction.execute(
              sql`INSERT INTO dataset_chunks(dataset_id, ordinal, entries, row_count, byte_count)
SELECT
  ${dataset.id},
  (value->>'ordinal')::integer,
  value->'entries',
  (value->>'rowCount')::integer,
  (value->>'byteCount')::integer
FROM jsonb_array_elements(${json(payload)}) AS value`,
            );
            await transaction.execute(
              sql`UPDATE datasets SET uploaded_rows = uploaded_rows + ${newRows}, uploaded_bytes = uploaded_bytes + ${newBytes}, next_ordinal = next_ordinal + ${newChunks.length} WHERE id = ${dataset.id}`,
            );
          }
          break;
        }
        case "dataset.finish": {
          const dataset = (
            await rows<{
              id: string;
              metadata: { entryCount: number };
              base_revision: string | number;
              uploaded_rows: string | number;
              next_ordinal: number;
            }>(
              transaction,
              sql`SELECT id, metadata, base_revision, uploaded_rows, next_ordinal FROM datasets WHERE upload_id = ${operation.uploadId} AND status = 'staging'`,
            )
          )[0];
          if (!dataset) throw notFound("Dataset upload");
          if (Number(dataset.base_revision) !== revision) throw conflict();
          if (
            Number(dataset.next_ordinal) !== operation.chunkCount ||
            Number(dataset.uploaded_rows) !==
              (dataset.metadata as { entryCount: number }).entryCount
          )
            throw new StoreError("Incomplete dataset: chunk or entry count mismatch");
          const duplicates = await rows(
            transaction,
            sql`SELECT entry->>'id' FROM dataset_chunks CROSS JOIN LATERAL jsonb_array_elements(entries) AS entry
            WHERE dataset_id = ${dataset.id} GROUP BY entry->>'id' HAVING count(*) > 1 LIMIT 1`,
          );
          if (duplicates.length) throw new StoreError("Duplicate dataset entry ID");
          await transaction.execute(
            sql`UPDATE datasets SET status = 'ready' WHERE id = ${dataset.id}`,
          );
          syncEvent = { resource: "dataset", resourceKey: dataset.id, action: "upsert" };
          mutated = true;
          break;
        }
        case "dataset.activate": {
          if (
            !(
              await rows(
                transaction,
                sql`SELECT id FROM datasets WHERE id = ${operation.datasetId} AND status = 'ready'`,
              )
            )[0]
          )
            throw notFound("Dataset");
          await transaction.execute(
            sql`UPDATE app_state SET active_dataset_id = ${operation.datasetId} WHERE id = 1`,
          );
          syncEvent = { resource: "dataset-active", resourceKey: operation.datasetId, action: "set" };
          mutated = true;
          break;
        }
        case "dataset.remove":
          await transaction.execute(sql`DELETE FROM datasets WHERE id = ${operation.datasetId}`);
          syncEvent = { resource: "dataset", resourceKey: operation.datasetId, action: "remove" };
          mutated = true;
          break;
        case "dataset.active":
          value = state.active_dataset_id
            ? ((
                await rows(
                  transaction,
                  sql`SELECT metadata FROM datasets WHERE id = ${state.active_dataset_id} AND status = 'ready'`,
                )
              )[0]?.metadata ?? null)
            : null;
          break;
        case "dataset.list": {
          const values = await rows(
            transaction,
            sql`SELECT metadata FROM datasets WHERE status = 'ready' ORDER BY id COLLATE "C" LIMIT 64 OFFSET ${operation.cursor}`,
          );
          value = page(
            values.map((item) => item.metadata),
            operation.cursor,
            values.length === 64,
          );
          break;
        }
        case "dataset.read": {
          if (
            !(
              await rows(
                transaction,
                sql`SELECT id FROM datasets WHERE id = ${operation.datasetId} AND status = 'ready'`,
              )
            )[0]
          )
            throw notFound("Dataset");
          const chunk = (
            await rows(
              transaction,
              sql`SELECT entries FROM dataset_chunks WHERE dataset_id = ${operation.datasetId} AND ordinal = ${operation.cursor}`,
            )
          )[0];
          value = { items: chunk?.entries ?? [], nextCursor: chunk ? operation.cursor + 1 : null };
          break;
        }
        case "state.read":
          value = await readState(transaction, state, operation);
          break;
        case "decision.get":
          value =
            (
              await rows(
                transaction,
                sql`SELECT decision FROM word_decisions WHERE word = ${operation.word}`,
              )
            )[0]?.decision ?? null;
          break;
        case "decision.set":
          await transaction.execute(
            sql`INSERT INTO word_decisions(word, decision) VALUES (${operation.decision.normalizedWord}, ${json(operation.decision)}) ON CONFLICT(word) DO UPDATE SET decision = excluded.decision`,
          );
          syncEvent = { resource: "decision", resourceKey: operation.decision.normalizedWord, action: "set" };
          mutated = true;
          break;
        case "decision.remove":
          await transaction.execute(sql`DELETE FROM word_decisions WHERE word = ${operation.word}`);
          syncEvent = { resource: "decision", resourceKey: operation.word, action: "remove" };
          mutated = true;
          break;
        case "known.remove":
          if (state.known_metadata?.id === operation.id) await replaceKnown(transaction, null);
          syncEvent = { resource: "known", resourceKey: null, action: "replace" };
          mutated = true;
          break;
        case "preferences.save":
          await transaction.execute(
            sql`UPDATE app_state SET preferences = ${json(operation.value)} WHERE id = 1`,
          );
          syncEvent = { resource: "preferences", resourceKey: null, action: "replace" };
          mutated = true;
          break;
        case "ankiConfig.save":
          await transaction.execute(
            sql`UPDATE app_state SET anki_config = ${json(operation.value)} WHERE id = 1`,
          );
          syncEvent = { resource: "anki", resourceKey: null, action: "replace" };
          mutated = true;
          break;
        case "state.clear": {
          if (operation.resource === "all") {
            await clearAll(transaction);
            syncEvent = { resource: "state", resourceKey: null, action: "full-reset" };
          }
          if (operation.resource === "knownWords") {
            await replaceKnown(transaction, null);
            syncEvent = { resource: "known", resourceKey: null, action: "replace" };
          }
          if (operation.resource === "decisions") {
            await replaceDecisions(transaction, []);
            syncEvent = { resource: "state", resourceKey: null, action: "full-reset" };
          }
          if (operation.resource === "preferences") {
            await transaction.execute(sql`UPDATE app_state SET preferences = NULL WHERE id = 1`);
            syncEvent = { resource: "preferences", resourceKey: null, action: "replace" };
          }
          if (operation.resource === "ankiSync") {
            await replaceSnapshot(transaction, null);
            await transaction.execute(sql`UPDATE app_state SET anki_config = NULL WHERE id = 1`);
            syncEvent = { resource: "anki", resourceKey: null, action: "replace" };
          }
          mutated = true;
          break;
        }
        case "state.begin": {
          const uploadId = randomUUID();
          await transaction.execute(
            sql`INSERT INTO state_uploads(id, target, base_revision) VALUES (${uploadId}, ${operation.target}, ${revision})`,
          );
          value = { uploadId };
          break;
        }
        case "state.chunk": {
          const upload = (
            await rows(
              transaction,
              sql`SELECT base_revision FROM state_uploads WHERE id = ${operation.uploadId}`,
            )
          )[0];
          if (!upload) throw notFound("State upload");
          if (Number(upload.base_revision) !== revision) throw conflict();
          const previous = (
            await rows(
              transaction,
              sql`SELECT payload FROM state_upload_chunks WHERE upload_id = ${operation.uploadId} AND ordinal = ${operation.index}`,
            )
          )[0];
          if (previous && previous.payload !== operation.text)
            throw new StoreError("Chunk retry contains different data", 409, "CHUNK_CONFLICT");
          if (!previous) {
            const byteCount = new TextEncoder().encode(operation.text).length;
            const totals = (
              await rows(
                transaction,
                sql`SELECT COALESCE(sum(byte_count),0) AS bytes FROM state_upload_chunks WHERE upload_id = ${operation.uploadId}`,
              )
            )[0]!;
            if (Number(totals.bytes) + byteCount > MAX_UPLOAD_BYTES)
              throw new StoreError(
                "State upload exceeds total size limit",
                413,
                "PAYLOAD_TOO_LARGE",
              );
            await transaction.execute(
              sql`INSERT INTO state_upload_chunks(upload_id, ordinal, payload, byte_count) VALUES (${operation.uploadId}, ${operation.index}, ${operation.text}, ${byteCount})`,
            );
          }
          break;
        }
        case "state.finish": {
          const upload = (
            await rows(
              transaction,
              sql`SELECT target, base_revision FROM state_uploads WHERE id = ${operation.uploadId}`,
            )
          )[0];
          if (!upload) throw notFound("State upload");
          if (Number(upload.base_revision) !== revision) throw conflict();
          const chunks = await rows<{ ordinal: number; payload: string }>(
            transaction,
            sql`SELECT ordinal, payload FROM state_upload_chunks WHERE upload_id = ${operation.uploadId} ORDER BY ordinal`,
          );
          if (
            chunks.length !== operation.chunkCount ||
            chunks.some((chunk, index) => chunk.ordinal !== index)
          )
            throw new StoreError("Incomplete state upload: missing chunk");
          let payload: unknown;
          try {
            payload = JSON.parse(chunks.map((chunk) => chunk.payload).join(""));
          } catch {
            throw new StoreError("Invalid JSON in uploaded state");
          }
          switch (upload.target) {
            case "knownWords":
              value = await replaceKnown(transaction, parse(knownSchema.nullable(), payload));
              syncEvent = { resource: "known", resourceKey: null, action: "replace" };
              break;
            case "decisions":
              await replaceDecisions(
                transaction,
                parse(decisionSchema.array().max(1_000_000), payload),
              );
              syncEvent = { resource: "state", resourceKey: null, action: "full-reset" };
              break;
            case "ankiSnapshot":
              await replaceSnapshot(transaction, parse(snapshotSchema.nullable(), payload));
              syncEvent = { resource: "anki", resourceKey: null, action: "replace" };
              break;
            case "queue": {
              const queueValue = parse(queueSchema.nullable(), payload);
              const queueDatasetId = queueValue?.datasetId ?? state.active_dataset_id;
              await replaceQueue(
                transaction,
                queueValue,
                state.active_dataset_id,
              );
              syncEvent = {
                resource: "queue",
                resourceKey: queueDatasetId,
                action: queueValue ? "replace" : "remove",
              };
              break;
            }
            case "userState":
              await restoreUser(transaction, parse(userStateSchema, payload));
              syncEvent = { resource: "state", resourceKey: null, action: "full-reset" };
              break;
            case "completeBackup":
              await restoreComplete(transaction, parse(completeBackupSchema, payload));
              syncEvent = { resource: "state", resourceKey: null, action: "full-reset" };
              break;
            default:
              throw new StoreError("Invalid upload target");
          }
          await transaction.execute(
            sql`DELETE FROM state_uploads WHERE id = ${operation.uploadId}`,
          );
          mutated = true;
          break;
        }
      }
      if (mutated) {
        const nextRevision = revision + 1;
        if (syncEvent) {
          await recordSyncEvent(transaction, nextRevision, syncEvent);
        }
        await transaction.execute(sql`UPDATE app_state SET revision = revision + 1 WHERE id = 1`);
      }
      const response = { revision: revision + (mutated ? 1 : 0), value };
      if (bytes(response) > 750_000)
        throw new StoreError("Response exceeds size limit", 413, "PAYLOAD_TOO_LARGE");
      return response;
    });
  };
}

export async function dispatchStoreOperation(input: unknown): Promise<unknown> {
  return createPostgresStore(getDatabase())(input);
}
