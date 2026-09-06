# Phase 5: Strengthen Tests And Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit Phase 6 — repair backup negative tests, close the remaining regression gaps (viewport resize), add production-serving smoke tests (worker import/query + legacy redirect against real build output), fix launcher folder discovery without bundling private vocabulary files, add cross-browser coverage, align Node requirements, and tighten CI config. Includes the Wave-4 hygiene batch.

**Architecture:** A second Playwright project (`production`) builds dist and serves the REPOSITORY ROOT via `vite preview`-equivalent static server with the app at `/dist/` — exercising real build output including the worker bundle and legacy redirect entry. Launcher + main.ts switch to origin-absolute vocabulary paths (`/WORDS TO MINE`) so discovery works under root-serving; dist never contains vocabulary files. Cross-browser: firefox + webkit projects added to the dev-server config; CI installs them. Node floor raised to ≥22.12 (Vite 8 requirement; Node 20 EOL 2026-04), declared in engines + CI + docs.

**Tech Stack:** TypeScript, Vite 8, Vitest, Playwright (chromium/firefox/webkit), python http.server for the launcher (unchanged), GitHub Actions.

**Spec:** `DL/WEBSITE-IMPROVEMENT-AUDIT.md` Phase 6 (lines 257-274).

## Global Constraints

- Failing/absent regression before each fix; production specs must run against REAL build output (dist), not the dev server.
- NEVER copy/bundle vocabulary folders (WORDS TO MINE, MIGAKU KNOWN WORDS, DL) into dist or any distributable — audit box: "Do not silently bundle private vocabulary files into distributable builds."
- Existing dev-server e2e stays green; CI runtime growth acceptable but bounded (firefox+webkit on the e2e suite; production project can run a smoke subset + the 100k perf spec is chromium-only).
- `npm run check` + `npm run test:e2e` green at wave end (all projects).
- Conventional commits.

---

### Task 1: Repair backup negative tests

**Files:**
- Modify: `tests/domain/backup.test.ts`
- Test: same file

**Context (audit confirmed gap):** many malformed-backup fixtures omit required `exportedAt`, so tests fail on exportedAt validation BEFORE reaching the branch they claim to exercise. Wave 1 added a `validBackupJson()` baseline helper for the new canonical-identity tests — the OLD negative tests still use ad-hoc minimal fixtures.

**Binding:** every negative test in the file starts from the complete valid baseline (the existing `validBackupJson()` helper or a shared `validBackup()` object) and mutates exactly ONE field, asserting the intended message via `toThrow(/<specific fragment>/)` (message fragments must identify WHICH validation fired — e.g. `/knownWords\.name/`, `/wordDecisions\[2\]\.status/`, `/unsupported-version/`, not generic /invalid-shape/ alone when multiple fields could produce it). Tests asserting JSON/format/version errors mutate only that top-level field. Sweep the whole file: list each `it` and its mutation in the report (a mapping table). Do not weaken any currently-strict assertion; the work is fixture repair, not assertion relaxation. If a test's stated intent is genuinely ambiguous after reading, keep its current assertion and note it.

- [ ] Step 1: Baseline audit table (test → mutation → asserted branch) written into the report FIRST; identify tests that currently die on exportedAt before their branch.
- [ ] Step 2: Rewrite fixtures (valid baseline + one mutation each).
- [ ] Step 3: `npx vitest run tests/domain/backup.test.ts` — all green; full suite + tsc.
- [ ] Step 4: Commit `test: repair backup negative tests to complete-baseline fixtures`

---

### Task 2: Viewport-resize regression + Wave-4 hygiene batch

**Files:**
- Modify: `tests/ui/virtual-list.test.ts` (resize regression), `src/domain/query.ts` (knownCount dead work + cast), `src/app/worker-client.ts` (closeSource parity)
- Test: virtual-list additions; existing query/worker-client suites as guards

**Items:**
1. **Resize regression** (audit Phase 6 box "deep-scroll, row-shrink, and resize regressions" — resize was the honest-partial in Wave 4): unit test — deep window mounted, simulate viewport resize by re-triggering `handleScroll` semantics at the same content offset (the list reads `root.getBoundingClientRect()`; the harness stubs gBCR — simulate a taller viewport by changing the stubbed rect and dispatching scroll) → assert no window churn beyond the current bucket (onRequestWindow not re-fired with a different start when content position unchanged). Follow the existing harness's scroll-simulation pattern; if gBCR stubbing makes "resize" indistinguishable, assert the invariant the audit names: mounted DOM stays bounded and the visible start index stable across the resize event. RED first if a real defect exists; if the invariant already holds, write the test as a guard and SAY SO (no fake RED).
2. **query.ts hygiene:** numeric-path call builds `Array.from(orderedIndexes)` + computes `knownCount` via a cast that is always discarded (wave-4 finding). Restructure so `paginateEntries` over raw indexes does not compute/decorate `known`/`knownCount` for index callers (overridable parameter or a leaner index-paginator internal); keep `PaginatedEntries` public shape for the existing EntryWithKnown caller unchanged. Tests: existing query + worker suites green (behavioral no-op); typecheck.
3. **worker-client closeSource parity:** the post-throw catch path skips `closeSource()` (wave-4 deferred). Move/duplicate the close into a `finally`-guarded path so abrupt exits invoke `iterator.return()` (still fire-and-forget with handlers attached). Guard: existing mid-chunk failure test (line ~217 precedent) must stay green.

