# Scalable Local-First Miner Design

- Date: 2026-09-04
- Scope: architectural foundation for future feature growth, datasets up to 100,000 rows, and eventual remote sync
- Compatibility target: preserve current importer, filters, highlighting, pagination, auto-loading, and persistence behavior

## Context

Repository currently ships as one 1,559-line HTML file. Inline CSS, CSV parsing, domain rules, rendering, Migaku DOM integration, persistence, folder discovery, and event wiring share one script boundary. There is no package manifest, build pipeline, automated test suite, or versioned application data schema.

Recent changes are concentrated in the same file, especially around Migaku highlighting. That behavior is valuable but difficult to change safely when unrelated concerns share state and DOM code. The revamp will introduce boundaries without replacing working behavior with a framework or backend.

## Goals

1. Make new features additive by separating domain, worker, storage, platform, UI, and bootstrap concerns.
2. Keep the main thread responsive while importing, filtering, sorting, and paginating datasets up to 100,000 rows.
3. Preserve current user-visible behavior during migration.
4. Persist imported data and preferences safely in a versioned local store.
5. Leave explicit interfaces for future remote sources and synchronization.
6. Establish repeatable type, unit, browser, and performance checks.

## Non-Goals

1. Accounts, authentication, server storage, multi-user collaboration, or remote synchronization in first phase.
2. Replacing Migaku's DOM/highlighting model.
3. Adding unrelated vocabulary providers before the source and storage interfaces are stable.
4. Rewriting user-facing workflows solely to introduce a framework.

## Chosen Approach

Use a modular TypeScript browser application with a small build boundary. Use Vite for development and production bundling, Vitest for domain and repository tests, and Playwright for browser workflows. Keep runtime deployment static and local-first.

The app remains framework-free at first. This avoids adding a component runtime to a DOM integration that already depends on MutationObserver and Migaku-generated markup. UI modules can later be replaced or wrapped by a framework without changing domain, worker, or storage contracts.

## Module Boundaries

Planned source layout:

```text
src/
  app/        bootstrap, application state, event orchestration
  domain/     types, parsing, normalization, query rules, highlight segments
  worker/     worker entry point and request/response protocol
  storage/    repository interfaces, IndexedDB implementation, migrations
  platform/   File APIs, folder discovery, environment capabilities
  ui/         controls, entry rendering, pagination, highlight adapter
  styles/     application stylesheets and responsive rules
  main.ts     browser entry point
index.html   canonical document shell
tests/       domain, worker, storage, and browser test support
```

Dependency direction is one-way:

```text
main -> app -> {domain, worker, storage, platform, ui}
worker -> domain
ui -> domain types
storage/platform -> domain types
domain -> no browser, DOM, storage, network, or global application state
```

Domain functions receive values and return values. They do not read `localStorage`, access `document`, call `fetch`, or mutate shared application state. Worker, storage, and platform adapters expose narrow interfaces so their implementations can change independently.

## Runtime Data Flow

### Import

1. UI receives a selected or dropped file, or platform adapter discovers a same-origin local folder file.
2. App sends source content and a request ID to the worker.
3. Worker parses CSV/TXT, validates required fields, normalizes entries, and reports diagnostics.
4. App asks `DatasetStore` to persist the complete staged dataset.
5. On successful persistence, app activates the new dataset and requests its first query page.
6. UI receives one page of entries and aggregate stats, then renders it.

Parsing and normalization happen before activation. A malformed replacement import cannot remove or replace a working dataset.

### Query

1. Controls produce an immutable query snapshot.
2. App sends query snapshot and request ID to worker.
3. Worker applies filtering, stable sorting, and pagination against the active normalized dataset.
4. Worker returns only visible entries, page metadata, counts, and diagnostics.
5. App accepts response only when request ID matches latest query.
6. UI replaces visible result content and asks highlight adapter to reconcile Migaku markup.

Search input is briefly debounced. Other controls issue immediate queries. Worker loops check cancellation between chunks so a newer query can supersede a long-running one.

## Domain Model

`Entry` is normalized once at import:

```text
Entry {
  id: string
  originalIndex: number
  word: string
  normalizedWord: string
  occurrences: number
  sentenceRaw: string
  hasSentence: boolean
  definitions: string
  furiganaRuns: FuriganaRun[]
}
```

Known-word status is derived from a separately stored `KnownWordSet`; it is not persisted as duplicated truth. The worker may materialize a transient `known` flag for query results.

`Dataset` metadata contains:

```text
Dataset {
  id: string
  name: string
  sourceType: "file" | "folder" | "future-remote"
  sourceName: string
  headers: string[]
  entryCount: number
  createdAt: string
  updatedAt: string
  schemaVersion: number
}
```

Query state contains search text, known/kana/sentence filters, minimum occurrences, sort mode, page size, and page number. View state contains furigana, highlight, pill highlight, and definitions toggles. These states are stored separately from dataset records.

## Worker Contract

Worker protocol uses discriminated messages with a protocol version and request ID. Initial operations are:

- `import`: parse source, return staged dataset and diagnostics.
- `load`: load normalized dataset chunks into worker memory.
- `query`: return visible entries and aggregate page stats.
- `dispose`: release active dataset resources.
- `cancel`: stop work for a request when possible.

