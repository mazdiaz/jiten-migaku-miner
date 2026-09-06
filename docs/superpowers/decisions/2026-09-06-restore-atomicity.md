# Decision: Restore-atomicity (crash consistency of `restoreBackup`)

Date: 2026-09-06
Task: Wave 1 Task 6 (`.superpowers/sdd/2026-09-06-phase1-protect-user-data/task-6-brief.md`)
Status: **Decision made — Option 1 chosen, implementation deferred to Wave 2**

## Context

Audit source (Phase 1 item 5, Additional risk), verbatim:

> "restore uses separate category writes. Process termination between commits bypasses application rollback and can leave mixed state. This is a crash-consistency risk, not a reproduced browser crash."

Task 3 (commit `e79b74e`) added `userStateLock` (`src/app/controller.ts:114`, `withUserStateLock` at line 863). Restore, clear, and all other user-state mutations are now serialized in-process, eliminating the interleaving corruption class. The remaining exposure is **crash consistency only**: durable state can end up mixed if the process dies mid-restore.

### Actual write sequence in `restoreBackup` (`src/app/controller.ts:464-524`)

Under `userStateLock`, after a 3-read snapshot (controller.ts:480-484), restore performs **three separate durable write phases**, each one or more independent IndexedDB transactions (each store method even opens and closes its own connection via `withDatabase`, `src/storage/indexed-db.ts:139-149`):

| # | Phase | Call site | IndexedDB transaction(s) |
|---|-------|-----------|--------------------------|
| 1 | Known words | `writeRestoredKnownWords` (controller.ts:526-538) | `remove(active.id)` or `save(knownId, ...)` — one tx over `knownWordSets` + `meta` (indexed-db.ts:549-566, 594-610). Note the `backup.knownWords === null` branch performs a **read** (`getActive`) before the write. |
| 2 | Decisions | `replaceAll(backup.wordDecisions)` (controller.ts:491) | One tx over `wordDecisions`: clear + all puts, atomic per store (indexed-db.ts:761-784). |
| 3 | Preferences | `writeRestoredPreferences` (controller.ts:540-547) | One tx over `preferences` (indexed-db.ts:656-678). |

Store layout (`src/storage/indexed-db.ts:16-28`): all six stores (`datasets`, `entryChunks`, `knownWordSets`, `preferences`, `meta`, `wordDecisions`) live in the **single database** `jiten-migaku-miner` (`INDEXED_DB_NAME`), version 2. `clearAll` (indexed-db.ts:817-841) already proves the multi-store-single-transaction pattern in this codebase.

Crash windows: process death between phase 1 and 2 leaves new known words + old decisions + old preferences; between 2 and 3 leaves new known + new decisions + old preferences. The application-level rollback (`rollbackUserState`, controller.ts:549-595) never runs — it lives in the same process that died. Mixed state persists until the next successful restore or `clearSavedData`.

## Options analysis

### Option 1: IndexedDB single-transaction restore

Add optional `AppStore.restoreUserState?(snapshot)` applying all three categories in one `readwrite` transaction spanning `knownWordSets` + `meta` + `wordDecisions` + `preferences`. IndexedDB transaction semantics: either every write in the transaction commits or none do, so process death at any point leaves the pre-restore state intact — the exact property rollback tries to approximate.

- **Cost:** contracts type + optional method (~20 lines), IndexedDB implementation modeled on `clearAll`/`replaceAll` (~70), memory-store implementation (trivial — memory has no crash exposure; ~15), controller fast path with fallback to the existing per-category path when the method is absent, plus `storageOperation` retry interplay (~35). Implementation alone ≈ 140 lines — borderline. **With the tests this repo's discipline requires** (fake-indexeddb atomicity test, memory contract test, controller fallback test, restore-path coverage in `tests/app/controller.test.ts` + `tests/storage/*`): realistically **250-400 diff lines**.
- **Risk:** moderate, contained. Contract grows by one optional method (mirrors existing optional `remove?`/`clear?` pattern). Controller keeps the legacy path as fallback, so no store is forced to migrate.
- **Rollback interaction:** app-level rollback is NOT dead code — it remains the error path for stores that don't implement `restoreUserState` (and the memory fallback mid-restore), but becomes unreachable on the IndexedDB happy path, which is the point.
- **Side benefit:** single-transaction restore can `clear()` the `knownWordSets` store before writing, fixing a latent hygiene issue — the current `save`-based restore orphans the previous known-word-set records forever (only the `meta` active pointer moves; old records are never deleted).
- **What breaks on crash:** nothing. All-or-nothing.

### Option 2: Two-phase commit with intent record

Write a restore-intent record (to `meta`) containing the backup payload, apply the category writes, clear the intent; on `init`, detect a dangling intent and replay.

