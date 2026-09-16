import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../domain/anki";
import type { Entry, WordDecision } from "../domain/types";
import type { SessionQueueSnapshot } from "../platform/session-queue";
import type { AppStore, DatasetMetadata, KnownWordsSaveReceipt, RestoreUserStateSnapshot } from "./contracts";

type Preferences = NonNullable<Awaited<ReturnType<AppStore["preferences"]["load"]>>>;
type KnownWords = { id: string; name: string; words: string[] };
type Page<T> = { items: T[]; nextCursor: number | null };
export interface CompleteBackup {
  version: 3;
  exportedAt: string;
  datasets: Array<{ metadata: DatasetMetadata; entries: Entry[] }>;
  activeDatasetId: string | null;
  queues: SessionQueueSnapshot[];
  knownWords: KnownWords | null;
  decisions: WordDecision[];
  preferences: Preferences | null;
  ankiSync: { config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null };
}
export interface RemoteAppStore extends AppStore {
  initialize(): Promise<void>;
  queue: {
    load(datasetId?: string): Promise<SessionQueueSnapshot | null>;
    save(snapshot: SessionQueueSnapshot | null): Promise<void>;
  };
  exportCompleteBackup(): Promise<string>;
  restoreCompleteBackup(text: string): Promise<void>;
}
export class RemoteStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "RemoteStoreError";
  }
}
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const DATASET_WIRE_BATCH_TARGET = 680_000;
export const STATE_CHUNK_TARGET_BYTES = 300_000;

export function splitUtf8Chunks(
  text: string,
  targetBytes: number = STATE_CHUNK_TARGET_BYTES,
): string[] {
  if (text.length === 0) return [];
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const remainingLength = text.length - offset;
    if (remainingLength * 4 <= targetBytes) {
      chunks.push(text.slice(offset));
      break;
    }

    const maxChars = Math.min(targetBytes, remainingLength);
    let low = Math.min(Math.floor(targetBytes / 4), remainingLength);
    let high = maxChars;
    let bestEnd = offset;

    let initialLow = offset + low;
    if (initialLow < text.length) {
      const prev = text.charCodeAt(initialLow - 1);
      const next = text.charCodeAt(initialLow);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        initialLow--;
      }
    }
    if (initialLow > offset) bestEnd = initialLow;

    low = Math.max(1, low);
    while (low <= high) {
      const mid = (low + high) >> 1;
      let effectiveEnd = offset + mid;
      if (effectiveEnd < text.length) {
        const prev = text.charCodeAt(effectiveEnd - 1);
        const next = text.charCodeAt(effectiveEnd);
        if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          effectiveEnd--;
        }
      }

      if (effectiveEnd <= offset) {
        low = mid + 1;
        continue;
      }

      const candidate = text.slice(offset, effectiveEnd);
      if (encoder.encode(candidate).length <= targetBytes) {
        if (effectiveEnd > bestEnd) bestEnd = effectiveEnd;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (bestEnd <= offset) {
      const code = text.charCodeAt(offset);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      bestEnd = isHighSurrogate && offset + 1 < text.length ? offset + 2 : offset + 1;
    }

    chunks.push(text.slice(offset, bestEnd));
    offset = bestEnd;
  }

  return chunks;
}

