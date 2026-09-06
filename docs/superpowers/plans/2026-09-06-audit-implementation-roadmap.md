# Audit Implementation Roadmap

> **For agentic workers:** This roadmap sequences the fixes from `DL/WEBSITE-IMPROVEMENT-AUDIT.md` into execution waves. Each wave gets its own detailed plan (TDD, bite-sized tasks) written just before the wave starts, grounded in then-current code. Wave 1's plan is already written: `2026-09-06-phase1-protect-user-data.md`.

**Goal:** Resolve every confirmed defect and accepted improvement in `DL/WEBSITE-IMPROVEMENT-AUDIT.md` (baseline commit `cde5343`) in verified, reviewable increments.

**Architecture:** Single-page app: `src/app/controller.ts` (state machine + storage orchestration), `src/worker/*` (in-memory dataset engine), `src/storage/*` (IndexedDB / memory AppStore), `src/ui/*` (DOM renderer, virtual list). No framework rewrite. Focused changes only.

**Tech Stack:** TypeScript, Vite, Vitest (+fake-indexeddb, happy-dom), Playwright (Chromium e2e).

**Spec:** `DL/WEBSITE-IMPROVEMENT-AUDIT.md` — the audit travels with every wave plan.

## Global Constraints

- No framework rewrite; no unrelated cleanup mixed into defect fixes (audit: "Keep changes small").
- Every confirmed defect gets a failing regression test BEFORE the implementation change (audit line 299).
- Dark palette, Japanese-text emphasis, and Migaku-compatible sentence rendering are preserved (audit Phase 3 preamble).
- `npm run check` (typecheck + 310+ tests + build) and `npm run test:e2e` must pass at the end of every wave.
- Audit checkboxes are checked off only with verification evidence, not implementation intent (audit Completion Criteria).
- Commits follow existing conventional style (`feat:`, `fix:`, `test:`, `docs:`).

## Wave Order And Plan Files

| Wave | Audit phases covered | Plan file (written when wave starts) |
| --- | --- | --- |
| 1. Protect user data | Phase 1 (all 5 items) | `2026-09-06-phase1-protect-user-data.md` (READY) |
| 2. Repair core workflows + focus | Phase 2 (queue queries, identity, review) + Phase 4 "Browser-Reproduced Focus Defects" | `2026-09-06-phase2-core-workflows.md` |
| 3. Simplify UI + remaining a11y | Phase 3 (layout, modes, mobile, copy) + Phase 4 "Other Accessibility Changes" | `2026-09-06-phase3-ui-a11y.md` |
| 4. Harden performance/parsing | Phase 5 (scroll anchoring, worker lifecycle, async failure, parsing, optional items) | `2026-09-06-phase4-performance-parsing.md` |
| 5. Strengthen tests/delivery | Phase 6 (test repair, production smoke, launcher, CI, Node alignment) | `2026-09-06-phase5-tests-delivery.md` |
| 6. High-value features | Phase 7 (coverage analysis, undo, filter chips, etc.) | `2026-09-06-phase6-features.md` |

Rationale for reordering audit Phase 4: keyboard-focus defects are core workflow bugs (fixed in Wave 2 on current DOM), while labeling/contrast/live-region fixes land in Wave 3 AFTER the Phase 3 DOM restructuring, so a11y work is not invalidated by re-layout.

## Wave Summaries

### Wave 1 — Protect user data (audit Phase 1)
Plan exists: `2026-09-06-phase1-protect-user-data.md`. Tasks: dataset-bounded IndexedDB chunk pagination; fallback state transfer + coherent backup export; clear/restore serialization via a user-state lock + epoch invalidation; memory-only migration must not write the durable marker + clear-failure reporting; backup identity canonicalization + round-trip guarantee; restore-atomicity decision record.

