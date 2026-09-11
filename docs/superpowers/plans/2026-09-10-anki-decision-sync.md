# Read-Only Anki Decision Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, read-only AnkiConnect decision layer that previews and atomically applies `Known`/`Mined` classifications while preserving manual decisions, existing Migaku knownness, queue semantics, backups, and old stored data.

**Architecture:** Keep Anki state in `AnkiSyncService`, separate from manual `WordDecision` records and from the published full `AppState`. Add pure domain resolution helpers, pass explicit Anki tuples through worker protocol v3, and expose a read-only AnkiConnect port. Persist one validated config/snapshot record through memory and IndexedDB stores; apply snapshots under the existing user-state lock and refresh query/coverage once.

**Tech Stack:** TypeScript, Vite, Vitest, happy-dom UI tests, fake-indexeddb storage tests, Playwright browser tests, AnkiConnect API version 6.

**Spec:** `docs/superpowers/specs/2026-09-10-ankiconnect-decision-sync-design.md`

## Global Constraints

- Anki integration is structurally read-only: no Anki mutation method may exist in the public adapter port.
- The only Anki endpoint is `http://127.0.0.1:8765` using AnkiConnect API version 6.
- `New` and not suspended derives `Mined`; every other selected card derives `Known`; duplicate `Known` wins.
- Manual decisions always override Anki-derived decisions; Migaku known words remain an independent knownness source.
- Scans and previews do not mutate persistent state; only explicit Apply replaces the Anki snapshot.
- Failed scans, failed batches, unavailable Anki, and failed Apply preserve the previous snapshot and visible effective state.
- Anki snapshot persistence stores canonical target words, derived statuses, sync timestamp, and lightweight summary metadata only; never full cards, card IDs, note fields, or review history.
- `cardsInfo` processing is bounded in batches of 500; no per-word storage transaction, worker request, render, or coverage calculation is allowed.
- Worker protocol version changes from `2` to `3`.
- IndexedDB schema version changes from `2` to `3` without rewriting existing stores.
- Backup exporter emits version `2`; parser accepts version `1` and `2`.
- Existing manual `WordDecision` shape remains unchanged.
- Existing public behavior remains compatible when no Anki config/snapshot exists.
- Tests run with `npm run test`; UI unit tests opt into `happy-dom`; IndexedDB tests import `fake-indexeddb/auto`.
- Every task ends with a focused test run and a conventional commit containing only that task's files.

---

## Test Fixture Conventions

Use existing test-file fixtures where they already exist; add these exact local helpers when a new snippet needs them:

```ts
const defaultQuery: QueryState = {
  search: "",
  hideKnown: false,
  hideKanaOnly: false,
  sentence: "any",
  minOccurrences: 0,
  sort: "original",
  pageSize: "all",
  page: 1,
  decision: "all",
};

function entry(word: string): Entry {
  return {
    id: word,
    originalIndex: 0,
    word,
    normalizedWord: word,
    occurrences: 1,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
  };
}

function jsonFetch(result: unknown): typeof fetch {
  return async () => new Response(JSON.stringify({ result, error: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
  });
}
```

New service tests must define `fakePort` as an `AnkiConnectPort` whose six methods are `vi.fn()`, `decisionSpy = { clearUndo: vi.fn() }`, `coverageSpy = { request: vi.fn(async () => undefined) }`, define `coreFor(store)` as a `ControllerCore` test double with the existing lock methods plus spies for `publish`, `runQuery`, and `countChangeSinceExport`, and define `makeEntry`, `manualDecision`, `previousSnapshot`, `previousSnapshotRecord`, `expectedSnapshot`, and `originalQueue` from the test's fixture values. New UI tests must define `makeAnkiDom()` with every element named in `DomMap` and `stateWithAnki()`/`stateWithPreview()` by calling `createInitialAppState("memory")` and replacing only the `anki`/`ankiPreview` fields. New E2E tests must define `mockAnkiConnect()` as the route handler described in Task 18 and use the existing dataset-import helper from the nearest E2E fixture.

### Task 1: Add Pure Anki Domain Types And Resolution

**Files:**
- Create: `src/domain/anki.ts`
- Create: `tests/domain/anki.test.ts`
- Modify: `src/domain/types.ts:92-97`
- Modify: `tests/domain/query.test.ts` fixtures to include new `EntryWithKnown` fields

**Interfaces:**
- Produces `AnkiWordStatus`, `DecisionSource`, `AnkiDeckScope`, `AnkiSyncConfig`, `AnkiSyncSnapshot`, `AnkiPreviewMatchStats`, `EffectiveDecision`, `resolveEffectiveDecision()`, `aggregateAnkiStatuses()`, `ankiCardStatus()`, and `isAnkiWordStatus()`.
- Extends `EntryWithKnown` with `decisionSource: DecisionSource` and `knownByAnki: boolean`.

- [ ] **Step 1: Write failing domain tests**

```ts
import { describe, expect, it } from "vitest";
import {
  aggregateAnkiStatuses,
  ankiCardStatus,
  resolveEffectiveDecision,
} from "../../src/domain/anki";

describe("Anki decision rules", () => {
  it("maps unsuspended New cards to Mined and every other card to Known", () => {
    expect(ankiCardStatus(true)).toBe("mined");
    expect(ankiCardStatus(false)).toBe("known");
  });

  it("gives Known precedence when duplicate cards share a word", () => {
    expect(aggregateAnkiStatuses(["mined", "known", "mined"])).toBe("known");
    expect(aggregateAnkiStatuses(["mined", "mined"])).toBe("mined");
    expect(aggregateAnkiStatuses([])).toBeNull();
  });

  it("gives manual decisions precedence and reveals Anki after removal", () => {
    expect(resolveEffectiveDecision("mined", "known")).toEqual({
      decision: "mined",
      source: "manual",
    });
    expect(resolveEffectiveDecision(null, "known")).toEqual({
      decision: "known",
      source: "anki",
    });
    expect(resolveEffectiveDecision(null, null)).toEqual({
      decision: "unreviewed",
      source: null,
    });
  });
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm exec vitest run tests/domain/anki.test.ts`

Expected: FAIL because `src/domain/anki.ts` and the new `EntryWithKnown` fields do not exist.

- [ ] **Step 3: Implement minimal domain types and helpers**

```ts
import type { WordDecisionStatus } from "./types";

export type AnkiWordStatus = "known" | "mined";
export type DecisionSource = "manual" | "anki" | null;
export type AnkiDeckScope = { kind: "deck"; name: string } | { kind: "all-decks" };

export interface AnkiSyncConfig {
  deckScope: AnkiDeckScope;
  noteType: string;
  targetField: string;
}

export interface AnkiSyncSnapshot {
  syncedAt: string;
  statuses: Array<[string, AnkiWordStatus]>;
}

export interface AnkiPreviewMatchStats {
  matchedWords: number;
  knownCount: number;
  minedCount: number;
  manualProtected: number;
}

export interface EffectiveDecision {
  decision: WordDecisionStatus | "unreviewed";
  source: DecisionSource;
}

export const ANKI_STATUSES: readonly AnkiWordStatus[] = ["known", "mined"];

export function isAnkiWordStatus(value: unknown): value is AnkiWordStatus {
  return value === "known" || value === "mined";
}

export function ankiCardStatus(isNewAndNotSuspended: boolean): AnkiWordStatus {
  return isNewAndNotSuspended ? "mined" : "known";
}

export function aggregateAnkiStatuses(
  statuses: Iterable<AnkiWordStatus>,
): AnkiWordStatus | null {
  let found = false;
  for (const status of statuses) {
    found = true;
    if (status === "known") return "known";
  }
  return found ? "mined" : null;
}

export function resolveEffectiveDecision(
  manual: WordDecisionStatus | null,
  anki: AnkiWordStatus | null,
): EffectiveDecision {
  if (manual !== null) return { decision: manual, source: "manual" };
  if (anki !== null) return { decision: anki, source: "anki" };
  return { decision: "unreviewed", source: null };
}
```

Add `decisionSource` and `knownByAnki` to `EntryWithKnown`. Update every test fixture to set `decisionSource: null` and `knownByAnki: false`; do not change `WordDecision`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec vitest run tests/domain/anki.test.ts tests/domain/query.test.ts`

Expected: PASS after fixture updates.

- [ ] **Step 5: Commit**

```bash
git add src/domain/anki.ts src/domain/types.ts tests/domain/anki.test.ts tests/domain/query.test.ts
git commit -m "feat: add Anki decision domain rules"
```

### Task 2: Make Query And Coverage Resolve Both Decision Layers

**Files:**
- Modify: `src/domain/query.ts`
- Modify: `src/domain/coverage.ts`
- Modify: `tests/domain/query.test.ts`
- Modify: `tests/domain/coverage.test.ts`

**Interfaces:**
- `applyKnownWords(entries, knownWords, decisions, ankiStatuses)` returns effective decision/source and both decision-knownness flags.
- `queryEntries(..., decisions, ankiStatuses)` accepts an optional Anki status map after existing manual decisions.
- `buildEffectiveKnownIndex(knownWords, decisions, ankiStatuses)` remains the shared coverage/worker lookup.
- `computeCoverage(entries, knownWords, decisions, targets, ankiStatuses)` accepts an optional fifth argument.

- [ ] **Step 1: Add failing precedence and parity tests**

```ts
it("uses Anki status only when no manual decision exists", () => {
  const [entry] = applyKnownWords(
    [entries[0]!],
    new Set(),
    new Map(),
    new Map([[entries[0]!.normalizedWord, "known"]]),
  );
  expect(entry).toMatchObject({
    known: true,
    decision: "known",
    decisionSource: "anki",
    knownByDecision: false,
    knownByAnki: true,
  });
});

