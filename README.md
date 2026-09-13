# Jiten → Migaku Miner

A local-first, offline-capable miner for Jiten vocabulary exports and Migaku known-word lists. Drop a Jiten CSV (and optionally a Migaku known-words TXT), then filter, sort, page, and mine cleanly isolated target sentences. Review unreviewed words in a focused one-card mode, queue words to mine, and optionally derive `Known`/`Mined` decisions from your Anki collection. Everything runs in your browser tab; no server, no account, no telemetry.

## Requirements

- Node.js 22.12 or newer (development, build, tests, and the bundled loopback file server)
- A browser with Web Workers, IndexedDB, and `:has()` CSS support (current Chrome, Edge, Firefox, Safari). The CSS Custom Highlight API is used when available for sentence highlighting; unsupported browsers fall back to wrapper spans.
- Optional: Anki Desktop with AnkiConnect listening on `http://127.0.0.1:8765` (for Anki sync only; the app works fully without it)

## Quick start (development)

```text
npm install
npm run dev
```

Open `http://127.0.0.1:8920/`.

## Quick start (end user, Windows)

Run `start-miner.bat`. It verifies `npm` is installed, builds the production bundle (`npm run build`), serves the repository root on loopback with the bundled Node file server (`npm run serve:root`), and opens `http://127.0.0.1:8920/dist/`. The server provides the directory listings and `Last-Modified` headers the optional `WORDS TO MINE` / `MIGAKU KNOWN WORDS` folder discovery needs, so vocabulary files work without copying them anywhere; the built app in `dist/` stays free of them. Browser access is loopback only. If the build fails, the launcher stops before opening the browser.

Manual equivalent on any platform:

```text
npm run build
npm run serve:root -- --port 8920
```

Then open `http://127.0.0.1:8920/dist/`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite development server on `127.0.0.1:8920` |
| `npm run build` | Strict typecheck plus production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` only |
| `npm test` | Vitest unit/repository suites (domain, storage, worker, app, UI) |
| `npm run test:e2e` | Playwright browser suites (`tests/e2e`) |
| `npm run test:e2e:prod` | Playwright production-serving suite against the real build output |
| `npm run lint` | Biome check over `src` and `tests` |
| `npm run check` | Typecheck + full unit suite + production build |

Playwright browsers: run `npx playwright install chromium firefox webkit` once after installing dependencies.

## Compatibility

`index.html` is the canonical application. The legacy path `/jiten-migaku-miner-v1.html` now serves a small redirect shell that immediately moves to `index.html` (with a normal link fallback), so old bookmarks keep working.

## Word decisions and review

- Manual decisions (`Known`, `Mined`, `Skip`, `Later`) are stored per word and always win over Anki-derived statuses. The Migaku known-word list stays an independent knownness source.
- Review mode walks the unreviewed words for the current filters one card at a time (keyboard: K/M/S/L, Z undo, Esc exit). It reuses the normal results surface so Migaku's in-page parsing and shortcuts keep working.
- A mining queue collects words to mine; queue mode shows just those words. Applying an Anki sync removes queued words it classifies, unless a manual decision protects them.
- Tracked vocabulary coverage summarizes how much of the dataset is known (Migaku list, manual `Known`, or Anki `Known`).

## Anki sync (read-only)

Derives `Known`/`Mined` from an Anki Desktop collection through AnkiConnect (API v6, `http://127.0.0.1:8765`). The adapter is structurally read-only: it exposes only `requestPermission`, `deckNames`, `modelNames`, `modelFieldNames`, `findCards`, and `cardsInfo` — no add/edit/suspend/reschedule operations exist anywhere in the codebase.

- Cards that are New and not suspended map to `Mined`; every other selected card maps to `Known`. Duplicate words merge with `Known` winning.
- Configure a deck scope (one deck or all decks for a note type), note type, and target word field. Sync shows a preview (cards scanned, matched words, protected manual decisions, queue removals) before anything is stored; Apply replaces the stored snapshot atomically and refreshes query/coverage once.
- The last applied snapshot persists (IndexedDB + backups), so the app stays useful while Anki is closed. Manual decisions always override; a word absent from the snapshot simply has no Anki status.
- "Clear Anki sync data…" (Settings → danger zone) removes the config and snapshot only.

## Storage and privacy

- All imported data stays in the browser. The only network access beyond the page origin is optional same-origin folder discovery (`/WORDS TO MINE/*.csv`, `/MIGAKU KNOWN WORDS/*.txt` at the server root) and, when you explicitly run it, read-only calls to local AnkiConnect on `127.0.0.1:8765`. Discovery never reads anything outside the serving root; `dist/` contains no vocabulary files.
- Datasets, known-word sets, word decisions, preferences, and Anki sync config/snapshot are stored in IndexedDB (database `jiten-migaku-miner`, schema version 3). If IndexedDB is unavailable, the app falls back to an in-memory store (transferring known words, decisions, preferences, and Anki state) and shows a visible warning that data will be lost on reload.
- Backup export produces a version 2 JSON document (known words, decisions, preferences, Anki sync state); the parser still accepts version 1 backups. Restores are atomic where the store supports it, with rollback otherwise.
- "Clear saved data…" (import panel) asks for confirmation, then removes all stored datasets, known-word sets, decisions, preferences, Anki sync data, legacy `jitenMiner.v1` / `jitenMiner.page` keys, and the migration marker from this browser.
- Migration from the old single-file app is automatic: on first launch, `jitenMiner.v1` and `jitenMiner.page` are read (never deleted), migrated into versioned IndexedDB records, and a `jitenMiner.migration` marker is written. If migration fails, legacy keys are preserved and a warning is shown.

