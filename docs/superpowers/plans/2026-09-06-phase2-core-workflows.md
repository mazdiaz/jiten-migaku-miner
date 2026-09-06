# Phase 2: Core Workflows + Focus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve audit Phase 2 (queue-aware queries, canonical word identity, review reliability) and Phase 4 "Browser-Reproduced Focus Defects", plus the Wave-1 carry-overs (clear-vs-import lock coverage, single-transaction restore per decision record `docs/superpowers/decisions/2026-09-06-restore-atomicity.md`).

**Architecture:** Controller keeps its `userStateLock`/`userStateEpoch` concurrency core (Wave 1) — extended, not redesigned. Query dispatch centralizes through mode-aware routing in `runQuery`. Word identity stays persisted-as-is; all MATCHING becomes case-insensitive via a single lowercase canonical at comparison points (worker scan, queue ordering, renderer queued-set, decision canonicalization choke point) — no data migration, old datasets and backups untouched. Review gains a session generation. UI focus fixes live in controls.ts/renderer.ts with no DOM hierarchy changes (Phase 3 re-layout is a later wave).

**Tech Stack:** TypeScript, Vite, Vitest (fake-indexeddb, happy-dom), Playwright Chromium.

**Spec:** `DL/WEBSITE-IMPROVEMENT-AUDIT.md` Phase 2 + Phase 4 (Browser-Reproduced Focus Defects section only — the "Other Accessibility Changes" are Wave 3). Decision record: `docs/superpowers/decisions/2026-09-06-restore-atomicity.md`.

## Global Constraints

- Failing regression before every implementation change (audit line 299).
- Minimal diffs; no framework rewrite; no unrelated cleanup.
- "No framework rewrite. Prefer focused changes over broad restructuring." (audit Phase 5 note, binding for all waves)
- Persisted data compat: existing lowercased decision keys, case-preserved `entry.normalizedWord` in stored datasets, and all previously-accepted backups MUST keep working. No schema change except the optional restore-transaction method (Task 6).
- `npm run check` + `npm run test:e2e` green at wave end.
- Conventional commits (`fix:`, `test:`, `docs:`).
- Test-harness conventions from Wave 1: `FakeWorkerClient`, `flakyAppStore`, `createDelayedAppStore`, session-queue stub — module-scoped in tests/app/controller.test.ts; reuse, don't recreate.

---

### Task 1: Centralize mode-aware query dispatch

**Files:**
- Modify: `src/app/controller.ts` (`runQuery` ~1011, `runQueueQuery` ~888, `updateQuery` ~312, `changePage` ~336, `updateViewport` ~319)
- Test: `tests/app/mining-queue.test.ts` (+ controller tests if fixtures live there)

