# Phase 6: High-Value Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit Phase 7 — Vocabulary Coverage Analysis (per the binding task spec `DL/TASKS/05-coverage-analysis.md`), One-step Undo, active-filter chips + Reset Filters, compact decision summary, backup freshness indicator, reading display controls — plus the Wave-5 follow-up (reviewGeneration symmetry). No SRS/cloud-sync/card integrations (audit line 289 prohibition).

**Architecture:** Coverage = pure domain fn → worker protocol request → controller lifecycle (generation-guarded) → collapsible UI panel with Focus button reusing existing filters. Undo = single-entry controller stack restoring prior decision status AND prior queue membership. Chips = renderer-derived from `state.query`, removal via `updateQuery` patches; Reset = full `DEFAULT_QUERY` reset. Decision summary + freshness = small derived UI from existing state + two new controller fields. Reading controls = two new `ViewState` fields with CSS classes; virtualization anchoring verified per audit requirement.

**Tech Stack:** unchanged. Playwright cross-browser (3 projects) + prod suite all stay green.

**Spec:** `DL/WEBSITE-IMPROVEMENT-AUDIT.md` Phase 7 (lines 276-289) + `DL/TASKS/05-coverage-analysis.md` (BINDING for Tasks 2-5).

## Global Constraints

- `DL/TASKS/05-coverage-analysis.md` is the binding spec for coverage: its Definitions, Metrics, target math, architecture (worker-resident, no entries to main thread), invalidation rules, copy requirements, and acceptance criteria are requirements — follow verbatim unless this plan overrides (it does not).
- Failing regression before every behavioral change; e2e per feature where the audit table implies user-visible workflow.
- Preserve: dark palette, Japanese emphasis, Migaku sentence rendering, queue preference-skip semantics (wave-2 ruling), audit "no second filter system" (Focus reuses existing filters).
- `npm run check` + `npm run test:e2e` (3 browsers) + `npm run test:e2e:prod` green at wave end.
- Conventional commits.

---

### Task 1: reviewGeneration symmetry (Wave-5 follow-up)

**Files:** `src/app/controller.ts` (4 restore-failure paths ~486/494/536/559), `tests/app/controller.test.ts`
**Binding:** add `this.reviewGeneration += 1;` alongside each existing `this.queryGeneration += 1;` on the four restore-failure exits (clearSavedData already bumps all three — mirror it). Regression: review active + gated restore failure → stale review continuation publishes nothing into the post-failure state; review error/surface not clobbered. RED via temp-revert pattern if GREEN-first.
Commit `fix: bump review generation on restore failure paths`

### Task 2: Coverage — pure domain math

**Files:** create `src/domain/coverage.ts`, `tests/domain/coverage.test.ts`
**Binding:** DL/TASKS/05 Task 1 verbatim — `computeCoverage(entries, knownWords, decisions, targets?)` with `CoverageStats`/`CoverageTargetResult` exactly as spec'd (types exported from coverage.ts or types.ts — spec file map allows either); shared effective-known helper (canonical lowercase matching per wave-2 identity); ALL spec test cases (basic, manual-known, mined-not-known, negative occurrences, zero-total null, target path, deterministic ties).
Commit `feat: compute tracked vocabulary coverage`

### Task 3: Coverage — worker protocol + engine

**Files:** `src/worker/protocol.ts`, `src/worker/worker-engine.ts`, `src/worker/miner.worker.ts`, `src/app/worker-client.ts`, tests `tests/worker/*`, `tests/app/worker-client.test.ts`
**Binding:** DL/TASKS/05 Task 2 + Architecture/Worker verbatim — coverage request/response in protocol (bump nothing: WORKER_PROTOCOL_VERSION stays 1 unless adding a type breaks compat — it is additive, keep version); engine `coverage(request)` delegates to domain fn over the complete dataset (LRU-touched, generation-guarded like query); worker-client `coverage(input)` method. All 5 spec test bullets (matches pure fn; wrong/missing dataset typed error; known/decision changes change result; normal query windows unaffected; no IndexedDB in worker).
Commit `feat: expose coverage through worker`

### Task 4: Coverage — controller lifecycle

