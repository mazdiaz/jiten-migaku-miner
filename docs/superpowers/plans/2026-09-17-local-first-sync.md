# Local-First Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make warm launches and normal study actions use IndexedDB immediately while PostgreSQL synchronizes in the background across devices.

**Architecture:** The miner controller will use an IndexedDB `AppStore` as its steady-state working copy. A separate `SyncEngine` owns cloud push/pull, using a durable coalescing outbox in the same IndexedDB database and an append-only PostgreSQL change feed. The existing `RemoteAppStore` stays available for first-device bootstrap, complete backup/restore, and fallback when IndexedDB is unavailable.

**Tech Stack:** Next.js 16, React 19, TypeScript 7, native IndexedDB, Web Worker, PostgreSQL, Drizzle ORM, postgres-js, Zod, Vitest, PGlite, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-local-first-sync-design.md`

## Global Constraints

- Keep the current single-owner GitHub authentication and same-origin checks on every new API request.
- Do not add a CRDT library, service worker, or new runtime dependency in this release.
- Use a new production IndexedDB name: `jiten-migaku-miner-local-first`.
- Keep the previous browser database untouched during the first local-first release.
- Local application state and its cloud-sync intent must commit in the same IndexedDB transaction.
- Warm startup must not wait for `/api/store` or `/api/sync` before rendering cached study data.
- Push pending local changes before pulling remote changes.
- Cloud mutation retries must be idempotent by `mutationId`.
- Do not purge `sync_events` in the first release.
- A remote change applied locally must never generate a new outbox mutation.
- Complete backup/export and complete restore remain cloud-backed in this release.
- Preserve the existing 1,000,000-row dataset limit, 400 KB row limit, 750 KB request limit, and 256 MiB staged-state limit.

---

## File Structure

### New files

- `src/sync/contracts.ts` — wire/domain types shared by browser sync and server sync.
- `src/sync/cloud-client.ts` — authenticated browser transport for `/api/sync`; no controller/UI logic.
- `src/sync/engine.ts` — push-first/pull-second orchestration, retry state, dataset hydration.
- `src/storage/indexed-db-core.ts` — IndexedDB database name/version, object-store creation, transaction helpers.
- `src/storage/local-sync.ts` — local queue/workspace/sync-meta/outbox APIs and compare-and-delete acknowledgement.
- `src/server/sync.ts` — server-side bootstrap/pull/push/idempotency operations.
- `src/app/api/sync/route.ts` — auth/origin/content-type/size boundary around `src/server/sync.ts`.
- `migrations/0002_local_first_sync.sql` — sync event and mutation ledger tables.
- `tests/storage/local-sync.test.ts` — IndexedDB sync stores and atomic outbox invariants.
- `tests/server/sync.test.ts` — PostgreSQL event feed, idempotency, push/pull behavior.
- `tests/sync/engine.test.ts` — two-device convergence and retry behavior.
- `tests/e2e/local-first-sync.spec.ts` — warm boot, offline local writes, second-context sync.

### Existing files to modify

- `src/storage/indexed-db.ts` — consume extracted IndexedDB core, add cache state and optional mutation recording.
- `src/storage/contracts.ts` — expose local cache-state capability needed for on-demand dataset hydration.
- `src/server/db/schema.ts` — mirror migration `0001` dataset counters and define sync tables.
- `src/server/store.ts` — dual-write compact sync events for every canonical mutation.
- `src/server/storage/validation.ts` — validation for any sync payload reused by server operations.
- `src/components/study-runtime.ts` — local-first boot path, cloud status, fallback, bootstrap, sync-engine lifecycle.
- `src/miner/controller.ts` — accept initial viewport state and dataset-preparation hook; do not add HTTP knowledge.
- `src/miner/state.ts` — add `local-first` persistence label if UI/tests need to distinguish it.
- `src/platform/session-queue.ts` — keep the synchronous controller-facing facade, but document/use an async durable backing adapter from runtime.
- `src/storage/remote-store.ts` — expose only the minimal helpers required for cloud bootstrap/backup compatibility; preserve old server-first behavior.
- `tests/storage/indexed-db.test.ts` — verify cached vs metadata-only datasets.
- `tests/storage/indexed-db-upgrade.test.ts` — verify all local-first stores are created.
- `tests/server/postgres-store.test.ts` — verify legacy `/api/store` writes emit sync events.
- `tests/e2e/cloud.spec.ts` — preserve server-first fallback behavior.
- `tests/e2e/backup-restore.spec.ts` — verify flush-before-export and rebootstrap-after-restore.
- `README.md` — rollout flag, migration order, local-first status semantics.

---

### Task 1: Add the PostgreSQL change feed and dual-write it from the existing store

**Files:**
- Create: `migrations/0002_local_first_sync.sql`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/store.ts`
- Test: `tests/server/postgres-store.test.ts`

**Interfaces:**
- Consumes: existing `StoreDatabase`, `createPostgresStore()`, and `app_state.revision`.
- Produces: `recordSyncEvent(transaction, event)` plus durable `sync_events` rows that Task 2 reads.

- [ ] **Step 1: Write failing PostgreSQL tests for legacy dual-write**

