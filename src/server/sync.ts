import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import type { Entry, WordDecision } from "../domain/types";
import type { DatasetMetadata } from "../storage/contracts";
import type {
  AcceptedMutationReceipt,
  CloudBootstrapManifest,
  PreferencesValue,
  RemoteChange,
  SyncPullPage,
  SyncPushReceipt,
} from "../sync/contracts";
import { getDatabase } from "./db/client";
import { bytes, parseSyncOperation, StoreError } from "./storage/validation";
import {
  json,
  page,
  recordSyncEvent,
  replaceKnown,
  replaceQueue,
  replaceSnapshot,
  rows,
  type StateRow,
  type StoreDatabase,
  type SyncEventInput,
} from "./store";

const notFound = (name: string) =>
  new StoreError(`${name} not found or not ready`, 404, "NOT_FOUND");

export function createPostgresSyncServer(database: StoreDatabase) {
  return async function dispatch(input: unknown): Promise<unknown> {
    const operation = parseSyncOperation(input);

    switch (operation.operation) {
      case "bootstrap": {
        const maxId = await rows<{ max_id: string | number | null }>(
          database,
          sql`SELECT COALESCE(MAX(id), 0) AS max_id FROM sync_events`,
        );
        const stateRow = (
          await rows<{ active_dataset_id: string | null }>(
            database,
            sql`SELECT active_dataset_id FROM app_state WHERE id = 1`,
          )
        )[0];
        const datasets = await rows<{ metadata: DatasetMetadata }>(
          database,
          sql`SELECT metadata FROM datasets WHERE status = 'ready' ORDER BY id COLLATE "C"`,
        );

        const manifest: CloudBootstrapManifest = {
          eventId: Number(maxId[0]?.max_id ?? 0),
          activeDatasetId: stateRow?.active_dataset_id ?? null,
          datasets: datasets.map((d) => d.metadata),
        };
        return manifest;
      }

      case "state.read": {
        await database.execute(sql`INSERT INTO app_state(id) VALUES (1) ON CONFLICT DO NOTHING`);
        const state = (
          await rows<StateRow>(database, sql`SELECT * FROM app_state WHERE id = 1`)
        )[0]!;
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

      case "pull": {
        const afterEventId = operation.afterEventId;
        const limit = Math.min(operation.limit ?? 200, 200);
        const events = await rows<{
          id: string | number;
          app_revision: string | number;
          resource: string;
          resource_key: string | null;
          action: string;
          origin_device_id: string | null;
        }>(
          database,
          sql`SELECT id, app_revision, resource, resource_key, action, origin_device_id
              FROM sync_events
              WHERE id > ${afterEventId}
              ORDER BY id ASC
              LIMIT ${limit}`,
        );

        const changes: RemoteChange[] = [];
        for (const event of events) {
          const id = Number(event.id);
          if (event.resource === "decision") {
            if (event.action === "set") {
              const found = (
                await rows<{ decision: WordDecision }>(
                  database,
                  sql`SELECT decision FROM word_decisions WHERE word = ${event.resource_key}`,
                )
              )[0];
              if (found) {
                changes.push({ id, kind: "decision.set", decision: found.decision });
              } else {
                changes.push({ id, kind: "decision.remove", normalizedWord: event.resource_key! });
              }
            } else {
              changes.push({ id, kind: "decision.remove", normalizedWord: event.resource_key! });
            }
          } else if (event.resource === "preferences") {
            const stateRow = (
              await rows<StateRow>(database, sql`SELECT preferences FROM app_state WHERE id = 1`)
            )[0];
            changes.push({
              id,
              kind: "preferences.replace",
              value: stateRow?.preferences as PreferencesValue,
            });
          } else if (event.resource === "dataset") {
            if (event.action === "upsert") {
              const found = (
                await rows<{ metadata: DatasetMetadata }>(
                  database,
                  sql`SELECT metadata FROM datasets WHERE id = ${event.resource_key} AND status = 'ready'`,
                )
              )[0];
              if (found) {
                changes.push({ id, kind: "dataset.upsert", dataset: found.metadata });
              } else {
                changes.push({ id, kind: "dataset.remove", datasetId: event.resource_key! });
              }
            } else {
              changes.push({ id, kind: "dataset.remove", datasetId: event.resource_key! });
            }
          } else if (event.resource === "dataset-active") {
            changes.push({ id, kind: "dataset.activate", datasetId: event.resource_key });
          } else if (event.resource === "known") {
            changes.push({ id, kind: "known.replace" });
          } else if (event.resource === "queue") {
            if (event.action === "replace") {
              changes.push({ id, kind: "queue.replace", datasetId: event.resource_key! });
            } else {
              changes.push({ id, kind: "queue.remove", datasetId: event.resource_key! });
            }
          } else if (event.resource === "anki") {
            changes.push({ id, kind: "anki.replace" });
          } else if (event.resource === "state" && event.action === "full-reset") {
            changes.push({ id, kind: "full-reset" });
          }
        }

        const nextEventId =
          events.length > 0 ? Number(events[events.length - 1]!.id) : afterEventId;
        const result: SyncPullPage = { changes, nextEventId };
        return result;
      }

      case "push": {
        return database.transaction(async (transaction) => {
          await transaction.execute(
            sql`INSERT INTO app_state(id) VALUES (1) ON CONFLICT DO NOTHING`,
          );
          const state = (
            await rows<StateRow>(transaction, sql`SELECT * FROM app_state WHERE id = 1 FOR UPDATE`)
          )[0]!;
          let revision = Number(state.revision);
          const receipts: AcceptedMutationReceipt[] = [];

          for (const mutation of operation.mutations) {
            const existing = (
              await rows<{ mutation_id: string; accepted_event_id: string | number | null }>(
                transaction,
                sql`SELECT mutation_id, accepted_event_id FROM sync_mutations WHERE mutation_id = ${mutation.mutationId}`,
              )
            )[0];
            if (existing) {
              receipts.push({
                mutationId: mutation.mutationId,
                eventId:
                  existing.accepted_event_id !== null ? Number(existing.accepted_event_id) : null,
              });
              continue;
            }

            let syncEvent: SyncEventInput;
            switch (mutation.kind) {
              case "decision.set": {
                await transaction.execute(
                  sql`INSERT INTO word_decisions(word, decision) VALUES (${mutation.decision.normalizedWord}, ${json(mutation.decision)}) ON CONFLICT(word) DO UPDATE SET decision = excluded.decision`,
                );
                syncEvent = {
                  resource: "decision",
                  resourceKey: mutation.decision.normalizedWord,
                  action: "set",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
              case "decision.remove": {
                await transaction.execute(
                  sql`DELETE FROM word_decisions WHERE word = ${mutation.normalizedWord}`,
                );
                syncEvent = {
                  resource: "decision",
                  resourceKey: mutation.normalizedWord,
                  action: "remove",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
              case "preferences.replace": {
                await transaction.execute(
                  sql`UPDATE app_state SET preferences = ${json(mutation.value)} WHERE id = 1`,
                );
                syncEvent = {
                  resource: "preferences",
                  resourceKey: null,
                  action: "replace",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
              case "dataset.activate": {
                if (mutation.datasetId !== null) {
                  const readyDataset = (
                    await rows(
                      transaction,
                      sql`SELECT id FROM datasets WHERE id = ${mutation.datasetId} AND status = 'ready'`,
                    )
                  )[0];
                  if (!readyDataset) throw notFound("Dataset");
                }
                await transaction.execute(
                  sql`UPDATE app_state SET active_dataset_id = ${mutation.datasetId} WHERE id = 1`,
                );
                syncEvent = {
                  resource: "dataset-active",
                  resourceKey: mutation.datasetId,
                  action: "set",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
              case "dataset.remove": {
                await transaction.execute(
                  sql`DELETE FROM datasets WHERE id = ${mutation.datasetId}`,
                );
                syncEvent = {
                  resource: "dataset",
                  resourceKey: mutation.datasetId,
                  action: "remove",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
              case "known.replace": {
                await replaceKnown(transaction, mutation.value);
                syncEvent = {
                  resource: "known",
                  resourceKey: null,
                  action: "replace",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
              case "queue.replace": {
                await replaceQueue(transaction, mutation.value, null);
                syncEvent = {
                  resource: "queue",
                  resourceKey: mutation.value.datasetId,
                  action: "replace",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
              case "queue.remove": {
                await transaction.execute(
                  sql`DELETE FROM queues WHERE dataset_id = ${mutation.datasetId}`,
                );
                syncEvent = {
                  resource: "queue",
                  resourceKey: mutation.datasetId,
                  action: "remove",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
              case "anki.replace": {
                await transaction.execute(
                  sql`UPDATE app_state SET anki_config = ${mutation.config ? json(mutation.config) : sql`NULL`} WHERE id = 1`,
                );
                await replaceSnapshot(transaction, mutation.snapshot);
                syncEvent = {
                  resource: "anki",
                  resourceKey: null,
                  action: "replace",
                  originDeviceId: operation.deviceId,
                };
                break;
              }
            }

            revision += 1;
            const eventId = await recordSyncEvent(transaction, revision, syncEvent);
            await transaction.execute(
              sql`INSERT INTO sync_mutations(mutation_id, device_id, accepted_event_id) VALUES (${mutation.mutationId}, ${operation.deviceId}, ${eventId})`,
            );
            receipts.push({ mutationId: mutation.mutationId, eventId });
          }

          await transaction.execute(sql`UPDATE app_state SET revision = ${revision} WHERE id = 1`);
          const receipt: SyncPushReceipt = {
            accepted: receipts,
            acceptedMutationIds: receipts.map((r) => r.mutationId),
          };
          return receipt;
        });
      }

      case "dataset.begin": {
        const existing = (
          await rows<{
            id: string;
            upload_id: string;
            status: string;
            metadata: DatasetMetadata;
          }>(
            database,
            sql`SELECT id, upload_id, status, metadata FROM datasets WHERE id = ${operation.metadata.id}`,
          )
        )[0];

        if (existing) {
          if (existing.status === "ready") {
            if (isDeepStrictEqual(existing.metadata, operation.metadata)) {
              const mut = (
                await rows<{ accepted_event_id: string | number | null }>(
                  database,
                  sql`SELECT accepted_event_id FROM sync_mutations WHERE mutation_id = ${operation.mutationId} LIMIT 1`,
                )
              )[0];
              const receipt: SyncPushReceipt = {
                accepted: [
                  {
                    mutationId: operation.mutationId,
                    eventId: mut?.accepted_event_id ? Number(mut.accepted_event_id) : null,
                  },
                ],
                acceptedMutationIds: [operation.mutationId],
              };
              return { uploadId: existing.upload_id, alreadyReady: true, receipt };
            }
            throw new StoreError(
              "Dataset already exists with different metadata",
              409,
              "DATASET_CONFLICT",
            );
          }
          if (existing.upload_id !== operation.mutationId) {
            await database.execute(sql`DELETE FROM datasets WHERE id = ${operation.metadata.id}`);
            await database.execute(
              sql`INSERT INTO datasets(id, upload_id, metadata, status, base_revision, uploaded_rows, uploaded_bytes, next_ordinal)
                  VALUES (${operation.metadata.id}, ${operation.mutationId}, ${json(operation.metadata)}, 'staging', 0, 0, 0, 0)`,
            );
          }
          return { uploadId: operation.mutationId };
        }

        await database.execute(
          sql`INSERT INTO datasets(id, upload_id, metadata, status, base_revision, uploaded_rows, uploaded_bytes, next_ordinal)
              VALUES (${operation.metadata.id}, ${operation.mutationId}, ${json(operation.metadata)}, 'staging', 0, 0, 0, 0)`,
        );
        return { uploadId: operation.mutationId };
      }

      case "dataset.chunks": {
        const existing = (
          await rows<{
            id: string;
            upload_id: string;
            status: string;
            metadata: DatasetMetadata;
            next_ordinal: number;
            uploaded_rows: string | number;
            uploaded_bytes: string | number;
          }>(
            database,
            sql`SELECT id, upload_id, status, metadata, next_ordinal, uploaded_rows, uploaded_bytes FROM datasets WHERE upload_id = ${operation.mutationId}`,
          )
        )[0];

        if (!existing) throw notFound("Dataset upload");
        if (existing.status === "ready") {
          return { ok: true };
        }

        const seen = new Set<number>();
        for (const c of operation.chunks) {
          if (seen.has(c.index)) throw new StoreError("Duplicate chunk index");
          seen.add(c.index);
        }
        const sorted = [...operation.chunks].sort((a, b) => a.index - b.index);
        const nextOrdinal = Number(existing.next_ordinal);
        const retryChunks = sorted.filter((c) => c.index < nextOrdinal);
        const newChunks = sorted.filter((c) => c.index >= nextOrdinal);

        for (const chunk of retryChunks) {
          const match = (
            await rows<{ equal: boolean }>(
              database,
              sql`SELECT entries = ${json(chunk.entries)} AS equal FROM dataset_chunks WHERE dataset_id = ${existing.id} AND ordinal = ${chunk.index}`,
            )
          )[0];
          if (!match?.equal)
            throw new StoreError("Chunk retry contains different data", 409, "CHUNK_CONFLICT");
        }

        let expected = nextOrdinal;
        for (const chunk of newChunks) {
          if (chunk.index !== expected) throw new StoreError("Non-contiguous chunk ordinal");
          expected++;
        }

        if (newChunks.length > 0) {
          const newRows = newChunks.reduce((acc, c) => acc + c.entries.length, 0);
          const newBytes = newChunks.reduce((acc, c) => acc + bytes(c.entries), 0);
          if (
            Number(existing.uploaded_rows) + newRows >
            (existing.metadata as { entryCount: number }).entryCount
          ) {
            throw new StoreError("Upload exceeds expected entry count", 413, "PAYLOAD_TOO_LARGE");
          }

          const payload = newChunks.map((c) => ({
            ordinal: c.index,
            entries: c.entries,
            rowCount: c.entries.length,
            byteCount: bytes(c.entries),
          }));

          await database.transaction(async (tx) => {
            await tx.execute(
              sql`INSERT INTO dataset_chunks(dataset_id, ordinal, entries, row_count, byte_count)
                  SELECT ${existing.id}, (value->>'ordinal')::integer, value->'entries', (value->>'rowCount')::integer, (value->>'byteCount')::integer
                  FROM jsonb_array_elements(${json(payload)}) AS value`,
            );
            await tx.execute(
              sql`UPDATE datasets SET uploaded_rows = uploaded_rows + ${newRows}, uploaded_bytes = uploaded_bytes + ${newBytes}, next_ordinal = next_ordinal + ${newChunks.length} WHERE id = ${existing.id}`,
            );
          });
        }

        return { ok: true };
      }

      case "dataset.finish": {
        return database.transaction(async (transaction) => {
          const dataset = (
            await rows<{
              id: string;
              metadata: DatasetMetadata;
              status: string;
              uploaded_rows: string | number;
              next_ordinal: number;
            }>(
              transaction,
              sql`SELECT id, metadata, status, uploaded_rows, next_ordinal FROM datasets WHERE upload_id = ${operation.mutationId}`,
            )
          )[0];

          if (!dataset) throw notFound("Dataset upload");
          if (dataset.status === "ready") {
            const mut = (
              await rows<{ accepted_event_id: string | number | null }>(
                transaction,
                sql`SELECT accepted_event_id FROM sync_mutations WHERE mutation_id = ${operation.mutationId}`,
              )
            )[0];
            const receipt: SyncPushReceipt = {
              accepted: [
                {
                  mutationId: operation.mutationId,
                  eventId: mut?.accepted_event_id ? Number(mut.accepted_event_id) : null,
                },
              ],
              acceptedMutationIds: [operation.mutationId],
            };
            return receipt;
          }

          if (
            Number(dataset.next_ordinal) !== operation.chunkCount ||
            Number(dataset.uploaded_rows) !== dataset.metadata.entryCount
          ) {
            throw new StoreError("Incomplete dataset: chunk or entry count mismatch");
          }

          const duplicates = await rows(
            transaction,
            sql`SELECT entry->>'id' FROM dataset_chunks CROSS JOIN LATERAL jsonb_array_elements(entries) AS entry
                WHERE dataset_id = ${dataset.id} GROUP BY entry->>'id' HAVING count(*) > 1 LIMIT 1`,
          );
          if (duplicates.length) throw new StoreError("Duplicate dataset entry ID");

          await transaction.execute(
            sql`UPDATE datasets SET status = 'ready' WHERE id = ${dataset.id}`,
          );
          await transaction.execute(
            sql`INSERT INTO app_state(id) VALUES (1) ON CONFLICT DO NOTHING`,
          );
          const state = (
            await rows<StateRow>(transaction, sql`SELECT * FROM app_state WHERE id = 1 FOR UPDATE`)
          )[0]!;
          const nextRevision = Number(state.revision) + 1;
          const eventId = await recordSyncEvent(transaction, nextRevision, {
            resource: "dataset",
            resourceKey: dataset.id,
            action: "upsert",
            originDeviceId: operation.deviceId,
          });
          await transaction.execute(
            sql`INSERT INTO sync_mutations(mutation_id, device_id, accepted_event_id) VALUES (${operation.mutationId}, ${operation.deviceId}, ${eventId}) ON CONFLICT DO NOTHING`,
          );
          await transaction.execute(
            sql`UPDATE app_state SET revision = ${nextRevision} WHERE id = 1`,
          );

          const receipt: SyncPushReceipt = {
            accepted: [{ mutationId: operation.mutationId, eventId }],
            acceptedMutationIds: [operation.mutationId],
          };
          return receipt;
        });
      }

      case "dataset.read": {
        const dataset = (
          await rows(
            database,
            sql`SELECT id FROM datasets WHERE id = ${operation.datasetId} AND status = 'ready'`,
          )
        )[0];
        if (!dataset) throw notFound("Dataset");

        const chunk = (
          await rows<{ entries: Entry[] }>(
            database,
            sql`SELECT entries FROM dataset_chunks WHERE dataset_id = ${operation.datasetId} AND ordinal = ${operation.cursor}`,
          )
        )[0];
        return { items: chunk?.entries ?? [], nextCursor: chunk ? operation.cursor + 1 : null };
      }
    }
  };
}

export async function dispatchSyncOperation(input: unknown): Promise<unknown> {
  return createPostgresSyncServer(getDatabase())(input);
}