**Files:** `src/app/state.ts` (+coverage/coverageStatus), `src/app/controller.ts`, `tests/app/controller.test.ts`
**Binding:** DL/TASKS/05 Task 3 + Architecture/Controller-state verbatim — state fields as spec'd; requests after dataset load / known import / decision changes / restore; coverageGeneration guard (stale ignored); does NOT recompute for view toggles/pages/search (assert at least one negative case); errors nonfatal (results list intact, coverageStatus "error" surface). FakeWorkerClient gains coverage support for tests.
Commit `feat: wire coverage lifecycle into controller`

### Task 5: Coverage — UI panel + e2e + perf

**Files:** `index.html`, `src/ui/dom.ts`, `src/ui/renderer.ts`, `src/ui/controls.ts`, `src/styles/*`, `tests/ui/coverage-panel.test.ts`, `tests/e2e/coverage.spec.ts`, `tests/e2e/performance.spec.ts` (augment)
**Binding:** DL/TASKS/05 Task 4 (UI) + Task 5 (e2e, all 11 steps) + Task 6 (perf: no extra DOM rows, stays in worker, bounded scroll; generous timeout not wall-clock) + Copy requirements verbatim ("Tracked vocabulary occurrence coverage", avoid forbidden phrases, threshold copy format). Collapsed summary + expanded panel above results list; Focus button = `updateQuery({hideKnown: true, sort: "occ-desc", page: 1})` ONLY (preserve sentence/kana/minocc/search); optional "Review unreviewed by frequency" button (spec allows) — implement per spec (temporarily derives review sort without touching user sort — if review-mode integration proves nontrivial, defer that ONE button with a ledger note; core Focus is required).
Commit `feat: add coverage analysis panel` (+ `test: cover coverage workflow` if split)

### Task 6: One-step Undo

**Files:** `src/app/controller.ts`, `src/app/state.ts` (undo surface fields), `index.html`, `src/ui/dom.ts`, `src/ui/renderer.ts`, `src/ui/controls.ts`, tests app+ui
**Binding (design):** controller keeps a single-entry undo record set by `applyWordDecision` BEFORE mutation: `{ normalizedWord, previousStatus: WordDecisionStatus | "unreviewed", previousQueueMembership: boolean }` (queue membership captured because a successful decision removes the word from the queue — audit: "Define restoration behavior for both the prior decision and queue membership"). `undoLastDecision()`: if record exists → re-apply previous status via the same decision path, and if previousQueueMembership && word not currently queued → re-add via setQueueWords (respecting queue dataset semantics). State: `undo: { available: boolean; label: string | null }` (label like `Undo Known — 新しい`) refreshed on each decision; cleared on dataset change, clear, restore. UI: button in results-head (normal + queue modes) AND review panel footer ("Undo last") enabled when available; keyboard `z` when not typing + not in toolbar (same scoping family as n/p). Clear/restore/import reset it. Tests: undo known→unreviewed restores decision AND queue membership; undo after mined; undo unavailable after clear/restore; double-undo no-ops; review decision undoable; e2e: decide, undo, verify badge gone + word re-queued if it was queued.
Commit `feat: one-step undo for triage decisions`

### Task 7: Active-filter chips + Reset Filters

**Files:** `index.html`, `src/ui/dom.ts`, `src/ui/renderer.ts`, `src/ui/controls.ts`, `src/styles/*`, tests ui + e2e
**Binding (design):** chips row (`.filter-chips`, in results head area / under toolbar) derived in renderer from `state.query` for: non-empty search, hideKnown, hideKanaOnly, sentence≠"any", decision≠"all", minOccurrences>1 — each chip `button.filter-chip` with label + "×", `data-filter-chip="<key>"`; click → `controller.updateQuery({ [key]: default })` (search:"", hideKnown:false, etc. — single-field reset). "Reset Filters" button visible ONLY when any chip active → `updateQuery({...DEFAULT_QUERY})` (full reset incl. sort/page; keeps nothing — "recover from overly restrictive filters"). Filtered-empty state (dataset non-null, totalEntries===0): existing empty message gains chips + Reset (distinguishes from no-dataset empty — already distinct). Tests: chip derivation matrix; chip removal single-field; reset full-default; filtered-empty shows chips+reset while no-dataset does not; e2e: set restrictive filters → chips visible → remove one → list updates → Reset → defaults.
Commit `feat: active filter chips and reset filters`

