# Migaku Custom Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DOM-mutating target highlighting with CSS Custom Highlight ranges in supported browsers while retaining the current wrapper implementation as a legacy fallback.

**Architecture:** Keep `src/ui/highlight-adapter.ts` as the single compatibility boundary. Preserve its visible-text reconstruction, occurrence selection, mutation observer, and fallback matching, but separate target-location discovery from rendering. Modern browsers register `Range` objects under a named CSS highlight; unsupported browsers use the existing `.th-wrap` wrappers.

**Tech Stack:** TypeScript 7, DOM Range API, CSS Custom Highlight API, MutationObserver, Vitest + Happy DOM, Biome.

**Spec:** `docs/superpowers/specs/2026-09-12-migaku-custom-highlight-design.md`

## Global Constraints

- Do not call or emulate undocumented Migaku extension APIs.
- Modern highlighting must not insert Jiten wrapper elements into parsed Migaku sentence DOM.
- Preserve target surface matching, `data-surface-index`, shared-stem fallback, ruby/spacer skipping, and mutation batching.
- Preserve `.th-wrap` fallback for browsers without CSS Custom Highlight support.
- `destroy()` must remove Jiten's named highlight as well as disconnecting/canceling existing observer work.
- Do not change Review decisions, shortcuts, or Migaku `Q` handling.

---

### Task 1: Add regression tests for the non-mutating highlight path

**Files:**
- Modify: `tests/ui/highlight-adapter.test.ts`

**Interfaces:**
- Consumes: `createHighlightAdapter(root: Element): HighlightAdapter`
- Produces: tests that define the required behavior before implementation.

- [ ] **Step 1: Add a fake CSS Highlight registry and constructor**

Add a helper that temporarily installs `globalThis.Highlight` and `CSS.highlights` with a small registry exposing `set`, `get`, and `delete`. The fake Highlight object should retain the `Range[]` passed to its constructor so assertions can inspect registered ranges.

- [ ] **Step 2: Add a failing primary-path test**

Create a Migaku-like parsed sentence where the target spans two text nodes. After `adapter.reconcile(root)`, assert:

```ts
expect(node.querySelectorAll("span.th-wrap")).toHaveLength(0);
expect(fakeRegistry.get("jiten-target")?.ranges).toHaveLength(2);
expect(node.textContent).toBe("彼は気になる。");
```

- [ ] **Step 3: Add cleanup/mutation tests**

Assert that a second reconciliation replaces the registered highlight rather than accumulating stale ranges, and that `adapter.destroy()` deletes `jiten-target`.

- [ ] **Step 4: Add a legacy-fallback test**

Run without a fake Custom Highlight API and preserve the old expectation that parsed target text receives `.th-wrap` wrappers.

- [ ] **Step 5: Add geometry rejection test**

Stub a target range to return only a zero-sized/out-of-sentence rectangle while the sentence has a normal client rect, then assert no range is registered for that candidate.

- [ ] **Step 6: Run the focused test and confirm RED**

Run:

```bash
npx vitest run tests/ui/highlight-adapter.test.ts
```

Expected: new Custom Highlight assertions fail because the adapter still inserts `.th-wrap` elements.

- [ ] **Step 7: Commit the failing tests**

```bash
git add tests/ui/highlight-adapter.test.ts
git commit -m "test(highlight): require non-mutating Migaku compatibility"
```

---

### Task 2: Implement Custom Highlight range rendering

**Files:**
- Modify: `src/ui/highlight-adapter.ts`
- Test: `tests/ui/highlight-adapter.test.ts`

**Interfaces:**
- Consumes: `.sentence[data-surface]` nodes and browser `Range`/Custom Highlight APIs.
- Produces: `createHighlightAdapter(root)` with a non-mutating modern render path and legacy wrapper fallback.

- [ ] **Step 1: Extract target-range discovery from wrapper rendering**