it("does not leak Anki Known through manual Mined", () => {
  const [entry] = applyKnownWords(
    [entries[0]!],
    new Set(),
    new Map([[entries[0]!.normalizedWord, { normalizedWord: entries[0]!.normalizedWord, status: "mined", updatedAt: "now" }]]),
    new Map([[entries[0]!.normalizedWord, "known"]]),
  );
  expect(entry).toMatchObject({ known: false, decision: "mined", decisionSource: "manual" });
});

it("keeps query and coverage knownness identical", () => {
  const anki = new Map([[entries[0]!.normalizedWord, "known" as const]]);
  const result = queryEntries(entries.slice(0, 1), new Set(), { ...query, pageSize: "all" }, undefined, new Map(), anki);
  const coverage = computeCoverage(entries.slice(0, 1), new Set(), new Map(), undefined, anki);
  expect(result.knownCount).toBe(coverage.knownUniqueWords);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm exec vitest run tests/domain/query.test.ts tests/domain/coverage.test.ts`

Expected: FAIL because Anki maps are not accepted and `EntryWithKnown` lacks effective metadata.

- [ ] **Step 3: Implement one shared resolver path**

In `applyKnownWords`, canonicalize lookup keys, resolve with `resolveEffectiveDecision`, and set:

```ts
const knownByMigaku = knownCanonical.has(canonical);
const effective = resolveEffectiveDecision(manualStatus, ankiStatus);
const knownByDecision = effective.source === "manual" && effective.decision === "known";
const knownByAnki = effective.source === "anki" && effective.decision === "known";
return {
  ...entry,
  known: knownByMigaku || knownByDecision || knownByAnki,
  decision: effective.decision,
  decisionSource: effective.source,
  knownByMigaku,
  knownByDecision,
  knownByAnki,
};
```

Extend `buildEffectiveKnownIndex` with canonical Anki statuses and the exact rule `Migaku || manual Known || (no manual decision && Anki Known)`. Pass the optional map through `computeCoverage`; preserve existing argument order so existing callers remain valid.

- [ ] **Step 4: Run domain suite and typecheck**

Run: `npm exec vitest run tests/domain/query.test.ts tests/domain/coverage.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/query.ts src/domain/coverage.ts tests/domain/query.test.ts tests/domain/coverage.test.ts
git commit -m "feat: resolve Anki status in query and coverage"
```

### Task 3: Bump Worker Protocol To Version 3

**Files:**
- Modify: `src/worker/protocol.ts`
- Modify: `tests/worker/protocol.test.ts`

**Interfaces:**
- `WORKER_PROTOCOL_VERSION` becomes `3`.
- Query and coverage requests contain `ankiStatuses: Array<[string, AnkiWordStatus]>`.
- Add `AnkiPreviewMatchRequest` with `knownWords`, `decisions`, and `ankiStatuses`.
- Add `AnkiPreviewMatchResponse` containing `AnkiPreviewMatchStats`.
- `parseWorkerRequest()` rejects empty/non-string Anki keys, unknown Anki statuses, malformed tuples, and wrong protocol versions.

- [ ] **Step 1: Add failing protocol tests**

```ts
it("accepts valid Anki tuples in query and preview requests", () => {
  const request = parseWorkerRequest({
    protocolVersion: 3,
    type: "anki-preview-match",
    requestId: "preview-1",
    datasetId: "dataset-1",
    knownWords: [],
    decisions: [],
    ankiStatuses: [["word", "known"]],
  });
  expect(request.type).toBe("anki-preview-match");
});

it.each([
  [["", "known"]],
  [["word", "unknown"]],
  [["word"]],
])("rejects malformed Anki tuple %j", (ankiStatuses) => {
  expect(() => parseWorkerRequest({
    protocolVersion: 3,
    type: "anki-preview-match",
    requestId: "preview-1",
    datasetId: "dataset-1",
    knownWords: [],
    decisions: [],
    ankiStatuses,
  })).toThrow();
});
```

- [ ] **Step 2: Run protocol tests and verify failure**

Run: `npm exec vitest run tests/worker/protocol.test.ts`

Expected: FAIL because protocol version is `2` and preview message is unknown.

- [ ] **Step 3: Implement v3 request/response types and validators**

Add `validateAnkiStatuses()` beside `validateDecisions()`:

```ts
function validateAnkiStatuses(value: unknown): Array<[string, AnkiWordStatus]> {
  if (!Array.isArray(value)) throw invalidMessage("ankiStatuses must be an array");
  return value.map((item, index) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw invalidMessage(`ankiStatuses[${index}] must be a [normalizedWord, status] pair`);
    }
    if (typeof item[0] !== "string" || item[0].length === 0) {
      throw invalidMessage(`ankiStatuses[${index}][0] must be a non-empty string`);
    }
    if (!isAnkiWordStatus(item[1])) {
      throw invalidMessage(`ankiStatuses[${index}][1] must be "known" or "mined"`);
    }
    return [item[0], item[1]];
  });
}
```

Use protocol literal `3` throughout the discriminated unions, add `anki-preview-match` to the message switch, and add `anki-preview-result` to `WorkerResponse`.

- [ ] **Step 4: Run protocol suite**

Run: `npm exec vitest run tests/worker/protocol.test.ts`

Expected: PASS, including existing v2 rejection tests updated to expect v3.

- [ ] **Step 5: Commit**

```bash
git add src/worker/protocol.ts tests/worker/protocol.test.ts
git commit -m "feat: add worker protocol v3 Anki state"
```

### Task 4: Teach Worker Engine About Effective Anki Decisions

**Files:**
- Modify: `src/worker/worker-engine.ts`
- Modify: `src/worker/miner.worker.ts`
- Modify: `tests/worker/worker-engine.test.ts`
- Modify: `tests/worker/worker-coverage.test.ts`

**Interfaces:**
- `WorkerEngine.query()` uses explicit `request.ankiStatuses` for filtering, known counts, and returned metadata.
- `WorkerEngine.coverage()` passes Anki statuses to `computeCoverage()`.
- `WorkerEngine.previewAnkiMatch()` publishes `anki-preview-result` with `AnkiPreviewMatchStats`.

- [ ] **Step 1: Add failing engine tests**

```ts
it("filters and decorates Anki Known without leaking manual overrides", async () => {
  engine.loadStart("dataset-1", "load-1");
  engine.loadChunk("dataset-1", 0, [entry("word")], "load-1");
  engine.loadComplete("dataset-1", "load-1");
  const responses: WorkerResponse[] = [];
  await engine.query({
    protocolVersion: 3,
    type: "query",
    requestId: "query-1",
    datasetId: "dataset-1",
    knownWords: [],
    decisions: [],
    ankiStatuses: [["word", "known"]],
    query: defaultQuery,
  }, (response) => responses.push(response));
  expect(responses[0]).toMatchObject({ type: "query-result", result: { knownCount: 1 } });
  expect(responses[0]).toMatchObject({ result: { items: [{ decision: "known", decisionSource: "anki", knownByAnki: true }] } });
});

