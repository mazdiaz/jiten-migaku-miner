import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../domain/anki";
import type { Entry, WordDecision } from "../domain/types";
import type { SessionQueueSnapshot } from "../platform/session-queue";
import type { AppStore, DatasetMetadata, RestoreUserStateSnapshot } from "./contracts";

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
    load(): Promise<SessionQueueSnapshot | null>;
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
  async function upload(target: string, value: unknown) {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES)
      throw new RemoteStoreError(
        "Saved state exceeds the 256 MiB upload limit.",
        413,
        "PAYLOAD_TOO_LARGE",
      );
    const { uploadId } = await request<{ uploadId: string }>("state.begin", { target });
    // Keep each chunk bounded without separating a UTF-16 surrogate pair: the
    // PostgreSQL UTF-8 text transport would replace either isolated half.
    let chunkCount = 0;
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(offset + 60_000, text.length);
      const previous = text.charCodeAt(end - 1),
        next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      await mutate("state.chunk", { uploadId, index: chunkCount++, text: text.slice(offset, end) });
      offset = end;
    }
    await mutate("state.finish", { uploadId, chunkCount });
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
          let pending: Entry[] = [],
            size = 2,
            index = 0;
          const flush = async () => {
            if (pending.length)
              await mutate("dataset.chunk", { uploadId, index: index++, entries: pending });
            pending = [];
            size = 2;
          };
          for await (const chunk of chunks)
            for (const entry of chunk) {
              const length = byteLength(entry) + 1;
              if (length + 2 > 400_000)
                throw new RemoteStoreError(
                  "One dataset row exceeds the 400 KB size limit.",
                  413,
                  "PAYLOAD_TOO_LARGE",
                );
              if (pending.length && (size + length > 350_000 || pending.length >= 500))
                await flush();
              pending.push(structuredClone(entry));
              size += length;
            }
          await flush();
          await mutate("dataset.finish", { uploadId, chunkCount: index });
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
        return run(() => upload("knownWords", value));
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
    queue: { load: () => run(() => queue()), save: (value) => savedUpload("queue", value) },
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
