import { z } from "zod";

export const MAX_WIRE_BYTES = 750_000;
export const MAX_CHUNK_BYTES = 400_000;
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_ROWS = 1_000_000;
export const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const text = z.string().max(100_000);
const key = z.string().min(1).max(512);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const word = key;
const timestamp = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
export const metadataSchema = z
  .object({
    id: key,
    name: text,
    sourceType: z.enum(["file", "folder", "future-remote"]),
    sourceName: text,
    headers: z.array(z.string().max(1024)).max(256),
    entryCount: integer.max(MAX_ROWS),
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: integer.positive(),
  })
  .strict()
  .refine((value) => bytes(value) <= 100_000, "Dataset metadata is too large");
export const entrySchema = z
  .object({
    id: key,
    originalIndex: integer,
    word,
    normalizedWord: word,
    occurrences: z.number().finite().nonnegative(),
    sentenceRaw: text,
    hasSentence: z.boolean(),
    definitions: text,
    furiganaRuns: z.array(z.object({ text, reading: text.nullable() }).strict()).max(10_000),
  })
  .strict()
  .refine((value) => bytes(value) <= MAX_CHUNK_BYTES, "A single entry exceeds the upload limit");
export const decisionSchema = z
  .object({
    normalizedWord: word,
    status: z.enum(["known", "mined", "skip", "later"]),
    updatedAt: timestamp,
  })
  .strict();
export const preferencesSchema = z
  .object({
    query: z
      .object({
        search: text,
        hideKnown: z.boolean(),
        hideKanaOnly: z.boolean(),
        sentence: z.enum(["any", "has", "none"]),
        minOccurrences: z.number().finite().nonnegative(),
        sort: z.enum(["occ-desc", "occ-asc", "original"]),
        pageSize: z.union([integer.positive(), z.literal("all")]),
        page: integer.positive(),
        decision: z.enum(["all", "unreviewed", "known", "mined", "skip", "later"]),
      })
      .strict(),
    view: z
      .object({
        showFurigana: z.boolean(),
        pillHighlight: z.boolean(),
        showHighlight: z.boolean(),
        showDefinitions: z.boolean(),
        sentenceSize: z.enum(["medium", "large"]),
        density: z.enum(["comfortable", "compact"]),
      })
      .strict(),
    page: integer.positive(),
  })
  .strict();
export const configSchema = z
  .object({
    deckScope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("all-decks") }).strict(),
      z.object({ kind: z.literal("deck"), name: key }).strict(),
    ]),
    noteType: key,
    targetField: key,
  })
  .strict();
export const knownSchema = z
  .object({ id: key, name: text, words: z.array(word).max(MAX_ROWS) })
  .strict();
export const snapshotSchema = z
  .object({
    syncedAt: timestamp,
    statuses: z.array(z.tuple([word, z.enum(["known", "mined"])])).max(MAX_ROWS),
  })
  .strict();
export const queueSchema = z
  .object({ version: z.literal(1), datasetId: key, normalizedWords: z.array(word).max(MAX_ROWS) })
  .strict();
export const userStateSchema = z
  .object({
    knownWords: knownSchema.nullable(),
    decisions: z.array(decisionSchema).max(MAX_ROWS),
    preferences: preferencesSchema,
    ankiSync: z
      .object({ config: configSchema.nullable(), snapshot: snapshotSchema.nullable() })
      .strict()
      .optional(),
  })
  .strict();
export const completeBackupSchema = z
  .object({
    version: z.literal(3),
    exportedAt: timestamp,
    datasets: z
      .array(
        z
          .object({ metadata: metadataSchema, entries: z.array(entrySchema).max(MAX_ROWS) })
          .strict(),
      )
      .max(1000),
    activeDatasetId: key.nullable(),
    queues: z.array(queueSchema).max(1000),
    knownWords: knownSchema.nullable(),
    decisions: z.array(decisionSchema).max(MAX_ROWS),
    preferences: preferencesSchema.nullable(),
    ankiSync: z
      .object({ config: configSchema.nullable(), snapshot: snapshotSchema.nullable() })
      .strict(),
  })
  .strict();
export const uploadTargetSchema = z.enum([
  "knownWords",
  "decisions",
  "ankiSnapshot",
  "queue",
  "userState",
  "completeBackup",
]);
const revision = integer;
const uploadId = z.uuid();
const cursor = integer.default(0);
export const operationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("initialize") }).strict(),
  z.object({ operation: z.literal("dataset.begin"), revision, metadata: metadataSchema }).strict(),
  z
    .object({
      operation: z.literal("dataset.chunk"),
      revision,
      uploadId,
      index: integer.max(10000),
      entries: z.array(entrySchema).min(1).max(2500),
    })
    .strict(),
  z
    .object({
      operation: z.literal("dataset.finish"),
      revision,
      uploadId,
      chunkCount: integer.max(10000),
    })
    .strict(),
  z.object({ operation: z.literal("dataset.activate"), revision, datasetId: key }).strict(),
  z.object({ operation: z.literal("dataset.remove"), revision, datasetId: key }).strict(),
  z.object({ operation: z.literal("dataset.active"), revision }).strict(),
  z.object({ operation: z.literal("dataset.list"), revision, cursor }).strict(),
  z.object({ operation: z.literal("dataset.read"), revision, datasetId: key, cursor }).strict(),
  z
    .object({
      operation: z.literal("state.read"),
      revision,
      resource: z.enum([
        "knownWords",
        "decisions",
        "preferences",
        "ankiConfig",
        "ankiSnapshot",
        "queue",
        "queues",
      ]),
      cursor,
      datasetId: key.optional(),
    })
    .strict(),
  z.object({ operation: z.literal("decision.get"), revision, word }).strict(),
  z.object({ operation: z.literal("decision.set"), revision, decision: decisionSchema }).strict(),
  z.object({ operation: z.literal("decision.remove"), revision, word }).strict(),
  z.object({ operation: z.literal("known.remove"), revision, id: key }).strict(),
  z
    .object({ operation: z.literal("preferences.save"), revision, value: preferencesSchema })
    .strict(),
  z.object({ operation: z.literal("ankiConfig.save"), revision, value: configSchema }).strict(),
  z
    .object({
      operation: z.literal("state.clear"),
      revision,
      resource: z.enum(["knownWords", "decisions", "preferences", "ankiSync", "all"]),
    })
    .strict(),
  z.object({ operation: z.literal("state.begin"), revision, target: uploadTargetSchema }).strict(),
  z
    .object({
      operation: z.literal("state.chunk"),
      revision,
      uploadId,
      index: integer.max(10000),
      text: z.string().max(60_000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("state.finish"),
      revision,
      uploadId,
      chunkCount: integer.positive().max(10000),
    })
    .strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export type CompleteBackup = z.infer<typeof completeBackupSchema>;
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "INVALID_INPUT",
  ) {
    super(message);
    this.name = "StoreError";
  }
}
export function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new StoreError(`Duplicate ${label}`);
}
export function parseOperation(value: unknown): Operation {
  if (bytes(value) > MAX_WIRE_BYTES)
    throw new StoreError("Request exceeds the size limit", 413, "PAYLOAD_TOO_LARGE");
  const result = operationSchema.safeParse(value);
  if (!result.success)
    throw new StoreError(
      `Invalid storage request: ${result.error.issues[0]?.message ?? "invalid value"}`,
    );
  return result.data;
}