it("counts unique canonical preview matches and protects manual decisions", async () => {
  const responses: WorkerResponse[] = [];
  await engine.previewAnkiMatch({
    protocolVersion: 3,
    type: "anki-preview-match",
    requestId: "preview-1",
    datasetId: "dataset-1",
    knownWords: [],
    decisions: [["word", "mined"]],
    ankiStatuses: [["WORD", "known"], ["word", "mined"]],
  }, (response) => responses.push(response));
  expect(responses[0]).toMatchObject({
    type: "anki-preview-result",
    result: { matchedWords: 1, knownCount: 0, minedCount: 0, manualProtected: 1 },
  });
});
```

- [ ] **Step 2: Run engine tests and verify failure**

Run: `npm exec vitest run tests/worker/worker-engine.test.ts tests/worker/worker-coverage.test.ts`

Expected: FAIL because the engine has no Anki map or preview method.

- [ ] **Step 3: Implement effective metadata and cache invalidation**

Extend `WindowCache` with `sourceByIndex`. Canonicalize request Anki tuples once per query, include sorted tuples in `windowCacheSignature()`, and resolve each entry with `resolveEffectiveDecision()`. Return:

```ts
const knownByDecision = source === "manual" && decision === "known";
const knownByAnki = source === "anki" && decision === "known";
return {
  ...value,
  known: knownByMigaku || knownByDecision || knownByAnki,
  knownByMigaku,
  knownByDecision,
  knownByAnki,
  decision,
  decisionSource: source,
};
```

Add `previewAnkiMatch()` that builds a canonical dataset-word set, iterates unique Anki tuples, resolves manual precedence, increments `matchedWords`, `knownCount`, `minedCount`, and `manualProtected`, and checks `chunkFinished()` plus dataset generation before publishing.

- [ ] **Step 4: Run worker suite and typecheck**

Run: `npm exec vitest run tests/worker && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/worker-engine.ts src/worker/miner.worker.ts tests/worker/worker-engine.test.ts tests/worker/worker-coverage.test.ts
git commit -m "feat: resolve Anki state in worker"
```

### Task 5: Extend Worker Client For Anki Tuples And Preview Matching

**Files:**
- Modify: `src/app/worker-client.ts`
- Modify: `tests/app/worker-client.test.ts`

**Interfaces:**
- `WorkerQueryInput.ankiStatuses?: Array<[string, AnkiWordStatus]>`.
- `WorkerCoverageInput.ankiStatuses?: Array<[string, AnkiWordStatus]>`.
- `WorkerClient.previewAnkiMatch(input): Promise<AnkiPreviewMatchStats>`.
- New operation kind is tracked independently and does not supersede normal/user/review/queue queries.

- [ ] **Step 1: Add failing client tests**

```ts
it("sends Anki tuples and resolves preview results", async () => {
  const client = createWorkerClient(() => fakeWorker);
  const resultPromise = client.previewAnkiMatch({
    datasetId: "dataset-1",
    knownWords: [],
    decisions: [],
    ankiStatuses: [["word", "mined"]],
  });
  expect(fakeWorker.messages.at(-1)).toMatchObject({
    type: "anki-preview-match",
    protocolVersion: 3,
    ankiStatuses: [["word", "mined"]],
  });
  fakeWorker.emit({
    protocolVersion: 3,
    type: "anki-preview-result",
    requestId: (fakeWorker.messages.at(-1) as { requestId: string }).requestId,
    datasetId: "dataset-1",
    result: { matchedWords: 1, knownCount: 0, minedCount: 1, manualProtected: 0 },
  });
  await expect(resultPromise).resolves.toEqual({ matchedWords: 1, knownCount: 0, minedCount: 1, manualProtected: 0 });
});
```

- [ ] **Step 2: Run client test and verify failure**

Run: `npm exec vitest run tests/app/worker-client.test.ts`

Expected: FAIL because `previewAnkiMatch()` and v3 response handling do not exist.

- [ ] **Step 3: Implement request construction and response routing**

Add `ankiStatuses: input.ankiStatuses ?? []` to query and coverage requests. Add a pending operation kind, response discriminator, and method:

```ts
async previewAnkiMatch(input: WorkerAnkiPreviewInput): Promise<AnkiPreviewMatchStats> {
  const requestId = this.requestId("anki-preview");
  const result = this.register<AnkiPreviewMatchStats>(requestId, "anki-preview");
  this.post({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    type: "anki-preview-match",
    requestId,
    datasetId: input.datasetId,
    knownWords: [...input.knownWords],
    decisions: input.decisions ?? [],
    ankiStatuses: [...input.ankiStatuses],
  });
  return result;
}
```

- [ ] **Step 4: Run client tests and typecheck**

Run: `npm exec vitest run tests/app/worker-client.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/worker-client.ts tests/app/worker-client.test.ts
git commit -m "feat: expose Anki preview through worker client"
```

### Task 6: Implement Strict Read-Only AnkiConnect Adapter

**Files:**
- Create: `src/platform/anki-connect.ts`
- Create: `tests/platform/anki-connect.test.ts`

**Interfaces:**
- `AnkiConnectPort` exposes only `requestPermission`, `deckNames`, `modelNames`, `modelFieldNames`, `findCards`, and `cardsInfo`.
- `AnkiCardInfo` contains only `cardId` and `{ [fieldName: string]: string }` field values.
- `createAnkiConnectPort(options?)` supports injected `fetchFn`, endpoint, and timeout for tests.
- `AnkiConnectError` has typed codes: `connection-failed`, `timeout`, `permission-denied`, `api-key-required`, `protocol-error`, and `anki-error`.
- `buildAnkiBaseSearch()` and `quoteAnkiSearchValue()` are pure exports used to test search escaping.

- [ ] **Step 1: Add failing adapter tests**

```ts
it("quotes note and deck values without allowing search syntax injection", () => {
  expect(quoteAnkiSearchValue('Diaz "Mine"')).toBe('"Diaz \\"Mine\\""');
  expect(buildAnkiBaseSearch({
    noteType: 'Diaz "Mine"',
    deckScope: { kind: "deck", name: "MAIN::Mining" },
  })).toBe('note:"Diaz \\"Mine\\"" deck:"MAIN::Mining"');
});

it("rejects permission denial and API-key-required responses", async () => {
  const denied = createAnkiConnectPort({ fetchFn: jsonFetch({ permission: "denied" }) });
  await expect(denied.requestPermission()).rejects.toMatchObject({ code: "permission-denied" });

  const keyRequired = createAnkiConnectPort({
    fetchFn: jsonFetch({ permission: "unauthorized", requireApiKey: true }),
  });
  await expect(keyRequired.requestPermission()).rejects.toMatchObject({ code: "api-key-required" });
});

it("batches cardsInfo at 500 and rejects malformed envelopes", async () => {
  const calls: unknown[][] = [];
  const port = createAnkiConnectPort({
    fetchFn: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { action: string; params?: { cards: number[] } };
      if (body.action === "cardsInfo") calls.push(body.params?.cards ?? []);
      return response({ result: [], error: null });
    },
  });
  await port.cardsInfo(Array.from({ length: 501 }, (_, index) => index + 1));
  expect(calls.map((batch) => batch.length)).toEqual([500, 1]);
  const malformed = createAnkiConnectPort({ fetchFn: jsonFetch({ result: "wrong", error: null }) });
  await expect(malformed.deckNames()).rejects.toMatchObject({ code: "protocol-error" });
});

it("maps connection failures and timeouts to typed adapter errors", async () => {
  const failed = createAnkiConnectPort({ fetchFn: async () => { throw new TypeError("refused"); } });
  await expect(failed.deckNames()).rejects.toMatchObject({ code: "connection-failed" });

  const timeout = createAnkiConnectPort({
    timeoutMs: 1,
    fetchFn: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }),
  });
  await expect(timeout.deckNames()).rejects.toMatchObject({ code: "timeout" });
});

it("has no Anki mutation methods", () => {
  const port = createAnkiConnectPort({ fetchFn: jsonFetch({ result: [], error: null }) });
  expect("addNote" in port).toBe(false);
  expect("updateNoteFields" in port).toBe(false);
  expect("changeDeck" in port).toBe(false);
  expect("suspend" in port).toBe(false);
  expect("unsuspend" in port).toBe(false);
  expect("forgetCards" in port).toBe(false);
  expect("setDueDate" in port).toBe(false);
});
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `npm exec vitest run tests/platform/anki-connect.test.ts`

Expected: FAIL because the port and adapter do not exist.

- [ ] **Step 3: Implement API v6 transport and strict parsing**

Use this request shape for every call:

```ts
const body = JSON.stringify({ action, version: 6, ...(params === undefined ? {} : { params }) });
const response = await fetchFn(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
  signal: controller.signal,
});
```

Require an object envelope with a `result` property and `error` equal to `null`; non-null errors become `anki-error`. Abort caused by the adapter timeout becomes `timeout`; other fetch failures become `connection-failed`. Validate every result shape before returning it. `cardsInfo()` splits IDs into `ANKI_CARDS_INFO_BATCH_SIZE = 500` requests and concatenates validated card records. Do not expose a generic `request()` method publicly, because a generic transport would weaken the read-only boundary.

- [ ] **Step 4: Run adapter tests, lint, and typecheck**

Run: `npm exec vitest run tests/platform/anki-connect.test.ts && npm run lint -- --write=false && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/anki-connect.ts tests/platform/anki-connect.test.ts
git commit -m "feat: add read-only AnkiConnect adapter"
```

### Task 7: Add Anki Sync Storage Contracts And Memory Parity

**Files:**
- Modify: `src/storage/contracts.ts`
- Modify: `src/storage/memory-store.ts`
- Create: `tests/storage/anki-sync-store.test.ts`
- Modify: `tests/storage/memory-store.test.ts`

**Interfaces:**
- Add `AnkiSyncStore` with `loadConfig`, `saveConfig`, `loadSnapshot`, `replaceSnapshot`, and `clear`.
- Add `ankiSync: AnkiSyncStore` to `AppStore`.
- Add `ankiSync` to `RestoreUserStateSnapshot` as `{ config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null }`.
- `MemoryAppStore` implements isolated clone-on-read/write behavior for config and snapshot.

- [ ] **Step 1: Add failing memory parity tests**

