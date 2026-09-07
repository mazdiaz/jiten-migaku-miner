# Website Improvement Audit

Repository: `mazdiaz/jiten-migaku-miner`  
Audit date: 2026-09-06  
Audited baseline: `cde53437366de521f89443425e3ef85ee48f9d5a`

## Summary

Prioritize data reliability and workflow simplification before adding more features. The current interface spends too much space on configuration, while storage, concurrency, keyboard-focus, and scrolling edge cases affect core mining workflows.

Tasks 01-04 in `DL/TASKS` have implementations, but should not be considered fully complete until the defects below are resolved. Task 05, Vocabulary Coverage Analysis, remains unimplemented at the audited baseline.

This document records findings and proposed changes, not completed work. All checkboxes intentionally remain unchecked. File references identify the audited baseline and may move during implementation.

## Scope And Verification

Reviewed application/controller, domain, worker, storage, platform adapters, UI/styles, tests, and deployment configuration. Browser inspection covered desktop and mobile layouts. Browser mutation checks used isolated storage.

- `npm run check`: passed typecheck, 310 tests, and production build.
- `npm run test:e2e`: passed all 27 Chromium tests, including the 100,000-row scenario.
- Existing passing suites do not cover all defects in this document.
- No source changes were made during the audit.
- This was not an exhaustive assistive-technology or cross-browser certification.

## Phase 1: Protect User Data

### 1. Preserve state during storage fallback

- [x] Transfer recoverable dataset, known words, decisions, and preferences into memory when persistent storage fails. (verified: switchToMemory transfer regression in tests/app/controller.test.ts / 5588970)
- [x] Export backups from one coherent state snapshot rather than mixing controller state with an emptied replacement store. (verified: preserves known words and decisions in exports after a late storage failure / 5588970)
- [x] Keep the existing memory-only persistence warning visible. (verified: warning retention in fallback regression / 5588970)

**Confirmed problem:** switching to an empty memory store leaves visible state populated, but backup export can read missing known-word data from that replacement store and export `knownWords: null`.

**References:** `src/app/controller.ts:713`, `src/app/controller.ts:447`.

**Verification:** seed a dataset, known words, and decisions; trigger a late storage failure; verify the visible state, subsequent operations, and exported backup remain consistent.

### 2. Serialize clear and restore with other mutations

- [x] Give clear and restore exclusive ownership of user-state mutations. (verified: clear waits for an in-flight decision write and leaves no decisions durable / e79b74e)
- [x] Coordinate decision writes, known imports, preference writes, and concurrent restores. (verified: restore is atomic relative to queued decisions; rollback is not overwritten / e79b74e)
- [x] Prevent queued writes from recreating data after Clear Saved Data completes. (verified: clear waits for an in-flight decision write and leaves no decisions durable / e79b74e)
- [x] Invalidate stale async continuations as well as query results. (verified: stale continuations skip publication after clear / e79b74e)
- [x] Ensure rollback cannot overwrite newer user actions. (verified: restore is atomic relative to queued decisions; rollback is not overwritten / e79b74e)

**Confirmed problems:** a pending decision write can recreate a decision after clear; restore can leave visible and persisted decisions inconsistent.

**References:** `src/app/controller.ts:478`, `src/app/controller.ts:620`, `src/app/controller.ts:918`.

**Verification:** use delayed stores to interleave clear/restore with pending and queued decisions, known imports, preference changes, and another restore. Assert both final durable state and visible state.

### 3. Bound every IndexedDB chunk read to its dataset

