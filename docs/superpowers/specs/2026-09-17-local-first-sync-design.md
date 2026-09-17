# Local-First Sync Design

## Goal

Make the miner feel instant on repeat visits while preserving durable cross-device PostgreSQL sync. The browser becomes the immediate working copy; PostgreSQL remains the durable shared copy. Normal UI actions must not wait for network acknowledgement.

## Current problem

The deployed runtime currently constructs `createRemoteAppStore()` and passes it directly to the miner controller. Startup waits for remote initialization, queue loading, controller initialization, server-backed state reads, active-dataset download, worker load, and the first query before the workspace is ready. The remote store also serializes operations behind a promise tail so dependent PostgreSQL revision writes stay ordered. This is safe, but it puts network latency in the critical path for startup and ordinary persistence.

The repository already contains most of the pieces needed for a local-first architecture: an IndexedDB `AppStore`, chunked datasets, a Web Worker, virtualized results, PostgreSQL persistence, revision checks, and a separate browser study runtime.

## Chosen architecture

Use a hybrid local-first model:

```text
UI / miner controller
        |
        v
IndexedDB working copy  <---->  SyncEngine  <---->  PostgreSQL
        |
        v
Web Worker
```

The miner controller reads and writes IndexedDB. A background `SyncEngine` pushes durable local mutations to PostgreSQL and pulls remote changes back into IndexedDB. The cloud is no longer part of the steady-state UI latency path.

The existing `RemoteAppStore` remains available for compatibility-sensitive operations such as complete backup/restore during the first local-first release and as the server-first fallback when IndexedDB is unavailable.

## Non-goals for the first local-first release

- No CRDT framework.
- No multi-user collaboration semantics.
- No service worker/PWA dependency.
- No automatic deletion of the pre-local-first IndexedDB database.
- No attempt to make complete backup restore work offline.
- No eager download of every saved dataset on every device.

The deployment is single-owner. Server arrival order is therefore an acceptable conflict rule for resources edited concurrently on multiple devices: the last mutation accepted by PostgreSQL wins. Pending local writes are pushed before remote changes are pulled, so a reconnecting device's unsynced edits are not silently discarded.

## Storage interfaces

Keep the existing `AppStore` as the miner-facing storage boundary. Add sync-specific ports rather than teaching the controller about HTTP or PostgreSQL.

```ts
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

export interface LocalSyncStore {
  getMeta(): Promise<LocalSyncMeta>;
  setMeta(value: LocalSyncMeta): Promise<void>;
  listOutbox(limit: number): Promise<SyncOutboxRecord[]>;
  acknowledge(dedupeKey: string, mutationId: string): Promise<void>;
  loadWorkspace(): Promise<WorkspaceResumeState | null>;
  saveWorkspace(value: WorkspaceResumeState): Promise<void>;
}

export interface CloudSyncPort {
  bootstrap(): Promise<CloudBootstrap>;
  pull(afterEventId: number, limit: number): Promise<SyncPullPage>;
  push(mutations: readonly MaterializedSyncMutation[]): Promise<SyncPushReceipt>;
  uploadDataset(
    mutationId: string,
    metadata: DatasetMetadata,
    chunks: AsyncIterable<readonly Entry[]>,
  ): Promise<SyncPushReceipt>;
  readDataset(datasetId: string, chunkSize: number): AsyncIterable<Entry[]>;
}
```

`SyncOutboxRecord` deliberately stores only identity and mutation kind. The sync engine materializes the latest local payload when flushing. This prevents large known-word sets, Anki snapshots, and queues from being duplicated inside the outbox and naturally coalesces rapid repeated changes.

The outbox key is a stable dedupe key such as `decision:騒ぐ`, `preferences`, `queue:<datasetId>`, `known`, `anki`, or `dataset:<datasetId>`. Each local mutation replaces the pending record for that key with a new `mutationId`. A sync acknowledgement deletes the record only if the stored `mutationId` still matches the sent mutation, so an in-flight acknowledgement cannot erase a newer local change.

## IndexedDB database and schema

Use a new production database name so stale browser data from the earlier IndexedDB era can never be mistaken for a valid cloud-seeded cache:

```ts
INDEXED_DB_NAME = "jiten-migaku-miner-local-first";
INDEXED_DB_VERSION = 4;
```

Keep the current stores and add local-first stores:

| Store | Key | Purpose |
| --- | --- | --- |
| `datasets` | `id` | Dataset metadata and local cache readiness. |
| `entryChunks` | `[datasetId, chunkIndex]` | Cached dataset rows. |
| `knownWordSets` | `id` | Current known-word set. |
| `preferences` | `id = "current"` | Query/view/page preferences. |
| `meta` | `key` | Active dataset and active known-set ids. |
| `wordDecisions` | `normalizedWord` | Manual decisions. |
| `ankiSync` | `id = "current"` | Anki config/snapshot. |
| `queues` | `datasetId` | Durable per-dataset mining queue snapshots. |
| `workspace` | `id = "current"` | Resume state not appropriate for cloud preferences, especially viewport. |
| `syncOutbox` | `dedupeKey` | Durable, coalescing pending cloud mutations. |
| `syncMeta` | `id = "current"` | Device id, bootstrap marker, server event cursor, last-sync timestamp. |

Extend the local dataset record with a cache state:

```ts
interface DatasetRecord extends DatasetMetadata {
  ready: boolean;
  cacheState: "metadata-only" | "ready";
}
```

`list()` returns both cached and metadata-only datasets so the library is complete. `readChunks()` only succeeds for `cacheState: "ready"`. The active dataset must be cached before controller initialization completes. Other datasets are downloaded on demand when switched to, then remain cached on that device.

All local mutations that need cloud synchronization must write application state and the matching outbox record in the same IndexedDB transaction. This is a hard invariant: the UI may acknowledge a local change only after both the local state and its durable sync intent commit atomically.

## Workspace resume state

Cloud preferences already persist query, view, and page. Add a small local workspace record for device-specific resume state:

```ts
{
  id: "current",
  activeDatasetId,
  viewportStart,
  queueMode,
  updatedAt
}
```

`viewportStart` is written with a 300-500 ms debounce while the virtualized all-results view moves. Query, view, and page remain in the existing preferences model and therefore sync across devices. Viewport position stays device-local because screen size and virtual-window position are device-specific.

Controller construction gains an `initialViewportStart` option so the first query can open at the saved window without issuing a second corrective query.

## Server change feed

Add an append-only sync event table and idempotency ledger:

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