```ts
it("round-trips and replaces Anki config/snapshot independently", async () => {
  const store = createMemoryAppStore();
  const config = { deckScope: { kind: "all-decks" as const }, noteType: "Mine", targetField: "Word" };
  const first = { syncedAt: "2026-09-10T10:00:00.000Z", statuses: [["word", "mined"] as [string, "mined"]] };
  await store.ankiSync.saveConfig(config);
  await store.ankiSync.replaceSnapshot(first);
  expect(await store.ankiSync.loadConfig()).toEqual(config);
  expect(await store.ankiSync.loadSnapshot()).toEqual(first);
  await store.ankiSync.replaceSnapshot({ syncedAt: "2026-09-10T11:00:00.000Z", statuses: [] });
  expect((await store.ankiSync.loadSnapshot())?.statuses).toEqual([]);
  await store.ankiSync.clear();
  expect(await store.ankiSync.loadConfig()).toBeNull();
  expect(await store.ankiSync.loadSnapshot()).toBeNull();
});
```

- [ ] **Step 2: Run storage test and verify failure**

Run: `npm exec vitest run tests/storage/anki-sync-store.test.ts tests/storage/memory-store.test.ts`

Expected: FAIL because `AppStore.ankiSync` is missing.

- [ ] **Step 3: Implement contracts and memory store**

Use a single `StoredAnkiSync` object internally:

```ts
interface StoredAnkiSync {
  config: AnkiSyncConfig | null;
  snapshot: AnkiSyncSnapshot | null;
}

class MemoryAnkiSyncStore implements AnkiSyncStore {
  private value: StoredAnkiSync = { config: null, snapshot: null };
  async loadConfig(): Promise<AnkiSyncConfig | null> { return cloneConfig(this.value.config); }
  async saveConfig(config: AnkiSyncConfig): Promise<void> { this.value.config = cloneConfig(config); }
  async loadSnapshot(): Promise<AnkiSyncSnapshot | null> { return cloneSnapshot(this.value.snapshot); }
  async replaceSnapshot(snapshot: AnkiSyncSnapshot): Promise<void> { this.value.snapshot = cloneSnapshot(snapshot); }
  clear(): void { this.value = { config: null, snapshot: null }; }
}
```

Clone nested deck scopes, tuple arrays, and status tuples so caller mutation cannot alter storage. Include the store in `MemoryAppStore`, `restoreUserState()`, and `clearAll()`.

- [ ] **Step 4: Run memory/storage suite and typecheck**

Run: `npm exec vitest run tests/storage/anki-sync-store.test.ts tests/storage/memory-store.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/contracts.ts src/storage/memory-store.ts tests/storage/anki-sync-store.test.ts tests/storage/memory-store.test.ts
git commit -m "feat: add memory Anki sync storage"
```

### Task 8: Upgrade IndexedDB From Version 2 To Version 3

**Files:**
- Modify: `src/storage/indexed-db.ts`
- Modify: `tests/storage/indexed-db.test.ts`
- Create or modify: `tests/storage/indexed-db-upgrade.test.ts`

**Interfaces:**
- `INDEXED_DB_VERSION` becomes `3`.
- New object store `ankiSync` has key path `id`; one record with key `current` stores config and snapshot.
- `IndexedDbAppStore.ankiSync` matches `AnkiSyncStore`.
- Existing dataset, entry chunk, known-word, preference, metadata, and manual-decision records survive v2 to v3 upgrade unchanged.

- [ ] **Step 1: Add failing round-trip and upgrade tests**

```ts
it("creates Anki store while preserving real v2 state", async () => {
  const databaseName = `anki-upgrade-${crypto.randomUUID()}`;
  const request = indexedDB.open(databaseName, 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("datasets", { keyPath: "id" });
    db.createObjectStore("entryChunks", { keyPath: ["datasetId", "chunkIndex"] });
    db.createObjectStore("knownWordSets", { keyPath: "id" });
    db.createObjectStore("preferences", { keyPath: "id" });
    db.createObjectStore("meta", { keyPath: "key" });
    db.createObjectStore("wordDecisions", { keyPath: "normalizedWord" });
  };
  const database = await requestToPromise(request);
  const transaction = database.transaction(["wordDecisions"], "readwrite");
  transaction.objectStore("wordDecisions").put({ normalizedWord: "word", status: "later", updatedAt: "now" });
  await transactionToPromise(transaction);
  database.close();
  const upgraded = new IndexedDbAppStore(databaseName);
  expect(await upgraded.wordDecisions.get("word")).toEqual({ normalizedWord: "word", status: "later", updatedAt: "now" });
  expect(await upgraded.ankiSync.loadConfig()).toBeNull();
  expect(await upgraded.ankiSync.loadSnapshot()).toBeNull();
});
```

Also add IndexedDB config/snapshot round-trip, replacement, and clear tests.

- [ ] **Step 2: Run IndexedDB tests and verify failure**

Run: `npm exec vitest run tests/storage/indexed-db.test.ts tests/storage/indexed-db-upgrade.test.ts`

Expected: FAIL because version remains `2` and no Anki store exists.

- [ ] **Step 3: Implement v3 store and guarded upgrade**

Add constants and record type:

```ts
export const INDEXED_DB_VERSION = 3;
const ANKI_SYNC_STORE = "ankiSync";
const ANKI_SYNC_KEY = "current";
interface AnkiSyncRecord {
  id: typeof ANKI_SYNC_KEY;
  config: AnkiSyncConfig | null;
  snapshot: AnkiSyncSnapshot | null;
}
```

In `onupgradeneeded`, create `ankiSync` only when missing. Implement `IndexedDbAnkiSyncStore` with a read/write transaction for each method; `replaceSnapshot` reads the current record and updates only `snapshot`; `saveConfig` updates only `config`; missing record defaults both fields to `null`. Add the store to `StoreName`, constructor, `AppStore`, and clone helpers.

- [ ] **Step 4: Extend atomic restore and global clear**

Add `ANKI_SYNC_STORE` to the restore transaction and write one `current` record from `snapshot.ankiSync`. Add it to `clearAll()` and ensure `clear()` deletes the record. Add tests proving failed restore leaves old Anki config/snapshot intact.

- [ ] **Step 5: Run storage suite and typecheck**

Run: `npm exec vitest run tests/storage && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/indexed-db.ts tests/storage/indexed-db.test.ts tests/storage/indexed-db-upgrade.test.ts
git commit -m "feat: persist Anki sync in IndexedDB v3"
```

### Task 9: Upgrade Backup Format To Version 2

**Files:**
- Modify: `src/domain/backup.ts`
- Modify: `tests/domain/backup.test.ts`

**Interfaces:**
- `BACKUP_VERSION` becomes `2`.
- `serializeBackup()` accepts `ankiSync` and always emits a validated v2 section.
- `parseBackup()` accepts v1 and v2, returns a normalized parsed shape with `ankiSync: null` for v1.
- v2 validation rejects invalid deck scopes, empty config strings, invalid timestamps, malformed status tuples, unknown statuses, empty/non-canonical keys, and duplicate keys.

- [ ] **Step 1: Add failing backup tests**

```ts
it("round-trips Anki config and snapshot in v2", () => {
  const text = serializeBackup({
    exportedAt: "2026-09-10T10:00:00.000Z",
    knownWords: null,
    wordDecisions: [],
    preferences: null,
    ankiSync: {
      config: { deckScope: { kind: "deck", name: "MAIN::Mining" }, noteType: "Mine", targetField: "Word" },
      snapshot: { syncedAt: "2026-09-10T09:00:00.000Z", statuses: [["word", "known"]] },
    },
  });
  const parsed = parseBackup(text);
  expect(parsed.version).toBe(2);
  expect(parsed.ankiSync?.snapshot?.statuses).toEqual([["word", "known"]]);
});

it("accepts v1 and normalizes missing Anki state to null", () => {
  const parsed = parseBackup(JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: "2026-09-10T10:00:00.000Z",
    knownWords: null,
    wordDecisions: [],
    preferences: null,
  }));
  expect(parsed.ankiSync).toBeNull();
});

it.each([
  [["", "known"]],
  [["word", "bad"]],
  [["word", "known"], ["word", "mined"]],
])("rejects malformed Anki statuses %j", (statuses) => {
  expect(() => parseBackup(v2Fixture({ snapshot: { syncedAt: "2026-09-10T09:00:00.000Z", statuses } }))).toThrow();
});
```

- [ ] **Step 2: Run backup tests and verify failure**

Run: `npm exec vitest run tests/domain/backup.test.ts`

Expected: FAIL because exporter emits version `1` and parser has no Anki section.

- [ ] **Step 3: Implement v2 schema and parser normalization**

Define `AnkiSyncBackupSection` as `{ config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null }`. Keep `MinerBackupV1` exported for old callers/tests, add `MinerBackupV2`, and export `ParsedMinerBackup` with an `ankiSync` property. In `parseBackup`, branch on version `1` or `2`; v1 runs existing validation and returns `ankiSync: null`; v2 validates `ankiSync` and returns it. Keep old preference defaults unchanged.

Canonical snapshot validation must compare `normalizeText(key)` to the supplied key and reject empty keys. Validate timestamps with `Number.isFinite(Date.parse(value))`. Validate deck scope exactly as `{ kind: "all-decks" }` or `{ kind: "deck", name: nonEmpty }`.

