# Local-First Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Historical implementation plan. Current production rollout and default-mode semantics are documented in `docs/superpowers/plans/2026-09-18-production-local-first-rollout.md`.

**Goal:** Make warm launches and normal study actions use IndexedDB immediately while PostgreSQL synchronizes in the background across devices.

**Architecture:** The miner controller uses an IndexedDB `AppStore` as its steady-state working copy. A separate `SyncEngine` owns cloud push/pull, backed by a durable coalescing IndexedDB outbox and an append-only PostgreSQL change feed. `RemoteAppStore` remains for complete backup/restore and as the server-first fallback when IndexedDB is unavailable.

**Tech Stack:** Next.js 16, React 19, TypeScript 7, native IndexedDB, Web Worker, PostgreSQL, Drizzle ORM, postgres-js, Zod, Vitest, PGlite, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-local-first-sync-design.md`

## Global Constraints

- Keep the existing single-owner GitHub authentication and same-origin checks on every new API request.
- Do not add a CRDT library, service worker, or runtime dependency in this release.
- Use `jiten-migaku-miner-local-first` as the new production IndexedDB database name.
- Keep the previous browser database untouched during the first local-first release.
- A local application mutation and its cloud-sync intent must commit in the same IndexedDB transaction.
- Warm startup must not wait for `/api/store` or `/api/sync` before rendering cached study data.
- Push local pending changes before pulling remote changes.
- Cloud retries must be idempotent by `mutationId`.
- Keep `sync_events` indefinitely in this release.
- Remote/bootstrap writes must never create outbox work.
- Complete backup/export and complete restore remain cloud-backed.
- `Clear saved data` remains online-only: cloud clear succeeds before local cache deletion.
- Preserve the current limits: 1,000,000 rows per dataset, 400 KB per row, 750 KB wire request/response target, 256 MiB staged-state limit.
- Do not change the controller's persistence enum; local-first still uses `persistence: "indexeddb"`. Cloud status stays outside `AppState`.

---

## File Structure

### New files

- `src/sync/contracts.ts` — sync wire/domain types.
- `src/sync/cloud-client.ts` — browser transport for `/api/sync`.
- `src/sync/engine.ts` — push-first/pull-second orchestration and dataset hydration.
- `src/storage/indexed-db-core.ts` — database name/version, object-store creation, transactions.
- `src/storage/local-sync.ts` — queue/workspace/sync-meta/outbox APIs.
- `src/server/sync.ts` — server bootstrap/read/pull/push/dataset-sync operations.
- `src/app/api/sync/route.ts` — authenticated/same-origin sync API boundary.
- `migrations/0002_local_first_sync.sql` — sync event/idempotency tables.
- `tests/storage/local-sync.test.ts` — IndexedDB outbox/meta/workspace/queue tests.
- `tests/server/sync.test.ts` — server sync protocol/idempotency tests.
- `tests/sync/engine.test.ts` — engine convergence/retry tests.
- `tests/e2e/local-first-sync.spec.ts` — warm boot/offline/cross-device tests.

### Existing files to modify

- `src/storage/indexed-db.ts` — use extracted core, metadata-only dataset cache, optional mutation recording.
- `src/storage/contracts.ts` — dataset cache-state helpers.
- `src/server/db/schema.ts` — mirror migration `0001` counters and define sync tables.
- `src/server/store.ts` — dual-write compact sync events from legacy `/api/store` operations.
- `src/server/storage/validation.ts` — shared size/schema validation used by sync server operations.
- `src/components/study-runtime.ts` — local-first boot, fallback, resume persistence, sync lifecycle/status.
- `src/miner/controller.ts` — initial viewport, prepare-dataset hook, refresh-from-storage.
- `src/storage/remote-store.ts` — no semantic rewrite; only expose existing backup/clear helpers if runtime composition needs typed access.
- `tests/storage/indexed-db.test.ts` — metadata-only/cache-ready behavior.
- `tests/storage/indexed-db-upgrade.test.ts` — all new stores.
- `tests/server/postgres-store.test.ts` — legacy writes emit events.
- `tests/app/controller.test.ts` — first-query viewport and refresh behavior.
- `tests/e2e/cloud.spec.ts` — server-first fallback remains functional.
- `tests/e2e/backup-restore.spec.ts` — flush-before-export and rebootstrap-after-restore.
- `README.md` — migration/flag/rollout/status docs.

---

### Task 1: Add the PostgreSQL change feed and dual-write it from the existing store

**Files:**
- Create: `migrations/0002_local_first_sync.sql`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/store.ts`
- Test: `tests/server/postgres-store.test.ts`

**Interfaces:**
- Consumes: `StoreDatabase`, current `createPostgresStore()`, current `app_state.revision`.
- Produces: `sync_events`, `sync_mutations`, and a `recordSyncEvent()` helper used by Task 2.

- [ ] **Step 1: Add failing legacy dual-write tests**

In `tests/server/postgres-store.test.ts`, define:

```ts
const NOW = "2026-09-17T00:00:00.000Z";
```

Add the decision test:

```ts
it("emits a decision sync event in the same committed operation", async () => {
  const dispatch = createPostgresStore(database);
  await dispatch({ operation: "initialize" });
  await dispatch({
    operation: "decision.set",
    revision: 0,
    decision: { normalizedWord: "騒ぐ", status: "known", updatedAt: NOW },
  });

  const result = await database.execute(
    sql`SELECT resource, resource_key, action FROM sync_events ORDER BY id`,
  );
  const records = Array.isArray(result) ? result : result.rows;
  expect(records).toEqual([
    { resource: "decision", resource_key: "騒ぐ", action: "set" },
  ]);
});
```

Add the following exact operation/event matrix as separate tests. Each test performs the operation through `createPostgresStore()`, reads `sync_events`, and asserts one logical event after the operation becomes visible:

| Operation | `resource` | `resource_key` | `action` |
| --- | --- | --- | --- |
| `preferences.save` | `preferences` | `null` | `replace` |
| successful `dataset.finish` | `dataset` | dataset id | `upsert` |
| `dataset.activate` | `dataset-active` | dataset id | `set` |
| `dataset.remove` | `dataset` | dataset id | `remove` |
| `decision.remove` | `decision` | normalized word | `remove` |
| `known.remove` or known `state.finish` | `known` | `null` | `replace` |
| queue `state.finish` with value | `queue` | dataset id | `replace` |
| queue `state.finish` with null | `queue` | dataset id | `remove` |
| `ankiConfig.save`, Anki snapshot finish/clear | `anki` | `null` | `replace` |
| complete restore or `state.clear all` | `state` | `null` | `full-reset` |

Assert `dataset.begin`, `dataset.chunk`, `dataset.chunks`, and `state.chunk` emit no event because staging is not yet visible state.

- [ ] **Step 2: Run the server test and confirm the schema failure**

```bash
npx vitest run tests/server/postgres-store.test.ts
```

Expected: FAIL on `sync_events` because the table does not exist.

- [ ] **Step 3: Add migration `0002_local_first_sync.sql`**

```sql
CREATE TABLE sync_events (
  id bigserial PRIMARY KEY,
  app_revision bigint NOT NULL,
  resource text NOT NULL,
  resource_key text,
  action text NOT NULL,
  origin_device_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_events_created_order_idx ON sync_events(id);

CREATE TABLE sync_mutations (
  mutation_id uuid PRIMARY KEY,
  device_id text NOT NULL,
  accepted_event_id bigint REFERENCES sync_events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Bring `src/server/db/schema.ts` in sync with migrations**

Add the already-deployed `0001` columns to `datasets`:

```ts
uploadedRows: bigint("uploaded_rows", { mode: "number" }).notNull().default(0),
uploadedBytes: bigint("uploaded_bytes", { mode: "number" }).notNull().default(0),
nextOrdinal: integer("next_ordinal").notNull().default(0),
```

Define `syncEvents` and `syncMutations` with the same columns/foreign key as `0002`. Do not edit `0000` or `0001`.

- [ ] **Step 5: Add `recordSyncEvent()` and emit events before revision commit**

Add to `src/server/store.ts`:

```ts
type SyncEventInput = {
  resource: string;
  resourceKey: string | null;
  action: string;
  originDeviceId?: string | null;
};