Add tests that perform these existing operations through `createPostgresStore()` and then query `sync_events` directly:

```ts
it("emits a decision event in the same transaction", async () => {
  await dispatch({
    operation: "decision.set",
    revision: 0,
    decision: { normalizedWord: "騒ぐ", status: "known", updatedAt: NOW },
  });

  const rows = await database.query<{
    resource: string;
    resource_key: string | null;
    action: string;
  }>("SELECT resource, resource_key, action FROM sync_events ORDER BY id");

  expect(rows.rows).toEqual([
    { resource: "decision", resource_key: "騒ぐ", action: "set" },
  ]);
});
```

Add equivalent assertions for `preferences.save`, successful `dataset.finish`, `dataset.activate`, `dataset.remove`, known-word `state.finish`, queue `state.finish`, Anki `state.finish`, and complete restore/clear producing `full-reset`.

- [ ] **Step 2: Run the server test and verify failure**

Run:

```bash
npx vitest run tests/server/postgres-store.test.ts
```

Expected: FAIL because `sync_events` does not exist.

- [ ] **Step 3: Add the migration**

Create `migrations/0002_local_first_sync.sql` exactly as:

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

- [ ] **Step 4: Bring the Drizzle schema in sync with migrations `0001` and `0002`**

In `src/server/db/schema.ts`, add the already-deployed upload-counter columns to `datasets`:

```ts
uploadedRows: bigint("uploaded_rows", { mode: "number" }).notNull().default(0),
uploadedBytes: bigint("uploaded_bytes", { mode: "number" }).notNull().default(0),
nextOrdinal: integer("next_ordinal").notNull().default(0),
```

Then define `syncEvents` and `syncMutations` matching the SQL migration. Do not generate or rewrite prior migration files.

- [ ] **Step 5: Add a compact event helper in `src/server/store.ts`**

Add:

```ts
type SyncEventInput = {
  resource: string;
  resourceKey?: string | null;
  action: string;
  originDeviceId?: string | null;
};

async function recordSyncEvent(
  database: StoreDatabase,
  appRevision: number,
  event: SyncEventInput,
): Promise<number> {
  const result = await rows<{ id: string | number }>(
    database,
    sql`INSERT INTO sync_events(app_revision, resource, resource_key, action, origin_device_id)
        VALUES (${appRevision}, ${event.resource}, ${event.resourceKey ?? null}, ${event.action}, ${event.originDeviceId ?? null})
        RETURNING id`,
  );
  return Number(result[0]!.id);
}
```

Call it only after the canonical mutation has succeeded and before the transaction returns. Use the post-mutation revision that will be committed for the operation.

Map existing operations to events as follows:

| Existing operation | Event |
| --- | --- |
| `dataset.finish` | `dataset/<id>/upsert` |
| `dataset.activate` | `dataset-active/<id>/set` |
| `dataset.remove` | `dataset/<id>/remove` |
| `decision.set` | `decision/<word>/set` |
| `decision.remove` | `decision/<word>/remove` |
| `preferences.save` | `preferences/null/replace` |
| known-word `state.finish` | `known/null/replace` |
| queue `state.finish` or clear | `queue/<datasetId>/replace` or `remove` |
| Anki snapshot/config finish/clear | `anki/null/replace` |
| complete restore or `state.clear all` | `state/null/full-reset` |

Do not emit events for staging-only chunk writes; only emit when a logical resource becomes visible.

- [ ] **Step 6: Run server tests**

Run:

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
- Consumes: `sync_events`, `sync_mutations`, existing canonical PostgreSQL tables, existing auth/access helpers.
- Produces: `CloudBootstrap`, `RemoteChange`, `MaterializedSyncMutation`, `SyncPullPage`, `SyncPushReceipt`, and authenticated `/api/sync` operations.

- [ ] **Step 1: Write failing protocol/server tests**

Cover four cases:

```ts
it("pulls events strictly after the supplied cursor", async () => { /* seed two events; afterEventId=first returns second */ });
it("replaying the same mutationId is idempotent", async () => { /* push twice; canonical row and event count change once */ });
it("push accepts a stale device without revision-conflict rejection", async () => { /* mutate server between bootstrap and push */ });
it("bootstrap returns the current event cursor and canonical metadata", async () => { /* assert active dataset, library, state cursor */ });
```

- [ ] **Step 2: Run and verify failure**

```bash
npx vitest run tests/server/sync.test.ts
```

Expected: FAIL because the sync contracts and server dispatcher do not exist.

- [ ] **Step 3: Add exact shared contracts**

Create `src/sync/contracts.ts` with these exported shapes:

```ts
import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../domain/anki";
import type { Entry, QueryState, ViewState, WordDecision } from "../domain/types";
import type { SessionQueueSnapshot } from "../platform/session-queue";
import type { DatasetMetadata } from "../storage/contracts";

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

export type RemoteChange =
  | { id: number; kind: "dataset.upsert"; dataset: DatasetMetadata }
  | { id: number; kind: "dataset.remove"; datasetId: string }
  | { id: number; kind: "dataset.activate"; datasetId: string | null }
  | { id: number; kind: "known.replace" }
  | { id: number; kind: "decision.set"; decision: WordDecision }
  | { id: number; kind: "decision.remove"; normalizedWord: string }
  | { id: number; kind: "preferences.replace"; value: PreferencesValue }
  | { id: number; kind: "queue.replace"; datasetId: string }
  | { id: number; kind: "queue.remove"; datasetId: string }
  | { id: number; kind: "anki.replace" }
  | { id: number; kind: "full-reset" };

export interface CloudBootstrap {
  eventId: number;
  activeDatasetId: string | null;
  datasets: DatasetMetadata[];
  knownWords: { id: string; name: string; words: string[] } | null;
  decisions: WordDecision[];
  preferences: PreferencesValue | null;
  queues: SessionQueueSnapshot[];
  anki: { config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null };
}

export interface SyncPullPage {
  changes: RemoteChange[];
  nextEventId: number;
  hasMore: boolean;
}

export interface SyncPushReceipt {
  accepted: Array<{ mutationId: string; eventId: number | null }>;
}
```

Dataset content is not included in `MaterializedSyncMutation`; it uses the dedicated staged upload methods added in Step 5.

- [ ] **Step 4: Implement `dispatchSyncOperation()`**

In `src/server/sync.ts`, expose:

```ts
export async function dispatchSyncOperation(input: unknown): Promise<unknown>;
```

Validate a discriminated union with operations:

```ts
"bootstrap"
"pull"
"push"
"dataset.begin"
"dataset.chunks"
"dataset.finish"
"dataset.read"
```

Rules:

- `bootstrap` reads one consistent canonical snapshot and `SELECT COALESCE(MAX(id), 0) FROM sync_events` in one transaction.
- `pull` returns at most 200 events with `id > afterEventId`, ordered ascending; hydrate small payloads (`decision`, `preferences`, dataset metadata) from canonical data and mark large resources (`known`, `queue`, `anki`, `full-reset`) for client refetch.
- `push` takes at most 100 mutations; before applying each, query `sync_mutations`. If present, return the prior `accepted_event_id` without reapplying.
- A fresh mutation applies canonical state, writes one event with `origin_device_id`, then inserts the mutation ledger row in the same transaction.
- `push` does not compare the client's old app revision.
- `dataset.begin/chunks/finish` reuses the existing chunk/count/byte limits but keys idempotency by `mutationId` instead of a client revision. An already-ready identical dataset is success; same id with different metadata is `409 DATASET_CONFLICT`.
- `dataset.read` pages canonical ready chunks and keeps each response below the existing wire limit.

- [ ] **Step 5: Add the API route with the same security boundary as `/api/store`**

`src/app/api/sync/route.ts` must:

```ts
const MAX_BODY_BYTES = 1024 * 1024;
```

Then perform, in order: `auth()`, `isOwner`, `isSameOrigin`, JSON content-type check, bounded body read, `JSON.parse`, `dispatchSyncOperation`, `Cache-Control: no-store`. Return typed `StoreError`/sync errors without exposing PostgreSQL internals.

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

### Task 3: Create the local-first IndexedDB schema and local sync stores

**Files:**
- Create: `src/storage/indexed-db-core.ts`
- Create: `src/storage/local-sync.ts`
- Modify: `src/storage/indexed-db.ts`
- Modify: `tests/storage/indexed-db-upgrade.test.ts`
- Test: `tests/storage/local-sync.test.ts`

**Interfaces:**
- Consumes: existing IndexedDB store implementations.
- Produces: one local-first database, `LocalSyncStore`, durable queue store, workspace store, and compare-and-delete outbox acknowledgement.

- [ ] **Step 1: Write failing schema tests**

Assert a newly opened database contains exactly these stores:

```ts
[
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
]
```

Also assert `syncOutbox` keyPath is `dedupeKey`, `queues` keyPath is `datasetId`, and `workspace`/`syncMeta` keyPath is `id`.

- [ ] **Step 2: Run and verify failure**

```bash
npx vitest run tests/storage/indexed-db-upgrade.test.ts tests/storage/local-sync.test.ts
```

Expected: FAIL because the new stores/core module do not exist.

- [ ] **Step 3: Extract the database mechanics without changing existing store behavior**

Move the reusable database/open/transaction code from `src/storage/indexed-db.ts` into `src/storage/indexed-db-core.ts` and export:

```ts
export const INDEXED_DB_NAME = "jiten-migaku-miner-local-first";
export const INDEXED_DB_VERSION = 4;
export type IndexedDbStoreName = /* union of all 11 names */;
export function withDatabase<T>(name: string, action: (db: IDBDatabase) => Promise<T>): Promise<T>;
export function runTransaction<T>(
  database: IDBDatabase,
  storeNames: readonly IndexedDbStoreName[],
  mode: IDBTransactionMode,
  operation: (
    transaction: IDBTransaction,
    resolveResult: (value: T) => void,
    abort: (reason: unknown) => void,
  ) => void,
): Promise<T>;
```

The upgrade callback creates all old stores plus `queues`, `workspace`, `syncOutbox`, and `syncMeta`. Keep `database.onversionchange = () => database.close()`.