/** Calls are serialized across every store area so dependent writes use the last acknowledged revision. */
export function createRemoteAppStore(
  options: {
    fetch?: typeof fetch;
    endpoint?: string;
    onPendingChange?: (count: number) => void;
  } = {},
): RemoteAppStore {
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = options.endpoint ?? "/api/store";
  let revision: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let pendingOperations = 0;
  function exclusive<T>(action: () => Promise<T>): Promise<T> {
    options.onPendingChange?.(++pendingOperations);
    const result = tail.then(action).finally(() => options.onPendingChange?.(--pendingOperations));
    tail = result.catch(() => undefined);
    return result;
  }
  async function request<T>(operation: string, fields: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify({
      operation,
      ...(operation === "initialize" ? {} : { revision }),
      ...fields,
    });
    if (new TextEncoder().encode(body).length > 750_000)
      throw new RemoteStoreError(
        "Request exceeds the upload size limit.",
        413,
        "PAYLOAD_TOO_LARGE",
      );
    let response: Response;
    try {
      response = await transport(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body,
      });
    } catch {
      throw new RemoteStoreError(
        "Could not reach saved data. Check your connection and reload before continuing.",
        0,
        "NETWORK_ERROR",
      );
    }
    let result: { revision?: number; value?: unknown; error?: string; code?: string };
    try {
      result = await response.json();
    } catch {
      throw new RemoteStoreError(
        "The server returned an invalid response. Reload before continuing.",
        response.status,
        "INVALID_RESPONSE",
      );
    }
    if (!response.ok)
      throw new RemoteStoreError(
        result.error ?? "Could not save or load data.",
        response.status,
        result.code ?? "SERVER_ERROR",
      );
    if (!Number.isSafeInteger(result.revision) || result.revision! < 0 || !("value" in result))
      throw new RemoteStoreError(
        "The server returned an invalid revision.",
        502,
        "INVALID_RESPONSE",
      );
    revision = result.revision!;
    return result.value as T;
  }
  async function initialize() {
    if (revision === null) await request("initialize");
  }
  function run<T>(action: () => Promise<T>): Promise<T> {
    return exclusive(async () => {
      await initialize();
      return action();
    });
  }
  async function mutate(operation: string, fields: Record<string, unknown> = {}) {
    await request(operation, fields);
  }
  async function upload<T = void>(target: string, value: unknown): Promise<T> {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES)
      throw new RemoteStoreError(
        "Saved state exceeds the 256 MiB upload limit.",
        413,
        "PAYLOAD_TOO_LARGE",
      );
    const { uploadId } = await request<{ uploadId: string }>("state.begin", { target });
    const chunks = splitUtf8Chunks(text, STATE_CHUNK_TARGET_BYTES);
    let chunkCount = 0;
    for (const chunk of chunks) {
      await mutate("state.chunk", { uploadId, index: chunkCount++, text: chunk });
    }
    return request<T>("state.finish", { uploadId, chunkCount });
  }
  function savedMutation(operation: string, fields: Record<string, unknown>) {
    const captured = structuredClone(fields);
    return run(() => mutate(operation, captured));
  }
  function savedUpload(target: string, value: unknown) {
    const captured = structuredClone(value);
    return run(() => upload(target, captured));
  }
  async function listPages<T>(operation: string, fields: Record<string, unknown>): Promise<T[]> {
    let cursor = 0;
    const items: T[] = [];
    for (;;) {
      const page = await request<Page<T>>(operation, { ...fields, cursor });
      items.push(...page.items);
      if (page.nextCursor === null) return items;
      if (page.nextCursor <= cursor)
        throw new RemoteStoreError("The server returned an invalid page.", 502, "INVALID_RESPONSE");
      cursor = page.nextCursor;
    }
  }
  async function readCollection<T, H extends object>(
    resource: string,
    fields: Record<string, unknown> = {},
  ): Promise<(H & { items: T[] }) | null> {
    let cursor = 0;
    const items: T[] = [];
    let header: H;
    for (;;) {
      const page = await request<(H & Page<T>) | null>("state.read", {
        resource,
        ...fields,
        cursor,
      });
      if (page === null) return null;
      const { items: values, nextCursor, ...rest } = page;
      header = rest as H;
      items.push(...values);
      if (nextCursor === null) return { ...header, items };
      if (nextCursor <= cursor)
        throw new RemoteStoreError("The server returned an invalid page.", 502, "INVALID_RESPONSE");
      cursor = nextCursor;
    }
  }
  async function known(): Promise<KnownWords | null> {
    const value = await readCollection<string, { id: string; name: string }>("knownWords");
    return value ? { id: value.id, name: value.name, words: value.items } : null;
  }
  async function snapshot(): Promise<AnkiSyncSnapshot | null> {
    const value = await readCollection<AnkiSyncSnapshot["statuses"][number], { syncedAt: string }>(
      "ankiSnapshot",
    );
    return value ? { syncedAt: value.syncedAt, statuses: value.items } : null;
  }
  async function queue(datasetId?: string): Promise<SessionQueueSnapshot | null> {
    const value = await readCollection<string, { version: 1; datasetId: string }>(
      "queue",
      datasetId === undefined ? {} : { datasetId },
    );
    return value ? { version: 1, datasetId: value.datasetId, normalizedWords: value.items } : null;
  }
  const scalar = <T>(resource: string) => request<T>("state.read", { resource, cursor: 0 });
  const decisionList = () => listPages<WordDecision>("state.read", { resource: "decisions" });
  const datasetList = () => listPages<DatasetMetadata>("dataset.list", {});
  return {
    initialize: () => exclusive(initialize),
    datasets: {
      stage: (metadata, chunks) => {
        const capturedMetadata = structuredClone(metadata);
        return run(async () => {
          const { uploadId } = await request<{ uploadId: string }>("dataset.begin", {
            metadata: capturedMetadata,
          });
          let pendingEntries: Entry[] = [];
          let pendingEntriesSize = 2;
          let chunkIndex = 0;
          let pendingWireChunks: Array<{ index: number; entries: Entry[] }> = [];
          let wireBatchEstimatedBytes = 150;

          const flushWireBatch = async () => {
            if (pendingWireChunks.length) {
              await mutate("dataset.chunks", { uploadId, chunks: pendingWireChunks });
            }
            pendingWireChunks = [];
            wireBatchEstimatedBytes = 150;
          };

          const emitLogicalChunk = async () => {
            if (!pendingEntries.length) return;
            const logicalChunk = { index: chunkIndex++, entries: pendingEntries };
            const logicalChunkBytes = byteLength(logicalChunk) + 1;

            if (
              pendingWireChunks.length &&
              wireBatchEstimatedBytes + logicalChunkBytes > DATASET_WIRE_BATCH_TARGET
            ) {
              await flushWireBatch();
            }

            pendingWireChunks.push(logicalChunk);
            wireBatchEstimatedBytes += logicalChunkBytes;
            pendingEntries = [];
            pendingEntriesSize = 2;
          };

          for await (const chunk of chunks) {
            for (const entry of chunk) {
              const length = byteLength(entry) + 1;
              if (length + 2 > 400_000) {
                throw new RemoteStoreError(
                  "One dataset row exceeds the 400 KB size limit.",
                  413,
                  "PAYLOAD_TOO_LARGE",
                );
              }
              if (
                pendingEntries.length &&
                (pendingEntriesSize + length > 350_000 || pendingEntries.length >= 2000)
              ) {
                await emitLogicalChunk();
              }
              pendingEntries.push(structuredClone(entry));
              pendingEntriesSize += length;
            }
          }

          await emitLogicalChunk();
          await flushWireBatch();
          await mutate("dataset.finish", { uploadId, chunkCount: chunkIndex });
        });
      },
      activate: (datasetId) => run(() => mutate("dataset.activate", { datasetId })),
      getActive: () => run(() => request<DatasetMetadata | null>("dataset.active")),
      list: () => run(datasetList),
      async *readChunks(datasetId, chunkSize) {
        if (!Number.isInteger(chunkSize) || chunkSize <= 0)
          throw new RangeError("chunkSize must be a positive integer");
        let cursor = 0;
        let pending: Entry[] = [];
        for (;;) {
          const page = await run(() => request<Page<Entry>>("dataset.read", { datasetId, cursor }));
          for (const entry of page.items) {
            pending.push(entry);
            if (pending.length === chunkSize) {
              yield pending;
              pending = [];
            }
          }
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        if (pending.length) yield pending;
      },
      remove: (datasetId) => run(() => mutate("dataset.remove", { datasetId })),
    },
    knownWords: {
      save: (id, name, words) => {
        const value = { id, name, words: [...new Set(words)] };
        return run(() => upload<KnownWordsSaveReceipt>("knownWords", value));
      },
      getActive: () =>
        run(async () => {
          const value = await known();
          return value ? { ...value, words: new Set(value.words) } : null;
        }),
      remove: (id) => run(() => mutate("known.remove", { id })),
      clear: () => run(() => mutate("state.clear", { resource: "knownWords" })),
    },
    wordDecisions: {
      get: (word) => run(() => request<WordDecision | null>("decision.get", { word })),
      list: () => run(decisionList),
      set: (decision) => savedMutation("decision.set", { decision }),
      remove: (word) => run(() => mutate("decision.remove", { word })),
      replaceAll: (decisions) => savedUpload("decisions", decisions),
      clear: () => run(() => mutate("state.clear", { resource: "decisions" })),
    },
    preferences: {
      load: () => run(() => scalar<Preferences | null>("preferences")),
      save: (value) => savedMutation("preferences.save", { value }),
      clear: () => run(() => mutate("state.clear", { resource: "preferences" })),
    },
    ankiSync: {
      loadConfig: () => run(() => scalar<AnkiSyncConfig | null>("ankiConfig")),
      saveConfig: (value) => savedMutation("ankiConfig.save", { value }),
      loadSnapshot: () => run(snapshot),
      replaceSnapshot: (value) => savedUpload("ankiSnapshot", value),
      clear: () => run(() => mutate("state.clear", { resource: "ankiSync" })),
    },
    queue: {
      load: (datasetId?: string) => run(() => queue(datasetId)),
      save: (value) => savedUpload("queue", value),
    },
    clearAll: () => run(() => mutate("state.clear", { resource: "all" })),
    restoreUserState: (value: RestoreUserStateSnapshot) => {
      const payload = {
        ...value,
        knownWords: value.knownWords
          ? { ...value.knownWords, words: [...new Set(value.knownWords.words)] }
          : null,
      };
      return savedUpload("userState", payload);
    },
    exportCompleteBackup: () =>
      run(async () => {
        const datasets: CompleteBackup["datasets"] = [];
        for (const metadata of await datasetList())
          datasets.push({
            metadata,
            entries: await listPages<Entry>("dataset.read", { datasetId: metadata.id }),
          });
        const active = await request<DatasetMetadata | null>("dataset.active");
        const queues: SessionQueueSnapshot[] = [];
        for (const id of await listPages<string>("state.read", { resource: "queues" })) {
          const value = await queue(id);
          if (value) queues.push(value);
        }
        const backup: CompleteBackup = {
          version: 3,
          exportedAt: new Date().toISOString(),
          datasets,
          activeDatasetId: active?.id ?? null,
          queues,
          knownWords: await known(),
          decisions: await decisionList(),
          preferences: await scalar<Preferences | null>("preferences"),
          ankiSync: {
            config: await scalar<AnkiSyncConfig | null>("ankiConfig"),
            snapshot: await snapshot(),
          },
        };
        const text = JSON.stringify(backup, null, 2);
        if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES)
          throw new RemoteStoreError(
            "Complete backup exceeds the 256 MiB restore limit and cannot be exported as a restorable file.",
            413,
            "PAYLOAD_TOO_LARGE",
          );
        return text;
      }),
    restoreCompleteBackup: (text) =>
      run(async () => {
        if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES)
          throw new RemoteStoreError(
            "Backup exceeds the 256 MiB restore limit.",
            413,
            "PAYLOAD_TOO_LARGE",
          );
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new RemoteStoreError("Backup is not valid JSON.", 400, "INVALID_INPUT");
        }
        await upload("completeBackup", value);
      }),
  };
}