### Task 8: Compact decision summary

**Files:** `index.html`, `src/ui/dom.ts`, `src/ui/renderer.ts`, `src/styles/*`, tests ui
**Binding (design):** one compact line in the results-head stats area: `Decisions: K known · M mined · L later · S skip · — · Migaku-known: N` derived from `state.wordDecisions` counts + `knownWords.size`; label imported knownness separately (audit wording); hidden when no dataset AND zero decisions AND no known list. Unit: counts matrix + separation of labels + hidden-state.
Commit `feat: compact decision summary line`

### Task 9: Backup freshness indicator

**Files:** `src/app/controller.ts`, `src/app/state.ts`, `index.html`, `src/ui/dom.ts`, `src/ui/renderer.ts`, tests
**Binding (design):** controller fields `lastExportAt: string | null` (ISO) + `changesSinceExport: number`; increment counter on every durable user-state mutation AFTER export (decision set/remove, known import, restore, preference persist — increment once per logical mutation, not per retry); `exportBackup()` sets both (0). clearSavedData resets to null/0 (persisted? NO — session-only; do not persist: freshness is advisory). Renderer: line in Data area: `Last export: <relative or date> · <n> changes since export` or `No export this session`; copy must NOT imply retention guaranteed (audit). Tests: increments on decision/known/restore; export zeroes; clear nulls; renderer copy; nonfatal.
Commit `feat: backup freshness indicator`

### Task 10: Reading display controls

**Files:** `src/app/state.ts` (ViewState + defaults), `src/app/controller.ts` (updateView already generic), `index.html` (Display group controls), `src/ui/dom.ts`, `src/ui/renderer.ts` (body classes), `src/styles/*`, `tests/ui/virtual-list.test.ts` (anchoring), tests ui + e2e
**Binding (design):** `ViewState` gains `sentenceSize: "medium" | "large"` + `density: "comfortable" | "compact"` (defaults medium/comfortable — existing look unchanged); body classes `sent-size-lg`, `density-compact` toggled in renderer syncControls; controls in Display group (two selects); persisted via existing preference path (backup view schema grows — `validateView` in backup.ts must accept the new fields with defaults for OLD backups: additive optional handling — old backups restore to defaults). CSS: `.sent-size-lg .sentence { font-size: clamp up }`, `.density-compact .mining-entry { padding/borders reduced }`. AUDIT REQUIREMENT: "Verify virtualization anchoring after every height-affecting preference" — unit regressions: toggling each class with mounted windowed rows → estimate re-measure compensates (extend wave-4 anchoring tests); e2e: toggle both → list still renders, no layout explosion. Backup round-trip test with new fields + old-backup compat test.
Commit `feat: reading display controls with virtualization verification`

### Task 11: Wave verification and audit bookkeeping

- [ ] `npm run check`; `npm run test:e2e` (3 browsers); `npm run test:e2e:prod`. Record counts.
- [ ] Audit Phase 7: check the 6 feature-table rows' intent via evidence appended to EACH row's Purpose cell? NO — the table has no checkboxes. Instead: append a `### Phase 7 Verification` subsection under the table with 6 evidence lines (one per feature: test/spec names + SHAs). Also mark roadmap progress if roadmap has checkboxes (it doesn't). Leave "Avoid expanding into SRS…" line untouched.
- [ ] DL/TASKS/05 acceptance criteria: check ALL its boxes with evidence (it has its own checklist — `git add -f` needed for DL path).
- [ ] Commit `docs: check off coverage acceptance criteria and phase 7 verification`

---

## Self-Review Notes

- Spec coverage: Phase 7 table row 1 → Tasks 2-5 (binding DL/TASKS/05); undo → Task 6; chips → Task 7; summary → Task 8; freshness → Task 9; reading controls → Task 10; Wave-5 follow-up → Task 1.
- Review-unreviewed-by-frequency button: spec-optional; defer-with-note escape hatch in Task 5.
- ViewState growth touches backup schema — old-backup compat is a first-class requirement (Task 10).
- Perf regression (Task 5) reuses 100k suite; no wall-clock benchmarks (spec prohibition).