- **Cost:** high — new persisted state (the payload, up to `MAX_BACKUP_BYTES` = 25 MiB, controller.ts:67), init-path changes in `initialize()` (the most delicate code in the controller), replay/idempotency logic, tests. Estimate **250+ lines**, all of it on the startup path.
- **Risk:** highest of the three. A bug here corrupts every startup, not just rare restores. All three category writes are individually idempotent (put / clear+put), so replay would work — but the scheme buys nothing over Option 1, because IndexedDB already gives us the atomic-commit primitive natively. Adding a hand-rolled 2PC on top of a database with real transactions is strictly worse.
- **What breaks on crash:** nothing mid-restore (replay), but a corrupted/oversized intent record could impair every subsequent init.

**Rejected:** strictly dominated by Option 1 on this storage engine.

### Option 3: Status quo + documentation

Keep Task 3's lock; document the crash window.

- **Cost:** 0 lines.
- **Risk:** residual. Window is milliseconds wide (between two transaction commits) on a rare, user-initiated operation — probability is very low. But blast radius when hit is durable cross-store inconsistency (e.g., new known-words filter applied against stale decisions) with no self-healing: it persists until the next successful restore or `clearSavedData`, and nothing surfaces it to the user. For a user-data-protection workstream, knowingly leaving a closable hole in the one operation whose entire job is "put my data back exactly" is the wrong trade.
- **What breaks on crash:** mixed durable state as described above.

## Decision

**Option 1: single-transaction IndexedDB restore.** It is the only option that actually closes the audited risk (Option 3 documents it; Option 2 spends more complexity to reach the same guarantee Option 1 gets for free from IndexedDB). It follows an existing in-repo pattern (`clearAll`), does not touch the init path, keeps the current path as fallback for stores without the method, and incidentally fixes known-word-set orphaning. Probability of tab death mid-restore is low, but the fix's marginal complexity is also low and one-directional (no new persistent state, no startup behavior change), so the reliability-per-line ratio favors implementing it.

**Implementation deferred to Wave 2.** The decision rule in the task brief allows implementing now only if the change fits under 150 diff lines. Implementation-only changes squeeze under that line (~140), but shipping an atomicity fix without the tests that verify it would be self-defeating: the claim "restore is now atomic" is only as good as the tests proving the fallback path, the memory-store contract, and the controller wiring. With mandatory tests the honest estimate is 250-400 lines — over the threshold. This is recorded as the **first candidate task for Wave 2's plan**.

### Consequences

- Until Wave 2 implements this, the crash-consistency window documented above remains open (bounded by Task 3's lock to crash-only, no longer reachable by in-process interleaving).
- `rollbackUserState` and the per-category restore path survive as the fallback for stores that do not implement `restoreUserState`; they become dead only on the IndexedDB fast path.
- Contract grows one optional method + one snapshot type, consistent with the existing optional-verb pattern (`remove?`, `clear?`).

### Verification steps (for the Wave 2 implementing task)

1. **Atomicity:** with fake-indexeddb, abort the `restoreUserState` transaction (e.g., inject a put failure on the last store written) and assert `knownWordSets`, `meta.activeKnownWordSetId`, `wordDecisions`, and `preferences` are all byte-identical to pre-restore state.
2. **Happy path:** full backup → restore round trip leaves all three categories matching the backup; `knownWordSets` contains exactly one record (orphan fix).
3. **Empty/null categories:** backup with `knownWords: null` and `preferences: null` clears the corresponding durable state in the same transaction. [errata 2026-09-06: implemented behavior writes DEFAULT query/view preferences (Wave-1 pinned contract); clearing was rejected to preserve restore semantics — see phase2 commit 20e2629 tests]
4. **Fallback:** a store stub without `restoreUserState` still restores via the existing per-category path, including rollback-on-error behavior.
5. **Memory fallback:** `storageOperation` retry after an injected IndexedDB failure routes `restoreUserState` to the memory store and restore still completes.
6. **Duplicate decisions:** a backup with duplicate `normalizedWord` aborts the whole transaction (parity with `replaceAll`, indexed-db.ts:770-779).

### Wave 2 task breakdown (first candidate)

1. `contracts.ts`: `RestoreUserStateSnapshot` type + optional `AppStore.restoreUserState?`.
2. `indexed-db.ts`: single-tx implementation over `knownWordSets`/`meta`/`wordDecisions`/`preferences` (clear + write each category; duplicate-decision check aborts).
3. `memory-store.ts`: trivial implementation (save/replaceAll/save sequence).
4. `controller.ts` `restoreBackup`: prefer `restoreUserState` when present; keep snapshot/rollback path for stores without it.
5. Tests per the six verification steps above.