- [ ] **Step 4: Run domain backup suite and typecheck**

Run: `npm exec vitest run tests/domain/backup.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/backup.ts tests/domain/backup.test.ts
git commit -m "feat: add backup format v2 Anki state"
```

### Task 10: Add Lightweight Anki App State And Service Core

**Files:**
- Modify: `src/app/state.ts`
- Modify: `src/app/services/context.ts`
- Create: `src/app/services/anki-sync-service.ts`
- Create: `tests/app/services/anki-sync-service.test.ts`

**Interfaces:**
- `AnkiUiState` contains only configured/status/timestamp/counts/config labels/error.
- `AnkiPreviewState` contains scan counts, dataset match counts, queue-removal count, and zero-card warning state.
- `AppState` gains `anki` and `ankiPreview`; `snapshotAppState()` clones only these small objects, never the full status `Map`.
- `ControllerCore` gains `ankiStatusTuples(): Array<[string, AnkiWordStatus]>` and retains existing lock/epoch/query methods.
- `AnkiSyncService` constructor is `new AnkiSyncService(core, portFactory, decisions, coverage)` where `portFactory: () => AnkiConnectPort`, `decisions: Pick<DecisionService, "clearUndo">`, and `coverage: Pick<CoverageService, "request">`.
- `AnkiSyncService` owns config, full snapshot map, preview candidate, config revision, connection orchestration, and persistence operations.

- [ ] **Step 1: Add failing service initialization/config tests**

```ts
it("loads saved config and snapshot into lightweight UI state without publishing the map", async () => {
  const store = createMemoryAppStore();
  await store.ankiSync.saveConfig({ deckScope: { kind: "all-decks" }, noteType: "Mine", targetField: "Word" });
  await store.ankiSync.replaceSnapshot({ syncedAt: "2026-09-10T10:00:00.000Z", statuses: [["word", "known"]] });
  const service = new AnkiSyncService(coreFor(store), () => fakePort, decisionSpy, coverageSpy);
  await service.initialize();
  expect(core.state.anki).toMatchObject({ configured: true, wordCount: 1, knownCount: 1, minedCount: 0 });
  expect((core.state as { ankiStatuses?: unknown }).ankiStatuses).toBeUndefined();
  expect(service.ankiStatusTuples()).toEqual([["word", "known"]]);
});

it("does not save config when permission is denied", async () => {
  const service = new AnkiSyncService(core, () => deniedPort, decisionSpy, coverageSpy);
  await expect(service.validateAndSaveConfig(validConfig)).rejects.toMatchObject({ code: "permission-denied" });
  expect(await store.ankiSync.loadConfig()).toBeNull();
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm exec vitest run tests/app/services/anki-sync-service.test.ts`

Expected: FAIL because state fields and service do not exist.

- [ ] **Step 3: Add AppState types and clone logic**

Use these shapes:

```ts
export type AnkiUiStatus = "idle" | "connecting" | "syncing" | "preview" | "error";

export interface AnkiUiState {
  configured: boolean;
  status: AnkiUiStatus;
  lastSyncedAt: string | null;
  wordCount: number;
  knownCount: number;
  minedCount: number;
  deckScopeLabel: string | null;
  noteType: string | null;
  targetField: string | null;
  errorMessage: string | null;
}

export interface AnkiPreviewState {
  scannedCards: number;
  uniqueWords: number;
  matchedWords: number | null;
  knownCount: number | null;
  minedCount: number | null;
  manualProtected: number | null;
  emptyTargetFields: number;
  queueRemovals: number;
  zeroCards: boolean;
  datasetAvailable: boolean;
}
```

Initialize `anki` and `ankiPreview: null`; clone both in `cloneAppState`. Do not add the snapshot map to `AppState`.

- [ ] **Step 4: Implement service initialization, connection, and config validation**

`initialize()` loads config and snapshot through `core.storageOperation`, canonicalizes snapshot tuples into a private `Map`, and publishes counts. `connect()` calls permission then deck/model discovery. `loadModelFields()` calls `modelFieldNames()`. `validateAndSaveConfig()` rechecks permission, selected deck, note type, and field; saves only after all checks pass; increments config revision and backup freshness only if config changed; invalidates any preview. All errors set `anki.status = "error"` without clearing prior snapshot/config.

Use `configLabel()` to display `All decks` or the selected deck. Keep all Anki transport objects private to the service.

Define `AnkiSyncServiceError` with codes `not-configured`, `stale-preview`, `invalid-config`, and `scan-failed`; methods reject with this error after updating UI error state so controller callers and tests can distinguish stale previews from transport failures.

- [ ] **Step 5: Run service tests, typecheck, and clone tests**

Run: `npm exec vitest run tests/app/services/anki-sync-service.test.ts tests/app/state-snapshot.test.ts && npm run typecheck`

Expected: PASS; snapshot tests prove published state contains no full Anki map.

- [ ] **Step 6: Commit**

```bash
git add src/app/state.ts src/app/services/context.ts src/app/services/anki-sync-service.ts tests/app/services/anki-sync-service.test.ts tests/app/state-snapshot.test.ts
git commit -m "feat: add Anki sync service state boundary"
```

### Task 11: Implement Read-Only Scan And Preview

**Files:**
- Modify: `src/app/services/anki-sync-service.ts`
- Modify: `tests/app/services/anki-sync-service.test.ts`

**Interfaces:**
- `previewSync(): Promise<void>` scans selected cards, builds a complete candidate in memory, asks worker for dataset matching, and publishes a temporary preview only.
- `cancelPreview(): void` drops candidate with no persistent mutation.
- `ankiStatusTuples()` returns the last successful applied snapshot, not the pending candidate.

- [ ] **Step 1: Add failing scan/preview tests**

```ts
it("builds candidate with canonical duplicate merging and does not mutate saved snapshot", async () => {
  fakePort.findCards.mockImplementation(async (search: string) => {
    if (search.includes("is:new")) return [1];
    return [1, 2, 3];
  });
  fakePort.cardsInfo.mockResolvedValue([
    { cardId: 1, fields: { Word: " Word " } },
    { cardId: 2, fields: { Word: "word" } },
    { cardId: 3, fields: { Word: "other" } },
  ]);
  await service.previewSync();
  expect(core.state.ankiPreview).toMatchObject({ scannedCards: 3, uniqueWords: 2, emptyTargetFields: 0 });
  expect(service.ankiStatusTuples()).toEqual(previousSnapshot);
  expect(await store.ankiSync.loadSnapshot()).toEqual(previousSnapshotRecord);
});

it("counts empty fields without failing and reports zero-card destructive warning", async () => {
  fakePort.findCards.mockResolvedValue([]);
  fakePort.cardsInfo.mockResolvedValue([]);
  await service.previewSync();
  expect(core.state.ankiPreview).toMatchObject({ scannedCards: 0, zeroCards: true, emptyTargetFields: 0 });
  expect(core.state.anki.status).toBe("preview");
});

it("skips empty target fields while retaining non-empty cards", async () => {
  fakePort.findCards.mockImplementation(async (search: string) => search.includes("is:new") ? [1] : [1, 2]);
  fakePort.cardsInfo.mockResolvedValue([
    { cardId: 1, fields: { Word: "" } },
    { cardId: 2, fields: { Word: "word" } },
  ]);
  await service.previewSync();
  expect(core.state.ankiPreview).toMatchObject({ scannedCards: 2, uniqueWords: 1, emptyTargetFields: 1 });
});

it("keeps previous snapshot when any cardsInfo batch fails", async () => {
  fakePort.findCards.mockResolvedValue(Array.from({ length: 501 }, (_, index) => index));
  fakePort.cardsInfo.mockRejectedValue(new Error("batch failed"));
  await expect(service.previewSync()).rejects.toThrow("batch failed");
  expect(service.ankiStatusTuples()).toEqual(previousSnapshot);
  expect(core.state.ankiPreview).toBeNull();
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm exec vitest run tests/app/services/anki-sync-service.test.ts`

Expected: FAIL because scan/preview methods are not implemented.

- [ ] **Step 3: Implement scan algorithm**

Build searches only through `buildAnkiBaseSearch(config)` and append ` is:new -is:suspended` for the Mined subset. Fetch selected IDs, fetch New/not-suspended IDs, then call `cardsInfo()` and require the configured field on every returned card. Trim field values; count empty values; canonicalize with `canonicalWord()`; classify by membership in the New ID set; merge duplicate words with `aggregateAnkiStatuses()`.

Require returned card IDs to belong to the selected ID set. Treat a missing configured field as a typed `AnkiConnectError("protocol-error", ...)` and discard the whole candidate. Keep candidate map, counts, captured config revision, epoch, and dataset ID private.

- [ ] **Step 4: Implement worker dataset matching and preview publication**

When a dataset exists, call:

```ts
await core.worker.previewAnkiMatch({
  datasetId,
  knownWords: [...core.state.knownWords],
  decisions: core.decisionTuples(),
  ankiStatuses: [...candidate.statuses],
});
```

