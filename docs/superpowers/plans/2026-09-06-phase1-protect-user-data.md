# Phase 1: Protect User Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all five data-integrity defect groups from audit Phase 1 (`DL/WEBSITE-IMPROVEMENT-AUDIT.md`): storage-fallback state loss, clear/restore race conditions, unbounded IndexedDB chunk reads, lost migration/clear failure reporting, and backup identity validation gaps.

**Architecture:** Controller (`src/app/controller.ts`) gains (a) state transfer into the memory store on storage fallback, (b) a single `userStateLock` serializing clear/restore/decisions/known-imports plus a `userStateEpoch` invalidating stale continuations, (c) clear-failure warning collection. `migrateLegacy` gains a persistence flag so memory-only migration never writes the durable marker. `backup.ts` validates canonical decision identities. IndexedDB chunk pagination keeps a dataset-bounded key range on every batch.

**Tech Stack:** TypeScript, Vitest with fake-indexeddb + happy-dom, existing `FakeWorkerClient` test harness.

**Spec:** `DL/WEBSITE-IMPROVEMENT-AUDIT.md`, Phase 1 (items 1–5) and Implementation Order step 1.

## Global Constraints

- Failing regression test before every implementation change (audit line 299).
- No unrelated cleanup; minimal diffs.
- `npm run check` and `npm run test:e2e` green at plan completion.
- Conventional commits (`fix:`, `test:`, `docs:`).
- Do not change persisted schema or break backups accepted by the previous release.

---

### Task 1: Keep IndexedDB chunk pagination bounded to its dataset

**Files:**
- Modify: `src/storage/indexed-db.ts:509-512`
- Test: `tests/storage/indexed-db.test.ts`

**Interfaces:**
- Consumes: existing `IndexedDbDatasetStore.readChunks(datasetId, chunkSize)`; `READ_BATCH_SIZE = 32`.
- Produces: unchanged public API. Regression guarantees `readChunks` never returns another dataset's rows.

**Context:** `readChunks` pages `ENTRY_CHUNKS_STORE` (composite key `[datasetId, chunkIndex]`) in batches of 32 records. After each batch it sets `range = IDBKeyRange.lowerBound([datasetId, lastRecord.chunkIndex], true)` — the upper bound is lost, so batch 2+ can read every later dataset's rows. Fix: re-bound with `IDBKeyRange.bound([datasetId, lastChunkIndex], [datasetId, Number.MAX_SAFE_INTEGER], true, false)`.

- [ ] **Step 1: Write the failing regression**

Add to `tests/storage/indexed-db.test.ts` (reuses existing helpers `metadata`, `entry`, `chunks`):

```typescript
describe("readChunks dataset bounds", () => {
  it("never reads another dataset's chunks after the first pagination batch", async () => {
    const store = createIndexedDbAppStore();
    const datasetId = `${databaseName}-pagination-a`;
    const otherId = `${databaseName}-pagination-b`;

    // 40 single-entry chunk records > READ_BATCH_SIZE (32) forces pagination.
    const firstChunks = Array.from({ length: 40 }, (_, index) => [
      entry(`${datasetId}-entry-${index}`, index),
    ]);
    await store.datasets.stage({ ...metadata(datasetId), entryCount: 40 }, chunks(firstChunks));

    const otherChunks = Array.from({ length: 5 }, (_, index) => [
      entry(`${otherId}-entry-${index}`, index),
    ]);
    await store.datasets.stage({ ...metadata(otherId), entryCount: 5 }, chunks(otherChunks));

    const read = await collectChunks(store.datasets.readChunks(datasetId, 1));
    const words = read.flat().map((value) => value.id);
    expect(words).toHaveLength(40);
    for (const id of words) {
      expect(id.startsWith(`${datasetId}-entry-`)).toBe(true);
    }
  });
});
```