Every response includes request ID, protocol version, operation, and either result or a typed error payload. Worker never updates IndexedDB directly; persistence remains an app/storage responsibility. This keeps storage transactions observable and testable and allows a future server-backed worker adapter.

For 100,000 rows, worker keeps normalized entries and cached lowercase search fields in memory. It may cache stable sort index arrays keyed by sort mode. Responses contain page entries, not the complete dataset.

## Persistence And Migration

`DatasetStore` is the first storage port. It supports staging, activation, listing, loading chunks, deleting, and reading the active dataset. Separate ports handle known-word sets and preferences.

IndexedDB is the default implementation. Dataset metadata, known-word sets, preferences, and entries use separate object stores. Entries are written in bounded chunks to avoid one oversized transaction. Store names and records carry schema versions so migrations can be explicit and testable.

The first migration reads existing `jitenMiner.v1` and `jitenMiner.page` keys. It writes equivalent dataset, known-word, and preference records, verifies the writes, and only then marks migration complete. Legacy keys remain untouched until verification succeeds. Migration failure leaves legacy data available and reports a recoverable warning.

If IndexedDB is unavailable, the app uses an in-memory store and shows that imported data will be lost on reload. It must not claim persistence succeeded. A clear-data action removes stored datasets, known-word sets, preferences, and migration markers after confirmation.

The first UI continues to show one active dataset, while the repository can retain multiple datasets. A future dataset library can add listing and switching without changing the data model.

## UI And Migaku Compatibility

The current controls and visible workflows remain the compatibility surface. UI modules own DOM creation and event binding, while app state owns values and transitions. Renderer receives query results and view state rather than reading domain internals.

Highlight behavior moves into a dedicated adapter. It preserves current target extraction, furigana placement, range wrapping, unwrapping, and fallback behavior. The adapter observes only result content, batches reconciliation with `requestAnimationFrame`, and pauses observation while it applies its own wrappers to avoid mutation loops.

`index.html` becomes canonical. `jiten-migaku-miner-v1.html` remains a compatibility entry point to protect bookmarks and existing launcher links. `start-miner.bat` remains the supported local launcher and serves the built app.

## Error Handling And Safety

- Import, worker, storage, and folder discovery errors use separate typed categories and actionable UI messages.
- New imports are validated and staged before activation.
- Failed imports leave current dataset, filters, and visible results intact.
- Worker failure rejects active work, displays an error, restarts the worker, and permits retry.
- Stale worker responses are discarded by request ID.
- Failed automatic discovery cannot clear manually loaded or persisted data.
- Local data never leaves the browser by default. Network access is limited to same-origin folder discovery until an explicit future adapter is enabled.

## Testing And Delivery

Package scripts:

```text
npm run dev
npm run build
npm run typecheck
npm run test
npm run test:watch
npm run test:e2e
npm run check
```

Unit tests cover quoted and multiline CSV, BOM handling, missing required columns, malformed rows, furigana, highlight segments, known-word matching, filters, stable sort order, and pagination edge cases. Storage tests cover chunk writes, activation atomicity, clear-data behavior, and legacy migration. Worker tests cover protocol validation, request IDs, cancellation, and stale results.

Playwright workflows cover Jiten import, optional known words, every current toggle, pagination and page restoration, auto-loading over HTTP, highlight reconciliation after DOM mutation, responsive layout, and clear-data behavior. A deterministic 100,000-row fixture checks import and query behavior and guards against unbounded result DOM.

CI runs `npm run check`, production build, and browser smoke tests. Static output from the build is deployable to any static host or local HTTP server.

## Rollout

1. Establish TypeScript/Vite testable shell while retaining current HTML behavior as baseline.
2. Extract and test pure domain functions without changing output.
3. Add worker protocol and move import/query work off main thread.
4. Add IndexedDB repositories and verified legacy migration.
5. Extract UI and highlight adapter; compare browser workflows with baseline.
6. Switch launcher and compatibility entry point to built app.
7. Add CI and performance fixture before removing obsolete inline implementation.

Each step must leave current manual import and launcher workflows usable. No step deletes legacy persisted data before its replacement is verified.

## Acceptance Criteria

1. Existing supported workflows produce equivalent visible results and controls.
2. A 100,000-row import completes without blocking the main thread with full-dataset rendering work.
3. Filtering, sorting, and pagination return correct results while only visible rows are in the DOM.
4. Reload restores active dataset, known-word data, preferences, and page through versioned IndexedDB records.
5. Existing `jitenMiner.v1` localStorage data migrates without data loss or silent reset.
6. Domain, worker, storage, browser, and performance checks run through documented scripts.
7. Future remote source/storage adapters can be added behind interfaces without changing domain rules.

## Risks And Trade-offs

- TypeScript and build tooling add setup requirements compared with opening one HTML file. The launcher and setup documentation must make this explicit and deterministic.
- IndexedDB and worker boundaries add asynchronous failure modes. Typed protocol errors, migration tests, and retry behavior contain that complexity.
- Windowed rendering makes `All` logically complete but physically incremental. This is required to keep large datasets usable.
- Migaku markup can change independently. Keeping highlight logic isolated and covered by DOM-level tests limits blast radius.
- The first phase intentionally does not implement remote sync. Ports are defined now, but server concerns remain out of scope until local behavior is stable.