- [ ] Steps: regressions RED (1) or declared guard → implement → full unit + tsc → Commit `fix: resize regression guard and query client hygiene`

---

### Task 3: Production-serving e2e project

**Files:**
- Create: `playwright.prod.config.ts` (or a second project in playwright.config.ts with its own webServer — prefer a SEPARATE config file so dev config stays lean), `tests/e2e/production.spec.ts`
- Modify: `package.json` (script `test:e2e:prod`), possibly `.github/workflows/ci.yml` (CI step runs it — coordinate with Task 5, one edit)
- Test: the new spec

**Binding design:**
- Config: `testDir: "tests/e2e"`, project name `production`, `testMatch: /production\.spec\.ts/`, baseURL `http://127.0.0.1:8931`, webServer command serves the REPOSITORY ROOT after a build: `npm run build && python -m http.server 8931 --bind 127.0.0.1` with `cwd` = repo root, url `http://127.0.0.1:8931/dist/`, `reuseExistingServer: !process.env.CI`. (Python is already a documented launcher dependency; CI ubuntu has python3 — use `python3` on CI vs `python` on Windows: command `python -m http.server ... || python3 -m http.server ...` won't work as a single webServer command — instead use a small npm script `serve:root` choosing via `process.platform`, or simply use `npx http-server`-free approach: keep python and add CI setup step installing nothing (ubuntu has python3 but the command must match) — implementer resolves cleanly, e.g. npm script `"serve:root": "node scripts/serve-root.mjs"` using node's built-in http (zero deps, cross-platform — PREFERRED).) The spec pages all live under `/dist/`.
- Spec asserts (REAL build output):
  - app boots at `/dist/` (h1 + import panel; no console errors beyond none).
  - WORKER path works in production bundle: import jiten fixture (use `tests/fixtures/jiten-small.csv` — served from repo root at `/tests/fixtures/...`; set via file input), entries render (worker query ran), a decision + filter round-trip.
  - legacy redirect: `/dist/jiten-migaku-miner-v1.html` → lands on `/dist/index.html` with h1 (the built legacy entry — vite already emits it as build input).
  - production asset sanity: main module + worker chunk return 200 and expected MIME (fetch the script tag src).
  - vocabulary folders NOT bundled: `request.get("/dist/WORDS TO MINE/")` → 404.
- Guardrail: production spec must NOT pass against the dev server by accident — it asserts `/dist/` paths which the dev server doesn't serve.

- [ ] Steps: write failing spec (no prod server exists → config RED trivially; the real RED is: run `npm run test:e2e:prod` before implementing serve-root/build wiring → fails) → implement config + script → green locally → Commit `test: production-serving smoke suite against real build output`

---

### Task 4: Launcher folder discovery fix

**Files:**
- Modify: `src/main.ts` (origin-absolute discovery paths), `start-miner.bat` (serve root, open /dist/), `README.md` (launcher + discovery + privacy sections), `tests/e2e/production.spec.ts` (folder auto-load assertion — coordinates with Task 3)
- Test: production spec addition + dev-e2e guard (existing miner folder auto-load spec must stay green under dev server)

**Binding design:**
- `discoverFolderSources` calls `folder.newest("/WORDS TO MINE", ".csv")` and `folder.newest("/MIGAKU KNOWN WORDS", ".txt")` — leading-slash = origin-absolute. Dev server (vite root) resolves to repo folders (unchanged behavior); root-serving production (Task 3 server, updated launcher) resolves to repo folders; dist-only hosting 404s → discovery returns null silently (non-destructive, documented).
- `BrowserFolderSource.resolveDirectory` already handles absolute paths via `new URL(directory, baseUrl)` (leading slash → origin root). VERIFY with a unit test in `tests/platform/` or wherever folder-source tests live (grep — session-queue.test.ts is platform; folder-source tests may not exist — add one: absolute path resolution against a `/dist/` base URL yields `/WORDS TO MINE/`).
- `start-miner.bat`: `--directory .` instead of `--directory dist`; opens `http://127.0.0.1:8920/dist/`. Message about vocabulary folders optional.
- README: launcher section (serves repository root so folder discovery works; app at /dist/; loopback-only), privacy section note (discovery is same-origin loopback; nothing bundled into dist), manual equivalent updated.
- Production spec: seed `WORDS TO MINE`-style discovery? The repo folders exist but contain personal files — the e2e must NOT depend on user's real files. Instead: assert discovery REQUEST happens against `/WORDS TO MINE/` (route interception: fulfill a synthetic listing + file; then assert auto-import ran with the synthetic "(auto)" name). This pins the absolute-path behavior in production WITHOUT touching real files.
- Verify dist contains no vocabulary folders after build (assert in spec — Task 3 already does; keep).