async function recordSyncEvent(
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
```

The existing store increments the revision after the switch. For a visible mutation, use `const nextRevision = revision + 1`, emit the event with `nextRevision`, then execute the existing `UPDATE app_state SET revision = revision + 1`. The event and canonical mutation remain inside the same PostgreSQL transaction.

For `state.finish`, derive the event from `upload.target`; for complete backup/user-state operations that change several resource families, emit one `full-reset` event instead of many per-row events.

- [ ] **Step 6: Run server storage tests**

```bash
npx vitest run tests/server/postgres-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/0002_local_first_sync.sql src/server/db/schema.ts src/server/store.ts tests/server/postgres-store.test.ts
git commit -m "feat: record cloud sync events"
```

---

### Task 2: Define the sync protocol and implement `/api/sync`

**Files:**
- Create: `src/sync/contracts.ts`
- Create: `src/server/sync.ts`
- Create: `src/app/api/sync/route.ts`
- Modify: `src/server/storage/validation.ts`
- Test: `tests/server/sync.test.ts`

**Interfaces:**
- Consumes: canonical PostgreSQL tables plus `sync_events`/`sync_mutations`.
- Produces: metadata bootstrap, paginated resource reads, pull, idempotent push, and idempotent staged dataset upload.

- [ ] **Step 1: Write failing server-sync tests with concrete fixtures**

Use two decisions:

```ts
const firstDecision = {
  normalizedWord: "猫",
  status: "known" as const,
  updatedAt: "2026-09-17T00:00:00.000Z",
};
const secondDecision = {
  normalizedWord: "犬",
  status: "mined" as const,
  updatedAt: "2026-09-17T00:01:00.000Z",
};
```

Write these tests:

1. Insert event id 1 for `猫`, event id 2 for `犬`; `pull(afterEventId:1)` returns only the `犬` change and `nextEventId === 2`.
2. Push `{ mutationId:"00000000-0000-4000-8000-000000000001", kind:"decision.set", decision:firstDecision }` twice; the canonical decision exists once, `sync_mutations` contains one row, and only one new `sync_events` row exists.
3. Bootstrap a device, mutate a preference directly through the legacy store to advance app revision, then push `secondDecision`; push succeeds instead of returning `REVISION_CONFLICT`.
4. Seed two ready dataset metadata rows and activate one; bootstrap returns both metadata rows, active id, and the current max event id without returning dataset entries.
5. Seed more than one sync-read page of decisions and assert `state.read` pagination returns every item without any response exceeding the existing response-size guard.

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run tests/server/sync.test.ts
```

Expected: FAIL because `src/server/sync.ts` and sync contracts do not exist.

- [ ] **Step 3: Add `src/sync/contracts.ts`**

Define these exact exported names:

```ts
export type PreferencesValue = { query: QueryState; view: ViewState; page: number };

export type SyncMutationKind =
  | "dataset.upload"
  | "dataset.remove"
  | "dataset.activate"
  | "known.replace"
  | "decision.set"
  | "decision.remove"
  | "preferences.replace"
  | "queue.replace"
  | "queue.remove"
  | "anki.replace";

export interface CloudBootstrapManifest {
  eventId: number;
  activeDatasetId: string | null;
  datasets: DatasetMetadata[];
}

export type MaterializedSyncMutation =
  | { mutationId: string; kind: "dataset.remove"; datasetId: string }
  | { mutationId: string; kind: "dataset.activate"; datasetId: string | null }
  | { mutationId: string; kind: "known.replace"; value: { id: string; name: string; words: string[] } | null }
  | { mutationId: string; kind: "decision.set"; decision: WordDecision }
  | { mutationId: string; kind: "decision.remove"; normalizedWord: string }
  | { mutationId: string; kind: "preferences.replace"; value: PreferencesValue }
  | { mutationId: string; kind: "queue.replace"; value: SessionQueueSnapshot }
  | { mutationId: string; kind: "queue.remove"; datasetId: string }
  | { mutationId: string; kind: "anki.replace"; config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null };
```

Also define `RemoteChange`, `SyncPullPage`, and `SyncPushReceipt` exactly as specified in the design doc.

- [ ] **Step 4: Implement the server operation schema**

`dispatchSyncOperation(input)` accepts this discriminated set:

```text
bootstrap
state.read
pull
push
dataset.begin
dataset.chunks
dataset.finish
dataset.read
```

Rules:

- `bootstrap`: return `CloudBootstrapManifest` only; do not include known words, decisions, queues, Anki statuses, or dataset entries.
- `state.read`: page one logical resource without a client revision requirement. Supported resources: `knownWords`, `decisions`, `preferences`, `ankiConfig`, `ankiSnapshot`, `queues`, `queue`. Reuse the current page sizing/response-size logic.
- `pull`: at most 200 events, strictly `id > afterEventId`, ascending. Hydrate small resources (`decision`, `preferences`, dataset metadata) into `RemoteChange`; leave large resources as marker changes.
- `push`: at most 100 materialized mutations. Before applying each mutation, check `sync_mutations`. Duplicate id returns its prior receipt and does not mutate canonical state again.
- Fresh push mutation: apply canonical state, increment `app_state.revision`, emit one sync event with `origin_device_id`, insert `sync_mutations`, all in the same transaction.
- `dataset.begin/chunks/finish`: use `mutationId` as stable upload identity, retain existing row/chunk/byte checks, and record `sync_mutations` only when finish makes the dataset ready.
- Ready same-id dataset with identical metadata is successful idempotency; same id with different metadata returns `409 DATASET_CONFLICT`.
- `dataset.read`: page ready chunks with existing response-size limits and no revision requirement.

- [ ] **Step 5: Add the authenticated route**

`src/app/api/sync/route.ts` uses the same order as `/api/store`:

```text
auth()
-> isOwner()
-> isSameOrigin()
-> content-type starts application/json
-> bounded body read (1 MiB)
-> JSON.parse
-> dispatchSyncOperation()
-> Cache-Control: no-store
```

Return domain error messages/codes; log unexpected server exceptions without sending raw SQL/provider messages to the browser.

- [ ] **Step 6: Run server tests**

```bash
npx vitest run tests/server/sync.test.ts tests/server/postgres-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sync/contracts.ts src/server/sync.ts src/app/api/sync/route.ts src/server/storage/validation.ts tests/server/sync.test.ts
git commit -m "feat: add idempotent cloud sync api"
```

---

### Task 3: Extract IndexedDB core and create the local-first schema

**Files:**
- Create: `src/storage/indexed-db-core.ts`
- Create: `src/storage/local-sync.ts`
- Modify: `src/storage/indexed-db.ts`
- Modify: `tests/storage/indexed-db-upgrade.test.ts`
- Test: `tests/storage/local-sync.test.ts`

**Interfaces:**
- Consumes: current IndexedDB implementation.
- Produces: one local-first database plus queue/workspace/sync-meta/outbox stores.

- [ ] **Step 1: Write failing schema tests**

Assert a fresh database contains these exact stores:

```ts
expect([...database.objectStoreNames]).toEqual([
  "ankiSync",
  "datasets",
  "entryChunks",
  "knownWordSets",
  "meta",
  "preferences",
  "queues",
  "syncMeta",
  "syncOutbox",
  "wordDecisions",
  "workspace",
]);
```

Sort the actual names before comparison if the test environment does not preserve creation order. Assert key paths:

```text
syncOutbox -> dedupeKey
queues     -> datasetId
syncMeta   -> id
workspace  -> id
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run tests/storage/indexed-db-upgrade.test.ts tests/storage/local-sync.test.ts
```

Expected: FAIL because the new stores/modules do not exist.

- [ ] **Step 3: Extract shared database mechanics**

Create `src/storage/indexed-db-core.ts` with:

```ts
export const INDEXED_DB_NAME = "jiten-migaku-miner-local-first";
export const INDEXED_DB_VERSION = 4;

export type IndexedDbStoreName =
  | "datasets"
  | "entryChunks"
  | "knownWordSets"
  | "preferences"
  | "meta"
  | "wordDecisions"
  | "ankiSync"
  | "queues"
  | "workspace"
  | "syncOutbox"
  | "syncMeta";
```

Move `openDatabase`, `withDatabase`, `runTransaction`, request-error classification, and object-store creation from `indexed-db.ts` without changing their transaction/error semantics. Keep `database.onversionchange = () => database.close()`.

- [ ] **Step 4: Implement `LocalSyncStore`**

`src/storage/local-sync.ts` exports:

```ts
export interface SyncOutboxRecord {
  dedupeKey: string;
  mutationId: string;
  kind: SyncMutationKind;
  resourceId: string | null;
  createdAt: string;
}

export interface LocalSyncMeta {
  id: "current";
  deviceId: string;
  bootstrapComplete: boolean;
  serverEventId: number;
  lastSyncAt: string | null;
}

export interface WorkspaceResumeState {
  id: "current";
  activeDatasetId: string | null;
  viewportStart: number;
  queueMode: "normal" | "queue";
  updatedAt: string;
}
```

`createLocalSyncStore()` provides:

```ts
getMeta(): Promise<LocalSyncMeta>;
setMeta(value: LocalSyncMeta): Promise<void>;
listOutbox(limit: number): Promise<SyncOutboxRecord[]>;
acknowledge(dedupeKey: string, mutationId: string): Promise<void>;
loadWorkspace(): Promise<WorkspaceResumeState | null>;
saveWorkspace(value: WorkspaceResumeState): Promise<void>;
loadQueue(datasetId: string): Promise<SessionQueueSnapshot | null>;
listQueues(): Promise<SessionQueueSnapshot[]>;
saveQueue(snapshot: SessionQueueSnapshot | null, datasetId: string, recordMutation: boolean): Promise<void>;
clearLocalData(): Promise<void>;
```

First `getMeta()` creates a stable `deviceId` with `crypto.randomUUID()` and stores:

```ts
{
  id: "current",
  deviceId,
  bootstrapComplete: false,
  serverEventId: 0,
  lastSyncAt: null,
}
```

- [ ] **Step 5: Implement compare-and-delete acknowledgement**

Inside one readwrite transaction over `syncOutbox`:

```ts
const request = store.get(dedupeKey) as IDBRequest<SyncOutboxRecord | undefined>;
request.onsuccess = () => {
  if (request.result?.mutationId === mutationId) store.delete(dedupeKey);
  resolveResult(undefined);
};
```

Test the race by writing mutation `old`, reading it as the in-flight item, replacing it with mutation `new`, acknowledging `old`, and asserting `new` remains.

- [ ] **Step 6: Run storage tests**

```bash
npx vitest run tests/storage/indexed-db-upgrade.test.ts tests/storage/indexed-db.test.ts tests/storage/local-sync.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/indexed-db-core.ts src/storage/local-sync.ts src/storage/indexed-db.ts tests/storage/indexed-db-upgrade.test.ts tests/storage/indexed-db.test.ts tests/storage/local-sync.test.ts
git commit -m "feat: add local-first indexeddb substrate"
```

---

### Task 4: Record cloud sync intent atomically with every local mutation

**Files:**
- Modify: `src/storage/indexed-db.ts`
- Modify: `src/storage/contracts.ts`
- Test: `tests/storage/local-sync.test.ts`
- Test: `tests/storage/indexed-db.test.ts`

**Interfaces:**
- Consumes: `syncOutbox` object store and sync mutation kinds.
- Produces: recording-enabled controller store plus recording-disabled bootstrap/remote-apply store.

- [ ] **Step 1: Add failing mutation/outbox matrix tests**

For a recording-enabled store, assert these exact pairs:

| Local operation | Dedupe key | Kind |
| --- | --- | --- |
| successful dataset stage | `dataset:<id>` | `dataset.upload` |
| dataset activate | `activeDataset` | `dataset.activate` |
| dataset remove | `dataset:<id>` | `dataset.remove` |
| known save/remove | `known` | `known.replace` |
| decision set | `decision:<word>` | `decision.set` |
| decision remove | `decision:<word>` | `decision.remove` |
| preferences save/clear | `preferences` | `preferences.replace` |
| Anki config/snapshot/clear | `anki` | `anki.replace` |

For each test, read both application data and `syncOutbox` after the method resolves. Add an injected transaction-abort test and assert neither side committed.

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run tests/storage/local-sync.test.ts tests/storage/indexed-db.test.ts
```

Expected: FAIL because application writes currently have no outbox side effect.

- [ ] **Step 3: Add explicit store construction options**

```ts
export interface IndexedDbAppStoreOptions {
  databaseName?: string;
  recordSyncMutations?: boolean;
  now?: () => string;
  createMutationId?: () => string;
}
```

`createIndexedDbAppStore()` defaults `recordSyncMutations` to `false`. The local-first UI runtime explicitly passes `true`; bootstrap and remote-apply stores pass `false`.

- [ ] **Step 4: Add deterministic outbox identity**

```ts
function outboxIdentity(kind: SyncMutationKind, resourceId: string | null): string {
  if (kind === "dataset.activate") return "activeDataset";
  if (kind === "known.replace") return "known";
  if (kind === "preferences.replace") return "preferences";
  if (kind === "anki.replace") return "anki";
  if (kind === "decision.set" || kind === "decision.remove") return `decision:${resourceId}`;
  if (kind === "queue.replace" || kind === "queue.remove") return `queue:${resourceId}`;
  return `dataset:${resourceId}`;
}
```

Each local write creates a new `mutationId`; repeated writes overwrite the same dedupe key.

- [ ] **Step 5: Put application data and outbox in the same transaction**

Examples:

- `decision.set`: stores `wordDecisions`, `syncOutbox`.
- `preferences.save`: stores `preferences`, `syncOutbox`.
- `dataset.activate`: stores `datasets`, `meta`, `syncOutbox`.
- dataset staging: do not record anything during chunk writes; the final transaction that sets `ready:true/cacheState:"ready"` also records `dataset.upload`.

Do not perform an outbox transaction after the application transaction.

- [ ] **Step 6: Add metadata-only dataset support**

Use:

```ts
interface DatasetRecord extends DatasetMetadata {
  ready: boolean;
  cacheState: "metadata-only" | "ready";
}
```

Extend `DatasetStore` with:

```ts
cacheState?(datasetId: string): Promise<"metadata-only" | "ready" | null>;
upsertMetadata?(metadata: DatasetMetadata): Promise<void>;
```

`upsertMetadata()` is recording-disabled only. `list()` returns ready and metadata-only metadata. `readChunks()` throws a named `DatasetNotCachedError` for metadata-only content.

- [ ] **Step 7: Make atomic legacy `restoreUserState()` produce cloud intent**

Within the existing single IndexedDB transaction:

1. read old decision keys before clearing;
2. compute `new Map(snapshot.decisions.map(decision => [decision.normalizedWord, decision]))`;
3. for every old key absent from the new map, write `decision.remove` to `syncOutbox`;
4. for every new decision, write `decision.set` to its per-word dedupe key;
5. write one `known.replace`, one `preferences.replace`, and one `anki.replace` outbox record;
6. commit restored state and all outbox records together.

This preserves legacy backup restore semantics without adding a large `userState.replace` payload to the sync protocol.

- [ ] **Step 8: Verify remote/bootstrap writes are silent**

Create a second store instance against the same database with `recordSyncMutations:false`; write a decision and metadata, then assert `listOutbox(10)` remains empty.

- [ ] **Step 9: Run storage tests**

```bash
npx vitest run tests/storage/indexed-db.test.ts tests/storage/local-sync.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/storage/indexed-db.ts src/storage/contracts.ts tests/storage/indexed-db.test.ts tests/storage/local-sync.test.ts
git commit -m "feat: record local mutations for cloud sync"
```

---

### Task 5: Build cloud client, first-device bootstrap, and dataset hydration

**Files:**
- Create: `src/sync/cloud-client.ts`
- Test: `tests/sync/engine.test.ts`

**Interfaces:**
- Consumes: `/api/sync`, recording-disabled IndexedDB store, `LocalSyncStore`.
- Produces: `CloudSyncPort`, `bootstrapLocalCache()`, `ensureDatasetCached()`.

- [ ] **Step 1: Write failing bootstrap tests**

Use a fake `CloudSyncPort` with:

```text
eventId = 12
activeDatasetId = dataset-a
dataset-a = 3 entries
dataset-b = metadata only
known words = { 猫, 犬 }
decision = 騒ぐ:known
preferences = page 4, hideKnown true
queue(dataset-a) = [騒ぐ]
Anki snapshot = null
```

Assert:

- bootstrap writes all user state locally;
- `dataset-a` becomes cache-ready with exactly three entries;
- `dataset-b` stays metadata-only;
- sync meta becomes `bootstrapComplete:true, serverEventId:12` only after active content is durable;
- if the third active-dataset chunk throws, bootstrap leaves `bootstrapComplete:false`;
- `ensureDatasetCached("dataset-b")` downloads once, and the second call performs zero cloud dataset reads.

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run tests/sync/engine.test.ts
```

Expected: FAIL because cloud client/bootstrap helpers do not exist.

- [ ] **Step 3: Implement `CloudSyncPort` in `src/sync/cloud-client.ts`**

Expose:

```ts
bootstrap(): Promise<CloudBootstrapManifest>;
readKnownWords(): Promise<{ id: string; name: string; words: string[] } | null>;
readDecisions(): Promise<WordDecision[]>;
readPreferences(): Promise<PreferencesValue | null>;
readQueues(): Promise<SessionQueueSnapshot[]>;
readAnki(): Promise<{ config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null }>;
pull(afterEventId: number, limit?: number): Promise<SyncPullPage>;
push(deviceId: string, mutations: readonly MaterializedSyncMutation[]): Promise<SyncPushReceipt>;
uploadDataset(deviceId: string, mutationId: string, metadata: DatasetMetadata, chunks: AsyncIterable<readonly Entry[]>): Promise<SyncPushReceipt>;
readDataset(datasetId: string, chunkSize: number): AsyncIterable<Entry[]>;
```

Use paginated `state.read`/`dataset.read`; never construct a single bootstrap response containing all state.

Use the same error categories as `remote-store.ts`: `NETWORK_ERROR`, `INVALID_RESPONSE`, server-provided domain code/status. Use `credentials:"same-origin"`.

- [ ] **Step 4: Implement `bootstrapLocalCache()` in `src/sync/engine.ts` or a private helper in that module**

Order:

```text
manifest = cloud.bootstrap()
known = cloud.readKnownWords()
decisions = cloud.readDecisions()
preferences = cloud.readPreferences()
queues = cloud.readQueues()
anki = cloud.readAnki()
write state with recording-disabled local stores
upsert every dataset metadata as metadata-only
if activeDatasetId != null: download/stage active dataset with recording disabled, then activate locally
save active queue/workspace
write sync meta bootstrapComplete=true/serverEventId=manifest.eventId LAST
```

Do not clear the old browser database. Clear only an incomplete new local-first cache before retrying bootstrap.

- [ ] **Step 5: Implement `ensureDatasetCached()`**

```ts
async function ensureDatasetCached(datasetId: string): Promise<void> {
  const state = await remoteApplyStore.datasets.cacheState!(datasetId);
  if (state === "ready") return;

  const metadata = (await remoteApplyStore.datasets.list()).find(
    (candidate) => candidate.id === datasetId,
  );
  if (!metadata) throw new Error(`Dataset metadata missing: ${datasetId}`);

  await remoteApplyStore.datasets.stage(metadata, cloud.readDataset(datasetId, 2_000));
}
```

The store used here has `recordSyncMutations:false`.

- [ ] **Step 6: Run bootstrap tests**

```bash
npx vitest run tests/sync/engine.test.ts
```

Expected: bootstrap/hydration tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sync/cloud-client.ts src/sync/engine.ts tests/sync/engine.test.ts
git commit -m "feat: bootstrap local cache from cloud"
```

---

### Task 6: Implement push-first/pull-second SyncEngine

**Files:**
- Modify: `src/sync/engine.ts`
- Modify: `src/storage/local-sync.ts`
- Test: `tests/sync/engine.test.ts`

**Interfaces:**
- Consumes: recording-enabled UI store, recording-disabled remote-apply store, local sync store, cloud sync port.
- Produces: background synchronization, status stream, remote-applied notifications.

- [ ] **Step 1: Add deterministic engine tests**

Use a fake cloud object that records method calls in `calls: string[]`.

Test push-before-pull:

```ts
await engine.syncNow();
expect(calls.slice(0, 2)).toEqual(["push", "pull"]);
```

Test durable retry:

```text
write decision:猫 outbox
first cloud push throws NETWORK_ERROR
construct a new engine against the same IndexedDB name
second cloud push succeeds
outbox is empty only after second acknowledgement
```

Test acknowledgement race:

```text
engine reads mutationId A
before cloud resolves, local write replaces same dedupe key with mutationId B
cloud acknowledges A
outbox still contains B
```

Test remote apply:

```text
cloud pull returns decision.set 犬:mined
engine applies through recording-disabled store
local decision is mined
outbox remains empty
```

Test two-device convergence with two separate IndexedDB names and one fake canonical cloud: device A writes `known`, device B writes `mined`, both sync, then A pulls again and both end `mined` because that was the cloud's final accepted mutation.

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run tests/sync/engine.test.ts
```

Expected: FAIL until engine orchestration is implemented.

- [ ] **Step 3: Add sync status**

```ts
export type SyncStatus =
  | { state: "idle"; pending: number; lastSyncAt: string | null }
  | { state: "syncing"; pending: number; lastSyncAt: string | null }
  | { state: "offline"; pending: number; lastSyncAt: string | null; message: string }
  | { state: "error"; pending: number; lastSyncAt: string | null; message: string };
```

Expose:

```ts
start(): void;
syncNow(): Promise<void>;
flush(): Promise<void>;
ensureDatasetCached(datasetId: string): Promise<void>;
subscribe(listener: (status: SyncStatus) => void): () => void;
onRemoteApplied(listener: () => Promise<void> | void): () => void;
dispose(): void;
```

- [ ] **Step 4: Materialize the current local value at send time**

| Kind | Source |
| --- | --- |
| `dataset.upload` | dataset metadata + local entry chunks; send via `uploadDataset()` |
| `dataset.remove` | outbox resource id |
| `dataset.activate` | local active dataset id |
| `known.replace` | `knownWords.getActive()` |
| `decision.set` | `wordDecisions.get(word)`; if missing send remove |
| `decision.remove` | outbox resource id |
| `preferences.replace` | `preferences.load()` |
| `queue.replace/remove` | `LocalSyncStore.loadQueue(datasetId)` |
| `anki.replace` | `ankiSync.loadConfig()` + `loadSnapshot()` |

Batch at most 100 small mutations. Stream dataset uploads separately.

- [ ] **Step 5: Implement the serialized engine loop**

Use one `running: Promise<void> | null` so overlapping triggers share the same run. The body is:

```ts
await pushUntilDrained();
await pullUntilCaughtUp();
const meta = await localSync.getMeta();
await localSync.setMeta({ ...meta, lastSyncAt: now() });
```

`flush()` runs `pushUntilDrained()` and then verifies `listOutbox(1).length === 0`; it does not require pull completion.

- [ ] **Step 6: Pull/apply pages safely**

For each page:

1. apply every remote change with recording-disabled stores;
2. fetch canonical known/queue/Anki state when the page contains those marker events;
3. `dataset.activate` calls `ensureDatasetCached()` before local activation;
4. `full-reset` runs `bootstrapLocalCache()` and marks controller refresh required;
5. await every registered `onRemoteApplied` listener;
6. only then write `serverEventId = page.nextEventId`.

If any step fails, leave the old cursor so the page safely replays.

- [ ] **Step 7: Add conservative browser triggers**

`start()` registers:

```text
online event       -> syncNow()
visibility visible -> syncNow()
15 second interval while visible -> syncNow()
outbox-created callback -> syncNow() after 250 ms debounce
```

`dispose()` removes every listener/timer.

- [ ] **Step 8: Run engine tests**

```bash
npx vitest run tests/sync/engine.test.ts tests/storage/local-sync.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/sync/engine.ts src/storage/local-sync.ts tests/sync/engine.test.ts
git commit -m "feat: sync local changes in background"
```

---

### Task 7: Add controller refresh/resume support and switch the runtime to warm local boot

**Files:**
- Modify: `src/miner/controller.ts`
- Modify: `src/components/study-runtime.ts`
- Test: `tests/app/controller.test.ts`
- Test: `tests/e2e/local-first-sync.spec.ts`

**Interfaces:**
- Consumes: local UI store, sync engine, workspace store.
- Produces: first-query resume position, live remote refresh, local-first feature-gated runtime.

- [ ] **Step 1: Add controller tests for initial viewport**

Create a controller with `initialViewportStart: 3500`, `pageSize:"all"`, a 5,000-entry worker fixture, then assert the very first worker query receives:

```ts
expect(query.window).toEqual({ start: 3500, size: 100 });
```

Create a second controller with `pageSize:50` and assert `query.window` is `undefined`.

- [ ] **Step 2: Add controller tests for `refreshFromStorage()`**

Case A: same active dataset, local store changes one decision. After `refreshFromStorage()`, assert the controller state contains the new decision and worker `loadDataset` call count does not increase; worker query call count does increase.

Case B: local store changes active dataset. After `refreshFromStorage()`, assert `prepareDataset(newId)` ran once, worker `loadDataset` received the new id, and queue was loaded with `sessionQueue.loadForDataset(newId)`.

- [ ] **Step 3: Implement controller-only hooks**

Extend `MinerControllerOptions`:

```ts
initialViewportStart?: number;
prepareDataset?: (datasetId: string) => Promise<void>;
```

Extend `MinerController`:

```ts
refreshFromStorage(): Promise<void>;
```

Initialize the private viewport from `initialViewportStart ?? 0`. In `loadAndQuery()`, call `await prepareDataset?.(datasetId)` before reading chunks.

Factor the persisted-state read currently inside `initialize()` into a private helper reused by `refreshFromStorage()`. Refresh behavior:

- re-read active metadata, known words, decisions, preferences, dataset library, Anki config/snapshot, and active queue;
- if active id changed: prepare/read/load worker dataset, then query;
- if active id unchanged: keep worker dataset and rerun query/coverage only;
- restore queue with `sessionQueue.loadForDataset` when available.

The controller imports no sync/cloud module.

- [ ] **Step 4: Add failing warm-offline E2E test**

Test flow:

```text
bootstrap local-first cache successfully
reload once to prove cached state exists
route /api/sync to abort/fail
reload page
wait for vocabulary result text
set a decision
assert study controls remain interactive
assert status text = Offline · changes saved locally
```

This test must fail before the runtime changes because current startup is server-first.

- [ ] **Step 5: Add the feature-gated local-first boot path**

In `study-runtime.ts`:

```ts
const localFirstEnabled = process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC === "1";
```

Flag off: preserve the current remote runtime path.

Flag on:

```text
open LocalSyncStore
if bootstrapComplete=false -> await bootstrapLocalCache()
load workspace and active queue from IndexedDB
create recording-enabled IndexedDbAppStore for controller
create recording-disabled IndexedDbAppStore for SyncEngine
create controller(initialViewportStart, prepareDataset=engine.ensureDatasetCached)
await controller.init()
mark local UI ready
register engine.onRemoteApplied(() => controller.refreshFromStorage())
engine.start()
void engine.syncNow()
```

Do not await the final `syncNow()` before setting local readiness.

If IndexedDB open throws `StorageUnavailableError`, enter the existing server-first remote-store path.

- [ ] **Step 6: Persist queue and workspace locally**

Keep the current synchronous in-memory `SessionQueueStore` facade. At boot, seed it from `LocalSyncStore.loadQueue(activeDatasetId)`. On `save()` or `clear()`, update the in-memory queue first and fire the IndexedDB queue transaction, which also writes `queue.replace/remove` outbox intent.

Persist workspace:

```ts
{
  id: "current",
  activeDatasetId: latest.dataset?.id ?? null,
  viewportStart,
  queueMode: latest.queue.mode,
  updatedAt: new Date().toISOString(),
}
```

Save viewport with a 400 ms debounce from the virtual-list `onRequestWindow` callback. Query/view/page remain in preferences.

- [ ] **Step 7: Map cloud status to exact UI copy**

```text
idle + pending=0 + lastSyncAt=null -> Saved locally
idle + pending=0 + lastSyncAt!=null -> Synced
syncing                        -> Saved locally · Syncing…
offline                        -> Offline · changes saved locally
error                          -> Sync error · changes remain on this device
```

Never make the app shell inert due solely to background sync failure.

- [ ] **Step 8: Run controller and warm-start tests**

```bash
npx vitest run tests/app/controller.test.ts tests/sync/engine.test.ts
npx playwright test tests/e2e/local-first-sync.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/miner/controller.ts src/components/study-runtime.ts tests/app/controller.test.ts tests/e2e/local-first-sync.spec.ts
git commit -m "feat: boot study workspace from local cache"
```

---

### Task 8: Preserve complete backup/restore and clear semantics

**Files:**
- Modify: `src/components/study-runtime.ts`
- Modify: `src/storage/remote-store.ts` only if typed access to existing complete backup/clear operations is missing
- Modify: `tests/e2e/backup-restore.spec.ts`
- Modify: `tests/e2e/cloud.spec.ts`

**Interfaces:**
- Consumes: `SyncEngine.flush()`, current remote complete backup/restore/clear operations.
- Produces: no backup regression and safe local cache reset.

- [ ] **Step 1: Add failing compatibility E2E cases**

Add these exact scenarios:

1. Local-first mode, mark `猫` known, intercept sync so the outbox is initially pending, click Export, release sync, download backup, parse JSON, assert the exported decision is present.
2. Complete restore to a backup containing dataset `restore-dataset`; after restore/reload assert that dataset is active and local sync meta is bootstrap-complete again.
3. Abort the restore request; assert the pre-restore cached dataset still renders and local-first database has not been cleared.
4. Force IndexedDB open failure; assert existing server-first fallback can still save a decision and export a complete backup.
5. Force cloud clear failure; assert local cached data still exists after the rejected clear action.

- [ ] **Step 2: Run and confirm local-first cases fail**

```bash
npx playwright test tests/e2e/backup-restore.spec.ts tests/e2e/cloud.spec.ts --project=chromium
```

- [ ] **Step 3: Wrap complete export**

In local-first mode:

```text
await syncEngine.flush()
assert localSync.listOutbox(1) is empty
return cloudStore.exportCompleteBackup()
```

If flush fails, show `Backup requires cloud sync; changes remain saved locally.` and do not return a stale cloud backup.

- [ ] **Step 4: Wrap complete restore**

For backup version 3:

```text
await cloudStore.restoreCompleteBackup(text)
await localSync.clearLocalData()
await bootstrapLocalCache()
window.location.assign("/?restored=1")
```

Do not clear local data before cloud restore success.

Legacy backup versions continue through controller `restoreUserState()`; Task 4 makes those writes generate ordinary outbox mutations.

- [ ] **Step 5: Preserve destructive clear**

In local-first mode:

```text
await cloudStore.clearAll()
await localSync.clearLocalData()
window.location.reload()
```

If cloud clear fails, return the error and keep local cache intact.

- [ ] **Step 6: Run compatibility tests**

```bash
npx playwright test tests/e2e/backup-restore.spec.ts tests/e2e/cloud.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/study-runtime.ts src/storage/remote-store.ts tests/e2e/backup-restore.spec.ts tests/e2e/cloud.spec.ts
git commit -m "fix: preserve cloud safety operations in local-first mode"
```

---

### Task 9: Add cross-device acceptance, performance instrumentation, and rollout docs

**Files:**
- Modify: `tests/e2e/local-first-sync.spec.ts`
- Modify: `tests/e2e/miner.spec.ts`
- Modify: `src/components/study-runtime.ts`
- Modify: `src/sync/engine.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: complete local-first runtime.
- Produces: end-to-end proof and operational rollout procedure.

- [ ] **Step 1: Add two-browser-context convergence E2E**

Use two authenticated Playwright browser contexts sharing the same disposable PostgreSQL database but separate browser storage:

```text
Context A: bootstrap -> set 騒ぐ known -> wait for Synced
Context B: bootstrap -> assert 騒ぐ known
Context B: set 騒ぐ mined -> wait for Synced
Context A: bring page to foreground / trigger sync -> assert 騒ぐ mined
```

- [ ] **Step 2: Add offline durability E2E**

```text
bootstrap
set browser context offline
set 猫 known and set hideKnown=true
reload while offline
assert decision and filter are restored locally
bring context online
wait for Synced
open fresh second context
assert cloud-synced 猫 decision is present
```

- [ ] **Step 3: Instrument boot/sync timing without adding analytics**

Expose a test-readable array:

```ts
window.__bootTimingEvents = [
  { stage: "local_boot", durationMs: 0 },
  { stage: "worker_dataset_load", durationMs: 0 },
  { stage: "first_query_ready", durationMs: 0 },
];
```

Replace the zero values with measured durations at runtime. Keep the current `__importTimingEvents`. Add equivalent `sync_push` and `sync_pull` timing events from the engine.

- [ ] **Step 4: Add dedicated warm-start performance acceptance**

Use the existing large performance fixture. Record the start before local store open and `first_query_ready` when the controller first publishes ready results. Assert:

```ts
expect(firstQueryReady.durationMs).toBeLessThan(500);
```

Also delay `/api/sync` by 5 seconds in the test and assert visible vocabulary appears before that response is released. Keep this in the dedicated performance scenario, not every functional E2E run.

- [ ] **Step 5: Document rollout in README**

Add this exact production order:

```text
1. Deploy migration/event dual-write code with NEXT_PUBLIC_LOCAL_FIRST_SYNC unset or 0.
2. Run npm run db:migrate against production DATABASE_URL.
3. Verify current server-first imports/decisions/queue/Anki/backups and verify sync_events receives rows.
4. Deploy /api/sync and local-first code with the flag still 0.
5. Validate a preview deployment against a separate preview PostgreSQL database.
6. Set NEXT_PUBLIC_LOCAL_FIRST_SYNC=1 in production and redeploy.
7. First production visit performs one bootstrap; subsequent visits use warm IndexedDB boot.
8. Keep RemoteAppStore fallback and the old browser database during stabilization.
9. Remove the rollout flag only in a later cleanup change.
```

Document all six status strings from the design spec and explain that `Saved locally` is durable on this browser while `Synced` means PostgreSQL has acknowledged pending work.

- [ ] **Step 6: Run the full verification suite**

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e:prod
```

Expected: every command exits 0.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/local-first-sync.spec.ts tests/e2e/miner.spec.ts src/components/study-runtime.ts src/sync/engine.ts README.md
git commit -m "test: verify local-first cross-device sync"
```

---

## Deployment Gates

1. **Gate A — compatibility foundation:** Task 1 only. Apply `0002`; current runtime remains server-first. Verify server-first behavior and sync-event dual-write.
2. **Gate B — dormant sync backend:** Task 2. Deploy `/api/sync` with local-first flag off. Exercise bootstrap/read/push/pull against preview DB.
3. **Gate C — browser substrate:** Tasks 3-4. No production runtime behavior change. Run storage/unit suite.
4. **Gate D — preview local-first:** Tasks 5-8. Enable `NEXT_PUBLIC_LOCAL_FIRST_SYNC=1` only in preview. Exercise cold bootstrap, warm reload, offline edits, remote-only dataset switch, backup/restore, clear, and two contexts.
5. **Gate E — production owner enablement:** Export a complete backup, enable the flag in production, redeploy, complete the one-time bootstrap, then warm-reload and verify no network response is required before cached results render.
6. **Gate F — stabilization:** After several normal study sessions and at least one second-device sync with no stuck outbox, remove the flag in a separate cleanup PR. Do not delete the old browser DB in this implementation.

## Migration Safety Checklist

Before Gate E:

```bash
npm run db:migrate
npm run test:db
npm run build
```

Verify all of the following:

- `sync_events` and `sync_mutations` exist.
- migration ledger contains `0000`, `0001`, and `0002`.
- a server-first decision produces one event row.
- preview and production use different PostgreSQL databases.
- production has a recent provider backup/restore point.
- `NEXT_PUBLIC_LOCAL_FIRST_SYNC` remains `0` until Gate D passes.
- old `jiten-migaku-miner` browser database is still present and untouched.

## Completion Criteria

- Warm reload with `/api/sync` delayed still renders cached vocabulary and accepts local decisions.
- Pending local changes survive a browser reload while offline.
- Two browser contexts converge without manual reload after background pull/controller refresh.
- Dataset import becomes usable after local IndexedDB commit; cloud upload continues in background.
- A remote-only saved dataset downloads once and is local on subsequent switches.
- Query/view/page restore from preferences; all-results viewport resumes from workspace state.
- UI distinguishes local durability from cloud synchronization.
- Complete backup waits for pending push; complete restore rebuilds local cache from restored cloud state.
- Legacy user-state restore synchronizes its replacements.
- IndexedDB failure still uses the current server-first path.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e:prod` all pass.