Note: `metadata(id)` hardcodes `entryCount: 3`; override as shown. `createIndexedDbAppStore()` — check its signature in `src/storage/indexed-db.ts`; if it takes a database name, pass the test's unique name consistent with the file's `afterEach` cleanup pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage/indexed-db.test.ts -t "never reads another dataset"`
Expected: FAIL — collected count is 45 (or words include `pagination-b` rows).

- [ ] **Step 3: Fix the range**

In `src/storage/indexed-db.ts`, replace lines 509-512:

```typescript
      range = IDBKeyRange.bound(
        [datasetId, lastRecord.chunkIndex],
        [datasetId, Number.MAX_SAFE_INTEGER],
        true,
        false,
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storage/indexed-db.test.ts`
Expected: PASS (all suites in file).

- [ ] **Step 5: Commit**

```bash
git add src/storage/indexed-db.ts tests/storage/indexed-db.test.ts
git commit -m "fix: keep indexeddb chunk pagination bounded to its dataset"
```

---

### Task 2: Transfer user state into memory store on storage fallback

**Files:**
- Modify: `src/app/controller.ts` (`switchToMemory`, `exportBackup`)
- Test: `tests/app/controller.test.ts`

**Interfaces:**
- Consumes: `createMemoryAppStore()`, `AppStore` contract (`knownWords.save(id, name, words)`, `wordDecisions.replaceAll(decisions)`, `preferences.save(prefs)`), controller state fields `knownWords`, `knownWordsName`, `wordDecisions`.
- Produces: `switchToMemory(error: unknown, transfer: () => Promise<void>)` — internal; no public API change. After fallback, `exportBackup()` reflects pre-fallback known words.

**Context:** `switchToMemory` (controller.ts:723) swaps in an empty memory store while visible state stays populated; `exportBackup` (controller.ts:447) then reads `store.knownWords.getActive()` from the empty replacement and exports `knownWords: null`. Fix: on switch, best-effort transfer known words, decisions, and preferences from controller state into the new memory store; keep the fallback warning visible. Failure to transfer merges into the warning (state itself remains in memory and is still exported coherently per Task 3's snapshot discipline).

- [ ] **Step 1: Write the failing regression**

Add to `tests/app/controller.test.ts`. Uses existing harness pieces (`FakeWorkerClient`, `createMemoryAppStore`, `createFileSource`); add a small delegating wrapper at the bottom of the helpers section:

```typescript
function flakyAppStore(inner: AppStore, shouldFail: () => boolean): AppStore {
  const guard = <A extends unknown[], R>(operation: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (shouldFail()) throw new Error("simulated late storage failure");
      return operation(...args);
    };
  return {
    datasets: {
      stage: guard(inner.datasets.stage),
      activate: guard(inner.datasets.activate),
      getActive: guard(inner.datasets.getActive),
      list: guard(inner.datasets.list),
      readChunks: guard(inner.datasets.readChunks),
      remove: guard(inner.datasets.remove),
    },
    knownWords: {
      save: guard(inner.knownWords.save),
      getActive: guard(inner.knownWords.getActive),
    },
    wordDecisions: {
      list: guard(inner.wordDecisions.list),
      set: guard(inner.wordDecisions.set),
      remove: guard(inner.wordDecisions.remove),
      replaceAll: guard(inner.wordDecisions.replaceAll),
    },
    preferences: {
      load: guard(inner.preferences.load),
      save: guard(inner.preferences.save),
    },
    clearAll: guard(inner.clearAll),
  };
}
```

If the `AppStore` contract declares optional members (`remove`, `clear`, …) adjust the wrapper to the exact required/optional split from `src/storage/contracts.ts` so it typechecks.

Test:

```typescript
it("preserves known words and decisions in exports after a late storage failure", async () => {
  const inner = createMemoryAppStore();
  let failing = false;
  const worker = new FakeWorkerClient();
  const controller = createMinerController({
    indexedDbStoreFactory: () => flakyAppStore(inner, () => failing),
    worker,
    legacyStorage: null,
    sessionQueueStore: createSessionQueueStoreStub(),
  });
  await controller.init();

  await controller.importKnown(createFileSource("known.txt", "新しい\n"));
  failing = true;
  await controller.setWordDecision("新しい", "known").catch(() => undefined);
  failing = false;

  const backup = JSON.parse(await controller.exportBackup());
  expect(backup.knownWords).not.toBeNull();
  expect(backup.knownWords.words).toContain("新しい");
  expect(backup.wordDecisions.map((d: { normalizedWord: string }) => d.normalizedWord)).toEqual([]);
});
```

Notes: reuse the existing session-queue stub pattern from this file (search for `sessionQueueStore:` usages; mirror them). The decision is expected absent because its store write failed — the assertion pins that decisions are never fabricated; the defect under test is `knownWords: null`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app/controller.test.ts -t "after a late storage failure"`
Expected: FAIL — `backup.knownWords` is `null`.

- [ ] **Step 3: Implement the transfer**

In `src/app/controller.ts`, extend `switchToMemory`:

```typescript
  private async switchToMemory(error: unknown): Promise<void> {
    if (this.persistentStore === null) this.persistentStore = this.store;
    const replacement = createMemoryAppStore();
    const transferFailures: string[] = [];
    try {
      if (this.state.knownWordsName !== null && this.state.knownWords.size > 0) {
        await replacement.knownWords.save(
          this.createId("known"),
          this.state.knownWordsName,
          this.state.knownWords,
        );
      } else if (this.state.knownWords.size > 0) {
        await replacement.knownWords.save(
          this.createId("known"),
          "Recovered known words",
          this.state.knownWords,
        );
      }
    } catch (transferError) {
      transferFailures.push(`Known-word recovery failed: ${errorMessage(transferError)}`);
    }
    try {
      if (this.state.wordDecisions.size > 0) {
        await replacement.wordDecisions.replaceAll([...this.state.wordDecisions.values()]);
      }
    } catch (transferError) {
      transferFailures.push(`Word-decision recovery failed: ${errorMessage(transferError)}`);
    }
    try {
      await replacement.preferences.save({
        query: { ...this.state.query, page: this.state.page },
        view: { ...this.state.view },
        page: this.state.page,
      });
    } catch {
      // Preferences are non-critical; visible state retains them.
    }

    this.store = replacement;
    this.state.persistence = "memory";
    const message = `IndexedDB unavailable; using memory persistence. ${errorMessage(error)}${
      transferFailures.length > 0 ? ` ${transferFailures.join(" ")}` : ""
    }`;
    this.fallbackWarning = message;
    this.setWarning(message);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app/controller.test.ts`
Expected: PASS. If old fallback tests assert the exact old warning text, update them to the new message only if the assertion is substring-based already — otherwise leave implementation message unchanged in shape.

- [ ] **Step 5: Commit**

```bash
git add src/app/controller.ts tests/app/controller.test.ts
git commit -m "fix: transfer user state into memory store on storage fallback"
```

---

### Task 3: Serialize clear and restore against all user-state mutations

**Files:**
- Modify: `src/app/controller.ts` (`clearSavedData`, `restoreBackup`, `setWordDecision`, `reviewDecision`, `applyWordDecision`, `importKnown`, `persistPreferences`, new `withUserStateLock` + `userStateEpoch`)
- Test: `tests/app/controller.test.ts`

**Interfaces:**
- Consumes: existing `withImportLock` pattern (controller.ts:810), `decisionLock` (controller.ts:113), `queryGeneration`/`importGeneration` invalidation style.
- Produces (internal): `private userStateLock: Promise<unknown>`; `private userStateEpoch = 0`; `private withUserStateLock<T>(action: () => Promise<T>): Promise<T>`. `decisionLock` is removed (superseded). Every durable user-state mutation (decision set/remove, clear, restore, known save) runs inside `withUserStateLock`; every await-continuation re-checks the epoch captured at enqueue and no-ops when stale.

**Context (confirmed defects):**
1. `clearSavedData` (620) does not take `decisionLock`/`importLock`; a queued `applyWordDecision` store write (918) landing after `clearAll` recreates a decision.
2. `restoreBackup` (478) writes categories separately; a decision enqueued mid-restore interleaves between its writes; `rollbackUserState` can then overwrite the newer user action.
3. Async continuations (e.g. `runQuery` calls inside `applyWordDecision`) can publish after clear/restore reset state.

Design: one lock for ownership; one epoch for staleness. `persistPreferences` must NOT take the lock (it is called from inside `runQuery`, which is called while `applyWordDecision` holds the lock — non-reentrant deadlock). Instead `persistPreferences` is made epoch-aware: capture epoch before the store write, skip when stale.

- [ ] **Step 1: Write failing regression — queued decision cannot recreate data after clear**

Add to `tests/app/controller.test.ts` (delayed-store helper):

```typescript
function gatedAppStore(inner: AppStore): AppStore & {
  gate(method: "set" | "save" | "replaceAll" | "clearAll" | "remove"): Promise<void>;
} {
  const waiters: Array<() => void> = [];
  const blockNext = (): Promise<void> => new Promise((resolve) => waiters.push(resolve));
  let pending: (() => void) | null = null;
  const gates = new Set<string>();
  const gate = (method: string): Promise<void> => {
    gates.add(method);
    pending ??= waiters.shift() ?? null;
    return blockNext();
  };
  const take = (method: string): (() => void) | null => {
    if (!gates.has(method) || pending === null) return null;
    gates.delete(method);
    const resolve = pending;
    pending = null;
    return resolve;
  };
  // wrap inner so the gated method blocks until released
  ...
}
```

The fully-specified helper is long; implement it concretely as: a wrapper object identical in shape to `flakyAppStore` from Task 2, but each gated method awaits a release promise the test controls (`gate("wordDecisions.set")` returns once the NEXT call to that method has started blocking). Keep the helper under 80 lines; name it `delayedAppStore`.

Tests (three, same file):

```typescript
it("clear waits for an in-flight decision write and leaves no decisions durable", async () => {
  const inner = createMemoryAppStore();
  const delayed = createDelayedAppStore(inner); // gates wordDecisions.set
  const controller = createMinerController({
    store: delayed.store,
    worker: new FakeWorkerClient(),
    legacyStorage: null,
    sessionQueueStore: createSessionQueueStoreStub(),
  });
  await controller.init();

  const decisionPromise = controller.setWordDecision("新しい", "known");
  await delayed.started("wordDecisions.set"); // decision store write now blocked
  const clearPromise = controller.clearSavedData();
  delayed.release("wordDecisions.set"); // let the decision write finish
  await Promise.all([decisionPromise, clearPromise]);

  expect(await inner.wordDecisions.list()).toEqual([]);
  expect(await delayed.store.wordDecisions.list()).toEqual([]);
});

it("restores atomically relative to queued decisions", async () => {
  // seed one decision, queue a second behind a gated restore write, fail the
  // preferences write mid-restore, assert rollback kept the ORIGINAL decision
  // and the queued decision then applied cleanly on the rolled-back state.
});

it("skips stale state publication after clear", async () => {
  // gate worker query resolution; start setWordDecision, let the store write
  // complete but block the post-write runQuery publish; run clearSavedData;
  // release; assert final published state is the fresh empty state (no result,
  // no decision, review idle).
});
```

 flesh out tests 2 and 3 with the same concrete style as test 1 before running (use `serializeBackup` to build a valid restore payload; the backup must include `exportedAt`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/app/controller.test.ts -t "clear waits\|restores atomically\|skips stale"`
Expected: FAIL — decision reappears durable after clear (test 1); interleaved restore corruption (test 2); stale publish (test 3).

- [ ] **Step 3: Implement lock + epoch**

In `src/app/controller.ts`:

1. Replace field `decisionLock` with:

```typescript
  private userStateLock: Promise<unknown> = Promise.resolve();
  private userStateEpoch = 0;

  private withUserStateLock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.userStateLock.then(action, action);
    this.userStateLock = result.then(() => undefined, () => undefined);
    return result;
  }
```

2. `setWordDecision` / `reviewDecision`: enqueue `applyWordDecision` through `withUserStateLock` (drop `decisionLock`). Capture `const epoch = this.userStateEpoch;` before enqueue; pass to `applyWordDecision(normalized, status, epoch)`.

3. `applyWordDecision(normalizedWord, status, epoch)`: after EVERY `await`, `if (epoch !== this.userStateEpoch) return;` — skip state mutation, queue update, publish, and re-query.

4. `clearSavedData`: wrap the entire body in `await this.withUserStateLock(async () => { ... })`; first statement inside: `this.userStateEpoch += 1;` (keep existing `importGeneration`/`queryGeneration` bumps).

5. `restoreBackup`: wrap the mutation section (snapshot read through `loadAndQuery`) in `withUserStateLock`; bump `this.userStateEpoch += 1;` BEFORE the snapshot read so decisions queued earlier become stale (their callers' writes completed pre-lock; state mutations are skipped). `applyRestoredState`'s existing `queryGeneration += 1` stays.

6. `importKnown`: route the `withImportLock` critical section body additionally through `withUserStateLock` (or convert its user-state portion: known save + state update) with epoch capture/guard. Implementation choice: nest `withUserStateLock` INSIDE `withImportLock` to preserve import-vs-import exclusivity; document the nesting order in a comment near the locks. Comments allowed here: concurrency invariant.

7. `persistPreferences`: capture `const epoch = this.userStateEpoch;` before the store write; after the write, publish error only `if (epoch === this.userStateEpoch)`. Do not take the lock (deadlock: called under lock from `runQuery`).

8. `exportBackup`: wrap body in `withUserStateLock` (readers serialized with writers → coherent snapshot).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/app/controller.test.ts`
Expected: PASS — new tests and all existing suites.

- [ ] **Step 5: Run full unit suite for interaction damage**

Run: `npx vitest run`
Expected: PASS (310+ tests). Pay attention to `tests/app/mining-queue.test.ts` and `tests/app/controller.test.ts` restore/rollback suites.

- [ ] **Step 6: Commit**

```bash
git add src/app/controller.ts tests/app/controller.test.ts
git commit -m "fix: serialize clear and restore with all user-state mutations"
```

---

### Task 4: Preserve migration retry and clear-failure reporting

**Files:**
- Modify: `src/app/migrate-legacy.ts` (options + marker write), `src/app/controller.ts` (`initialize` migration options, `clearSavedData` warning collection)
- Test: `tests/app/migrate-legacy.test.ts`, `tests/app/controller.test.ts`

**Interfaces:**
- Consumes: `LegacyMigrationOptions` (`src/app/migrate-legacy.ts`), `writeMigrationMarker`/`hasMigrationMarker` in same file, controller `initialize` migration block (controller.ts:646-665), `clearSavedData` (controller.ts:620-644).
- Produces: `LegacyMigrationOptions.persistentStore: boolean` (required, no default — forces every caller to decide). When `false`, `migrateLegacy` skips `writeMigrationMarker`. `clearSavedData` collects failures from primary store, `persistentStore`, and `legacyStorage` into one joined warning preserved in the final published state; a primary-store `clearAll` failure no longer throws out of `clearSavedData` unreported.

**Context:** (1) After fallback to memory, migration success writes the marker into `localStorage` (migrate-legacy.ts:304) — a later reload with working IndexedDB sees the marker (line 203) and never retries, silently losing the migrated data. (2) `clearSavedData` calls `setWarning` for persistent/legacy failures, then overwrites `this.warningMessage = this.fallbackWarning` (controller.ts:641) — clear failures vanish from final UI state; a primary-store failure escapes as an exception with no partial-failure report.

- [ ] **Step 1: Write failing regression — memory-only migration leaves no durable marker**

In `tests/app/migrate-legacy.test.ts` (reuse the file's existing legacy-payload builders):

```typescript
it("does not write the migration marker when the store is not persistent", async () => {
  const storage = createLegacyStorageWithPayload(); // existing helper in this file
  const store = createMemoryAppStore();
  const worker = new FakeWorkerWorkerStubForMigrateLegacy(); // reuse file's worker stub
  const result = await migrateLegacy({
    storage,
    store,
    worker,
    query: defaultQueryState,
    view: defaultViewState,
    persistentStore: false,
  });
  expect(result.migrated).toBe(true);
  expect(hasMigrationMarker(storage, MIGRATION_VERSION)).toBe(false);
});
```

Mirror the exact helper names from the existing tests in that file (legacy payload seeding, worker stub) — copy the setup from the nearest passing test rather than inventing new helpers.

- [ ] **Step 2: Write failing regression — clear failures survive in final state**

In `tests/app/controller.test.ts`:

```typescript
it("reports partial clear failure in final state", async () => {
  const inner = createMemoryAppStore();
  const failing = flakyAppStore(inner, () => true); // every op fails, incl. clearAll
  const controller = createMinerController({
    store: failing,
    worker: new FakeWorkerClient(),
    legacyStorage: null,
    sessionQueueStore: createSessionQueueStoreStub(),
  });
  await controller.init().catch(() => undefined);

  await controller.clearSavedData(); // must not throw

  const state = captureLastState(controller); // reuse file's subscribe-capture helper
  expect(state.wordDecisions.size).toBe(0);
  expect(state.errorMessage).toMatch(/could not be fully cleared/i);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/app/migrate-legacy.test.ts tests/app/controller.test.ts -t "marker when the store is not persistent\|partial clear failure"`
Expected: FAIL — marker present; `clearSavedData` rejects or message missing.

- [ ] **Step 4: Implement**

`src/app/migrate-legacy.ts`:
- Add `persistentStore: boolean` to `LegacyMigrationOptions`.
- Line 304: `if (options.persistentStore) writeMigrationMarker(options.storage, MIGRATION_VERSION);`

`src/app/controller.ts`:
- In `initialize`'s `migrationOptions()`: add `persistentStore: !this.storeWasProvided && this.state.persistence === "indexeddb"`.
- Restructure `clearSavedData` body (inside the Task 3 lock):

```typescript
      this.userStateEpoch += 1;
      const clearFailures: string[] = [];
      try {
        await this.storageOperation((store) => store.clearAll());
      } catch (error) {
        clearFailures.push(`Saved data could not be fully cleared: ${errorMessage(error)}`);
      }
      if (this.persistentStore !== null) {
        try {
          await this.persistentStore.clearAll();
        } catch (error) {
          clearFailures.push(`Saved data could not be cleared from persistent storage: ${errorMessage(error)}`);
        }
      }
      if (this.legacyStorage !== null) {
        try {
          clearLegacyData(this.legacyStorage);
        } catch (error) {
          clearFailures.push(`Legacy saved data could not be cleared: ${errorMessage(error)}`);
        }
      }
      this.worker.dispose();
      this.sessionQueue.clear();
      this.state = createInitialAppState(this.state.persistence);
      this.warningMessage = [this.fallbackWarning, ...clearFailures]
        .filter((part): part is string => part !== null)
        .join(" ")
        .trim() || null;
      this.state.errorMessage = this.warningMessage;
      this.publish();
```

- Fix every other `migrateLegacy` caller/test compile error by passing an explicit `persistentStore` (tests that migrate through a provided store use `false`; IndexedDB-backed callers use `true`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/app/migrate-legacy.test.ts tests/app/controller.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/migrate-legacy.ts src/app/controller.ts tests/app/migrate-legacy.test.ts tests/app/controller.test.ts
git commit -m "fix: preserve migration retry after fallback and clear-failure reporting"
```

---

### Task 5: Canonical backup identities and round-trip guarantee

**Files:**
- Modify: `src/domain/backup.ts` (`validateDecision`, `validateKnownWords`)
- Test: `tests/domain/backup.test.ts`

**Interfaces:**
- Consumes: `normalizeText` (already imported), `BackupError` code `"invalid-shape"`.
- Produces: `parseBackup` rejects (a) whitespace-only decision keys, (b) noncanonical keys (`raw !== normalizeText(raw)`), (c) duplicates after normalization. Accepted backups satisfy `parseBackup(serializeBackup(parsed)) === parsed` when known words are sorted-unique (serialize's contract).

**Context:** `validateDecision` (backup.ts:96) checks duplicates on the RAW string; `serializeBackup` normalizes keys — `" x "` and `"x"` pass parsing, collide at export, and the exported file fails re-import.

- [ ] **Step 1: Write failing regressions**

In `tests/domain/backup.test.ts`, add a complete valid baseline helper (audit-confirmed gap: existing negative fixtures omit `exportedAt`):

```typescript
function validBackupJson(): string {
  return JSON.stringify({
    format: "jiten-migaku-miner-backup",
    version: 1,
    exportedAt: "2026-09-06T00:00:00.000Z",
    knownWords: { name: "Migaku known words", words: ["新しい", "透過"] },
    wordDecisions: [
      { normalizedWord: "新しい", status: "known", updatedAt: "2026-09-05T00:00:00.000Z" },
    ],
    preferences: {
      query: { search: "", hideKnown: false, hideKanaOnly: false, sentence: "any", minOccurrences: 1, sort: "occ-desc", pageSize: 50, page: 1, decision: "all" },
      view: { showFurigana: false, pillHighlight: false, showHighlight: false, showDefinitions: true },
      page: 1,
    },
  });
}

it("rejects whitespace-only decision identities", () => {
  const backup = JSON.parse(validBackupJson());
  backup.wordDecisions.push({ normalizedWord: "   ", status: "known", updatedAt: "2026-09-05T00:00:00.000Z" });
  expect(() => parseBackup(JSON.stringify(backup))).toThrow(/must not be empty/);
});

it("rejects noncanonical decision identities", () => {
  const backup = JSON.parse(validBackupJson());
  backup.wordDecisions.push({ normalizedWord: " 新しい ", status: "known", updatedAt: "2026-09-05T00:00:00.000Z" });
  expect(() => parseBackup(JSON.stringify(backup))).toThrow(/canonical/);
});

it("rejects duplicates that differ only by normalization", () => {
  const backup = JSON.parse(validBackupJson());
  backup.wordDecisions.push({ normalizedWord: "新しい", status: "mined", updatedAt: "2026-09-05T00:00:00.000Z" });
  expect(() => parseBackup(JSON.stringify(backup))).toThrow(/duplicate/);
});

it("every accepted backup survives a serialize/parse round-trip", () => {
  const parsed = parseBackup(validBackupJson());
  const serialized = serializeBackup({
    exportedAt: parsed.exportedAt,
    knownWords: parsed.knownWords,
    wordDecisions: parsed.wordDecisions,
    preferences: parsed.preferences,
  });
  expect(parseBackup(serialized)).toEqual(parsed);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/domain/backup.test.ts -t "whitespace-only\|noncanonical\|round-trip"`
Expected: FAIL — whitespace/noncanonical accepted; round-trip passes already for the canonical fixture (keep it as the invariant guard for Task 5's changes; the two rejection tests are the failing signal).

- [ ] **Step 3: Implement**

In `src/domain/backup.ts`, `validateDecision`:

```typescript
function validateDecision(value: unknown, index: number): WordDecision {
  if (!isRecord(value)) fail("invalid-shape", `wordDecisions[${index}] must be an object`);
  const rawWord = requiredString(value.normalizedWord, `wordDecisions[${index}].normalizedWord`);
  const normalizedWord = normalizeText(rawWord);
  if (normalizedWord.length === 0) {
    fail("invalid-shape", `wordDecisions[${index}].normalizedWord must not be empty or whitespace-only`);
  }
  if (normalizedWord !== rawWord) {
    fail("invalid-shape", `wordDecisions[${index}].normalizedWord must be canonical: ${JSON.stringify(rawWord)}`);
  }
  // ... status + updatedAt checks unchanged ...
}
```

Duplicate loop unchanged (keys now canonical). In `validateKnownWords`, reject whitespace-only entries:

```typescript
    if (typeof word !== "string" || normalizeText(word).length === 0) {
      fail("invalid-shape", `knownWords.words[${index}] must be a non-empty string`);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/domain/backup.test.ts`
Expected: PASS — new tests plus existing suite. If existing tests fed noncanonical fixtures expecting acceptance, update those fixtures to canonical values (they were asserting the defective behavior).

- [ ] **Step 5: Commit**

```bash
git add src/domain/backup.ts tests/domain/backup.test.ts
git commit -m "fix: enforce canonical backup identities with round-trip guarantee"
```

---

### Task 6: Restore-atomicity evaluation and decision record

**Files:**
- Create: `docs/superpowers/decisions/2026-09-06-restore-atomicity.md`
- Read-only analysis: `src/storage/contracts.ts`, `src/storage/indexed-db.ts`, `src/storage/memory-store.ts`

**Interfaces:**
- Consumes: Task 3's lock serialization; `AppStore` contract shape.
- Produces: decision document with a chosen option and, if "implement" is chosen, a follow-up task added to this plan.

**Context:** Audit Phase 1 item 5 additional risk: restore commits known/decisions/preferences in separate store calls; process termination between commits bypasses application rollback (crash-consistency risk, not a reproduced browser crash). Audit says "Evaluate", not "implement".

- [ ] **Step 1: Analyze options**

Evaluate, with concrete cost/risk per option against `src/storage/contracts.ts`:
1. IndexedDB single-transaction restore (new optional `AppStore.restoreUserState?()` spanning the three stores in one `readwrite` transaction).
2. Two-phase commit with an intent record (idempotent replay on next init).
3. Status quo (Task 3 lock only) with documented risk.

- [ ] **Step 2: Write the decision record**

`docs/superpowers/decisions/2026-09-06-restore-atomicity.md`: context (audit citation), options, choice, consequences, verification steps for the choice. If option 1 or 2 chosen and it fits in <150 lines of diff, append the implementation task to THIS plan and execute it; otherwise file it as the first task of Wave 2's plan.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/decisions/2026-09-06-restore-atomicity.md
git commit -m "docs: record restore-atomicity decision"
```

---

### Task 7: Wave verification and audit bookkeeping

**Files:**
- Modify: `DL/WEBSITE-IMPROVEMENT-AUDIT.md` (check off Phase 1 boxes only)
- No source changes expected.

- [ ] **Step 1: Full check**

Run: `npm run check`
Expected: typecheck + all unit tests + production build PASS.

- [ ] **Step 2: E2E**

Run: `npm run test:e2e`
Expected: all Chromium tests PASS, including the 100k-row scenario (Task 3's lock must not deadlock large imports — the nesting `importLock → userStateLock` is exercised here).

- [ ] **Step 3: Manual browser verification (audit Phase 1 verification paragraphs)**

Using `npm run dev` + isolated browser storage:
- Seed dataset, known words, decisions; trigger a late storage failure (devtools: block the DB); verify visible state, operations, and exported backup stay consistent (Phase 1.1).
- Interleave clear/restore with pending decisions, known imports, preference changes; assert durable + visible state (Phase 1.2).
- Reload after memory-only migration with storage re-enabled; verify migration retries (Phase 1.4).

- [ ] **Step 4: Check off audit Phase 1 checkboxes**

In `DL/WEBSITE-IMPROVEMENT-AUDIT.md`, mark Phase 1 items `- [x]`, each with evidence appended on the same line: `(verified: <test name> / <commit>)`. Do NOT check items lacking evidence.

- [ ] **Step 5: Commit**

```bash
git add DL/WEBSITE-IMPROVEMENT-AUDIT.md
git commit -m "docs: check off audit phase 1 with verification evidence"
```

---

## Self-Review Notes

- Spec coverage: audit Phase 1 items 1 (Task 2), 2 (Task 3), 3 (Task 1), 4 (Task 4), 5 (Tasks 5+6) — all covered; Phase 1.2's "Invalidate stale async continuations as well as query results" is the epoch in Task 3; "Ensure rollback cannot overwrite newer user actions" is guaranteed by the lock ordering (rollback completes before queued decisions run).
- Known follow-ups deferred to later waves by design: multi-dataset chunk-boundary e2e (Wave 5 expands; unit regression exists in Task 1), backup negative-test baseline repair (Task 5 adds the valid-baseline helper for new tests only; full repair is Wave 5), review-session generation (Wave 2 — separate concern from clear/restore serialization).
- Risk: Task 3 touches the controller's concurrency core. If e2e 100k test regresses, suspect importLock→userStateLock nesting order; the invariant is: imports hold importLock, user-state mutations hold userStateLock, and only importKnown nests userStateLock inside importLock.
