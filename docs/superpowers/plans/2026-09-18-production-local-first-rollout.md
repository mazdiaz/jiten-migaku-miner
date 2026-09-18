# Production Local-First Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local-first storage the default, make schema drift fail before deployment, and prove CSV imports remain usable from IndexedDB while cloud sync is unavailable.

**Architecture:** A single server-safe storage-mode helper will interpret `NEXT_PUBLIC_LOCAL_FIRST_SYNC`, with only `"0"` selecting retained server-first fallback. Local-first boot will publish distinct cold and warm status copy and expose a non-secret runtime diagnostic. Migration discovery/checksum logic will be shared by migration and read-only verification commands; Vercel will verify schema without mutating it.

**Tech Stack:** Next.js 16, React 19, TypeScript, IndexedDB, PostgreSQL, `postgres`, Vitest, Playwright, Biome, GitHub Actions, Vercel.

**Spec:** `docs/superpowers/specs/2026-09-17-local-first-sync-design.md`

## Global Constraints

- `NEXT_PUBLIC_LOCAL_FIRST_SYNC` unset and `"1"` mean local-first; only `"0"` means server-first fallback.
- Local-first CSV imports become usable after IndexedDB commit; PostgreSQL sync is background work.
- Warm startup must not wait for `/api/sync` and must not call `/api/store`.
- `db:verify` is read-only; `db:migrate` remains idempotent and advisory-lock serialized.
- Preview deployments must not migrate production databases.
- No credential values, database URLs, or secrets may enter logs, tests, PR text, or diagnostics.
- Existing server-first compatibility tests run with `NEXT_PUBLIC_LOCAL_FIRST_SYNC=0`.

---

### Task 1: Storage Mode and Startup Diagnostics

**Files:**
- Create: `src/config/storage-mode.ts`
- Create: `tests/config/storage-mode.test.ts`
- Modify: `src/components/study-runtime.ts`
- Modify: `src/components/miner.tsx`

**Interfaces:**
- Produces `isLocalFirstEnabled(value?: string): boolean` and `storageModeLabel(value?: string): string`.
- Publishes `window.__jitenStorageMode` for diagnostics without including environment values.

- [ ] **Step 1: Write failing mode tests**

  Test `isLocalFirstEnabled(undefined)`, `isLocalFirstEnabled("1")`, and `isLocalFirstEnabled("0")`; assert labels are `local-first` and `server-first fallback`.

- [ ] **Step 2: Run focused test and confirm failure**

  Run `npx vitest run tests/config/storage-mode.test.ts`.
  Expected: module/function-not-found failure.

- [ ] **Step 3: Implement helper**

  Use `value !== "0"`; keep raw `process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC` access in this module only.

- [ ] **Step 4: Run focused test and confirm pass**

  Run `npx vitest run tests/config/storage-mode.test.ts`.

- [ ] **Step 5: Add failing startup assertions**

  Assert local-first startup publishes a non-secret mode diagnostic and cold/warm messages use `Setting up local cache…` and `Loading local vocabulary…`.

- [ ] **Step 6: Implement diagnostics and status transitions**

  Replace direct flag comparison in `study-runtime.ts`; initialize `Miner` copy from helper; set mode on `window` and log it outside test environments; preserve remote copy only for explicit fallback.

- [ ] **Step 7: Run focused runtime tests**

  Run `npx vitest run tests/config/storage-mode.test.ts tests/sync/engine.test.ts tests/app/controller.test.ts`.

### Task 2: Shared Migration Verification