- [x] Preserve the dataset upper bound on every chunk-pagination batch. (verified: never reads another dataset's chunks after the first pagination batch / bc11d75)
- [x] Add a regression combining multiple datasets with at least 32 stored chunks. (verified: never reads another dataset's chunks after the first pagination batch - 40 chunks across 2 datasets / bc11d75)

**Confirmed problem:** after the first 32 chunks, the pagination range becomes an unbounded lower bound and can read another dataset's rows.

**Reference:** `src/storage/indexed-db.ts:509`.

### 4. Preserve recovery and failure reporting

- [x] Do not write a durable legacy-migration completion marker for memory-only migration. (verified: does not write the migration marker when the store is not persistent / ef4fe8d)
- [x] Verify a later reload with working storage retries migration successfully. (verified: retries migration on a later reload with working storage after memory fallback / ef4fe8d)
- [x] Preserve clear-operation cleanup failures in final UI state. (verified: reports partial clear failure in final state / ef4fe8d)
- [x] Report partial clear failure rather than silently implying complete removal. (verified: reports partial clear failure in final state / ef4fe8d)

**References:** `src/app/controller.ts:660`, `src/app/migrate-legacy.ts:203`, `src/app/migrate-legacy.ts:304`, `src/app/controller.ts:628-642`.

### 5. Harden backup validation and restore safety

- [x] Normalize decision identities before checking duplicates, or reject noncanonical identities explicitly. (verified: rejects noncanonical decision identities / 536282a)
- [x] Reject whitespace-only and normalization-equivalent duplicate keys. (verified: rejects whitespace-only decision identities; rejects duplicates that differ only by normalization / 536282a)
- [x] Verify every accepted backup survives serialize/parse round-trip. (verified: every accepted backup survives a serialize/parse round-trip / 536282a)
- [x] Evaluate a storage-level transaction for restoring all user-state categories together. (verified: decision record docs/superpowers/decisions/2026-09-06-restore-atomicity.md / 0851713; implementation deferred to Wave 2)

**Confirmed problem:** keys such as `" x "` and `"x"` can pass parsing, then normalize into duplicate keys during export and fail re-import.

**Reference:** `src/domain/backup.ts:96`.

**Additional risk:** restore uses separate category writes. Process termination between commits bypasses application rollback and can leave mixed state. This is a crash-consistency risk, not a reproduced browser crash.

## Phase 2: Repair Core Workflows

### 1. Keep Queue Mode queries queue-aware

- [x] Centralize mode-aware query dispatch for refresh, page changes, search/filter updates, and viewport requests. (verified: queue-mode dispatch regressions / 7b43332)
- [x] Preserve the include-list and queue-add order for every Queue Mode query. (verified: filter/page/viewport include-list regressions / 7b43332)
- [x] Keep normal filters and page state unchanged while queueing/mining. (verified: queue path skips preference persistence — exit restores saved normal filters / 7b43332)
- [ ] Test large-queue paging and scrolling, not only initial queue entry. (partial: paging verified / 7b43332; scroll anchoring deferred to Phase 5)

**Confirmed problem:** some query/page/viewport updates take the normal query path without the queue include-list and can display unqueued words while the UI still says Queue Mode.

**References:** `src/app/controller.ts:304`, `src/app/controller.ts:328`, `src/app/controller.ts:960`.

### 2. Use one canonical word identity

- [x] Remove controller-only case folding where it conflicts with imported identity. (verified: NHK/mixed-case regressions at worker, controller, queue-order, DOM / 7ca6bb3; UI unqueue click regression for mixed-case entry vs lowercase queue key / ae32335)
- [x] Use consistent identity for list decisions, review decisions, reset, queue add/remove, and worker matching. (verified: NHK/mixed-case regressions at worker, controller, queue-order, DOM / 7ca6bb3; UI unqueue click regression for mixed-case entry vs lowercase queue key / ae32335)
- [x] Test real uppercase and mixed-case imported terms, including `NHK`. (verified: NHK/mixed-case regressions at worker, controller, queue-order, DOM / 7ca6bb3; UI unqueue click regression for mixed-case entry vs lowercase queue key / ae32335)
- [x] Account for existing persisted identity semantics before changing normalization globally. (verified: no-migration lowercase-match design + compat analysis in task-2 report / 7ca6bb3)

**Confirmed problem:** controller lowercases keys while imported dataset identity preserves case. Decisions and queue membership can fail to match the corresponding row.

**References:** `src/app/controller.ts:342`, `src/app/controller.ts:410`, `src/domain/import.ts:56`.

### 3. Make Review errors and sessions reliable

- [x] Render non-null review errors independently of review status. (verified: review error alert + card retention, session generation, dataset-change stop regressions / 1a6eb69)
- [x] Keep the current card and retry controls visible after failed persistence. (verified: review error alert + card retention, session generation, dataset-change stop regressions / 1a6eb69)
- [x] Add a modal error region with appropriate alert semantics. (verified: review error alert + card retention, session generation, dataset-change stop regressions / 1a6eb69; role=alert region)
- [x] Stop/invalidate review when the active dataset changes. (verified: review error alert + card retention, session generation, dataset-change stop regressions / 1a6eb69)
- [x] Capture review-session generation in async queries and decision continuations. (verified: review error alert + card retention, session generation, dataset-change stop regressions / 1a6eb69)
- [x] Test stop/restart and dataset replacement during delayed operations. (verified: review error alert + card retention, session generation, dataset-change stop regressions / 1a6eb69)

**Confirmed problems:** failed decisions leave status `ready`, but the renderer only shows the error when status is `error`; dataset replacement can leave a stale review card visible.

**References:** `src/app/controller.ts:394`, `src/ui/renderer.ts:52`, `src/app/controller.ts:205`, `src/app/controller.ts:890`.

## Phase 3: Simplify The Interface

These are proposed UX changes unless explicitly identified as observed defects. Preserve the existing dark palette, Japanese-text emphasis, and Migaku-compatible sentence rendering.

### Observed Layout Measurements

| Viewport | Observation with imported fixture |
| --- | --- |
| Desktop, 1440 x 1000 | First entry begins approximately 1,014px down the page, below the initial viewport. |
| Mobile, 375 x 812 | First entry begins approximately 1,986px down the page. |
| Mobile sticky toolbar | Approximately 359px tall, consuming about 44% of viewport height. |

Measurements are fixture- and layout-dependent, not universal performance thresholds.

### 1. Reduce configuration above results

- [x] Collapse imports after successful load into a compact dataset/known-list summary with a Change Files control. (verified: import-collapse unit+e2e / 927db4e)
- [x] Keep full dropzones available in the empty state and when explicitly expanded. (verified: empty-state and expanded dropzone regressions / 927db4e)
- [x] Stop showing two complete filter interfaces simultaneously. (verified: single-toolbar disclosure e2e — one search input, sortSelect hidden until expanded / 5a93441)
- [x] Keep one compact toolbar and expose advanced controls on demand. (verified: advanced-panel regressions / 5a93441)
- [x] Separate Filters from Display options. (verified: fieldset legends e2e / 5a93441)
- [x] Keep search, mode, queue count, and essential navigation easy to reach. (verified: sticky row 1 retains search+queue+pager e2e / 5a93441)

**Filters:** search, effective knownness, sentence presence, decision, occurrences, and sorting.

**Display:** furigana, definitions, highlighting, and page size.

### 2. Clarify modes and entry hierarchy

- [x] Clearly distinguish Browse, Review, and Mining Queue. (verified: mode UI unchanged post-restructure — queue-header e2e shows queue mode banner while browse list and review overlay stay distinct / 5a93441)
- [x] Keep the current mode and exit action visible. (verified: queue-header e2e — queue mode visible, Exit Queue present / 5a93441)
- [x] Hide irrelevant controls without modifying saved normal filters. (verified: queue-hidden classes in advanced panel / 5a93441; queue path skips preference persistence — exit restores saved normal filters / 7b43332)
- [x] Present entries in this order: target/occurrence/badges, sentence, definition, compact actions. (verified: entry-order unit + mobile e2e / fbd6396)
- [x] Keep decision and queue controls outside the sentence DOM. (verified: .entry-actions row separate from .sentence — order assertions / fbd6396)
- [x] Preserve both Migaku-known and local-decision badges where applicable. (verified: badge unit assertion in T3 / fbd6396)

### 3. Improve mobile layout

- [x] Stack queue heading and actions on narrow screens. (verified: mobile-layout e2e queue section / fbd6396)
- [x] Allow queue actions and secondary toolbar controls to wrap or collapse. (verified: advanced disclosure + mobile wrap specs / 5a93441+fbd6396)
- [x] Prefer approximately 44px touch targets for primary actions. (verified: ≥44px bounding assertions at 320/375 / fbd6396)
- [ ] Validate 320px and 375px widths, larger text, and portrait/landscape layouts. (partial: 320/375 verified / fbd6396; larger-text and landscape checks deferred)

**Observed code defect:** queue heading/actions use a non-wrapping layout that crowds narrow screens.

**Reference:** `src/styles/entries.css:379`.

### 4. Improve labels and persistence copy

- [x] Replace ambiguous Known with Hide Known and Defs with Definitions. (verified: label text e2e / f76c4e3)
- [x] Ensure the primary Hide Known label includes locally marked Known words, not only Migaku imports. (verified: Hide Known label title mentions locally marked Known / f76c4e3)
- [x] Explain what highlight and pill options do. (verified: Display group adv-note explains Pill and highlighting / f76c4e3)
- [x] Replace tab-only persistence wording with Saved Locally In This Browser where appropriate. (verified: "Saved locally in this browser." data-area copy e2e / f76c4e3)
- [x] State that backups contain known words, decisions, and preferences, but exclude Jiten datasets and session queue. (verified: "not Jiten datasets or the session queue" scope-note copy e2e / f76c4e3)
- [x] Remind users to retain original CSV files. (verified: "Keep your original CSV files" reminder copy e2e / f76c4e3)
- [x] Move Clear Saved Data and portability controls into a clearly labeled Data settings area. (verified: fieldset.data-area legend + clear/export/restore controls e2e / f76c4e3)

**References:** `index.html:146`, `index.html:188`, `src/app/controller.ts:447`.

## Phase 4: Fix Accessibility

### Browser-Reproduced Focus Defects

- [x] Preserve or intentionally restore focus after Queue and decision actions rerender entries. (verified: focus restoration tiers + review trap + inert + return-focus unit/e2e / 4a565d7)
- [x] When a row disappears, focus the next relevant entry or the results heading. (verified: focus restoration tiers + review trap + inert + return-focus unit/e2e / 4a565d7)
- [x] Contain keyboard focus inside Review and make background controls inert. (verified: focus restoration tiers + review trap + inert + return-focus unit/e2e / 4a565d7)
- [x] Retain return-focus behavior when Review closes. (verified: focus restoration tiers + review trap + inert + return-focus unit/e2e / 4a565d7)

**Observed:** activating Queue moves focus to `body`; Shift+Tab from the opened Review panel reaches the background `bottomNext` button.

**References:** `src/ui/renderer.ts:304`, `index.html:199`, `src/ui/controls.ts:314`.

### Other Accessibility Changes

- [x] Add a keyboard/touch-accessible Show Full Definition disclosure instead of relying on `title` for truncated content. Reference: `src/ui/renderer.ts:238`. (verified: definitions disclosure opens via keyboard e2e — details/summary replaces title / 2514aeb)
- [x] Use one visible, clearly focused control per file picker; remove invisible keyboard stops. Reference: `src/styles/layout.css:84`. (verified: single dropzone focus stop markup e2e — no tabindex stops / 2514aeb)
- [x] Brighten secondary text to meet 4.5:1 contrast on all surfaces where small text appears. Reference: `src/styles/tokens.css:4`. (verified: #8a94a8 ≥4.76:1 on all surfaces, math in task report / 2514aeb)
- [x] Account for sticky-toolbar height when scrolling to results, and focus the results heading after keyboard pagination. Reference: `src/ui/controls.ts:158`. (verified: keyboard + click pagination focus #resultsHeading clear of sticky toolbar e2e; scroll-margin comment follow-up / 2514aeb+5cb19e6)
- [x] Restrict `lang="ja"` to Japanese target/sentence text rather than English definitions and messages. Reference: `index.html:206`. (verified: lang scoping markup e2e — reviewContent carries no lang, only target/sentence tagged / 2514aeb)
- [x] Allow single-letter shortcuts to be disabled or scope them to an explicitly focused interaction surface. Reference: `src/ui/controls.ts:314`. (verified: letter shortcuts inert inside toolbar, native button activation untouched e2e / 2514aeb)
- [x] Add an explicit accessible label to sticky search. Reference: `index.html:110`. (verified: #stickySearch aria-label markup e2e / 2514aeb)
- [x] Narrow live announcements to concise counts/status instead of the entire rebuilt results list. Reference: `index.html:106`. (verified: #results not aria-live; #resultStats/#queueStats aria-live=polite markup e2e / 2514aeb)
- [x] Respect `prefers-reduced-motion` for smooth scrolling and decorative transitions. (verified: prefers-reduced-motion media queries disable transitions in tokens.css and layout.css / 2514aeb)

Actual screen-reader announcement behavior still needs assistive-technology testing.

## Phase 5: Harden Performance And Parsing

### 1. Preserve virtual-scroll position

- [x] Preserve visible item and pixel offset when measured heights change. (verified: estimate-change compensation regressions incl. shrink + hysteresis / 86b5e3f)
- [x] Handle shrinking rows as well as growth. (verified: estimate-change compensation regressions incl. shrink + hysteresis / 86b5e3f)
- [x] Test deep scrolling with variable sentence lengths, furigana, definition toggles, and viewport resizing. (verified: estimate-change unit regressions + perf e2e deep scroll past row 40,000 on a 100k import / 86b5e3f; viewport-resize-specific case relies on unchanged ratio-based handler math, no dedicated resize regression)
- [x] Keep mounted DOM bounded throughout. (verified: maxNodes slice unchanged + existing perf spec 100k DOM count assertions / 86b5e3f)

**Confirmed problem:** replacing the global average row-height estimate changes all preceding spacers without anchoring the visible content. At row 50,000, changing the estimate from 100px to 200px adds 5,000,000px above mounted rows.

**Reference:** `src/ui/virtual-list.ts:84`.

### 2. Improve worker query/cache lifecycle

- [x] Cache ordered filtered indexes independently of pagination mode. (verified: numeric-page scan-count regression / fe69d0d)
- [x] Decorate only the requested numeric page rather than copying every matched entry before slicing. (verified: page-slice correctness + loop bound ≤ pageSize / fe69d0d)
- [x] Validate dataset generation before publishing query-cache results. (verified: stale-query-after-replacement regression / fe69d0d)
- [x] Add dataset unload or bounded retention for completed datasets. (verified: LRU-3 eviction + reload-recency regressions / fe69d0d c9d30cb)
- [x] Test overlapping query/replacement operations and repeated large imports. (verified: replacement suppression + 5-load bounded regressions / fe69d0d)

**Confirmed problems:** numeric pagination copies all matches; an old in-flight query can publish stale indexes after replacement; loaded datasets accumulate until worker disposal.

**References:** `src/worker/worker-engine.ts:358`, `src/worker/worker-engine.ts:278`, `src/worker/worker-engine.ts:126`.

### 3. Handle asynchronous worker failure promptly

- [x] Attach rejection handling immediately when dataset loading begins. (verified: prompt-rejection without unhandledrejection + iterator-stop regressions / 357ca0e)
- [x] Stop or race iterator consumption against operation failure. (verified: prompt-rejection without unhandledrejection + iterator-stop regressions / 357ca0e)
- [x] Test worker failure while awaiting the next asynchronous chunk. (verified: prompt-rejection without unhandledrejection + iterator-stop regressions / 357ca0e)

**Confirmed problem:** internal load promises can reject before a handler is attached, emitting unhandled rejection despite the caller catching `loadDataset()`.

**Reference:** `src/app/worker-client.ts:299`.

### 4. Fix parsing and target reconciliation

- [x] Strip a leading BOM before CSV tokenization, including quoted first headers. Reference: `src/domain/text.ts:9`. (verified: BOM plain+quoted header regressions / ab06456)
- [x] Preserve the intended target offset/range when reconciling highlighting instead of choosing the first sentence-wide text match. Reference: `src/ui/highlight-adapter.ts:95`. (verified: occurrence-ordinal reconciliation regressions / ab06456)
- [x] Add repeated-target tests with ruby and extension-split text nodes. (verified: ruby + idempotent re-reconcile regressions / ab06456)

### Optional Technical Improvements

- [ ] Evaluate versioned worker-resident known/decision sets to avoid cloning, sorting, and serializing whole collections on every window request.
- [ ] Match worker responses to pending operation types and validate dataset identity and payload shape.
- [ ] Review newest-file discovery's first-20-candidate limit against its documented guarantee.
- [ ] Add defensive snapshot tests before treating nested controller state as immutable.
(deferred: excluded from wave 4 scope by plan; tracked for wave 5+)

No framework rewrite is recommended. Prefer focused changes over broad restructuring.

## Phase 6: Strengthen Tests And Delivery

- [x] Repair backup negative tests to start from a complete valid baseline, mutate one field, and assert the intended validation message/field. (verified: complete-baseline+single-mutation rewrite, 15 vacuous tests repaired / da38539)
- [x] Add delayed-write concurrency tests for clear, restore, decisions, preferences, and dataset changes. (verified: delayed-store suites for clear/restore/decisions/preferences/imports / e79b74e 33f48dd)
- [x] Add mobile layout and keyboard-focus regressions. (verified: mobile-layout.spec.ts + keyboard-focus specs / fbd6396 4a565d7)
- [x] Add deep-scroll, row-shrink, and resize regressions. (verified: virtual-list estimate-change + shrink + resize guard regressions / 86b5e3f 937c105)
- [x] Add multi-dataset IndexedDB chunk-boundary coverage. (verified: pagination-bounds regression, 40 chunks × 2 datasets / bc11d75)
- [x] Test the production build and actual static-serving path, not only the development server. (verified: production suite over real dist, root-served / 59b10d6)
- [x] Verify worker import/query and legacy redirect behavior against production output. (verified: prod worker import+decision round-trip + legacy redirect specs / 59b10d6)
- [x] Fix or document launcher folder discovery: the launcher serves `dist`, while advertised vocabulary folders live outside it. (verified: root-serving launcher + origin-absolute discovery, prod interception spec / 6d5078c)
- [x] Do not silently bundle private vocabulary files into distributable builds when fixing folder discovery. (verified: dist 404 assertions for vocab folders + DL / 59b10d6 6d5078c)
- [x] Add browser coverage beyond desktop Chromium for browsers the project claims to support. (verified: firefox + webkit projects, dev 123/123 + prod 18/18; Edge = Chromium family not separately tested / e3f015a)
- [x] Align documented and declared Node requirements with installed tooling. (verified: engines >=22.12.0, CI node 22, README/bat aligned / e3f015a)
- [x] Consider removing `passWithNoTests: true` and disabling existing-server reuse in CI. (verified: removed + reuseExistingServer !CI / e3f015a)

**Confirmed test gap:** many malformed-backup fixtures omit required `exportedAt`, so tests fail before reaching the validation branch they claim to exercise.

**References:** `tests/domain/backup.test.ts:170`, `playwright.config.ts:15`, `start-miner.bat:23`, `vitest.config.ts:7`.

## Phase 7: Add High-Value Features

Implement after reliability and core usability fixes. These are proposed enhancements, not defects unless already required by an existing task plan.

| Feature | Purpose | Scope |
| --- | --- | --- |
| Vocabulary Coverage Analysis | Show tracked occurrence coverage and a highest-frequency unknown priority path. | Implement `DL/TASKS/05-coverage-analysis.md`; keep heavy computation in the worker. |
| One-step Undo | Recover accidental Known/Mined/Skip/Later decisions during triage. | Define restoration behavior for both the prior decision and queue membership. |
| Active-filter chips and Reset Filters | Explain why entries disappeared and recover from overly restrictive filters. | Reuse existing query state; distinguish filtered-empty from no dataset. |
| Compact decision summary | Show Known/Mined/Later/Skipped progress without a large dashboard. | Label imported knownness separately from local decisions. |
| Backup freshness indicator | Show last successful export and changes since export. | Do not imply that exporting guarantees the user retained the download. |
| Reading display controls | Offer sentence size and compact/comfortable density. | Verify virtualization anchoring after every height-affecting preference. |

### Phase 7 Verification

- Vocabulary Coverage Analysis: (verified: coverage suite — 17 domain units, worker/controller/renderer coverage tests, 11-step e2e scenario, worker-resident perf-bounded computation / b073851 3d93f9e a622288 e8d61a3 365fac6 c1b6d20) — Review unreviewed by frequency deferred (needs review sort-override surface)
- One-step Undo: (verified: controller+UI+e2e / 39ba993)
- Active-filter chips and Reset Filters: (verified: derivation matrix + e2e / ee3c2d7)
- Compact decision summary: (verified: renderer units / 7f3113d)
- Backup freshness indicator: (verified: increment/reset/copy units / 4ae14b6)
- Reading display controls: (verified: anchoring pins + e2e computed-size + reload / 3611288)

Avoid expanding into SRS, cloud sync, or direct card integrations until the local workflow is dependable.

## Implementation Order

1. Protect data: storage boundaries, fallback coherence, clear/restore serialization, migration recovery, and backup validation.
2. Repair workflows: queue queries, canonical identity, review sessions/errors, and keyboard focus.
3. Simplify UI: collapsed imports, one toolbar, mobile layout, clearer entry hierarchy, and persistence copy.
4. Harden performance and delivery: scroll anchoring, cache generations, worker failures, and production smoke tests.
5. Add coverage, Undo, and selected productivity enhancements.

Use a failing regression test for each confirmed defect before changing implementation. Keep changes small, preserve existing user work, and avoid unrelated cleanup.

## Completion Criteria

- [x] Confirmed data-integrity failures have regression coverage and no longer reproduce. (verified: Phase 1 — storage-fallback transfer/export 5588970, clear/restore serialization e79b74e, chunk pagination bounds bc11d75, migration recovery ef4fe8d, backup validation round-trip 536282a)
- [x] Queue and Review preserve their documented behavior under async operations. (verified: queue-mode dispatch/include-list regressions 7b43332, review session generation + error rendering 1a6eb69, restore-failure review regeneration e997aa6)
- [x] Keyboard-only import, browsing, decisions, review, and queue workflows retain meaningful focus. (verified: focus restoration tiers + review trap + inert + return-focus unit/e2e 4a565d7, keyboard specs across accessibility/word-decisions/review-mode suites)
- [x] Mobile controls remain usable at 320px and 375px without obscuring most reading space. (verified: mobile-layout e2e — audit order without horizontal overflow, ≥44px touch targets, sticky toolbar inside viewport / fbd6396; larger-text/landscape validation deferred, see Phase 3)
- [x] Large datasets remain bounded in DOM and stable during deep scroll and resizing. (verified: estimate-change anchoring incl. shrink 86b5e3f, resize guard 937c105, windowed-exit/dataset-change render invalidation c1b6d20, perf e2e 100k deep-scroll bounded DOM)
- [x] Accepted backups round-trip and restore without silently losing user-state categories. (verified: every accepted backup serialize/parse round-trip 536282a, e2e export/restore of known words, decisions, preferences)
- [x] Production-serving workflow is covered by smoke tests. (verified: production suite over real dist, root-served — boot, worker import/query, legacy redirect, asset types, no bundled vocab / 59b10d6 6d5078c; this run 18/18)
- [x] `npm run check` passes. (verified: this run — typecheck + 568 unit tests + production build, 2026-09-07)
- [x] `npm run test:e2e` passes with new regression cases. (verified: this run — 150 passed across 3 browsers incl. coverage, one-step undo, filter-chips, display-controls, mobile, perf specs, 2026-09-07)
- [x] Completed work is checked off using verification evidence, not implementation intent. (verified: every checked box in this audit cites a regression test, spec run, or measured check)

Target outcome: less configuration on screen, more readable sentences, reliable decisions, and recoverable mistakes.