### Wave 2 — Core workflows (audit Phase 2 + focus defects)
- **Queue-aware queries:** centralize mode-aware dispatch — every `runQuery` caller path (`updateQuery`, `changePage`, `updateViewport`, `runQuery` after decisions) must route through one dispatcher that adds `includeNormalizedWords` + `queryChannel: "queue"` when `state.queue.mode === "queue"`. Files: `src/app/controller.ts` (`runQuery`/`runQueueQuery` merge into `dispatchQuery`), tests `tests/app/mining-queue.test.ts` + e2e large-queue paging.
- **Canonical word identity:** decide one identity function (imported `normalizedWord` case-preserving vs controller `.toLocaleLowerCase()`); audit requires accounting for persisted semantics first (decision keys already stored lowercased — needs a data-compat check before global change). Files: `src/app/controller.ts:342,410`, `src/domain/import.ts:56`, worker `cacheSearchFields`. Tests with `NHK`-style mixed-case fixtures.
- **Review reliability:** render `review.errorMessage` regardless of status; keep card + retry visible after failed persistence (renderer change `src/ui/renderer.ts:52`); stop review on dataset change; review-session generation captured in `runReviewQuery` + `reviewDecision` continuations (`src/app/controller.ts:205,890`).
- **Focus defects:** focus restoration after Queue/decision rerenders; focus next entry or results heading when row disappears; focus trap + background `inert` while Review open; return focus on close. Files: `src/ui/renderer.ts:304`, `src/ui/controls.ts:314`, `index.html:199`. Regressions: keyboard-only e2e.

### Wave 3 — UI simplify + a11y (audit Phase 3 + Phase 4 remainder)
- Collapse imports post-load into summary + Change Files; single toolbar; Filters vs Display separation (`index.html`, `src/ui/controls.ts`, styles).
- Entry hierarchy: target/occurrence/badges → sentence → definition → compact actions; decision/queue controls outside sentence DOM (`src/ui/renderer.ts`).
- Mobile: wrapping queue heading (`src/styles/entries.css:379`), 44px targets, 320/375px validation.
- Copy: Hide Known / Definitions labels, "Saved Locally In This Browser", backup-scope copy, Data settings area (`index.html:146,188`, `src/app/controller.ts:447`).
- A11y remainder: Show Full Definition disclosure (renderer:238), single file-picker focus stop (layout.css:84), contrast 4.5:1 (tokens.css:4), sticky-offset scrolling + heading focus after pagination (controls.ts:158), `lang="ja"` scoping (index.html:206), shortcut scoping/disable (controls.ts:314), sticky search label (index.html:110), narrow live region (index.html:106), `prefers-reduced-motion`.
- Each height-affecting display change re-verifies Wave 4's scroll anchoring interplay (audit Phase 7 note).

### Wave 4 — Performance/parsing (audit Phase 5)
- **Scroll anchoring:** anchor visible item + pixel offset when average row-height estimate changes; handle shrink; keep DOM bounded (`src/ui/virtual-list.ts:84`). Regression: deep scroll with variable heights, resize, row shrink.
- **Worker cache lifecycle:** cache ordered indexes for numeric pagination too; decorate only requested page; validate dataset generation before publishing (stale-publish after replacement); dataset unload/retention (`src/worker/worker-engine.ts:126,278,358`). Overlapping query/replacement tests.
- **Async worker failure:** attach rejection handler at load start; race iterator vs failure (`src/app/worker-client.ts:299`).
- **Parsing:** BOM strip before CSV tokenize (`src/domain/text.ts:9`); target offset/range reconciliation in highlighting (`src/ui/highlight-adapter.ts:95`); ruby + repeated-target tests.
- Optional items (versioned known/decision sets, response validation, newest-file limit) only if cheap after the above.

### Wave 5 — Tests/delivery (audit Phase 6)
- Repair backup negative tests to complete-valid-baseline + single mutation (`tests/domain/backup.test.ts:170`).
- Add delayed-write concurrency, mobile layout, keyboard-focus, deep-scroll/resize, multi-dataset chunk-boundary suites (many land inside Waves 1–4; Wave 5 audits coverage gaps).
- Production build smoke test against real static serving (dist), worker import/query + legacy redirect against production output.
- Fix launcher folder discovery without bundling private vocabulary files (`start-miner.bat:23`).
- `passWithNoTests` removal, CI existing-server reuse, Node/docs alignment (`vitest.config.ts:7`, `playwright.config.ts:15`).

### Wave 6 — Features (audit Phase 7)
Order: Vocabulary Coverage Analysis (`DL/TASKS/05-coverage-analysis.md`, worker-resident) → One-step Undo → filter chips + Reset Filters → compact decision summary → backup freshness indicator → reading display controls. Each feature: spec check against audit scope column, then its own task breakdown inside the wave plan.

## Verification Cadence

Every task: failing test → minimal fix → targeted test run → commit. Every wave end: `npm run check` + `npm run test:e2e` + manual browser pass for UI waves + check off audit boxes with evidence links (commit hash / test name).