- [ ] **Step 4: Add local sync types and CRUD**

`src/storage/local-sync.ts` defines:

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

Create `createLocalSyncStore({ databaseName, now, createId })` with:

```ts
getMeta(): Promise<LocalSyncMeta>;
setMeta(value: LocalSyncMeta): Promise<void>;
listOutbox(limit: number): Promise<SyncOutboxRecord[]>;
acknowledge(dedupeKey: string, mutationId: string): Promise<void>;
loadWorkspace(): Promise<WorkspaceResumeState | null>;
saveWorkspace(value: WorkspaceResumeState): Promise<void>;
loadQueue(datasetId: string): Promise<SessionQueueSnapshot | null>;
listQueues(): Promise<SessionQueueSnapshot[]>;
saveQueue(snapshot: SessionQueueSnapshot | null, datasetId: string): Promise<void>;
clearLocalData(): Promise<void>;
```

`getMeta()` creates a stable `deviceId` via `crypto.randomUUID()` the first time and returns `{ bootstrapComplete:false, serverEventId:0, lastSyncAt:null }`.

`acknowledge()` must compare mutation ids inside one readwrite transaction:

```ts
const current = await get(dedupeKey);
if (current?.mutationId === mutationId) store.delete(dedupeKey);
```

- [ ] **Step 5: Test acknowledgement race safety**

Write this exact behavior:

```ts
await putOutbox({ dedupeKey: "preferences", mutationId: "old", ...base });
const sent = (await sync.listOutbox(10))[0]!;
await putOutbox({ dedupeKey: "preferences", mutationId: "new", ...base });
await sync.acknowledge(sent.dedupeKey, sent.mutationId);
expect((await sync.listOutbox(10))[0]?.mutationId).toBe("new");
```

- [ ] **Step 6: Run storage tests**

```bash
npx vitest run tests/storage/indexed-db-upgrade.test.ts tests/storage/indexed-db.test.ts tests/storage/local-sync.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/indexed-db-core.ts src/storage/local-sync.ts src/storage/indexed-db.ts tests/storage/indexed-db-upgrade.test.ts tests/storage/local-sync.test.ts tests/storage/indexed-db.test.ts
git commit -m "feat: add local-first indexeddb schema"
```

---

### Task 4: Make local writes atomically record sync intent

**Files:**
- Modify: `src/storage/indexed-db.ts`
- Modify: `src/storage/contracts.ts`
- Test: `tests/storage/local-sync.test.ts`
- Test: `tests/storage/indexed-db.test.ts`

**Interfaces:**
- Consumes: `SyncOutboxRecord`, `syncOutbox` object store.
- Produces: recording-enabled UI store and recording-disabled remote-apply store sharing the same database.

- [ ] **Step 1: Add failing atomicity tests**

For each resource, write a local value through a recording-enabled store and assert the application record and expected outbox record appear after the same transaction. Minimum cases:

```text
dataset stage success -> dataset:<id> / dataset.upload
dataset activate      -> activeDataset / dataset.activate
dataset remove        -> dataset:<id> / dataset.remove
known save/remove     -> known / known.replace
decision set/remove   -> decision:<word> / decision.set|decision.remove
preferences save      -> preferences / preferences.replace
Anki config/snapshot  -> anki / anki.replace
```

Also inject a transaction abort and assert neither application data nor outbox mutation remains.

- [ ] **Step 2: Run and verify failure**

```bash
npx vitest run tests/storage/local-sync.test.ts
```

Expected: FAIL because IndexedDB writes do not record outbox intent.

- [ ] **Step 3: Add explicit IndexedDB store options**

Use:

```ts
export interface IndexedDbAppStoreOptions {
  databaseName?: string;
  recordSyncMutations?: boolean;
  now?: () => string;
  createMutationId?: () => string;
}
```

`createIndexedDbAppStore()` defaults `recordSyncMutations` to `false` for compatibility tests. The local-first runtime will explicitly pass `true`.

- [ ] **Step 4: Add one mutation-record builder**

Implement deterministic dedupe keys:

```ts
function outboxIdentity(kind: SyncMutationKind, resourceId: string | null): string {
  if (kind.startsWith("decision.")) return `decision:${resourceId}`;
  if (kind.startsWith("dataset.") && kind !== "dataset.activate") return `dataset:${resourceId}`;
  if (kind === "dataset.activate") return "activeDataset";
  if (kind.startsWith("queue.")) return `queue:${resourceId}`;
  if (kind === "known.replace") return "known";
  if (kind === "preferences.replace") return "preferences";
  return "anki";
}
```

Each recorded write uses a new `mutationId`. Rapid subsequent writes replace the same dedupe key.

- [ ] **Step 5: Include `syncOutbox` in the same write transaction**

Do not perform a second transaction after application persistence. For example `decision.set` becomes one transaction over `wordDecisions` and `syncOutbox`, and `dataset.activate` becomes one transaction over `datasets`, `meta`, and `syncOutbox`.

`dataset.stage` records `dataset.upload` only in the final transaction that flips the dataset to ready. A failed staging sequence therefore leaves no cloud upload intent.