## Architecture

```text
src/domain/    Pure types, CSV/known-word parsing, text helpers, query/coverage math,
               Anki status rules and decision resolution. No browser APIs.
src/worker/    Typed message protocol (version 3), query engine, module worker entry point.
               Parses, filters, sorts, pages, and computes coverage for datasets up to
               100,000 rows; never touches storage.
src/storage/   Storage ports (DatasetStore, KnownWordStore, WordDecisionStore,
               PreferencesStore, AnkiSyncStore, AppStore) with memory and IndexedDB
               implementations plus the legacy localStorage reader.
src/platform/  Browser file and same-origin folder source adapters; strict read-only
               AnkiConnect adapter.
src/app/       Application state, worker client, controller orchestration, query controller
               (search debounce + viewport windows), legacy migration, and feature services
               (decisions, review session, mining queue, coverage, Anki sync, backups).
src/ui/        Typed DOM map, controls, renderer with per-feature views, virtual list,
               Migaku highlight adapter (CSS Custom Highlight API with legacy wrapper
               fallback and parsed-token baseline normalization).
src/styles/    Design tokens, layout, entry styles, and highlight styles.
src/main.ts    Bootstrap: wires storage, worker, controller, UI, and folder discovery.
```

Key behaviors:

- Import work (CSV parsing, filtering, sorting, coverage) runs in a Web Worker through a versioned protocol (`WORKER_PROTOCOL_VERSION = 3`) with request IDs and cancellation; Anki statuses travel through the same protocol so query, coverage, and preview matching resolve one consistent decision layer. Persistence stays on the app side of the boundary.
- Imports are staged and verified before activation. A malformed replacement import can never remove or replace a working dataset.
- "All" results are rendered through a windowed virtual list (100-row windows, at most 120 mounted entry nodes), so a 100,000-row dataset never creates 100,000 DOM nodes. The worker caches filtered/sorted indexes for all-results queries and invalidates them when the dataset, known words, or any filter/sort field changes.
- Effective decisions resolve as manual → Anki → unreviewed, and entries show their source (`Known · Anki` badges for Anki-derived statuses). Anki `Known` hidden under a manual override never leaks into knownness.
- Sentence highlighting paints target ranges through the CSS Custom Highlight API without inserting wrapper nodes into Migaku-parsed DOM; a MutationObserver-backed adapter re-marks after external DOM changes, and browsers without the API fall back to the legacy `th-wrap` spans.
- Anki sync scans are read-only and build a full candidate in memory before the preview; Apply commits one snapshot atomically under the user-state lock, and failed scans/applies leave the previous snapshot intact.

## Testing

- `tests/domain`, `tests/storage`, `tests/worker`, `tests/app`, `tests/ui` — Vitest suites. UI adapter/list tests run under `happy-dom`; IndexedDB tests use `fake-indexeddb`.
- `tests/e2e/miner.spec.ts` — import, filters, toggles, pagination, known words, reload restoration, clear-data, folder auto-load, non-mutating highlight behavior.
- `tests/e2e/review-mode.spec.ts` — one-card review workflow, keyboard decisions, shared results surface, shortcut scoping.
- `tests/e2e/anki-sync.spec.ts` — AnkiConnect mocked over HTTP: configure, preview, apply, read-only action enforcement, connection-failure behavior.
- `tests/e2e/backup-restore.spec.ts`, `tests/e2e/display-controls.spec.ts`, `tests/e2e/migaku-baseline.spec.ts` — backup round-trip, reading display preferences, and Migaku token baseline normalization.
- `tests/e2e/performance.spec.ts` — generates a deterministic 100,000-row CSV via `node tests/fixtures/generate-100k.mjs` into a temp directory, imports it, and asserts bounded DOM while scrolling.
- `tests/e2e/compatibility.spec.ts` — legacy-path redirect and root launcher behavior.
- `tests/e2e/production.spec.ts` — production-serving smoke suite (`npm run test:e2e:prod`): boots the real build output, verifies assets, and asserts vocabulary folders are neither bundled into `dist/` nor fetched from it (discovery resolves against the repository root).

## Adding adapters

- **New data source:** implement `FileSource { name; text() }` (see `src/platform/file-source.ts`) and pass it to `controller.importJiten` / `controller.importKnown`. Folder and future remote sources plug in the same way; keep discovery failure non-destructive.
- **New storage backend:** implement the ports in `src/storage/contracts.ts` (`DatasetStore`, `KnownWordStore`, `WordDecisionStore`, `PreferencesStore`, `AnkiSyncStore`, `AppStore`) and construct the controller with `store` or `indexedDbStoreFactory`. The controller already handles memory fallback, staging, activation, and rollback generically.