CREATE TABLE sync_mutations (
  mutation_id uuid PRIMARY KEY,
  device_id text NOT NULL,
  accepted_event_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_events_id_idx ON sync_events(id);
```

Do not purge sync events in the first release. Expected single-owner event volume is small and indefinite retention removes bootstrap-gap complexity.

Every canonical PostgreSQL mutation must emit an event in the same transaction. The existing server-first `/api/store` path must dual-write events before the local-first client is enabled so an already-open old tab cannot make invisible cloud changes.

Event forms are compact:

```ts
type RemoteChange =
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
```

Large resources are not duplicated into the event log. `known.replace`, `queue.replace`, `anki.replace`, and `full-reset` instruct the client to fetch the canonical current resource through the sync transport.

## Push semantics

The sync loop is always push-first, then pull:

```text
1. read pending outbox records
2. materialize current local values
3. push to PostgreSQL
4. acknowledge only matching mutationIds
5. pull events after local serverEventId
6. apply remote events to IndexedDB
7. advance serverEventId only after the whole pull page commits locally
8. repeat until outbox empty and pull has no more pages
```

`sync.push` does not use the old global optimistic revision as a rejection gate. It serializes on the database transaction, applies mutations in request order, records each `mutationId`, and returns prior success for duplicate retries. This keeps background sync resilient to another device changing the cloud between requests.

Dataset uploads use a dedicated idempotent staged sync upload because entries can be large. Re-uploading an already-ready dataset id with identical metadata is a successful no-op; a different payload under the same dataset id is an explicit conflict.

## Pull semantics and conflict handling

Because the deployment has one human owner, the first release uses server acceptance order as the conflict rule. A device flushes pending local changes before pulling. Therefore:

- two online devices converge to whichever mutation the server accepts last;
- an offline device that later reconnects publishes its pending edits before ingesting newer cloud events;
- duplicate requests are harmless because `mutationId` is idempotent;
- applying the device's own echoed event is harmless and keeps cursor advancement simple.

Remote events are applied directly to IndexedDB without generating new outbox records. The local store therefore needs an internal `applyRemote*` path that bypasses mutation recording.

If a remote event refers to a dataset not cached locally, only metadata is updated. If it activates that dataset, the sync engine downloads and installs the dataset before the controller switches to it.

## Initial cloud bootstrap

A new device or a browser with no completed local-first bootstrap follows a one-time cloud hydration path:

```text
open new local-first IndexedDB
        |
        v
read cloud metadata/state
        |
        +--> preferences, decisions, known words, Anki, queues
        +--> dataset library metadata
        +--> active dataset entries only
        |
        v
commit local state
        |
        v
write bootstrapComplete=true and serverEventId=<cloud cursor>
        |
        v
initialize controller from IndexedDB
```

Do not mark bootstrap complete until the active dataset and all state needed by controller initialization are durable locally. A failed bootstrap leaves the marker false and retries on the next load.

The old `jiten-migaku-miner` IndexedDB database is untouched during rollout. The new local-first database uses a different name, so stale pre-cloud data cannot appear. Legacy data can be deleted manually or in a later cleanup release after the new architecture has been stable.

## Warm startup

When `bootstrapComplete` is true:

```text
open IndexedDB
    |
    +--> restore workspace/preferences/active dataset
    +--> load active cached dataset into worker
    +--> render/query immediately

in parallel after local readiness:
    syncEngine.flushAndPull()
```

Authentication and PostgreSQL errors must not block a warm local startup. The status area reports cloud state separately from local readiness.

## Cloud status UI

Replace the current all-or-nothing PostgreSQL status with two concepts: local durability and cloud sync.

Supported copy:

- `Loading local vocabulary…`
- `Saved locally`
- `Saved locally · Syncing…`
- `Synced`
- `Offline · changes saved locally`
- `Sync error · changes remain on this device`

Only IndexedDB failure should prevent local persistence. If IndexedDB cannot be opened, fall back to the existing `RemoteAppStore` server-first boot path and retain the current `beforeunload` protection for pending remote writes.

## Complete backup/restore

For the first local-first release, complete backup/export remains cloud-backed:

1. flush the local outbox;
2. verify the outbox is empty;
3. call the existing remote complete-export path.

Complete restore remains online-only:

1. call the existing atomic PostgreSQL restore;
2. clear the local-first IndexedDB database;
3. bootstrap again from PostgreSQL;
4. reload the study runtime.

This preserves current version-3 backup semantics without adding a second complex local atomic-restore implementation in the same release.

## Migration and rollout

Roll out in compatibility-first order:

1. Add PostgreSQL sync tables and dual-write sync events from the existing server store. Deploy with current server-first UI unchanged.
2. Add `/api/sync`, idempotent push, pull, bootstrap helpers, and tests. Keep UI server-first.
3. Add the new local-first IndexedDB schema, atomic outbox recording, workspace state, and sync engine behind `NEXT_PUBLIC_LOCAL_FIRST_SYNC`.
4. Test in local production mode and a Vercel preview using a disposable preview database.
5. Enable local-first in production for the owner. The first production visit performs one cloud bootstrap; later visits warm-start locally.
6. Keep `RemoteAppStore` fallback and the old IndexedDB database for at least one stabilization window. Do not delete either in the first release.
7. After stable operation, remove the rollout flag and optionally add an explicit legacy-cache cleanup action.

## Performance targets

These are acceptance targets, not guarantees:

- Warm cached startup should render locally without waiting for `/api/store` or `/api/sync`.
- Active cached dataset should reach worker/query readiness in under 500 ms on a normal desktop for the existing 100k-row performance fixture.
- Marking a decision or changing a view/query setting should update the UI without waiting for network acknowledgement.
- Background sync should batch/coalesce repeated preference, queue, known-word, and per-word decision changes.
- A failed network request must leave pending mutations durable in IndexedDB and retryable after reload.

## Required tests

- IndexedDB upgrade/new-database schema tests.
- Atomic local-write + outbox tests for every synced resource.
- In-flight acknowledgement cannot erase a newer outbox mutation.
- Sync push retry is idempotent.
- Push-first/pull-second convergence across two simulated devices.
- Remote change application does not create a new outbox mutation.
- Active remote-only dataset is downloaded before activation.
- Failed initial bootstrap does not set `bootstrapComplete`.
- Warm startup succeeds with the sync endpoint unavailable.
- Existing backup/restore behavior still passes after local-first integration.
- E2E test proving a second browser context receives a first context's decision after sync.
- Performance instrumentation distinguishes `local_boot`, `worker_dataset_load`, `first_query_ready`, `sync_push`, and `sync_pull`.