Refactor matching so the adapter computes text-node segments for the selected target independently of how they are rendered. Preserve ordinal matching and the shared-stem fallback.

Use a structure equivalent to:

```ts
interface TextSegment {
  node: Text;
  first: number;
  last: number;
}
```

- [ ] **Step 2: Add Custom Highlight feature detection**

Treat the API as available only when both a callable `globalThis.Highlight` constructor and `CSS.highlights` registry with `set`/`delete` methods are present.

- [ ] **Step 3: Build ranges without mutating DOM**

For each segment:

```ts
const range = document.createRange();
range.setStart(segment.node, segment.first);
range.setEnd(segment.node, segment.last + 1);
```

Collect valid ranges from every sentence and register one aggregate `Highlight` object under `jiten-target` after reconciliation.

- [ ] **Step 4: Add geometry validation**

When `range.getClientRects()` and `sentence.getBoundingClientRect()` provide meaningful geometry, retain only ranges with at least one non-zero rectangle intersecting the sentence rectangle. If layout data is unavailable or the sentence box is all-zero, do not reject the range.

- [ ] **Step 5: Keep fallback isolated**

When Custom Highlight support is absent, render the discovered segments using the existing `.th-wrap`, `.th-first`, `.th-last` logic. Keep `th-live` for the surface-not-found fallback.

- [ ] **Step 6: Ensure stale highlights are cleared**

At the beginning/end of each modern reconciliation, replace `jiten-target` with only current ranges. On `destroy()`, delete `jiten-target`.

- [ ] **Step 7: Run focused tests and confirm GREEN**

```bash
npx vitest run tests/ui/highlight-adapter.test.ts
```

Expected: all highlight-adapter tests pass.

- [ ] **Step 8: Commit implementation**

```bash
git add src/ui/highlight-adapter.ts tests/ui/highlight-adapter.test.ts
git commit -m "fix(highlight): use non-mutating browser highlight ranges"
```

---

### Task 3: Add CSS Custom Highlight styling and preserve fallback styles

**Files:**
- Modify: `src/styles/entries.css`

**Interfaces:**
- Consumes: named highlight `jiten-target` created by the adapter.
- Produces: modern yellow/pill target appearance without DOM wrappers.

- [ ] **Step 1: Add modern highlight rules**

Near the existing target highlight styles add:

```css
::highlight(jiten-target) {
  background-color: rgba(255, 255, 0, 0.22);
}

body.hl-pill ::highlight(jiten-target) {
  background-color: rgba(139, 167, 255, 0.1);
  text-decoration: underline rgba(139, 167, 255, 0.55);
}
```

Do not remove `.th-wrap`, `.th-live`, or `.target-highlight` rules because unsupported browsers still need them.

- [ ] **Step 2: Run lint and focused tests**

```bash
npm run lint
npx vitest run tests/ui/highlight-adapter.test.ts tests/ui/decision-controls.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit CSS**

```bash
git add src/styles/entries.css
git commit -m "style(highlight): paint targets with custom highlight API"
```

---

### Task 4: Full verification and pull request

**Files:**
- No functional files expected.

**Interfaces:**
- Consumes: completed branch.
- Produces: verified PR ready for real Migaku smoke testing.

- [ ] **Step 1: Run full local-equivalent verification**

```bash
npm run lint
npm run check
npm run test:e2e
npm run test:e2e:prod
```

Expected: all commands pass.

- [ ] **Step 2: Review diff for forbidden coupling**

Confirm there are no new Migaku token-class dependencies, no extension API calls, no Review shortcut changes, and no removal of legacy fallback styles.

- [ ] **Step 3: Open PR**

Title:

```text
fix(highlight): avoid mutating Migaku parsed text
```

PR body should explain that modern browsers use CSS Custom Highlight ranges, unsupported browsers keep the old wrapper fallback, and actual Migaku extension behavior still requires a manual smoke test because CI cannot load the extension.