- [ ] **Step 6: Add metadata-only dataset support**

Extend the local dataset record:

```ts
interface DatasetRecord extends DatasetMetadata {
  ready: boolean;
  cacheState: "metadata-only" | "ready";
}
```

Expose through `DatasetStore`:

```ts
cacheState?(datasetId: string): Promise<"metadata-only" | "ready" | null>;
upsertMetadata?(metadata: DatasetMetadata): Promise<void>;
```

`upsertMetadata()` is an internal bootstrap/remote-apply operation and must not record outbox intent. `readChunks()` throws `DatasetNotCachedError` for metadata-only records.

- [ ] **Step 7: Verify remote-apply writes are silent**

Create a second store instance with `recordSyncMutations:false`, apply a decision and metadata update, then assert `syncOutbox` remains empty.

- [ ] **Step 8: Run storage tests**

```bash
npx vitest run tests/storage/indexed-db.test.ts tests/storage/local-sync.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/storage/indexed-db.ts src/storage/contracts.ts tests/storage/indexed-db.test.ts tests/storage/local-sync.test.ts
git commit -m "feat: record local changes for background sync"
```

---

### Task 5: Implement cloud bootstrap and on-demand dataset hydration

**Files:**
- Create: `src/sync/cloud-client.ts`
- Modify: `src/storage/remote-store.ts`
- Test: `tests/sync/engine.test.ts`

**Interfaces:**
- Consumes: `/api/sync`, recording-disabled local store, `LocalSyncStore`.
- Produces: `createCloudSyncClient()`, `bootstrapLocalCache()`, and `ensureDatasetCached()`.

- [ ] **Step 1: Write failing bootstrap tests**

Test:

1. empty local database + populated cloud -> bootstrap writes state, dataset library metadata, active dataset content, queues, and cursor;
2. failed active-dataset download -> `bootstrapComplete` remains `false`;
3. non-active datasets remain `metadata-only` after bootstrap;
4. `ensureDatasetCached(id)` downloads a metadata-only dataset once and subsequent calls do not hit the network.

- [ ] **Step 2: Run and verify failure**

```bash
npx vitest run tests/sync/engine.test.ts
```

Expected: FAIL because cloud sync client/bootstrap functions do not exist.

- [ ] **Step 3: Implement `createCloudSyncClient()`**

Expose:

```ts
export interface CloudSyncPort {
  bootstrap(): Promise<CloudBootstrap>;
  pull(afterEventId: number, limit?: number): Promise<SyncPullPage>;
  push(deviceId: string, mutations: readonly MaterializedSyncMutation[]): Promise<SyncPushReceipt>;
  uploadDataset(
    deviceId: string,
    mutationId: string,
    metadata: DatasetMetadata,
    chunks: AsyncIterable<readonly Entry[]>,
  ): Promise<SyncPushReceipt>;
  readDataset(datasetId: string, chunkSize: number): AsyncIterable<Entry[]>;
}
```

Use the same response/error discipline as `remote-store.ts`: same-origin credentials, JSON validation, bounded request bodies, and explicit `NETWORK_ERROR`/`INVALID_RESPONSE` errors.

- [ ] **Step 4: Implement first-device bootstrap**

`bootstrapLocalCache()` performs:

```text
cloud.bootstrap()
-> clear incomplete local-first cache only
-> write preferences/known/decisions/Anki/queues through recording-disabled stores
-> upsert all dataset metadata as metadata-only
-> download active dataset, stage locally, activate locally
-> write workspace activeDatasetId
-> set syncMeta { bootstrapComplete:true, serverEventId:cloud.eventId, lastSyncAt:now }
```

The final sync-meta write occurs last. On any error, leave `bootstrapComplete:false`.

- [ ] **Step 5: Implement on-demand dataset hydration**

`ensureDatasetCached(datasetId)`:

```ts
const state = await localStore.datasets.cacheState!(datasetId);
if (state === "ready") return;
const metadata = (await localStore.datasets.list()).find((item) => item.id === datasetId);
if (!metadata) throw new Error(`Dataset metadata missing: ${datasetId}`);
await localStore.datasets.stage(metadata, cloud.readDataset(datasetId, 2_000));
```

Use the recording-disabled store for cloud-originated hydration so it does not enqueue `dataset.upload`.

- [ ] **Step 6: Run sync tests**

```bash
npx vitest run tests/sync/engine.test.ts
```