When no dataset exists, leave match fields `null` and mark `datasetAvailable: false`. Compute queue removals by intersecting current queue words with candidate words that have no manual decision. Publish `anki.status = "preview"` only after all scan/match work succeeds. `cancelPreview()` clears candidate and preview without storage writes.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm exec vitest run tests/app/services/anki-sync-service.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/anki-sync-service.ts tests/app/services/anki-sync-service.test.ts
git commit -m "feat: add Anki sync preview scanning"
```

### Task 12: Implement Atomic Apply, Clear, Stale Preview, And Queue Semantics

**Files:**
- Modify: `src/app/services/anki-sync-service.ts`
- Modify: `tests/app/services/anki-sync-service.test.ts`
- Modify: `src/app/services/decision-service.ts` only if needed to expose existing undo clearing; do not alter manual decision semantics.

**Interfaces:**
- `applySync(): Promise<void>` atomically replaces stored snapshot and then updates the private map, queue, UI summary, undo, query, and coverage.
- `clearSyncData(): Promise<void>` clears config/snapshot and exposes underlying manual/Migaku state.
- `resetLocal(): void` drops service memory for global clear after store clearing.
- `restoreFromBackup(section): void` hydrates service memory after atomic backup restore.

- [ ] **Step 1: Add failing apply/atomicity tests**

```ts
it("applies one snapshot, removes only Anki-owned queue entries, and refreshes once", async () => {
  core.state.queue = { datasetId: "dataset-1", normalizedWords: ["anki-word", "manual-word"], mode: "normal" };
  core.state.wordDecisions.set("manual-word", manualDecision("later"));
  await service.previewSync();
  await service.applySync();
  expect(await store.ankiSync.loadSnapshot()).toEqual(expectedSnapshot);
  expect(service.ankiStatusTuples()).toEqual(expectedSnapshot.statuses);
  expect(core.state.queue.normalizedWords).toEqual(["manual-word"]);
  expect(core.runQuery).toHaveBeenCalledTimes(1);
  expect(coverageSpy.request).toHaveBeenCalledTimes(1);
  expect(core.countChangeSinceExport).toHaveBeenCalledTimes(1);
});

it("refuses stale preview after epoch/config/dataset changes", async () => {
  await service.previewSync();
  core.bumpUserStateEpoch();
  await expect(service.applySync()).rejects.toMatchObject({ code: "stale-preview" });
  expect(await store.ankiSync.loadSnapshot()).toEqual(previousSnapshotRecord);
});

