# Jiten → Migaku Miner

A local-first, offline-capable miner for Jiten vocabulary exports and Migaku known-word lists. Drop a Jiten CSV (and optionally a Migaku known-words TXT), then filter, sort, page, and mine cleanly isolated target sentences. Everything runs in your browser tab; no server, no account, no telemetry.

## Requirements

- Node.js 20 or newer (development, build, tests)
- Python 3 or newer (only for the `start-miner.bat` static file server)
- A browser with Web Workers, IndexedDB, and `:has()` CSS support (current Chrome, Edge, Firefox, Safari)

## Quick start (development)

```text
npm install
npm run dev
```

Open `http://127.0.0.1:8920/`.

## Quick start (end user, Windows)

Run `start-miner.bat`. It verifies `npm` and `python` are installed, builds the production bundle (`npm run build`), opens `http://127.0.0.1:8920/`, and serves the `dist` directory on loopback. If the build fails, the launcher stops before opening the browser.

Manual equivalent on any platform:

```text
npm run build
python -m http.server 8920 --bind 127.0.0.1 --directory dist
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite development server on `127.0.0.1:8920` |
| `npm run build` | Strict typecheck plus production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` only |
| `npm test` | Vitest unit/repository suites (domain, storage, worker, app, UI) |
| `npm run test:e2e` | Playwright browser suites (`tests/e2e`) |
| `npm run check` | Typecheck + full unit suite + production build |

Playwright browsers: run `npx playwright install chromium` once after installing dependencies.

## Compatibility

`index.html` is the canonical application. The legacy path `/jiten-migaku-miner-v1.html` now serves a small redirect shell that immediately moves to `index.html` (with a normal link fallback), so old bookmarks keep working.

## Storage and privacy

- All imported data stays in the browser. Network access is limited to optional same-origin folder discovery (`WORDS TO MINE/*.csv`, `MIGAKU KNOWN WORDS/*.txt`) when the page is served over HTTP(S).
- Datasets, known-word sets, and preferences are stored in IndexedDB (database `jiten-migaku-miner`, versioned schema). If IndexedDB is unavailable, the app falls back to an in-memory store and shows a visible warning that data will be lost on reload.
- "Clear saved data…" (import panel) asks for confirmation, then removes all stored datasets, known-word sets, preferences, legacy `jitenMiner.v1` / `jitenMiner.page` keys, and the migration marker from this browser.
- Migration from the old single-file app is automatic: on first launch, `jitenMiner.v1` and `jitenMiner.page` are read (never deleted), migrated into versioned IndexedDB records, and a `jitenMiner.migration` marker is written. If migration fails, legacy keys are preserved and a warning is shown.

## Architecture

```text
src/domain/    Pure types, CSV/known-word parsing, text helpers, query math. No browser APIs.
src/worker/    Typed message protocol (version 1), query engine, module worker entry point.
               Parses, filters, sorts, and pages datasets up to 100,000 rows; never touches storage.
src/storage/   Storage ports (DatasetStore, KnownWordStore, PreferencesStore) with memory and
               IndexedDB implementations plus the legacy localStorage reader.
src/platform/  Browser file and same-origin folder source adapters.
src/app/       Application state, worker client, controller orchestration, query controller
               (search debounce + viewport windows), legacy migration.
src/ui/        Typed DOM map, controls, renderer, Migaku highlight adapter, virtual list.
src/styles/    Design tokens, layout, and entry styles.
src/main.ts    Bootstrap: wires storage, worker, controller, UI, and folder discovery.
```

Key behaviors:

- Import work (CSV parsing, filtering, sorting) runs in a Web Worker through a versioned protocol (`WORKER_PROTOCOL_VERSION = 1`) with request IDs and cancellation; persistence stays on the app side of the boundary.
- Imports are staged and verified before activation. A malformed replacement import can never remove or replace a working dataset.
- "All" results are rendered through a windowed virtual list (100-row windows, at most 120 mounted entry nodes), so a 100,000-row dataset never creates 100,000 DOM nodes. The worker caches filtered/sorted indexes for all-results queries and invalidates them when the dataset, known words, or any filter/sort field changes.
- Sentence highlighting reproduces the Migaku-friendly DOM behavior (`target-highlight`, `th-wrap` ranges, furigana-aware, pill mode) through a MutationObserver-backed adapter that re-marks after external DOM changes.

## Testing

- `tests/domain`, `tests/storage`, `tests/worker`, `tests/app`, `tests/ui` — Vitest suites. UI adapter/list tests run under `happy-dom`; IndexedDB tests use `fake-indexeddb`.
- `tests/e2e/miner.spec.ts` — Playwright workflows: import, filters, toggles, pagination, known words, reload restoration, clear-data, folder auto-load.
- `tests/e2e/performance.spec.ts` — generates a deterministic 100,000-row CSV via `node tests/fixtures/generate-100k.mjs` into a temp directory, imports it, and asserts bounded DOM while scrolling.
- `tests/e2e/compatibility.spec.ts` — legacy-path redirect and root launcher behavior.

## Adding adapters

- **New data source:** implement `FileSource { name; text() }` (see `src/platform/file-source.ts`) and pass it to `controller.importJiten` / `controller.importKnown`. Folder and future remote sources plug in the same way; keep discovery failure non-destructive.
- **New storage backend:** implement the ports in `src/storage/contracts.ts` (`DatasetStore`, `KnownWordStore`, `PreferencesStore`, `AppStore`) and construct the controller with `store` or `indexedDbStoreFactory`. The controller already handles memory fallback, staging, activation, and rollback generically.
