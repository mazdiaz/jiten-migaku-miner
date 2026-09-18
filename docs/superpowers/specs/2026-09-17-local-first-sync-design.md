# Local-First Sync Design

## Goal

Make the miner feel instant on repeat visits while preserving durable cross-device PostgreSQL sync. The browser becomes the immediate working copy; PostgreSQL remains the durable shared copy. Normal study actions must not wait for network acknowledgement.

## Current problem

The deployed runtime constructs `createRemoteAppStore()` and passes it directly to the miner controller. Startup waits for remote initialization, queue loading, server-backed state reads, active-dataset download, worker load, and the first query. The remote store also serializes requests so PostgreSQL revision writes remain ordered. This is safe, but network/database latency sits directly in the startup and persistence path.

The repository already has the useful local pieces: an IndexedDB `AppStore`, chunked datasets, a Web Worker, virtualized results, PostgreSQL persistence, revision checks, and a separate browser study runtime.

## Chosen architecture

```text
UI / miner controller
        |
        v
IndexedDB working copy  <---->  SyncEngine  <---->  PostgreSQL
        |
        v
Web Worker
```

The controller reads and writes IndexedDB. `SyncEngine` pushes durable local mutations in the background and pulls cloud changes back into IndexedDB. PostgreSQL remains the durable cross-device copy but leaves the steady-state UI critical path.

The existing `RemoteAppStore` stays available for complete backup/restore and as a server-first fallback when IndexedDB is unavailable.

## Non-goals

- No CRDT framework.
- No multi-user collaboration semantics.
- No service worker/PWA requirement.
- No automatic deletion of the pre-local-first IndexedDB database.
- No offline complete-backup restore.
- No eager download of every saved dataset on every device.

This is a single-owner deployment. The first release therefore uses server acceptance order for conflicting writes. Pending local writes are pushed before remote changes are pulled, so a reconnecting device does not silently discard its unsynced edits.

## Storage interfaces

Keep `AppStore` as the miner-facing boundary. Add sync-specific ports instead of teaching the controller about HTTP or PostgreSQL.

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

export interface CloudBootstrapManifest {
  eventId: number;
  activeDatasetId: string | null;
  datasets: DatasetMetadata[];
}