Expected: bootstrap/hydration cases PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sync/cloud-client.ts src/storage/remote-store.ts tests/sync/engine.test.ts
git commit -m "feat: bootstrap local cache from cloud"
```

---

### Task 6: Implement the background SyncEngine

**Files:**
- Create: `src/sync/engine.ts`
- Modify: `src/storage/local-sync.ts`
- Test: `tests/sync/engine.test.ts`

**Interfaces:**
- Consumes: recording-enabled local UI store, recording-disabled remote-apply store, `LocalSyncStore`, `CloudSyncPort`.
- Produces: `SyncEngine` with `start()`, `syncNow()`, `flush()`, `ensureDatasetCached()`, `subscribe()` and `dispose()`.

- [ ] **Step 1: Write failing two-device and retry tests**

Add tests for:

```ts
it("pushes local outbox before pulling remote changes", async () => { /* assert call order */ });
it("keeps outbox durable after a network failure", async () => { /* fail push; recreate engine; retry */ });
it("does not delete a newer mutation when an older request is acknowledged", async () => { /* race */ });
it("applies pulled remote changes without creating outbox entries", async () => { /* remote-apply store */ });
it("converges two devices on the server-accepted final decision", async () => { /* device A/B fake IndexedDB names */ });
```

- [ ] **Step 2: Run and verify failure**

```bash
npx vitest run tests/sync/engine.test.ts
```

Expected: FAIL because `SyncEngine` does not exist.

- [ ] **Step 3: Implement explicit sync status**

```ts
export type SyncStatus =
  | { state: "idle"; pending: number; lastSyncAt: string | null }
  | { state: "syncing"; pending: number; lastSyncAt: string | null }
  | { state: "offline"; pending: number; lastSyncAt: string | null; message: string }
  | { state: "error"; pending: number; lastSyncAt: string | null; message: string };