**Files:**
- Create: `src/server/db/migrations.ts`
- Create: `scripts/db-verify.ts`
- Create: `tests/server/db-migrations.test.ts`
- Modify: `scripts/db-migrate.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `loadMigrations()`, `migrationChecksum(source)`, and `verifyMigrationLedger(expected, applied)`.
- `npm run db:verify` reads `miner_migrations`, compares every numbered file and checksum, prints actionable failures, and exits non-zero without writes.

- [ ] **Step 1: Write pure verification tests**

  Cover complete ledger, missing `0002_local_first_sync.sql`, checksum mismatch, and unexpected ledger entries.

- [ ] **Step 2: Run focused tests and confirm failure**

  Run `npx vitest run tests/server/db-migrations.test.ts`.
  Expected: missing helper failure.

- [ ] **Step 3: Implement shared loader/checksum/verifier**

  Load sorted `/migrations/` files matching `/^\d+.*\.sql$/`, hash UTF-8 source with SHA-256, and return structured missing/mismatch/unexpected results.

- [ ] **Step 4: Run focused tests and confirm pass**

  Run `npx vitest run tests/server/db-migrations.test.ts`.

- [ ] **Step 5: Refactor `db:migrate` to shared logic**

  Preserve `pg_advisory_xact_lock(873466220)`, ledger creation, idempotence, and refusal when an applied checksum changes.

- [ ] **Step 6: Implement read-only CLI and package script**

  Query ledger only; report `Database schema is current.` on success; report missing/mismatched/unexpected migrations and `Run: npm run db:migrate` on failure; do not call `CREATE`, `INSERT`, `UPDATE`, or `DELETE`.

- [ ] **Step 7: Verify CLI behavior against disposable/local configured database**

  Run `npm run db:verify`; record whether configured database is current without printing connection details. Expected current repository database result: failure because `0002_local_first_sync.sql` is absent.

### Task 3: Deployment Verification and Documentation

**Files:**
- Create: `vercel.json`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add deployment verification configuration**

  Configure Vercel build command as `npm run db:verify && npm run build`; do not configure automatic migration.

- [ ] **Step 2: Add CI coverage for default and fallback builds**

  Keep compatibility E2E/build job at `NEXT_PUBLIC_LOCAL_FIRST_SYNC=0`; run dedicated local-first build/tests with flag unset or `1` and assert mode helper behavior.

- [ ] **Step 3: Update rollout documentation**

  Document backup/restore point, production target confirmation, explicit `db:migrate`, `db:verify`, deployment, smoke tests, rollback value `0`, preview DB separation, and current observed missing `0002` state.

- [ ] **Step 4: Run JSON/YAML/lint checks**

  Run `npm run lint` after implementation and inspect `git diff --check`.

### Task 4: Local-First E2E Durability Regression Tests

**Files:**
- Modify: `tests/e2e/local-first-sync.spec.ts`
- Modify: `tests/e2e/local-first-performance.spec.ts`
- Modify: `tests/e2e/fixtures.ts` only if test setup needs a local-first-safe reset
- Modify: `tests/support/environment.ts` only if explicit mode propagation needs correction

- [ ] **Step 1: Add blocked CSV import test**

  Complete initial bootstrap, block `/api/sync`, import `tests/fixtures/jiten-small.csv`, assert three entries and usable controls before release, assert no database-error or PostgreSQL-success copy, then release and assert `Synced`.

- [ ] **Step 2: Run local-first E2E and confirm new test exposes missing behavior**

  Run `NEXT_PUBLIC_LOCAL_FIRST_SYNC=1 npm run test:e2e -- tests/e2e/local-first-sync.spec.ts` using the repository's platform-compatible environment invocation.

- [ ] **Step 3: Add 503/reload durability test**

  Fulfill `/api/sync` with 503, import locally, assert `Sync error · changes remain on this device`, reload while failure persists, and assert dataset remains visible.

- [ ] **Step 4: Add no-`/api/store` assertion**

  Count page requests during normal local-first boot, decision, and import; assert zero legacy store calls.

- [ ] **Step 5: Strengthen warm-start ordering/timing**

  Keep `/api/sync` pending, assert request seen and still blocked before study UI readiness, assert cached entries appear, assert `first_query_ready < 500`, then release and assert eventual `Synced`.

- [ ] **Step 6: Run focused E2E suite**

  Run `npm run test:e2e -- tests/e2e/local-first-sync.spec.ts tests/e2e/local-first-performance.spec.ts --project=chromium` with local-first enabled.

### Task 5: Full Verification and PR

**Files:**
- Modify any implementation/test files required by verification failures only.

- [ ] **Step 1: Run required checks**

  Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:db`, and `npm run test:e2e`.

- [ ] **Step 2: Review changes and production evidence**

  Run `git status --short`, `git diff --check`, `git diff`, and `git log --oneline -10`; ensure no secrets or unrelated files appear.

- [ ] **Step 3: Commit implementation**

  Commit with a concise conventional message covering default local-first rollout and schema verification.

- [ ] **Step 4: Push branch and open PR**

  Push `fix/production-local-first-rollout` and open a PR against `main`; do not merge.

- [ ] **Step 5: Report exact rollout state**

  Summarize production SHA, observed migration gap, `/api/store` root cause, tests, required Vercel actions, and remaining inability to independently inspect Vercel env/logs unless provider access is supplied.