export interface CloudSyncPort {
  bootstrap(): Promise<CloudBootstrapManifest>;
  readKnownWords(): Promise<{ id: string; name: string; words: string[] } | null>;
  readDecisions(): Promise<WordDecision[]>;
  readPreferences(): Promise<PreferencesValue | null>;
  readQueues(): Promise<SessionQueueSnapshot[]>;
  readAnki(): Promise<{ config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null }>;
  pull(afterEventId: number, limit: number): Promise<SyncPullPage>;
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

Bootstrap returns only metadata/cursor. Large collections are read through paginated sync reads so bootstrap and pull never require a multi-megabyte JSON response.

`SyncOutboxRecord` stores identity, not large payloads. The engine materializes the latest local value at flush time. This naturally coalesces repeated preference/queue/known/Anki changes and prevents a large known-word set from being duplicated in the outbox.

Use stable dedupe keys: `decision:<word>`, `preferences`, `queue:<datasetId>`, `known`, `anki`, `dataset:<datasetId>`, and `activeDataset`. Each new local mutation replaces the pending record for that key with a new `mutationId`. An acknowledgement deletes the record only if the stored `mutationId` still matches the sent mutation.

## IndexedDB schema

Use a new production database name so stale pre-cloud browser data cannot be mistaken for a valid cache:

```ts
INDEXED_DB_NAME = "jiten-migaku-miner-local-first";
INDEXED_DB_VERSION = 4;
```

| Store | Key | Purpose |
| --- | --- | --- |
| `datasets` | `id` | Dataset metadata and cache readiness. |
| `entryChunks` | `[datasetId, chunkIndex]` | Cached dataset rows. |
| `knownWordSets` | `id` | Current known-word set. |
| `preferences` | `id = "current"` | Query/view/page preferences. |
| `meta` | `key` | Active dataset and active known-set ids. |
| `wordDecisions` | `normalizedWord` | Manual decisions. |
| `ankiSync` | `id = "current"` | Anki config/snapshot. |
| `queues` | `datasetId` | Durable per-dataset mining queues. |
| `workspace` | `id = "current"` | Device-local resume state. |
| `syncOutbox` | `dedupeKey` | Durable coalescing pending cloud mutations. |
| `syncMeta` | `id = "current"` | Device id, bootstrap marker, server cursor, last sync. |

Extend local dataset records:

```ts
interface DatasetRecord extends DatasetMetadata {
  ready: boolean;
  cacheState: "metadata-only" | "ready";
}
```

`list()` returns both cached and metadata-only datasets. `readChunks()` only succeeds for ready cached content. The active dataset must be cached before controller initialization. Other datasets download on demand when selected and stay cached afterward.

All local mutations that require cloud sync must write application state and the matching outbox record in the same IndexedDB transaction. Remote/bootstrap writes use a recording-disabled store and never create outbox entries.

## Workspace resume

Cloud preferences already persist query/view/page. Add a small device-local workspace record:

```ts
{
  id: "current",
  activeDatasetId,
  viewportStart,
  queueMode,
  updatedAt
}
```

Persist viewport with a 400 ms debounce. Query/view/page keep their existing cross-device persistence. Viewport stays local because screen size and virtual-window position are device-specific.

Controller construction gains `initialViewportStart` so the first query can open at the saved window without a second corrective query.

## PostgreSQL change feed

Add:

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
  accepted_event_id bigint REFERENCES sync_events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Keep events indefinitely in this release. Every canonical PostgreSQL mutation emits an event in the same transaction. The legacy `/api/store` path must dual-write events before local-first runtime is enabled so an already-open old tab cannot create invisible cloud changes.

Compact event forms:

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

Large resources are not duplicated in the event table. `known.replace`, `queue.replace`, `anki.replace`, and `full-reset` instruct the client to fetch canonical current state through paginated sync reads.

## Push flow

```text
1. read pending outbox records
2. materialize current local values
3. push to PostgreSQL
4. acknowledge only matching mutationIds
5. pull events after serverEventId
6. apply remote events to IndexedDB without recording mutations
7. refresh the in-memory controller from IndexedDB if user-visible state changed
8. advance serverEventId only after the pull page and controller refresh succeed
9. repeat until outbox empty and pull has no more pages
```

`sync.push` does not use the old global optimistic revision as a rejection gate. It applies mutations in server transaction order, records each `mutationId`, and returns prior success for duplicate retries.

Dataset uploads use a dedicated idempotent staged sync upload. The dataset mutation id is also the stable upload identity. Re-uploading an already-ready dataset id with identical metadata is a successful no-op; the same id with different metadata is an explicit conflict.

## Pull and conflict handling

The first release uses server acceptance order. A device flushes local pending changes before pulling. Therefore two online devices converge to the server's final accepted mutation, and an offline device publishes its durable pending edits before ingesting cloud changes. Echoing the device's own event is harmless and simplifies cursor advancement.

If a remote event references a dataset not cached locally, only metadata is updated. If the event activates that dataset, the engine downloads it before local activation.

Remote changes live in IndexedDB, but the controller keeps an in-memory state snapshot. After a pull page changes user-visible resources, the runtime calls a controller `refreshFromStorage()` method. That method re-reads local metadata/known words/decisions/preferences/Anki/queue. It reloads worker dataset content only if the active dataset changed; otherwise it reruns the current query against already-loaded worker data.

## Initial cloud bootstrap

A new device or browser with no completed bootstrap performs one remote hydration:

```text
open local-first DB
  -> cloud bootstrap manifest (event cursor + dataset library + active id)
  -> paginated reads for known words, decisions, preferences, queues, Anki
  -> write those resources through recording-disabled local stores
  -> upsert dataset metadata as metadata-only
  -> download and cache active dataset only
  -> activate locally
  -> write workspace active dataset
  -> set bootstrapComplete=true and serverEventId=<manifest cursor>
  -> initialize controller from IndexedDB
  -> immediately run background pull after manifest cursor
```

The manifest cursor anchors reconciliation. If cloud state changes while paginated bootstrap reads are running, the first pull replays every event after that cursor; repeated application is idempotent.

Do not set `bootstrapComplete` until state and the active dataset are durable locally. Failed bootstrap leaves it false and retries later.

The previous `jiten-migaku-miner` browser database stays untouched.

## Warm startup

When `bootstrapComplete` is true:

```text
open IndexedDB
  -> restore workspace/preferences/active cached dataset
  -> load dataset into worker
  -> first query / render
  -> mark local UI ready

then, without blocking readiness:
  -> syncEngine.syncNow()
```

Authentication/network/PostgreSQL errors do not block warm local use. Only local-storage failure prevents local persistence; in that case fall back to the existing server-first runtime.

## Status UI

Use exactly:

- `Loading local vocabulary…`
- `Saved locally`
- `Saved locally · Syncing…`
- `Synced`
- `Offline · changes saved locally`
- `Sync error · changes remain on this device`

Background sync failure never makes the whole study surface inert.

## Backup, restore, and clear

Complete backup/export remains cloud-backed:

1. flush local outbox;
2. verify outbox empty;
3. call existing remote complete export.

Complete restore remains online-only:

1. restore PostgreSQL atomically;
2. clear only the new local-first cache;
3. bootstrap from PostgreSQL;
4. reload runtime.

Legacy user-state restore continues through local IndexedDB. Its atomic `restoreUserState` transaction must also record sync intent for known words, preferences, Anki, and the decision replacement/difference so cloud state converges.

`Clear saved data` is intentionally online-only in the first release: clear PostgreSQL first, then clear the local-first database. If cloud clear fails, keep local data untouched.

## Rollout

1. Add PostgreSQL sync tables and dual-write events; deploy with current server-first UI unchanged.
2. Add `/api/sync` push/pull/bootstrap/paginated read operations; UI still server-first.
3. Add new IndexedDB schema, atomic outbox recording, workspace state, sync engine behind `NEXT_PUBLIC_LOCAL_FIRST_SYNC`.
4. Validate local production build and Vercel preview against a disposable preview database.
5. Enable local-first only after preview passes. First production visit performs one bootstrap; later visits warm-start locally.
6. Keep `RemoteAppStore` fallback and old browser DB through the stabilization window.
7. Remove rollout flag only in a later cleanup change.

## Performance targets

- Warm cached startup renders without waiting for `/api/store` or `/api/sync`.
- Existing 100k-row performance fixture reaches first query readiness within 500 ms on a normal desktop target environment.
- Decision/view/query interactions update locally without waiting for cloud acknowledgement.
- Repeated preference/queue/known/Anki and per-word decision changes coalesce in the outbox.
- Network failure leaves pending mutations durable and retryable after reload.

## Required tests

- New IndexedDB schema and upgrade tests.
- Atomic local-write + outbox tests for every synced resource.
- In-flight acknowledgement cannot erase a newer mutation.
- Sync push retry is idempotent.
- Push-first/pull-second convergence across two simulated devices.
- Remote apply does not create outbox work.
- Controller refreshes live state after remote apply without unnecessary dataset reload.
- Active remote-only dataset downloads before activation.
- Failed bootstrap does not mark completion.
- Warm startup works while sync endpoint is unavailable.
- Existing backup/restore behavior still passes.
- Second browser context receives first context's decision after sync.
- Performance timings distinguish `local_boot`, `worker_dataset_load`, `first_query_ready`, `sync_push`, and `sync_pull`.
