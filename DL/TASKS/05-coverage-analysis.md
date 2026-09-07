# Vocabulary Coverage Analysis Implementation Plan

> **For agentic workers:** Implement after Persistent Word Decisions so manually-known words are included in effective knownness. Keep all heavy whole-dataset computation in the worker.

**Repository:** `mazdiaz/jiten-migaku-miner`  
**Priority:** 5  
**Depends on:** Persistent Word Decisions  
**Integrates well with:** Review Mode

## Goal

Answer the practical question:

> “How much of this Jiten-tracked vocabulary occurrence mass do I already know, and roughly how many high-frequency unknown words would I need to learn to reach 98%, 98.5%, 99%, or 99.5%?”

This is not a linguistic guarantee of raw-text comprehension. It is a metric over the entries and occurrence counts present in the imported Jiten CSV.

The UI must label it clearly as **tracked vocabulary occurrence coverage** (or equivalent wording), not absolute text coverage.

---

# Definitions

For each Jiten entry:

```text
weight = max(0, occurrences)
effectiveKnown =
  word is in imported Migaku known set
  OR local decision == "known"
```

`mined`, `skip`, and `later` are not known.

## Metrics

```ts
export interface CoverageStats {
  totalUniqueWords: number;
  knownUniqueWords: number;
  unknownUniqueWords: number;

  totalTrackedOccurrences: number;
  knownTrackedOccurrences: number;
  unknownTrackedOccurrences: number;

  coveragePercent: number | null;
  targets: CoverageTargetResult[];
}

export interface CoverageTargetResult {
  targetPercent: number;
  reached: boolean;
  additionalWords: number;
  additionalTrackedOccurrences: number;
}
```

If `totalTrackedOccurrences === 0`:

```ts
coveragePercent = null
```

Do not display `NaN`, `Infinity`, or misleading `100%`.

## Target calculation

For each target:

```text
98
98.5
99
99.5
```

If current coverage already meets the target:

```text
reached = true
additionalWords = 0
additionalTrackedOccurrences = 0
```

Otherwise:

1. take effectively-unknown entries
2. sort by occurrence count descending
3. deterministic tie-breaker: current original Jiten order
4. accumulate occurrences
5. stop at the first word where projected coverage reaches the target

`additionalWords` is therefore the smallest count under a greedy highest-occurrence-first strategy.

Describe it in the UI as an estimate/priority path, not a promise that learning exactly N words guarantees comprehension.

---

# Architecture

## Pure domain function

Create:

```text
src/domain/coverage.ts
```

Suggested interface:

```ts
export function computeCoverage(
  entries: readonly Entry[],
  knownWords: ReadonlySet<string>,
  decisions: ReadonlyMap<string, WordDecision>,
  targets?: readonly number[],
): CoverageStats;
```

Default targets:

```ts
[98, 98.5, 99, 99.5]
```

The function should share the same effective-known semantics as normal query behavior. Extract a tiny shared helper if needed rather than duplicating logic that can drift.

## Worker

Whole-dataset coverage belongs in the Web Worker.

Extend the worker protocol with a coverage request/response, e.g.:

```ts
type CoverageRequest = {
  type: "coverage";
  requestId: string;
  datasetId: string;
  knownWords: string[];
  decisions: Array<[string, WordDecisionStatus]>;
  targets: number[];
};
```

Return `CoverageStats`.

Do not send all entries back to the main thread.

Coverage calculation should be invalidated/recomputed when:

- active dataset changes
- imported known list changes
- a word decision changes

It does not need to recompute for:

- furigana toggle
- highlight toggle
- definitions toggle
- normal page changes
- normal search filter

Coverage describes the whole active dataset.

## Controller state

Add:

```ts
coverage: CoverageStats | null;
coverageStatus: "idle" | "loading" | "ready" | "error";
```

The controller requests coverage:

- after active dataset load
- after known import
- after decision changes
- after restore backup changes known/decisions

Use generation IDs so an old coverage result cannot overwrite a newer dataset/known state.

---

# UI

Add a compact collapsible panel above the results list.

Suggested collapsed summary:

```text
Tracked vocabulary coverage: 98.4%
```

Expanded:

```text
Tracked vocabulary occurrence coverage

Known unique words        8,614 / 9,241
Known occurrences         42,810 / 43,497
Coverage                  98.42%

Priority path
98.0%     reached
98.5%     +4 words
99.0%     +37 words
99.5%     +141 words

[Focus highest-value unknowns]
```

Include an info/help note:

```text
Based on occurrence counts in this Jiten export. This is not guaranteed raw-text comprehension coverage.
```

## Focus button

Do not add a complex “exact threshold candidate set” in v1.

`Focus highest-value unknowns` should set existing normal-list filters to a useful view:

```ts
hideKnown: true
sort: "occ-desc"
page: 1
```

Do not overwrite:

- sentence filter
- kana-only filter
- minimum occurrences
- search text

Optionally set `decision: "unreviewed"` only if the user explicitly clicks a separate `Review unreviewed by frequency` action. Do not silently hide Mined/Later/Skip when the generic Focus button is clicked.

If Review Mode exists, an additional button is allowed:

```text
Review unreviewed by frequency
```

This may temporarily derive `sort=occ-desc` for Review Mode without changing the user's normal sort.

---

# File map

Expected changes:

