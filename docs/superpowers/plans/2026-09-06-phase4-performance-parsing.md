# Phase 4: Harden Performance And Parsing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit Phase 5 — virtual-scroll anchoring, worker query/cache lifecycle, async worker-failure handling, parsing/target reconciliation — plus the Wave-3 carry-overs (conditional scroll-margin, CSS dedupe, role=group).

**Architecture:** Virtual list keeps the estimate-based spacer model but gains content-anchored scroll compensation when the estimate changes (grow OR shrink). Worker engine caches ordered indexes for ALL pagination modes, decorates only the requested page, validates dataset generation before publishing/sending, and bounds retained datasets (LRU). Worker-client attaches rejection handling to load promises immediately and stops iterator consumption on failure. Parsing: BOM stripped before tokenization; highlight reconciliation receives the intended occurrence ordinal instead of first-match.

**Tech Stack:** TypeScript, Vite, Vitest (happy-dom — note: getBoundingClientRect returns zeros there; the existing tests/ui/virtual-list.test.ts harness shows how heights are faked), Playwright Chromium.

**Spec:** `DL/WEBSITE-IMPROVEMENT-AUDIT.md` Phase 5 (lines 207-255).

## Global Constraints

- Failing regression before every implementation change.
- Audit Phase 5 optional items (versioned known/decision sets, worker response-type matching, newest-file 20-candidate limit, controller snapshot tests) are EXPLICITLY DEFERRED — do not implement; ledger records the deferral for the audit evidence line.
- 100k-row e2e must stay green and not regress in runtime materially (Task 6 records timing).
- `npm run check` + `npm run test:e2e` green at wave end.
- Conventional commits.

---

### Task 1: Virtual-scroll anchoring on measured-height changes

**Files:**
- Modify: `src/ui/virtual-list.ts`
- Test: `tests/ui/virtual-list.test.ts`

