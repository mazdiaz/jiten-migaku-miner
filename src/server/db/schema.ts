import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Entry, WordDecision } from "../../domain/types";
import type { DatasetMetadata } from "../../storage/contracts";

export const datasets = pgTable(
  "datasets",
  {
    id: text("id").primaryKey(),
    uploadId: uuid("upload_id").notNull(),
    metadata: jsonb("metadata").$type<DatasetMetadata>().notNull(),
    status: text("status").notNull().default("staging"),
    baseRevision: bigint("base_revision", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("datasets_upload_id_idx").on(table.uploadId),
    check("datasets_status_check", sql`${table.status} in ('staging', 'ready')`),
  ],
);
export const datasetChunks = pgTable(
  "dataset_chunks",
  {
    datasetId: text("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    entries: jsonb("entries").$type<Entry[]>().notNull(),
    rowCount: integer("row_count").notNull(),
    byteCount: integer("byte_count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.datasetId, table.ordinal] })],
);
export const appState = pgTable(
  "app_state",
  {
    id: integer("id").primaryKey(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    activeDatasetId: text("active_dataset_id").references(() => datasets.id, {
      onDelete: "set null",
    }),
    knownMetadata: jsonb("known_metadata"),
    preferences: jsonb("preferences"),
    ankiConfig: jsonb("anki_config"),
    ankiSyncedAt: text("anki_synced_at"),
  },
  (table) => [check("app_state_singleton", sql`${table.id} = 1`)],
);
export const knownWords = pgTable("known_words", { word: text("word").primaryKey() });
export const wordDecisions = pgTable("word_decisions", {
  word: text("word").primaryKey(),
  decision: jsonb("decision").$type<WordDecision>().notNull(),
});
export const ankiStatuses = pgTable("anki_statuses", {
  word: text("word").primaryKey(),
  status: text("status").notNull(),
});
export const queues = pgTable("queues", {
  datasetId: text("dataset_id")
    .primaryKey()
    .references(() => datasets.id, { onDelete: "cascade" }),
});
export const queueWords = pgTable(
  "queue_words",
  {
    datasetId: text("dataset_id")
      .notNull()
      .references(() => queues.datasetId, { onDelete: "cascade" }),
    word: text("word").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.datasetId, table.word] }),
    uniqueIndex("queue_words_order_idx").on(table.datasetId, table.ordinal),
  ],
);
export const stateUploads = pgTable("state_uploads", {
  id: uuid("id").primaryKey(),
  target: text("target").notNull(),
  baseRevision: bigint("base_revision", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const stateUploadChunks = pgTable(
  "state_upload_chunks",
  {
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => stateUploads.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    payload: text("payload").notNull(),
    byteCount: integer("byte_count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.uploadId, table.ordinal] })],
);