```text
src/domain/coverage.ts
src/domain/types.ts

src/worker/protocol.ts
src/worker/engine.ts
src/worker/worker.ts
src/app/worker-client.ts

src/app/state.ts
src/app/controller.ts

src/ui/dom.ts
src/ui/controls.ts
src/ui/renderer.ts
src/styles/*
index.html

tests/domain/coverage.test.ts
tests/worker/*
tests/app/controller.test.ts
tests/ui/*
tests/e2e/coverage.spec.ts
```

---

# Implementation tasks

## Task 1 — Pure coverage math

Use small explicit fixtures.

Required tests:

### Basic

```text
A occurrences 50 known
B occurrences 30 unknown
C occurrences 20 unknown
```

Expected:

```text
total = 100
known = 50
coverage = 50
```

### Manual Known

Local decision `A = known` must contribute.

### Mined is not known

Local decision `A = mined` must not contribute.

### Negative/bad occurrence values

Follow the application's established nonnegative occurrence semantics.

### Zero total

Coverage is null.

### Target path

Construct fixtures where exact additional word counts are obvious.

### Deterministic ties

Equal occurrence counts use `originalIndex`.

## Task 2 — Worker coverage request

Tests:

- result matches pure domain function
- wrong/missing dataset returns typed error
- changed known list changes result
- changed decisions change result
- normal query windows remain unaffected

No IndexedDB access from worker.

## Task 3 — Controller lifecycle

Tests:

- coverage loads after dataset
- no dataset -> coverage null
- known import refreshes coverage
- local Known refreshes coverage upward
- Mined does not change known coverage
- reset Known refreshes downward if not in Migaku list
- stale async response ignored after dataset swap

Coverage errors should not destroy the normal results list. Show a nonfatal warning/coverage error state.

## Task 4 — Coverage UI

Unit tests:

- collapsed summary formats with sensible precision (recommend two decimals)
- zero-total displays `N/A`, not 0/100 by invention
- target rows show `reached` or `+N words`
- explanatory note is present
- Focus button calls controller query update with hideKnown + occ-desc + page 1
- existing unrelated filters remain unchanged

Do not use a large chart; the numbers are more useful than visualization here.

## Task 5 — E2E

Use a deterministic fixture with known occurrence weights.

Scenario:

1. Import CSV.
2. Import known list.
3. Verify expected coverage.
4. Mark an unknown word Known.
5. Verify coverage increases.
6. Reset it.
7. Mark it Mined.
8. Verify coverage does not increase.
9. Click Focus highest-value unknowns.
10. Verify list is hide-known + occurrence descending.
11. Reload; verify coverage derives correctly from persisted state.

## Task 6 — Performance regression

Extend/augment the 100k performance suite enough to ensure:

- coverage request completes without mounting extra DOM rows
- coverage calculation stays in worker
- scrolling virtualized results remains bounded

Do not add an unrealistically strict wall-clock benchmark to CI. Assert architecture/DOM bounds and a generous timeout instead.

---

# Copy requirements

Use terminology consistently:

Preferred:

```text
Tracked vocabulary occurrence coverage
```

Avoid:

```text
Reading comprehension
Text understood
You know 99% of this book
```

Threshold copy:

```text
+37 highest-occurrence unknown words to reach 99% tracked coverage
```

This makes the model transparent.

---

# Acceptance criteria

- [x] Coverage is computed over the entire active Jiten dataset. (verified: worker coverage request computes over the full loaded dataset, no page slicing / b073851 3d93f9e)
- [x] Imported Migaku known + local Known decisions count. (verified: domain unit "counts local known decisions as known" shares effective-known semantics with queries / b073851)
- [x] Mined/Skip/Later do not count. (verified: domain unit "treats mined, skip, and later decisions as not known" / b073851)
- [x] 98/98.5/99/99.5 target estimates are deterministic. (verified: default-targets unit + originalIndex tie-break unit / b073851)
- [x] Zero-occurrence datasets do not show bogus percentages. (verified: null coverage unit + UI N/A rendering / b073851 e8d61a3)
- [x] Heavy computation remains in the worker. (verified: worker protocol/engine coverage handler, no entries shipped to main thread, perf spec bounded DOM / 3d93f9e)
- [x] Coverage refreshes after relevant state changes only. (verified: controller lifecycle — dataset load, known import, decision, restore trigger recompute; toggles/filters do not / a622288)
- [x] Focus button uses existing filters instead of inventing a second filter system. (verified: controller applies hideKnown + occ-desc + page 1, preserves sentence/kana/min-occ/search / a622288 e8d61a3 e2e)
- [x] UI clearly says the metric is Jiten-tracked occurrence coverage. (verified: renderer + e2e wording — "tracked vocabulary occurrence coverage" with not-comprehension note / e8d61a3)
- [x] Existing results remain usable if coverage calculation errors. (verified: controller coverage-error state is nonfatal, results list untouched / a622288)
- [x] `npm run check` passes. (verified: this run — typecheck + 568 unit tests + production build, 2026-09-07)
- [x] `npm run test:e2e` passes. (verified: this run — 150 passed across 3 browsers incl. coverage.spec.ts 11-step scenario, 2026-09-07)

## Suggested commit sequence

```text
feat: compute tracked vocabulary coverage
feat: expose coverage through worker
feat: add coverage analysis panel
test: cover coverage workflow
```