**Interfaces:**
- Produces (internal): `setWindow` measures mounted children as today, but the estimate update becomes bidirectional (grow AND shrink toward measured average, with a small hysteresis: only adopt a new estimate when |measured − estimate| / estimate > 0.05, so noise doesn't churn). When the estimate changes while content is mounted, apply CONTENT-ANCHORED compensation: capture `(visibleIndex, pixelOffsetIntoContent)` semantics by adjusting scrollTop by exactly the spacer-top delta (`newSpacerTop − oldSpacerTop`) BEFORE the DOM swap lands in view — i.e. compute both spacer tops, shift `scrollTarget` scrollTop by their difference, so the visible item and pixel offset are preserved. Scroll target is the `window` (as handleScroll assumes) — guard for test environments via the existing ScrollTarget shape (add optional `scrollTo`-like access: the implementation reads `window.scrollY`/sets `window.scrollTo(0, y)`; in happy-dom these exist and are functional enough for assertion).
- `handleScroll` keeps `floor(visibleTop / rowHeight)` math (estimate-uniform model unchanged).
- DOM bounded: maxNodes unchanged.
- Known-defect pin (audit): at start=50000 with estimate 100→200, old code silently added 5,000,000px above; new code compensates scroll — visible start index and intra-item offset unchanged.

**Design notes (binding):**
- Track `lastSpacerTop` (px actually applied last setWindow). On estimate change: `newTop = start * newEstimate`; `delta = newTop − lastSpacerTop`; if delta ≠ 0 → `window.scrollTo(0, window.scrollY + delta)` (guard try/catch or feature-detect for test DOMs lacking scroll). Then apply spacers with the new estimate. Shrink = negative delta, same code path.
- If `window.scrollY` is undefined/throws (non-window scroll environments), skip compensation silently (current behavior) — unit tests will exercise the window path.

- [ ] **Step 1: Failing regressions** (extend the existing test harness — it must currently fake child heights; read it first):
  - `estimate growth preserves visible position`: deep start (e.g. 5000), heights that force average well above initial estimate → assert window.scrollY adjusted by spacer delta and `currentStart` unchanged (or exposed equivalent — the harness may assert via onRequestWindow staying stable).
  - `estimate shrink preserves visible position`: heights below estimate → negative delta handled.
  - `hysteresis prevents estimate churn`: measured within 5% → estimate unchanged, no scroll adjustment.
- [ ] **Step 2:** RED. [ ] **Step 3:** Implement. [ ] **Step 4:** unit full + tsc. [ ] **Step 5:** Commit `fix: anchor virtual scroll when row-height estimate changes`

---

### Task 2: Worker query/cache lifecycle

**Files:**
- Modify: `src/worker/worker-engine.ts`
- Test: `tests/worker/worker-engine.test.ts` (+ include-list tests if they cover caching)

**Interfaces:**
- Produces (internal):
  1. **Cache for all pagination modes:** `cacheable` becomes always-true (signature already excludes page/window). Numeric-pagination queries reuse `orderedIndexes` and decorate ONLY the requested page slice (replace the decorate-everything loop at ~358-366: slice `orderedIndexes[(page-1)*size ... page*size]` — mirror `paginateEntries` semantics; reuse domain/paginateEntries by decorating only the slice then calling it, keeping page-clamping behavior identical).
  2. **Dataset generation validation:** `private datasetGeneration = 0`, bumped by `loadComplete`, `dispose` (and `loadStart` staging eviction). `query` captures generation at entry; before writing `this.windowCache` AND before `send(query-result)`, if `generation !== this.datasetGeneration` → return silently (stale).
  3. **Bounded retention:** complete datasets retained in an LRU of capacity 3 (active dataset always retained; evict least-recently-used inactive beyond 3). `loadComplete` + query touch update recency. Eviction drops dataset state (entries/searchFields/sortIndexes).
- Tests:
  - `numeric pagination reuses cached ordered indexes` (second page-turn query with same filters: scan not re-executed — observable via a scan-count spy or timing-free behavioral signal the harness supports; if no spy exists, expose nothing — instead assert identical results AND that a marker (e.g. deliberate knownWords mutation between pages without signature change is NOT re-scanned — simplest: instrument via a counting wrapper in the test around the entries array... implementer picks a sound observable; justify in report).
  - `numeric pagination decorates only the requested page` (result items length === pageSize even when matches are 10k — memory guard assertion via engine-internal state or simply correctness at boundary pages).
  - `stale query does not publish after dataset replacement` (start query, swap dataset via loadComplete of a second dataset mid-flight using the engine's async yields — the existing harness forces yields via chunk sizes; assert the first query's send never fires after the swap).
  - `retention evicts beyond three datasets` (load 4 datasets sequentially; first evicted: querying it throws dataset-not-found; active + last two remain queryable).
  - `repeated large imports keep engine dataset count bounded` (import/load 5 datasets; internal complete count ≤ 3).
- [ ] **Step 1:** RED regressions. [ ] **Step 2:** confirm. [ ] **Step 3:** implement. [ ] **Step 4:** worker tests full + FULL unit suite (controller tests use FakeWorkerClient — unaffected; include-list tests may exercise engine — run them). [ ] **Step 5:** Commit `fix: worker cache lifecycle, generation guard, bounded retention`

---

### Task 3: Asynchronous worker failure handling

**Files:**
- Modify: `src/app/worker-client.ts` (`loadDataset`)
- Test: `tests/app/worker-client.test.ts`

**Interfaces:**
- Produces:
  1. **Immediate rejection handling:** after `const result = this.register<void>(...)` in loadDataset, attach `result.catch(() => {})` so a rejection landing while the for-await loop is still blocked on the source iterator (worker error response arrives mid-load, caller hasn't awaited `result` yet) is marked handled — no `unhandledrejection`; the caller still receives the rejection via `return result`.
  2. **Iterator race:** consume the source iterator raced against rejection — pragmatic shape: a `failed` promise derived once (`const failure = result.then(() => { throw new Error("__unused__") }, (e) => e)` — or simpler: a settled-flag set by a `result.then(...)` observer); each loop iteration: `const next = await Promise.race([iterator.next(), rejectionGate])` — when the rejection gate wins, BREAK the loop (stop pulling chunks from storage) and let the existing catch/postCancel path run. Implementation detail is the implementer's as long as: (a) rejection can never be unhandled, (b) after rejection the source iterator is not further consumed (its `return()` is invoked via for-await break semantics or explicitly).
- Tests (harness: existing worker-client tests fake WorkerLike — follow patterns):
  - `worker error mid-load does not emit unhandled rejection`: attach process-level `unhandledrejection` listener spy (happy-dom/vitest support), start loadDataset with a slow chunk source (async generator awaiting a gated promise), deliver worker error response for the load requestId while blocked → assert no unhandledrejection observed and loadDataset rejects with the error after the gate opens... IMPORTANT: with the iterator race the rejection should surface WITHOUT opening the gate — assert loadDataset rejects promptly (before source gate opens) — that IS the race behavior pin.
  - `source iterator stops being consumed after failure`: gated generator records next() calls; after rejection, assert no further next() (and return() invoked if the harness can observe it).
- [ ] **Step 1:** RED. [ ] **Step 2:** confirm. [ ] **Step 3:** implement. [ ] **Step 4:** full unit + tsc. [ ] **Step 5:** Commit `fix: handle worker load failure promptly without unhandled rejection`

---

### Task 4: Parsing and target reconciliation

**Files:**
- Modify: `src/domain/text.ts` (`parseCsv` BOM strip), `src/ui/renderer.ts` (occurrence ordinal into dataset), `src/ui/highlight-adapter.ts` (nth-match), `index.html` none
- Test: `tests/domain/import.test.ts` (BOM cases), `tests/ui/highlight-adapter.test.ts` (repeated targets)

**Interfaces:**
- `parseCsv`: strip ONE leading `\uFEFF` from `source` before tokenization (covers quoted first header `"\uFEFFWord"` which the header-level cleanup in import.ts misses). import.ts's existing first-header replace becomes redundant but harmless — leave it.
- Occurrence ordinal: `renderSentence` computes, for the highlighted segment, its occurrence ordinal among segments with the SAME text (0-based count of prior segments with identical text — the intended match when a word repeats in one sentence). Sets `sentence.dataset.surfaceIndex = String(ordinal)`.
- `markSentence`: read `surfaceIndex` (default 0); find the nth occurrence of `surface` in visible text (loop indexOf with position advance); fall back: if nth occurrence doesn't exist, fall back to FIRST match (defensive), then existing stem-fallback path unchanged.
- Tests:
  - BOM: `parses csv with BOM before plain header` (`\uFEFFWord,...` → headers[0]==="Word"); `parses csv with BOM before quoted header` (`"\uFEFFWord",...` — quoted first field). (import.test.ts or a text.test.ts — follow existing placement; parseCsv tests may live in import.test.ts.)
  - Repeated target: sentence where surface "言葉" appears twice, highlight markers on the SECOND occurrence → reconcile wraps the second occurrence (assert wrapped node's surrounding text / the th-first span's position), not the first.
  - Ruby + split nodes: target inside `<ruby>` (furigana on) AND text split across nodes (existing th-wrap split from prior reconcile) → nth-match still lands correctly; re-reconcile idempotent.
- [ ] **Step 1:** RED. [ ] **Step 2:** confirm. [ ] **Step 3:** implement. [ ] **Step 4:** full unit + tsc; e2e highlight specs (compatibility.spec.ts has th-wrap assertions — run it). [ ] **Step 5:** Commit `fix: BOM-tolerant CSV parsing and occurrence-accurate highlight reconciliation`

---

### Task 5: Wave-3 carry-overs

**Files:**
- Modify: `src/styles/layout.css` (conditional scroll-margin), `src/styles/entries.css` + `src/ui/renderer.ts` (drop `.entry-queue-actions` class+rule; CSS dedupe `.sticky-row-2` vs `.adv-controls`), `src/ui/renderer.ts` (`role="toolbar"` → `role="group"` on `.entry-actions`)
- Test: affected unit assertions (role attr; class absence), e2e untouched (no selector depends on role; `.entry-queue-actions` — grep tests first, wave-3 kept it for a test selector — update that selector)

**Items:**
1. Conditional scroll-margin: `#stickyToolbar:has(#advancedPanel:not([hidden])) ~ * #resultsHeading` — :has + sibling combinators fragile; simpler: since renderer toggles `advancedPanel.hidden`, ALSO toggle a class on `#resultsHeading` (e.g. `toolbar-expanded`) or body (`advanced-open`) → CSS `body.advanced-open #resultsHeading { scroll-margin-top: 340px; }` (verify ≥ expanded toolbar height at 375px — measure via e2e or compute; pick value with margin). Renderer/body-class toggle lands where `review-open` body class is toggled.
2. CSS dedupe: fold `.sticky-row-2 .control/.check-control/input` rules into `.adv-controls` set (advancedPanel carries both classes — make one canonical, delete the other); delete `.entry-queue-actions { flex-wrap: wrap; }` rule AND stop emitting the class in renderer (update the wave-3 test selector that referenced it — grep `entry-queue-actions` in tests/).
3. `role="toolbar"` → `role="group"` on `.entry-actions` (no roving tabindex implemented; group is accurate). Update unit assertion.

- [ ] **Step 1:** failing unit assertions (role=group; no entry-queue-actions class; body.advanced-open class applied when panel expanded — renderer test) + quick e2e RED for scroll-margin under expanded panel (focus pagination with panel open → heading top ≥ expanded toolbar bottom) — e2e may be flaky-prone; if the geometry assertion proves unreliable in RED phase, keep it unit-level (class toggle) + manual measurement note; implementer's judgment, documented.
- [ ] **Step 2:** RED. [ ] **Step 3:** implement. [ ] **Step 4:** full unit + full e2e + tsc. [ ] **Step 5:** Commit `fix: ui polish carryovers - scroll margin, css dedupe, role group`

---

### Task 6: Wave verification and audit bookkeeping

- [ ] `npm run check` + `npm run test:e2e` green (100k timing recorded vs baseline ~3.9s).
- [ ] Check off audit Phase 5: items 1 (4 boxes), 2 (5 boxes), 3 (3 boxes), 4 (3 boxes) with evidence; "Optional Technical Improvements" 4 boxes — leave UNCHECKED, append note `(deferred: wave-4 scope excluded optional items per plan; tracked for wave 5+)`. Also check Phase 3.3 box 4's remainder? NO — larger-text/landscape still unverified; leave as is.
- [ ] Commit `docs: check off audit phase 5 with verification evidence`

---

## Self-Review Notes

- Spec coverage: Phase 5.1 → Task 1; 5.2 → Task 2; 5.3 → Task 3; 5.4 → Task 4; optional → deferred by design; carry-overs → Task 5.
- Task 2 memory guard: decorate-only-page assertion needs a real observable; implementer must justify choice in report.
- Task 4 renderer/adapter contract change (dataset.surfaceIndex) is additive; adapter defaults keep old behavior for un-marked sentences.
- e2e compatibility.spec.ts highlight assertions are the guard for Task 4 regressions.