- [ ] Steps: failing unit (absolute-path resolution) + failing production discovery assertion (relative path 404s under /dist/ page) → implement → dev e2e + prod e2e green → README/bat updates → Commit `fix: launcher serves repository root for folder discovery without bundling`

---

### Task 5: Cross-browser projects + CI/Node alignment

**Files:**
- Modify: `playwright.config.ts` (firefox + webkit projects; `reuseExistingServer: !process.env.CI`), `.github/workflows/ci.yml` (install firefox+webkit; run prod suite; node 22), `package.json` (engines), `README.md` (requirements), `start-miner.bat` (Node message), `vitest.config.ts` (remove `passWithNoTests`)
- Test: cross-browser run results

**Items:**
1. playwright.config: projects = chromium, firefox, webkit (same dev-server baseURL). `reuseExistingServer: !process.env.CI`.
2. Run full dev e2e on firefox + webkit locally (`npx playwright test --project=firefox --project=webkit`). FIX real failures (likely suspects: `:has()` ok in modern; `inert` ok; scroll-behavior timing; clipboard/none). Browser-specific workarounds ONLY where the behavior is genuinely browser-different; do not weaken assertions browser-wide. Any test that CANNOT pass on a claimed-support browser is a finding — fix the app, not the test (record deviations in report; if truly blocked, mark that project's failure as a documented limitation → the audit box will cite partial coverage honestly).
3. CI: `node-version: 22`; playwright install `chromium firefox webkit --with-deps`; add `npm run test:e2e:prod` step.
4. engines: `"node": ">=22.12.0"` (Vite 8 floor; local toolchain is Node 24). README requirements line + start-miner.bat message updated to match.
5. vitest.config: drop `passWithNoTests: true`.

- [ ] Steps: add projects → run cross-browser → fix failures (RED→GREEN per fix where app-side) → config/CI/engines/docs edits → full `npm run check` + `npm run test:e2e` (all 3 projects) green locally → Commit `feat: cross-browser e2e coverage, node 22 floor, ci hardening`

---

### Task 6: Wave verification and audit bookkeeping

- [ ] `npm run check`; `npm run test:e2e` (chromium+firefox+webkit); `npm run test:e2e:prod`. Record counts.
- [ ] Check off audit Phase 6 boxes with evidence — several boxes were satisfied by earlier waves and are ALREADY evidenced in the audit file (delayed-write concurrency, mobile/keyboard regressions, chunk-boundary coverage — verify their boxes are already checked; the audit currently has them unchecked since Phase 6 was untouched — check them NOW citing the wave commits that added those tests). Mapping:
  - backup negative tests → Task 1
  - delayed-write concurrency → waves 1-3 commits (e79b74e, 33f48dd region — cite test names)
  - mobile/keyboard → fbd6396/4a565d7 + specs
  - deep-scroll/row-shrink/resize → 86b5e3f + Task 2
  - chunk-boundary → bc11d75
  - production build/static serving → Task 3
  - worker import/query + legacy redirect vs prod output → Task 3
  - launcher folder discovery (+ no bundling) → Task 4
  - browser coverage beyond chromium → Task 5 (or partial with documented limitations)
  - Node alignment → Task 5
  - passWithNoTests/reuseExistingServer → Task 5
- [ ] Commit `docs: check off audit phase 6 with verification evidence`

---

## Self-Review Notes

- Spec coverage: Phase 6 has 11 boxes + confirmed-gap note → Tasks 1-6 cover all; three boxes close via evidence from prior waves (their tests exist on main already).
- Task 3's server choice: zero-dep node http server script preferred (CI has no python guarantee on the exact command name; keeps launcher python separate).
- Task 4 hard constraint: nothing from WORDS TO MINE / MIGAKU KNOWN WORDS / DL ever lands in dist — spec asserts 404.
- Task 5 risk: webkit/firefox flakes — bounded by fix-the-app mandate; honest partial allowed with documentation.