```

Do not put this status in `AppState`; it belongs to the runtime/cloud-sync layer.

- [ ] **Step 4: Implement outbox materialization**

For each `SyncOutboxRecord`, read the latest local state immediately before sending:

| kind | materialized from |
| --- | --- |
| `dataset.upload` | dataset metadata + local entry chunks; handled by `uploadDataset()` |
| `dataset.remove` | record resource id |
| `dataset.activate` | local active dataset id |
| `known.replace` | `knownWords.getActive()` |
| `decision.set` | `wordDecisions.get(word)`; if absent convert to remove |
| `decision.remove` | record resource id |
| `preferences.replace` | `preferences.load()` |
| `queue.replace/remove` | local queue store |
| `anki.replace` | config + snapshot |

Send small mutations in batches of at most 100. Process dataset uploads separately because they stream chunks.

- [ ] **Step 5: Implement push-first/pull-second**

The core loop must be structurally equivalent to:

```ts
async function syncNow(): Promise<void> {
  if (running) return running;
  running = (async () => {
    await pushUntilDrained();
    await pullUntilCaughtUp();
    await syncMeta.setLastSyncAt(now());
  })().finally(() => {
    running = null;
  });
  return running;
}
```

After each push receipt, call `acknowledge(dedupeKey, mutationId)`. After each pull page, apply all changes and update `serverEventId` only after local application succeeds.

- [ ] **Step 6: Apply remote changes deterministically**

- `decision.set/remove`, `preferences.replace`, dataset metadata/remove/activate use recording-disabled local APIs.
- `known.replace`, `queue.replace`, `anki.replace` fetch current canonical values through the cloud client before applying.
- `dataset.activate` calls `ensureDatasetCached()` before local activation.
- `full-reset` reruns bootstrap into the local cache, then reports a runtime refresh requirement.

- [ ] **Step 7: Add conservative triggers**

`start()` registers:

```text
window online      -> syncNow()
document visible   -> syncNow()
15-second timer    -> syncNow() while page is visible
local outbox write -> debounce syncNow() by 250 ms
```

Do not schedule more frequently than 250 ms. `dispose()` removes listeners and timers.

- [ ] **Step 8: Run sync tests**

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

### Task 7: Switch the study runtime to warm local boot and persist resume state

**Files:**
- Modify: `src/components/study-runtime.ts`
- Modify: `src/miner/controller.ts`
- Modify: `src/miner/state.ts`
- Modify: `src/platform/session-queue.ts`
- Test: `tests/app/controller.test.ts`
- Test: `tests/e2e/local-first-sync.spec.ts`

**Interfaces:**
- Consumes: local UI store, sync engine, workspace store, cloud client.
- Produces: instant cached startup, on-demand dataset preparation, 400 ms viewport resume persistence, user-visible local/cloud status.

- [ ] **Step 1: Write the controller resume tests**

Construct a controller with `initialViewportStart: 3500`, load an all-results dataset, and assert the first worker query receives `window.start === 3500`. Add a second test proving normal page-size mode ignores the saved viewport.

- [ ] **Step 2: Add controller options without network knowledge**

Extend `MinerControllerOptions`:

```ts
initialViewportStart?: number;
prepareDataset?: (datasetId: string) => Promise<void>;
```

Initialize the private viewport from `initialViewportStart ?? 0`. In `loadAndQuery()`, run `await this.prepareDataset?.(datasetId)` immediately before reading chunks. The controller must not import sync/cloud modules.

- [ ] **Step 3: Write a failing warm-start E2E test**

The test should:

1. seed the new local-first IndexedDB and mark bootstrap complete;
2. make `/api/sync` return a network failure;
3. reload;
4. assert vocabulary becomes visible and usable from local cache;
5. assert status contains `Offline · changes saved locally` rather than a blocking workspace error.

- [ ] **Step 4: Add feature-gated local-first boot**

In `study-runtime.ts`:

```ts
const localFirstEnabled = process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC === "1";
```

When false, keep the existing `createRemoteAppStore()` path byte-for-byte equivalent in behavior.

When true:

```text
open local sync meta
if bootstrapComplete=false -> await one-time bootstrap
load workspace + active queue locally
create recording-enabled IndexedDbAppStore for controller
create recording-disabled IndexedDbAppStore for SyncEngine remote application
create controller with initialViewportStart + prepareDataset
await controller.init()
mark UI ready immediately after local controller readiness
start SyncEngine without awaiting its first network round trip
```

If opening IndexedDB throws a storage-unavailable error, log the local failure and enter the existing server-first runtime path.

- [ ] **Step 5: Replace the queue's remote-in-critical-path behavior**

At boot, load the active dataset's queue from IndexedDB. Keep the controller-facing `SessionQueueStore` synchronous by maintaining the in-memory `queue` variable exactly as the current runtime does. `save()`/`clear()` update memory immediately and fire the durable IndexedDB queue write; that write atomically records `queue.replace/remove` in the outbox.

- [ ] **Step 6: Persist workspace resume state**

On controller state changes, persist `activeDatasetId` and `queue.mode`. In the virtual-list `onRequestWindow`, debounce `viewportStart` writes by 400 ms. Store only:

```ts
{
  id: "current",
  activeDatasetId,
  viewportStart,
  queueMode,
  updatedAt: new Date().toISOString(),
}
```

Do not duplicate query/view/page; they already live in preferences.

- [ ] **Step 7: Separate local readiness from cloud sync copy**

Map `SyncStatus` to exactly these messages:

```text
idle + pending=0 + lastSyncAt=null -> Saved locally
idle + pending=0 + lastSyncAt!=null -> Synced
syncing                        -> Saved locally · Syncing…
offline                        -> Offline · changes saved locally
error                          -> Sync error · changes remain on this device
```

Do not set the entire workspace to `inert` on background sync failure.

- [ ] **Step 8: Run focused tests**

```bash
npx vitest run tests/app/controller.test.ts tests/sync/engine.test.ts
npx playwright test tests/e2e/local-first-sync.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/study-runtime.ts src/miner/controller.ts src/miner/state.ts src/platform/session-queue.ts tests/app/controller.test.ts tests/e2e/local-first-sync.spec.ts
git commit -m "feat: boot study workspace from local cache"
```

---

### Task 8: Preserve complete backup, restore, and destructive clear semantics

**Files:**
- Modify: `src/components/study-runtime.ts`
- Modify: `src/storage/remote-store.ts`
- Modify: `tests/e2e/backup-restore.spec.ts`
- Modify: `tests/e2e/cloud.spec.ts`

**Interfaces:**
- Consumes: `SyncEngine.flush()`, existing remote complete backup/restore methods.
- Produces: no backup regression and a safe local-cache reset after cloud restore.

- [ ] **Step 1: Add failing backup compatibility tests**

Cover:

- local unsynced decision -> Export -> export contains the decision because export waits for `flush()`;
- complete restore -> PostgreSQL restore succeeds -> local-first DB is rebuilt -> restored dataset appears after reload;
- network failure before complete restore -> existing local cache remains untouched;
- IndexedDB-unavailable server-first fallback still exports/restores as before.

- [ ] **Step 2: Run and verify failure**

```bash
npx playwright test tests/e2e/backup-restore.spec.ts tests/e2e/cloud.spec.ts --project=chromium
```

Expected: at least the local-first cases FAIL.

- [ ] **Step 3: Wrap complete export**

In local-first mode:

```text
await syncEngine.flush()
assert outbox count === 0
return cloudStore.exportCompleteBackup()
```

If flush fails, show `Backup requires cloud sync; changes remain saved locally.` and do not return a stale backup.

- [ ] **Step 4: Wrap complete restore**

For a version-3 backup:

```text
await cloudStore.restoreCompleteBackup(text)
await localSync.clearLocalData()
await bootstrapLocalCache(...)
window.location.assign("/?restored=1")
```

Do not clear local data before the cloud restore succeeds.

Legacy backup restore continues through the controller/local store and therefore records ordinary resource outbox mutations.

- [ ] **Step 5: Preserve destructive clear**

In local-first mode, require the existing remote `clearAll()` to succeed first, then clear the local-first database and reload. If remote clear fails, keep local data. This rare destructive action is intentionally online-only in the first release.

- [ ] **Step 6: Run compatibility tests**

```bash
npx playwright test tests/e2e/backup-restore.spec.ts tests/e2e/cloud.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/study-runtime.ts src/storage/remote-store.ts tests/e2e/backup-restore.spec.ts tests/e2e/cloud.spec.ts
git commit -m "fix: preserve cloud backup semantics with local-first storage"
```

---

### Task 9: Add cross-device E2E coverage and performance acceptance checks

**Files:**
- Modify: `tests/e2e/local-first-sync.spec.ts`
- Modify: `tests/e2e/miner.spec.ts`
- Modify: `src/components/study-runtime.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed local-first runtime and sync engine.
- Produces: rollout evidence and documented operational procedure.

- [ ] **Step 1: Add a two-browser-context convergence test**