**Interfaces:**
- Consumes: `runQueueQuery` (existing), `queryChannel: "queue"`, `includeNormalizedWords`.
- Produces: `runQuery(options)` becomes the single dispatch point — when `this.state.queue.mode === "queue" && this.state.dataset !== null`, it delegates to `runQueueQuery()` (passing silent option through if trivial; queue path may ignore it). No public API change. Every caller (`updateQuery`, `changePage`, `updateViewport`, `applyWordDecision` else-branch, `stopQueueMode`'s post-mode-reset call, `loadAndQuery`) automatically becomes queue-aware.

**Context (defect):** `updateQuery`/`changePage`/`updateViewport` call `runQuery()` which always uses `queryChannel: "user"` and omits `includeNormalizedWords` — while queue mode is active, filter/page/viewport updates display unqueued words under a UI that says Queue Mode. `applyWordDecision` already branches manually (controller.ts:994) — after this task it can use the unified path (remove the manual branch).

**Design decisions (binding):**
- Dispatch goes at the TOP of `runQuery`, before the null-dataset early return is skipped: queue delegation requires a dataset; if `dataset === null` keep existing empty-state path.
- `changePage` in queue mode: bounded queues (words > 5000) keep `this.state.page` (runQueueQuery reads it); unbounded queues have a single page — `changePage`'s totalPages clamp already handles this (result.totalPages === 1). Do not add queue-specific page logic.
- `updateQuery` resets page to 1 — fine for queue entry; do not special-case.
- `runQueueQuery` stays as-is otherwise (include-list, ordering, threshold paging, window).

- [ ] **Step 1: Write failing regressions** (in the queue test file, using its existing fixtures/fake worker):

```typescript
it("page changes during queue mode keep the queue include-list", async () => {
  // seed dataset with entries A,B,C (A queued), enter queue mode, assert
  // first query used includeNormalizedWords; call controller.changePage(1) —
  // wait: unbounded queue has 1 page. Instead use updateQuery({ search: "" })
  // and a second entry page scenario. Cover ALL THREE defect paths:
});

it("filter updates during queue mode keep the queue include-list", async () => {
  // controller.updateQuery({ search: "…" }) while mode === "queue";
  // capture FakeWorker query calls; assert latest call has
  // queryChannel "queue" + includeNormalizedWords containing queued word,
  // and result items only from the queue.
});

it("viewport updates during bounded queue mode stay queue-aware", async () => {
  // queue with >QUEUE_SAFETY_THRESHOLD words is heavy for unit tests — instead
  // set query.pageSize "all" and a queue of 1-2 words, then updateViewport(n):
  // updateViewport early-returns unless pageSize === "all"; with small queue
  // runQueueQuery uses the unbounded path — assert the resulting query still
  // carries the include-list (this pins the dispatch, which is the defect).
});
```
(Flesh out with the file's existing seed helpers; the assertion target is always the FakeWorker's recorded `queryCalls`.)

- [ ] **Step 2:** Run — expected FAIL: recorded calls show `queryChannel: "user"` and no include-list.
- [ ] **Step 3:** Implement dispatch at top of `runQuery`; remove `applyWordDecision`'s manual branch (controller.ts:994-995 → single `await this.runQuery()`).
- [ ] **Step 4:** Targeted file pass, then full unit suite (`npx vitest run`) — queue + controller suites must stay green.
- [ ] **Step 5:** Commit `fix: centralize mode-aware query dispatch`

---

### Task 2: One canonical word identity for matching

**Files:**
- Modify: `src/worker/worker-engine.ts` (`scanDataset` matching, `entryWithMetadata` unchanged), `src/app/controller.ts` (`applyWordDecision` canonicalization, `reviewDecision` word source), `src/ui/renderer.ts` (queued-set compare ~329), `src/app/controller.ts` (`orderByQueue` ~75)
- Test: `tests/worker/worker-engine.test.ts` (or include-list test file), `tests/app/controller.test.ts`, `tests/app/mining-queue.test.ts`

**Interfaces:**
- Produces: internal canonical `matchKey(word) = normalizeText(word).toLocaleLowerCase()`. Applied ONLY at comparison/storage-key points: (a) worker builds lowercase lookup sets for knownWords/decisions/includeWords and matches against the cached lowercase `fields.normalizedWord`; (b) `applyWordDecision` canonicalizes its input before store write + state key (single choke point — fixes review decisions currently stored case-preserved via `review.current.normalizedWord`); (c) `orderByQueue` and renderer queued-set compare on lowercase of entry.normalizedWord. `EntryWithKnown.normalizedWord` stays case-preserved (display + renderer `data-word`). Persisted data, backups, import — UNTOUCHED.

**Context (defects):** controller lowercases decision/queue keys (controller.ts:350,409,421) while imported `entry.normalizedWord` preserves case (import.ts:56); worker `scanDataset` matches `decisions.get(value.normalizedWord)` / `knownWords.has(...)` / `includeWords.has(...)` raw (worker-engine.ts:413-428) → NHK-entry vs "nhk"-key decision/known/queue misses. `reviewDecision` passes case-preserved `review.current.normalizedWord` (controller.ts:377) into `applyWordDecision` → review decisions keyed differently from list decisions for the same word.

- [ ] **Step 1: Failing regressions:**
  - worker: dataset with entry `{ word: "NHK", normalizedWord: "NHK" }`; query with `knownWords: ["nhk"]` → expect entry.knownByMigaku true (fails today); same for `decisions: [["nhk","mined"]]` → decision "mined"; and `includeNormalizedWords: ["nhk"]` → entry included.
  - controller: seed mixed-case entry via FakeWorker; `setWordDecision("NHK","known")` then `reviewDecision` path or direct: assert store key + state key lowercased consistently; assert queue toggle on "NHK" then decision removes it from queue (currently misses on includes()).
  - renderer (unit if renderer tests exist; else covered via controller queue regression): `queued.has(lowercase compare)` — queued button state for NHK entry with queue ["nhk"].
- [ ] **Step 2:** FAIL confirmed.
- [ ] **Step 3:** Implement per Interfaces. Worker: build `knownLower = new Set([...knownWords].map(k => k.toLocaleLowerCase()))` etc. once per scan; use `fields.normalizedWord` for membership; decision lookup via `decisionsLower` map. Keep `knownByMigakuByIndex` semantics.
- [ ] **Step 4:** Full suite green (`npx vitest run`).
- [ ] **Step 5:** Commit `fix: use one canonical lowercase identity for word matching`

---

### Task 3: Review error rendering and session reliability

**Files:**
- Modify: `src/ui/renderer.ts` (`renderReviewSurface` 31-62), `src/app/controller.ts` (review generation; `startReview`/`stopReview`/`reviewDecision`/`runReviewQuery`; `importJiten` commit path)
- Test: `tests/ui/*.test.ts` (review rendering — follow existing review-mode unit test location), `tests/app/controller.test.ts`

**Interfaces:**
- Produces: `ReviewState.errorMessage` rendered whenever non-null (independent of `status`), as a `role="alert"` div inside `reviewContent`, WITH the current card kept visible above it and triage buttons left enabled when `status === "ready"` (retry path). Controller: `private reviewGeneration = 0`; `stopReview()` bumps it; `runReviewQuery`/`reviewDecision` continuations capture and re-check it (replaces the bare `review.active` checks at controller.ts:385,394,944,956 — keeps `active` check too); active-dataset change (importJiten committed block, ~line 205 region) calls `this.stopReview()`.

**Context (defects):** failed decisions set review status back to `ready` with errorMessage (controller.ts:395-399) but renderer only shows errorMessage when status==="error" (renderer.ts:52) → invisible failure, and `reviewContent.textContent = errorMessage` REPLACES the card (renderer.ts:53) → card lost on genuine errors. Dataset replacement leaves a stale review card (no stopReview on import commit). Wave-1 deferred minor: `processed+1` drift when review restarts mid-continuation — solved by the same generation guard.

- [ ] **Step 1: Failing regressions:**
  - renderer-level: state with `review.active, status:"ready", current:<entry>, errorMessage:"save failed"` → assert rendered DOM contains BOTH the entry article AND an alert region with the message; triage buttons not disabled.
  - controller: `reviewDecision` with a failing store write → state.review.errorMessage non-null AND status "ready" AND current retained (this part likely already passes — pin it); then the restart-drift regression: gate the review query, `reviewDecision` → `stopReview()` → `startReview()` → release → assert processed === 0 and no stale publish into the new session.
  - controller: active import commits while review active → review inactive after commit (stopReview called).
- [ ] **Step 2:** FAIL (renderer + dataset-change at minimum).
- [ ] **Step 3:** Implement per Interfaces. Renderer: render card first, then append error div `class="review-error" role="alert"` when errorMessage !== null; remove the status==="error" early-return textContent path (error state still renders alert; if current===null and error → alert only).
- [ ] **Step 4:** Full suite + targeted.
- [ ] **Step 5:** Commit `fix: reliable review error rendering and session invalidation`

---

### Task 4: Keyboard focus for queue/decision actions and review trap

**Files:**
- Modify: `src/ui/controls.ts` (resultsList click handler 217-239, subscribe callback 76-81, review keydown 320-330), `index.html` (no structural change expected; only if inert needs a hook — prefer renderer body toggle), `src/ui/renderer.ts` (`renderReviewSurface` — inert toggle)
- Test: `tests/ui/decision-controls.test.ts`, `tests/ui/mining-queue-ui.test.ts` (follow existing patterns), + e2e addition in `tests/e2e/mining-queue.spec.ts` or `word-decisions.spec.ts` (one keyboard focus spec)

**Interfaces:**
- Produces: (1) After a queue toggle / decision click, focus is intentionally placed: same word's same-action button if still present; else the nearest still-rendered entry's primary action (first `[data-decision-action]` in the entry after the removed one); else `dom.resultsHeading`. Implemented via a `pendingFocus` record set in the click handler and consumed in the existing subscribe callback after render. (2) Review open: `Tab`/`Shift+Tab` cycle within reviewPanel focusables (keydown trap on the overlay, honor `Escape` as today); `document.querySelector("main.app-shell")?.inert = review.active` toggled where `review-open` body class is toggled today (renderer.ts:34). (3) Return-focus on review close already exists (controls.ts:77) — keep; add regression.

**Context (defects, audit Phase 4):** activating Queue moves focus to `body` (rerender replaces clicked node); Shift+Tab from open Review reaches background `bottomNext` (no trap, no inert). Also pager keyboard nav scrolls without sticky offset — that's the Wave 3 a11y item (controls.ts:158), NOT this task.

- [ ] **Step 1: Failing regressions (happy-dom unit level + one e2e):**
  - unit: simulate click on decision button for word W; after subscribe render, `document.activeElement` is the same-position target (or heading when W's entry disappeared via decision filter). Cover: (a) entry stays (e.g. decision filter "all") → same word+action focused; (b) entry leaves (decision filter = the decision just set... filter must already be restrictive: use queue-mode remove case or decision:"unreviewed" filter + known decision) → next entry's first action or heading.
  - unit: review active → synthetic Tab from last focusable in panel wraps to first; `main` has `inert` true; after stopReview inert false and activeElement is reviewButton.
  - e2e (one spec): keyboard-only flow — Tab to a decision button, Enter, assert focus within results (not body); open review, Shift+Tab stays inside panel, Esc closes and focus returns to review button.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement per Interfaces.
- [ ] **Step 4:** Full unit suite + `npx playwright test tests/e2e/<the touched spec>` then full e2e at Task 7.
- [ ] **Step 5:** Commit `fix: intentional focus after queue and decision actions, review focus trap`

---

### Task 5: Clear-vs-import serialization (Wave-1 carry-over)

**Files:**
- Modify: `src/app/controller.ts` (`clearSavedData` lock composition, `importJiten` commit section)
- Test: `tests/app/controller.test.ts`

**Interfaces:**
- Produces: lock ordering extended: `clearSavedData` acquires `importLock` THEN `userStateLock` (nesting `withImportLock(() => this.withUserStateLock(...))`), matching importKnown's existing inner-nesting direction; `importJiten`'s commit section (activateAndVerify → state mutation → persistPreferences, the `withImportLock` block ~line 202-217) additionally runs inside `withUserStateLock` (same nesting as importKnown). Update the lock-invariant comment. No public API change.

**Context (final Wave-1 review):** a clear racing an import commit can leave a resurrected dataset record visible on next init; clear currently doesn't wait for in-flight imports (importGeneration bump aborts future checks but already-staged/activated writes can interleave with clearAll). This is the "Coordinate decision writes, known imports, preference writes, and concurrent restores" audit family extended to dataset activation.

- [ ] **Step 1: Failing regression:** delayed store gating `datasets.activate`; start importJiten, block at activate; run clearSavedData to completion; release; assert final durable datasets list is EMPTY (today: activated dataset record survives clear) and visible state is fresh-empty.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement nesting; verify no deadlock (import path acquires userStateLock only inside importLock; clear acquires in same order).
- [ ] **Step 4:** Full suite (deadlock watch: timeouts).
- [ ] **Step 5:** Commit `fix: serialize clear against dataset import commits`

---

### Task 6: Single-transaction restore + orphaned known-word-set fix (decision record)

**Files:**
- Modify: `src/storage/contracts.ts` (optional `restoreUserState?`), `src/storage/indexed-db.ts` (implement), `src/storage/memory-store.ts` (implement — trivially), `src/app/controller.ts` (`restoreBackup` uses it when present, keeps per-category path as fallback), `src/worker/*` untouched
- Test: `tests/storage/indexed-db.test.ts`, `tests/app/controller.test.ts`
- Spec: `docs/superpowers/decisions/2026-09-06-restore-atomicity.md` — follow its 5-step breakdown and 6 verification steps VERBATIM (they are the requirement), including: transaction spans knownWordSets + meta + wordDecisions + preferences in one `readwrite` tx; null-knownWords deletes prior set + clears meta pointer (fixes the orphaned-known-word-set latent bug); abort-on-duplicate parity with per-category path; `storageOperation` fallback routing for the new method (decision record flags this as MUST-verify); controller falls back to sequential writes when store lacks the method.

**Interfaces:**
- Produces: `AppStore.restoreUserState?(state: { knownWords: { id: string; name: string; words: Iterable<string> } | null; decisions: WordDecision[]; preferences: { query: QueryState; view: ViewState; page: number } }): Promise<void>` — all-or-nothing on IndexedDB. Controller: `restoreBackup` snapshot+rollback logic simplified when method present (rollback becomes unreachable on IDB — keep verification reads).

- [ ] **Step 1:** Failing regressions per decision-record verification steps (multi-part: atomicity via injected abort — fake-indexeddb tx abort hook or throwing preferences put via flaky wrapper routed INSIDE the store; orphan fix: two restores → knownWordSets store contains only the latest set; fallback path intact for stores without the method).
- [ ] **Step 2:** FAIL. [ ] **Step 3:** Implement per decision record. [ ] **Step 4:** Full suite. [ ] **Step 5:** Commit `fix: single-transaction restore closes crash-consistency window`

---

### Task 7: Wave verification and audit bookkeeping

- [ ] `npm run check` — record counts. [ ] `npm run test:e2e` — all green (incl. new keyboard spec, 100k).
- [ ] Check off in `DL/WEBSITE-IMPROVEMENT-AUDIT.md`: Phase 2 items 1-3 (all boxes) + Phase 4 "Browser-Reproduced Focus Defects" (all 4 boxes) with `(verified: <test/spec name> / <sha>)` evidence. Phase 2 item 2 box "Account for existing persisted identity semantics…" — evidence = no-migration design + compat regressions. Do NOT touch other sections.
- [ ] Commit `docs: check off audit phase 2 and focus defects with verification evidence`

---

## Self-Review Notes

- Spec coverage: audit Phase 2.1 → Task 1; 2.2 → Task 2; 2.3 → Task 3; Phase 4 focus → Task 4; Wave-1 carry-overs → Tasks 5-6. Audit Phase 2.1 "Test large-queue paging and scrolling, not only initial queue entry" — Task 1 regressions cover paging/search dispatch; large-queue SCROLL is virtual-list territory (Phase 5/Wave 4) — noted as ⚠️ partial, evidence line will cite dispatch tests; scrolling itself deferred to Wave 4 (ledger it).
- Phase 2.3 "Add a modal error region with appropriate alert semantics" → Task 3 `role="alert"` region.
- Identity compat: no persisted format changes — old datasets/backups keep working by construction (worker compares lowercase of both sides).
- Task ordering: 1→2 independent; 3 independent; 4 depends on 3 only for review-error DOM shape (trap test asserts alert region? no — independent); 5-6 independent of 1-4. Executed sequentially 1..7.