it("preserves prior snapshot and queue when storage replacement fails", async () => {
  await service.previewSync();
  store.ankiSync.replaceSnapshot = vi.fn().mockRejectedValue(new Error("storage failed"));
  await expect(service.applySync()).rejects.toThrow("storage failed");
  expect(service.ankiStatusTuples()).toEqual(previousSnapshot);
  expect(core.state.queue.normalizedWords).toEqual(originalQueue);
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm exec vitest run tests/app/services/anki-sync-service.test.ts`

Expected: FAIL because Apply and clear semantics are not implemented.

- [ ] **Step 3: Implement stale guards and locked storage replacement**

Before locking, require a candidate and compare config revision, dataset ID, and user-state epoch. Inside `core.withUserStateLock`, compare all three again. Call `store.ankiSync.replaceSnapshot()` before mutating service map, queue, undo, or UI state. If storage throws, leave every in-memory value unchanged and set a retryable Anki error.

After storage succeeds, replace the private map, count known/mined statuses, remove queued words only when candidate contains the word and `core.state.wordDecisions` has no manual record, call `decisions.clearUndo()`, count exactly one backup-relevant change, publish once, then call `core.runQuery()` and coverage once. Never call those methods per status.

- [ ] **Step 4: Implement clear and backup hydration**

`clearSyncData()` acquires the user-state lock, calls `store.ankiSync.clear()`, then clears config/map/preview, increments config revision, counts one change, publishes, and refreshes query/coverage once. `resetLocal()` performs only in-memory reset. `restoreFromBackup()` accepts `{ config, snapshot } | null`, canonicalizes snapshot tuples, updates UI counts, and invalidates preview without counting a new change.

- [ ] **Step 5: Run service suite and typecheck**

Run: `npm exec vitest run tests/app/services/anki-sync-service.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/anki-sync-service.ts tests/app/services/anki-sync-service.test.ts
git commit -m "feat: atomically apply Anki decisions"
```

### Task 13: Wire Anki Service Through Controller, Query, Coverage, Review, And Queue

**Files:**
- Modify: `src/app/state.ts`
- Modify: `src/app/services/context.ts`
- Modify: `src/app/controller.ts`
- Modify: `src/app/services/coverage-service.ts`
- Modify: `src/app/services/mining-queue-service.ts`
- Modify: `src/app/services/review-session.ts`
- Modify: `src/app/worker-client.ts` call sites if signatures require it
- Modify: `tests/app/controller.test.ts`
- Modify: `tests/app/services/review-session-state-replacement.test.ts`
- Modify: `tests/app/mining-queue.test.ts`

**Interfaces:**
- `MinerController` exposes `connectAnki(): Promise<{ decks: string[]; models: string[] }>`, `loadAnkiModelFields(noteType: string): Promise<string[]>`, `validateAndSaveAnkiConfig(config: AnkiSyncConfig): Promise<void>`, `previewAnkiSync(): Promise<void>`, `applyAnkiSync(): Promise<void>`, `cancelAnkiSyncPreview(): void`, and `clearAnkiSyncData(): Promise<void>`.
- Every worker query and coverage request passes `ankiStatuses: this.ankiSync.ankiStatusTuples()`.
- Initialization loads Anki state without requiring Anki to be open.

- [ ] **Step 1: Add failing controller behavior tests**

```ts
it("keeps saved Anki classifications active after Anki becomes unavailable", async () => {
  const store = createMemoryAppStore();
  await store.ankiSync.saveConfig(validConfig);
  await store.ankiSync.replaceSnapshot(savedSnapshot);
  const controller = createMinerController({ store, worker: workerWithDataset() });
  await controller.init();
  const state = latestState(controller);
  expect(state.anki.wordCount).toBe(savedSnapshot.statuses.length);
  expect(state.result?.items[0]?.decisionSource).toBe("anki");
});

it("passes Anki Known through review and hideKnown", async () => {
  await controller.validateAndSaveAnkiConfig(validConfig);
  await controller.applyAnkiSync();
  controller.updateQuery({ hideKnown: true });
  await flush();
  expect(latestState(controller).result?.items).not.toContainEqual(expect.objectContaining({ decision: "known" }));
});
```

- [ ] **Step 2: Run controller/service tests and verify failure**

Run: `npm exec vitest run tests/app/controller.test.ts tests/app/mining-queue.test.ts tests/app/services/review-session-state-replacement.test.ts`

Expected: FAIL because worker inputs omit Anki tuples and controller lacks Anki methods.

- [ ] **Step 3: Construct and initialize `AnkiSyncService`**

Add `ankiConnect?: AnkiConnectPort` and `ankiConnectFactory?: () => AnkiConnectPort` to `MinerControllerOptions`. Construct the service with the same `ControllerCore` used by existing services, using `options.ankiConnectFactory ?? (() => options.ankiConnect ?? createAnkiConnectPort())`; construct `BackupService` only after the Anki service exists and pass that service to its new constructor parameter. Add `ankiStatusTuples()` to the core as a controller-owned delegate. During `initialize()`, load config/snapshot before initial query; if Anki storage read fails, surface the normal initialization error without attempting network access.

- [ ] **Step 4: Add controller facade methods and pass explicit state**

Implement facade methods as direct service calls. Update every `worker.query()` and `worker.coverage()` object in `controller.ts`, `coverage-service.ts`, `mining-queue-service.ts`, and `review-session.ts` to include `ankiStatuses`. Update import candidate queries too. `clearSavedData()` calls `ankiSync.resetLocal()` after `store.clearAll()` and before publishing fresh initial state.

- [ ] **Step 5: Verify review, filters, queue, and undo semantics**

Review query must use effective `decision: "unreviewed"`, so Anki-resolved words never enter review. A manual review action still writes a normal manual decision and hides the Anki layer; undo removes that manual record and exposes Anki again. Queue mode passes Anki state but otherwise retains existing neutral filters and ordering. Apply clears the existing manual undo record; manual undo never writes Anki status into `WordDecision`.

- [ ] **Step 6: Run application tests and typecheck**

Run: `npm exec vitest run tests/app tests/domain tests/worker && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/state.ts src/app/services/context.ts src/app/controller.ts src/app/services/coverage-service.ts src/app/services/mining-queue-service.ts src/app/services/review-session.ts src/app/worker-client.ts tests/app/controller.test.ts tests/app/mining-queue.test.ts tests/app/services/review-session-state-replacement.test.ts
git commit -m "feat: wire Anki decisions through app flows"
```

### Task 14: Include Anki State In Atomic Backup Export And Restore

**Files:**
- Modify: `src/app/services/backup-service.ts`
- Modify: `src/storage/memory-store.ts` if restore shape needs final adjustments
- Modify: `src/storage/indexed-db.ts` if restore transaction needs final adjustments
- Modify: `tests/app/controller.test.ts`
- Modify: `tests/app/services/services-unit.test.ts`
- Modify: `tests/storage/memory-store.test.ts`
- Modify: `tests/storage/indexed-db.test.ts`

**Interfaces:**
- Export reads config/snapshot under the existing user-state lock and emits backup v2.
- Restore passes Anki config/snapshot through `restoreUserState()` atomically and hydrates `AnkiSyncService` only after storage succeeds.
- Restoring v1 clears existing Anki state; failed restore leaves old Anki state paired with old manual/known/preferences state.
- `BackupService` constructor gains an `AnkiSyncService` dependency after `MiningQueueService`; no backup code reaches the AnkiConnect port directly.

- [ ] **Step 1: Add failing backup integration tests**

```ts
it("exports and restores Anki state as one user-state unit", async () => {
  await controller.validateAndSaveAnkiConfig(validConfig);
  await controller.applyAnkiSync();
  const exported = JSON.parse(await controller.exportBackup());
  expect(exported.version).toBe(2);
  expect(exported.ankiSync.snapshot.statuses).toEqual(expectedStatuses);

  const restored = createMinerController({ store: createMemoryAppStore(), worker: workerWithDataset() });
  await restored.restoreBackup(JSON.stringify(exported));
  expect(latestState(restored).anki.wordCount).toBe(expectedStatuses.length);
});

it("restoring v1 clears newer Anki state", async () => {
  const v1 = JSON.stringify({ format: "jiten-migaku-miner-backup", version: 1, exportedAt: "2026-09-10T10:00:00.000Z", knownWords: null, wordDecisions: [], preferences: null });
  await controller.restoreBackup(v1);
  expect(latestState(controller).anki.configured).toBe(false);
  expect(latestState(controller).anki.wordCount).toBe(0);
});

it("does not leave partially restored Anki state after a failed atomic restore", async () => {
  store.restoreUserState = vi.fn().mockRejectedValue(new Error("restore failed"));
  await expect(controller.restoreBackup(validBackupWithDifferentAnki)).rejects.toThrow("restore failed");
  expect(await store.ankiSync.loadSnapshot()).toEqual(previousSnapshot);
});
```

- [ ] **Step 2: Run integration tests and verify failure**

Run: `npm exec vitest run tests/app/controller.test.ts tests/app/services/services-unit.test.ts tests/storage`

Expected: FAIL because BackupService still serializes v1 and restore snapshots lack Anki state.

- [ ] **Step 3: Extend BackupService export and restore snapshots**

In `exportBackup()`, read `store.ankiSync.loadConfig()` and `loadSnapshot()` inside the existing lock and pass the pair to `serializeBackup()`. In `restoreBackup()`, capture previous Anki config/snapshot with the existing rollback snapshot; pass `ankiSync` to `restoreUserState()`. For fallback stores, write config and snapshot after known/decisions/preferences, and roll them back in reverse order if any later write fails.

After storage commit, call `ankiSync.restoreFromBackup(backup.ankiSync)` before query/coverage refresh. Preserve existing queue/review invalidation and one counted restore mutation.

- [ ] **Step 4: Run backup/storage/application suites**

Run: `npm exec vitest run tests/domain/backup.test.ts tests/app/controller.test.ts tests/app/services/services-unit.test.ts tests/storage && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/backup-service.ts src/storage/memory-store.ts src/storage/indexed-db.ts tests/app/controller.test.ts tests/app/services/services-unit.test.ts tests/storage
git commit -m "feat: include Anki state in atomic backups"
```

### Task 15: Add Anki Sync UI Markup, Rendering, And Styling

**Files:**
- Modify: `index.html`
- Modify: `src/ui/dom.ts`
- Create: `src/ui/views/anki-view.ts`
- Modify: `src/ui/renderer.ts`
- Modify: `src/styles/layout.css`
- Create or modify: `tests/ui/anki-sync-view.test.ts`
- Modify: existing UI test DOM factories to include required Anki elements

**Interfaces:**
- Add an `Anki Sync` section near import/data controls with IDs used by `DomMap`.
- `renderAnkiSection(dom, state)` renders unconfigured, setup, configured idle, connecting/syncing, preview, zero-card warning, and error states without receiving the Anki port.
- UI displays only lightweight summary state; no full Anki map crosses into renderer state.

- [ ] **Step 1: Add failing happy-dom rendering tests**

Start the file with `// @vitest-environment happy-dom` and test:

```ts
it("renders unconfigured and configured states", () => {
  const dom = makeAnkiDom();
  renderAnkiSection(dom, stateWithAnki({ configured: false }));
  expect(dom.ankiConnect.hidden).toBe(false);
  expect(dom.ankiActions.hidden).toBe(true);

  renderAnkiSection(dom, stateWithAnki({
    configured: true,
    deckScopeLabel: "MAIN::Mining",
    noteType: "Diaz Custom Mine",
    targetField: "Target Word (no syntax)",
    wordCount: 3900,
    knownCount: 3120,
    minedCount: 780,
  }));
  expect(dom.ankiStatusLine.textContent).toContain("3,900 words");
  expect(dom.ankiStatusLine.textContent).toContain("3,120 Known");
});

it("renders preview counts and zero-card warning", () => {
  const dom = makeAnkiDom();
  renderAnkiSection(dom, stateWithPreview({ zeroCards: true }));
  expect(dom.ankiPreview.hidden).toBe(false);
  expect(dom.ankiPreviewWarning.hidden).toBe(false);
  expect(dom.ankiApply.disabled).toBe(false);
});
```

- [ ] **Step 2: Run UI tests and verify failure**

Run: `npm exec vitest run tests/ui/anki-sync-view.test.ts`

Expected: FAIL because markup, DomMap fields, and view do not exist.

- [ ] **Step 3: Add markup and DomMap fields**

Place the section after `#importGrid` and before existing backup/clear controls. Include:

```html
<section id="ankiSection" class="anki-section" aria-label="Anki Sync">
  <h3>Anki Sync</h3>
  <p id="ankiDescription">Automatically classify words from your Anki collection.</p>
  <p id="ankiStatusLine" hidden></p>
  <p id="ankiError" class="anki-error" hidden></p>
  <button id="ankiConnect" type="button">Connect to Anki</button>
  <div id="ankiSetup" hidden>
    <label>Deck scope <select id="ankiDeckScope"></select></label>
    <label>Note type <select id="ankiNoteType"></select></label>
    <label>Target word field <select id="ankiTargetField"></select></label>
    <button id="ankiCheckConfig" type="button">Check configuration</button>
  </div>
  <div id="ankiActions" hidden>
    <button id="ankiSyncNow" type="button">Sync from Anki</button>
    <button id="ankiSettings" type="button">Settings</button>
    <button id="ankiClear" type="button">Clear Anki sync data…</button>
  </div>
  <div id="ankiPreview" hidden>
    <h4>Anki Sync Preview</h4>
    <p id="ankiPreviewCounts"></p>
    <p id="ankiPreviewWarning" hidden></p>
    <button id="ankiApply" type="button">Apply Sync</button>
    <button id="ankiCancelPreview" type="button">Cancel</button>
  </div>
</section>
```

Add all elements to `DomMap` and `getDomMap()`. Update every unit-test DOM factory to create these required elements, or isolate `getDomMap()` from view tests as existing tests do for unrelated controls.

- [ ] **Step 4: Implement view and renderer integration**

Use `textContent`, `hidden`, `disabled`, and select options only; never assign unsanitized HTML. Render labels exactly as `deckScopeLabel`, `noteType`, `targetField`, timestamp, counts, and preview diagnostics. Call `renderAnkiSection()` from `renderer.renderState()` after import-panel rendering. Add restrained styles matching current data-panel controls; support narrow widths without horizontal overflow.

- [ ] **Step 5: Run UI tests, lint, and typecheck**

Run: `npm exec vitest run tests/ui && npm run lint && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add index.html src/ui/dom.ts src/ui/views/anki-view.ts src/ui/renderer.ts src/styles/layout.css tests/ui/anki-sync-view.test.ts tests/ui
git commit -m "feat: add Anki sync status and preview UI"
```

### Task 16: Bind Setup, Preview, Apply, Cancel, And Clear Controls

**Files:**
- Modify: `src/ui/controls.ts`
- Modify: `src/ui/dom.ts` if a binding target is missing
- Modify: `tests/ui/anki-sync-controls.test.ts`

**Interfaces:**
- `ControlsOptions` gains injectable `confirmAnkiClear` for deterministic tests.
- Controls call only high-level `MinerController` methods; no UI code sees the AnkiConnect port.

- [ ] **Step 1: Add failing control-flow tests**

```ts
it("connects, discovers fields, validates config, previews, applies, and clears", async () => {
  const bindings = bindControls(dom, controller, { confirmAnkiClear: () => true });
  dom.ankiConnect.click();
  await flush();
  expect(controller.connectAnki).toHaveBeenCalledTimes(1);
  expect(dom.ankiDeckScope.options.length).toBeGreaterThan(0);

  dom.ankiNoteType.value = "Diaz Custom Mine";
  dom.ankiNoteType.dispatchEvent(new Event("change"));
  await flush();
  expect(controller.loadAnkiModelFields).toHaveBeenCalledWith("Diaz Custom Mine");

  dom.ankiCheckConfig.click();
  await flush();
  expect(controller.validateAndSaveAnkiConfig).toHaveBeenCalled();
  dom.ankiSyncNow.click();
  await flush();
  expect(controller.previewAnkiSync).toHaveBeenCalledTimes(1);
  dom.ankiApply.click();
  await flush();
  expect(controller.applyAnkiSync).toHaveBeenCalledTimes(1);
  dom.ankiClear.click();
  await flush();
  expect(controller.clearAnkiSyncData).toHaveBeenCalledTimes(1);
  bindings.dispose();
});
```

- [ ] **Step 2: Run control tests and verify failure**

Run: `npm exec vitest run tests/ui/anki-sync-controls.test.ts`

Expected: FAIL because no Anki listeners exist.

- [ ] **Step 3: Implement select population and bindings**

On connect, call `controller.connectAnki()`, populate deck scope with a sentinel `all-decks` option plus discovered decks, populate note types, and show setup. On note-type change, call `loadAnkiModelFields()` and repopulate target field. Build config from selected values, translating sentinel `all-decks` to `{ kind: "all-decks" }`, then call `validateAndSaveAnkiConfig()`. Wire Sync, Apply, Cancel, Settings, and clear confirmation to the corresponding facade methods. Preserve current selections when renderer publishes state.

- [ ] **Step 4: Handle async failures without destructive changes**

Catch rejected controller promises only to let the controller-owned state render the typed error. Do not clear selects, snapshot summary, or existing list results on connection/preview failure. Disable Apply unless `state.ankiPreview !== null` and status is `preview`.

- [ ] **Step 5: Run UI suite and typecheck**

Run: `npm exec vitest run tests/ui && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/controls.ts src/ui/dom.ts tests/ui/anki-sync-controls.test.ts
git commit -m "feat: bind Anki sync workflow controls"
```

### Task 17: Add Decision Source Labels And Update Renderer Signatures

**Files:**
- Modify: `src/ui/views/entry-view.ts`
- Modify: `src/ui/renderer.ts`
- Modify: `tests/ui/entry-node.test.ts`
- Modify: `tests/ui/decision-summary.test.ts` only if summary fixtures require new fields

**Interfaces:**
- Anki-derived effective statuses render as `Known · Anki` or `Mined · Anki`.
- Manual statuses retain `Known`, `Mined`, `Skip`, or `Later` and may be rendered with the existing manual styling.
- Migaku badge remains independent.

- [ ] **Step 1: Add failing source-label tests**

```ts
it("shows Anki source on effective decision badges", () => {
  const node = renderEntryNode(makeEntry({
    decision: "known",
    decisionSource: "anki",
    knownByAnki: true,
  }), 1, DEFAULT_VIEW);
  expect(node.querySelector(".entry-badge-decision")?.textContent).toBe("Known · Anki");
});

it("does not label manual decisions as Anki", () => {
  const node = renderEntryNode(makeEntry({ decision: "mined", decisionSource: "manual" }), 1, DEFAULT_VIEW);
  expect(node.querySelector(".entry-badge-decision")?.textContent).toBe("Mined");
});
```

- [ ] **Step 2: Run UI test and verify failure**

Run: `npm exec vitest run tests/ui/entry-node.test.ts`

Expected: FAIL because entry rendering ignores `decisionSource`.

- [ ] **Step 3: Implement source-aware badge copy and cache signatures**

In `appendBadges()`, append ` · Anki` only when `entry.decisionSource === "anki"`; preserve existing labels for all other sources. Add `decisionSource` and `knownByAnki` to `renderer.ts` result signatures so source changes rebuild rows even when decision text stays the same.

- [ ] **Step 4: Run UI suite and typecheck**

Run: `npm exec vitest run tests/ui && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/views/entry-view.ts src/ui/renderer.ts tests/ui/entry-node.test.ts tests/ui/decision-summary.test.ts
git commit -m "feat: show Anki decision sources"
```

### Task 18: Add Browser End-To-End Coverage

**Files:**
- Create: `tests/e2e/anki-sync.spec.ts`

**Interfaces:**
- Browser tests mock `http://127.0.0.1:8765` with CORS-compatible API v6 responses; no real Anki install is required.

- [ ] **Step 1: Add failing E2E workflow**

```ts
test("configures, previews, and applies read-only Anki sync", async ({ page }) => {
  await mockAnkiConnect(page, { cards: fixtureCards });
  await page.goto("/");
  await importSmallDataset(page);
  await page.getByRole("button", { name: "Connect to Anki" }).click();
  await page.getByLabel("Note type").selectOption({ label: "Diaz Custom Mine" });
  await page.getByLabel("Target word field").selectOption({ label: "Target Word (no syntax)" });
  await page.getByRole("button", { name: "Check configuration" }).click();
  await page.getByRole("button", { name: "Sync from Anki" }).click();
  await expect(page.getByText("Anki Sync Preview")).toBeVisible();
  await page.getByRole("button", { name: "Apply Sync" }).click();
  await expect(page.getByText("Known · Anki")).toBeVisible();
  expect(mockAnkiConnect.mutationActions).toEqual([]);
});

test("keeps prior visible state when Anki is unavailable", async ({ page }) => {
  await page.route("http://127.0.0.1:8765/**", (route) => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to Anki" }).click();
  await expect(page.getByText(/Anki.*unavailable|connection/i)).toBeVisible();
});
```

- [ ] **Step 2: Run focused E2E and verify failure**

Run: `npm exec playwright test tests/e2e/anki-sync.spec.ts --project=chromium`

Expected: FAIL until the UI and controller workflow are wired.

- [ ] **Step 3: Implement mock route and assertions**

The mock must handle OPTIONS preflight with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, and `Access-Control-Allow-Headers: Content-Type`. Return API v6 envelopes for permission, deck/model/field discovery, findCards, and cardsInfo. Record every request action and assert no action outside the six read-only actions occurs. Use the existing fixture import helpers and no hard-coded application config.

- [ ] **Step 4: Run Chromium E2E**

Run: `npm exec playwright test tests/e2e/anki-sync.spec.ts --project=chromium`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/anki-sync.spec.ts
git commit -m "test: cover Anki sync browser workflow"
```

### Task 19: Run Full Verification And Review Diff

**Files:**
- No intended source changes; fix only failures found in files already listed above.

- [ ] **Step 1: Inspect repository status and complete diff**

Run:

```bash
git status --short
```

Expected: only Anki feature files and plan/spec-related files appear; no generated `dist`, test-result, secrets, or unrelated edits are staged.

- [ ] **Step 2: Run typecheck, lint, unit tests, build, and browser suites**

Run:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:e2e
npm run test:e2e:prod
```

Expected: all commands exit `0`. If a command fails, reproduce with its focused test, fix root cause, rerun focused test, then rerun the full command. Do not weaken assertions or skip existing suites.

- [ ] **Step 3: Verify acceptance criteria against implementation**

Check each criterion from the spec: setup discovers values; no mutation action exists; New/not-suspended and duplicate precedence are correct; preview is non-mutating; manual precedence and removal reveal Anki; failures preserve prior snapshot; Apply refreshes once; filters/hideKnown/review/coverage/source labels agree; queue removals occur only on Apply; full map stays service-owned; v2/v3 migration and v1 restore clear Anki; closing Anki leaves saved classifications active; global and Anki-specific clear work.

- [ ] **Step 4: Run final diff review**

Run: `git diff --check` and review every changed file for accidental Anki mutation method names, raw search-string concatenation outside the adapter, per-word refreshes, stale preview writes, and full snapshot publication through `AppState`.

- [ ] **Step 5: Commit any verification fix only in its owning task**

If verification exposes a defect, return it to the task that owns the changed file, add a regression test there, rerun that task's focused command, and commit with that task's conventional message. If all commands pass, create no verification-only commit.

## Spec Coverage Review

- Domain status mapping, canonical duplicate merging, manual precedence, knownness parity: Tasks 1-2.
- Read-only AnkiConnect boundary, permission/API-key/error handling, search escaping, timeout, and batching: Task 6.
- Config discovery, persistence, invalidation, and later collection drift: Tasks 10-11 and 16.
- Complete in-memory scan, empty-field diagnostics, zero-card warning, preview matching in worker: Tasks 3-5 and 11.
- Atomic Apply, stale preview guards, queue removal, undo invalidation, one refresh: Task 12.
- Lightweight published UI state and service-owned full snapshot: Tasks 10 and 15.
- IndexedDB v2 to v3 upgrade, memory parity, clear, atomic restore: Tasks 7-8 and 14.
- Backup v2, v1 compatibility, malformed-state rejection, atomic restore: Tasks 9 and 14.
- Query, coverage, filters, review, queue, and source labels: Tasks 2, 4, 13, and 17.
- Setup/idle/preview/error/clear UI and browser workflow: Tasks 15-18.
- Full unit, storage, worker, UI, E2E, lint, typecheck, and build verification: Task 19.