Use two authenticated Playwright contexts backed by separate browser storage but the same disposable PostgreSQL database:

```text
Context A: bootstrap -> mark 騒ぐ known -> wait for Synced
Context B: bootstrap -> trigger sync -> assert 騒ぐ is known
Context B: change same word to mined -> wait for Synced
Context A: trigger visibility sync -> assert mined wins
```

- [ ] **Step 2: Add an offline durability test**

```text
bootstrap
set browser offline
make decision + change filter
reload while API remains unavailable
assert decision/filter restored locally
bring browser online
wait for Synced
reload fresh second context
assert cloud received the decision
```

- [ ] **Step 3: Instrument warm boot without adding analytics dependencies**

Record to a test-readable window array:

```ts
window.__bootTimingEvents = [
  { stage: "local_boot", durationMs },
  { stage: "worker_dataset_load", durationMs },
  { stage: "first_query_ready", durationMs },
];
```

Keep the existing import timing instrumentation. Sync engine similarly records `sync_push` and `sync_pull` timing events.

- [ ] **Step 4: Add the warm-start performance assertion**

Using the existing large fixture/performance scenario, assert:

```ts
expect(firstQueryReady.durationMs).toBeLessThan(500);
```

Also intercept requests and assert a warm cached launch reaches visible study results before the first `/api/sync` response resolves.

Treat the 500 ms check as a dedicated performance test, not a flaky assertion in every functional E2E run.

- [ ] **Step 5: Document exact rollout order in README**

Add:

```text
1. Deploy migration 0002 with NEXT_PUBLIC_LOCAL_FIRST_SYNC unset/0.
2. Run npm run db:migrate against the production DATABASE_URL.
3. Verify server-first app and sync-event dual-write in production logs/database.
4. Deploy the sync API/local-first code with the flag still 0.
5. Validate a preview deployment against a separate preview PostgreSQL database.
6. Set NEXT_PUBLIC_LOCAL_FIRST_SYNC=1 in production and redeploy.
7. First production visit performs one cloud bootstrap; subsequent visits use local warm boot.
8. Keep the old IndexedDB database and RemoteAppStore fallback through the stabilization window.
```

Document the new status messages and that offline changes are local until `Synced` appears.

- [ ] **Step 6: Run the complete verification suite**

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e:prod
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/local-first-sync.spec.ts tests/e2e/miner.spec.ts src/components/study-runtime.ts README.md
git commit -m "test: verify local-first cross-device sync"
```

---

## Rollout Order

The task order is intentionally not the same as “turn everything on at once.” Use these deployment gates:

1. **Gate A — database/event compatibility:** complete Task 1, apply `0002`, deploy with current runtime unchanged. Verify normal imports, decisions, queue, Anki, and backups still work.
2. **Gate B — dormant sync backend:** complete Task 2. Deploy `/api/sync` with local-first feature flag still off. Verify bootstrap/pull/push against a preview/disposable database and production read-only bootstrap.
3. **Gate C — browser local substrate:** complete Tasks 3-4. No runtime behavior changes yet. Run all unit/storage tests.
4. **Gate D — local-first preview:** complete Tasks 5-8. Enable `NEXT_PUBLIC_LOCAL_FIRST_SYNC=1` only in preview. Exercise first bootstrap, warm reload, offline edit, dataset switch, backup/restore, and a second browser context.
5. **Gate E — production owner opt-in:** enable the flag in production and redeploy. Keep the old IndexedDB database untouched. Export a complete backup before the first production enablement.
6. **Gate F — stabilization:** after at least several normal study sessions with no pending outbox stuck and successful cross-device sync, remove the feature flag branch from runtime in a separate cleanup PR. Do not combine that cleanup with this implementation.

## Migration Safety Checklist

Before enabling local-first in production:

```bash
npm run db:migrate
npm run test:db
npm run build
```

Then verify:

- `sync_events` and `sync_mutations` exist;
- a normal server-first decision produces one `sync_events` row;
- `0000`, `0001`, and `0002` are present in the migration ledger;
- preview and production databases are different;
- production has a recent provider restore point or backup;
- `NEXT_PUBLIC_LOCAL_FIRST_SYNC` is still `0` until the sync backend and local cache tests pass.

On the first local-first production launch, do not delete or reset the old browser database. A failed bootstrap must leave `bootstrapComplete=false` and fall back/retry without destroying the prior cloud data.

## Completion Criteria

Implementation is complete only when all of these are true:

- A warm reload with `/api/sync` intentionally delayed still shows cached vocabulary and accepts local decisions.
- Pending local changes survive a full browser reload while offline.
- Two browser contexts converge after reconnect/sync.
- Dataset imports become usable after local IndexedDB commit; cloud upload continues in the background.
- Switching to a remote-only saved dataset downloads it once, caches it, and subsequent switches are local.
- Query/view/page preferences restore; all-results viewport resumes close to the previous position.
- The status distinguishes local durability from cloud synchronization.
- Complete backup waits for pending sync and complete restore rebuilds the local cache from the restored cloud state.
- IndexedDB failure still leaves the existing server-first path usable.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e:prod` all pass.
