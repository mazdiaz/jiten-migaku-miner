import { describe, expect, it } from "vitest";
import { computeCoverage, DEFAULT_COVERAGE_TARGETS } from "../../src/domain/coverage";
import type { Entry, QueryState } from "../../src/domain/types";
import { dispatchWorkerRequest } from "../../src/worker/miner.worker";
import {
  type CoverageRequest,
  isWorkerRequest,
  parseWorkerRequest,
  type QueryRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "../../src/worker/protocol";
import { WorkerEngine } from "../../src/worker/worker-engine";

function entry(index: number, word = `word-${index}`, occurrences = index): Entry {
  return {
    id: `entry-${index}`,
    originalIndex: index,
    word,
    normalizedWord: word,
    occurrences,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
  };
}

function coverageRequest(overrides: Partial<CoverageRequest> = {}): CoverageRequest {
  return {
    protocolVersion: 3,
    type: "coverage",
    requestId: "coverage-1",
    datasetId: "dataset-1",
    knownWords: [],
    decisions: [],
    ankiStatuses: [],
    ...overrides,
  };
}

function queryState(overrides: Partial<QueryState> = {}): QueryState {
  return {
    search: "",
    hideKnown: false,
    hideKanaOnly: false,
    sentence: "any",
    minOccurrences: 0,
    sort: "original",
    pageSize: 50,
    page: 1,
    decision: "all",
    ...overrides,
  };
}

function queryRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    protocolVersion: 3,
    type: "query",
    requestId: "query-1",
    datasetId: "dataset-1",
    knownWords: [],
    decisions: [],
    ankiStatuses: [],
    query: queryState(),
    ...overrides,
  };
}

function loadDataset(engine: WorkerEngine, datasetId: string, entries: Entry[]): void {
  const requestId = `load-${datasetId}`;
  engine.loadStart(datasetId, requestId);
  for (let offset = 0, chunkIndex = 0; offset < entries.length; offset += 2000, chunkIndex += 1) {
    engine.loadChunk(datasetId, chunkIndex, entries.slice(offset, offset + 2000), requestId);
  }
  engine.loadComplete(datasetId, requestId);
}

describe("worker coverage protocol", () => {
  const validCoverageRequest: WorkerRequest = {
    protocolVersion: 3,
    type: "coverage",
    requestId: "coverage-1",
    datasetId: "dataset-1",
    knownWords: ["猫"],
    decisions: [["犬", "known"]],
    ankiStatuses: [],
    targets: [98, 99],
  };

  it("accepts valid coverage requests with optional targets", () => {
    expect(parseWorkerRequest(validCoverageRequest)).toEqual(validCoverageRequest);
    expect(isWorkerRequest(validCoverageRequest)).toBe(true);

    const withoutTargets = {
      ...validCoverageRequest,
    } as Partial<CoverageRequest>;
    delete withoutTargets.targets;
    expect(parseWorkerRequest(withoutTargets)).toEqual(withoutTargets);
    expect(isWorkerRequest(withoutTargets)).toBe(true);
  });

  it("rejects malformed coverage payloads with typed errors", () => {
    const malformedRequests = [
      { ...validCoverageRequest, datasetId: "" },
      { ...validCoverageRequest, knownWords: "猫" },
      { ...validCoverageRequest, knownWords: [42] },
      { ...validCoverageRequest, decisions: [["犬", "bogus"]] },
      { ...validCoverageRequest, decisions: [["犬"]] },
      { ...validCoverageRequest, targets: "98" },
      { ...validCoverageRequest, targets: [98, "99"] },
      { ...validCoverageRequest, targets: [Number.NaN] },
    ];

    for (const request of malformedRequests) {
      expect(() => parseWorkerRequest(request), JSON.stringify(request)).toThrowError(
        expect.objectContaining({ code: "invalid-message" }),
      );
    }
  });

  it("dispatches coverage requests to the engine and returns coverage results", async () => {
    const engine = new WorkerEngine();
    loadDataset(engine, "dataset-1", [entry(0, "alpha", 50), entry(1, "beta", 30)]);

    const responses: WorkerResponse[] = [];
    await dispatchWorkerRequest(
      {
        protocolVersion: 3,
        type: "coverage",
        requestId: "cov-dispatch",
        datasetId: "dataset-1",
        knownWords: ["alpha"],
        decisions: [],
        ankiStatuses: [],
      },
      engine,
      (response) => responses.push(response),
    );

    const expected = computeCoverage(
      [entry(0, "alpha", 50), entry(1, "beta", 30)],
      new Set(["alpha"]),
      new Map(),
    );
    expect(responses).toEqual([
      {
        protocolVersion: 3,
        type: "coverage-result",
        requestId: "cov-dispatch",
        datasetId: "dataset-1",
        result: expected,
      },
    ]);
  });

  it("dispatches coverage failures as typed error responses", async () => {
    const responses: WorkerResponse[] = [];

    await dispatchWorkerRequest(
      {
        protocolVersion: 3,
        type: "coverage",
        requestId: "cov-missing",
        datasetId: "missing",
        knownWords: [],
        decisions: [],
        ankiStatuses: [],
      },
      new WorkerEngine(),
      (response) => responses.push(response),
    );

    expect(responses).toEqual([
      {
        protocolVersion: 3,
        type: "error",
        requestId: "cov-missing",
        code: "dataset-not-found",
        message: "Dataset not found: missing",
      },
    ]);
  });
});

describe("worker engine coverage", () => {
  it("matches the pure domain coverage function for the same fixtures", async () => {
    const engine = new WorkerEngine();
    const source = [entry(0, "alpha", 50), entry(1, "beta", 30), entry(2, "gamma", 20)];
    loadDataset(engine, "dataset-1", source);

    const knownWords = ["alpha"];
    const decisions: CoverageRequest["decisions"] = [
      ["gamma", "mined"],
      ["beta", "skip"],
    ];
    const targets = [50, 98, 99.5];

    const responses: WorkerResponse[] = [];
    await engine.coverage(
      coverageRequest({ requestId: "cov-1", knownWords, decisions, targets }),
      (response) => responses.push(response),
    );

    const expected = computeCoverage(source, new Set(knownWords), new Map(decisions), targets);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      protocolVersion: 3,
      type: "coverage-result",
      requestId: "cov-1",
      datasetId: "dataset-1",
    });
    expect(responses[0]?.type === "coverage-result" ? responses[0].result : null).toEqual(expected);
  });

  it("uses the default targets when the request omits them", async () => {
    const engine = new WorkerEngine();
    loadDataset(engine, "dataset-1", [entry(0, "alpha", 50), entry(1, "beta", 50)]);

    const responses: WorkerResponse[] = [];
    await engine.coverage(coverageRequest({ requestId: "cov-default" }), (response) =>
      responses.push(response),
    );

    const result = responses[0]?.type === "coverage-result" ? responses[0].result : null;
    expect(result?.targets.map((target) => target.targetPercent)).toEqual([
      ...DEFAULT_COVERAGE_TARGETS,
    ]);
  });

  it("returns typed errors for missing or not-ready datasets", async () => {
    const engine = new WorkerEngine();
    loadDataset(engine, "dataset-1", [entry(0, "alpha")]);

    await expect(
      engine.coverage(coverageRequest({ requestId: "nf-1", datasetId: "missing" }), () => {}),
    ).rejects.toMatchObject({ code: "dataset-not-found" });

    // A started-but-incomplete load stays in staging and is not coverable.
    engine.loadStart("staging-1", "load-staging");
    await expect(
      engine.coverage(coverageRequest({ requestId: "nf-2", datasetId: "staging-1" }), () => {}),
    ).rejects.toMatchObject({ code: "dataset-not-found" });
  });

  it("changes results when the known list changes", async () => {
    const engine = new WorkerEngine();
    const source = [entry(0, "alpha", 50), entry(1, "beta", 30), entry(2, "gamma", 20)];
    loadDataset(engine, "dataset-1", source);

    const withoutKnown: WorkerResponse[] = [];
    await engine.coverage(coverageRequest({ requestId: "k-0", knownWords: [] }), (r) =>
      withoutKnown.push(r),
    );
    const withKnown: WorkerResponse[] = [];
    await engine.coverage(
      coverageRequest({ requestId: "k-1", knownWords: ["alpha", "beta"] }),
      (r) => withKnown.push(r),
    );

    const before = withoutKnown[0]?.type === "coverage-result" ? withoutKnown[0].result : null;
    const after = withKnown[0]?.type === "coverage-result" ? withKnown[0].result : null;
    expect(before?.knownUniqueWords).toBe(0);
    expect(before?.coveragePercent).toBe(0);
    expect(after?.knownUniqueWords).toBe(2);
    expect(after?.coveragePercent).toBe(80);
  });

  it("passes request Anki statuses into coverage computation", async () => {
    const engine = new WorkerEngine();
    const source = [entry(0, "alpha", 50), entry(1, "beta", 30)];
    loadDataset(engine, "dataset-1", source);

    const responses: WorkerResponse[] = [];
    await engine.coverage(
      coverageRequest({ requestId: "anki-cov", ankiStatuses: [["BETA", "known"]] }),
      (response) => responses.push(response),
    );

    const result = responses[0]?.type === "coverage-result" ? responses[0].result : null;
    expect(result).toMatchObject({
      knownUniqueWords: 1,
      knownTrackedOccurrences: 30,
      coveragePercent: 37.5,
    });
  });

  it("dispatches Anki preview requests to the engine", async () => {
    const engine = new WorkerEngine();
    loadDataset(engine, "dataset-1", [entry(0, "word")]);
    const responses: WorkerResponse[] = [];

    await dispatchWorkerRequest(
      {
        protocolVersion: 3,
        type: "anki-preview-match",
        requestId: "preview-dispatch",
        datasetId: "dataset-1",
        knownWords: [],
        decisions: [],
        ankiStatuses: [["word", "known"]],
      },
      engine,
      (response) => responses.push(response),
    );

    expect(responses).toEqual([
      {
        protocolVersion: 3,
        type: "anki-preview-result",
        requestId: "preview-dispatch",
        datasetId: "dataset-1",
        result: { matchedWords: 1, knownCount: 1, minedCount: 0, manualProtected: 0 },
      },
    ]);
  });

  it("changes results when decisions change", async () => {
    const engine = new WorkerEngine();
    const source = [entry(0, "alpha", 50), entry(1, "beta", 30), entry(2, "gamma", 20)];
    loadDataset(engine, "dataset-1", source);

    const mined: WorkerResponse[] = [];
    await engine.coverage(
      coverageRequest({ requestId: "d-0", decisions: [["beta", "mined"]] }),
      (r) => mined.push(r),
    );
    const known: WorkerResponse[] = [];
    await engine.coverage(
      coverageRequest({ requestId: "d-1", decisions: [["beta", "known"]] }),
      (r) => known.push(r),
    );

    const minedResult = mined[0]?.type === "coverage-result" ? mined[0].result : null;
    const knownResult = known[0]?.type === "coverage-result" ? known[0].result : null;
    expect(minedResult?.knownUniqueWords).toBe(0);
    expect(knownResult?.knownUniqueWords).toBe(1);
    expect(knownResult?.knownTrackedOccurrences).toBe(30);
    expect(knownResult?.coveragePercent).toBe(30);
  });

  it("leaves normal query windows unaffected when interleaved with coverage", async () => {
    const engine = new WorkerEngine();
    const source = Array.from({ length: 10 }, (_, index) =>
      entry(index, `word-${index}`, 10 - index),
    );
    loadDataset(engine, "dataset-1", source);

    const beforeResponses: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "q-before",
        query: queryState({ pageSize: "all" }),
        window: { start: 0, size: 3 },
      }),
      (response) => beforeResponses.push(response),
    );

    const coverageResponses: WorkerResponse[] = [];
    await engine.coverage(
      coverageRequest({ requestId: "cov-mid", knownWords: ["word-9"] }),
      (response) => coverageResponses.push(response),
    );

    const afterResponses: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "q-after",
        query: queryState({ pageSize: "all" }),
        window: { start: 0, size: 3 },
      }),
      (response) => afterResponses.push(response),
    );

    const before = beforeResponses[0]?.type === "query-result" ? beforeResponses[0].result : null;
    const after = afterResponses[0]?.type === "query-result" ? afterResponses[0].result : null;
    const coverage =
      coverageResponses[0]?.type === "coverage-result" ? coverageResponses[0].result : null;

    expect(before?.items.map((item) => item.id)).toEqual(["entry-0", "entry-1", "entry-2"]);
    expect(after?.items.map((item) => item.id)).toEqual(["entry-0", "entry-1", "entry-2"]);
    expect(after?.totalEntries).toBe(before?.totalEntries);
    expect(after?.knownCount).toBe(before?.knownCount);
    expect(coverage?.knownUniqueWords).toBe(1);
  });

  it("suppresses stale coverage results after a dataset swap", async () => {
    const engine = new WorkerEngine();
    loadDataset(
      engine,
      "dataset-1",
      Array.from({ length: 4001 }, (_, index) => entry(index, `old-${index}`)),
    );

    const staleResponses: WorkerResponse[] = [];
    const staleCoverage = engine.coverage(coverageRequest({ requestId: "stale-cov" }), (response) =>
      staleResponses.push(response),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    loadDataset(engine, "dataset-1", [entry(9999, "新しい", 7)]);
    await staleCoverage;

    expect(staleResponses.some((response) => response.type === "coverage-result")).toBe(false);

    const freshResponses: WorkerResponse[] = [];
    await engine.coverage(coverageRequest({ requestId: "fresh-cov" }), (response) =>
      freshResponses.push(response),
    );
    const fresh = freshResponses[0]?.type === "coverage-result" ? freshResponses[0].result : null;
    expect(fresh?.totalUniqueWords).toBe(1);
    expect(fresh?.totalTrackedOccurrences).toBe(7);
  });

  it("does not emit a coverage result when cancelled mid-operation", async () => {
    const engine = new WorkerEngine();
    loadDataset(
      engine,
      "dataset-1",
      Array.from({ length: 4001 }, (_, index) => entry(index)),
    );

    const responses: WorkerResponse[] = [];
    setTimeout(() => engine.cancel("cancel-cov"), 0);
    await engine.coverage(coverageRequest({ requestId: "cancel-cov" }), (response) =>
      responses.push(response),
    );

    expect(responses.some((response) => response.type === "coverage-result")).toBe(false);
  });

  it("refreshes dataset LRU recency on coverage access", async () => {
    const engine = new WorkerEngine();
    loadDataset(engine, "dataset-a", [entry(0, "a")]);
    loadDataset(engine, "dataset-b", [entry(1, "b")]);
    loadDataset(engine, "dataset-c", [entry(2, "c")]);

    await engine.coverage(coverageRequest({ requestId: "lru", datasetId: "dataset-a" }), () => {});
    loadDataset(engine, "dataset-d", [entry(3, "d")]);

    await expect(
      engine.query(queryRequest({ requestId: "evicted-b", datasetId: "dataset-b" }), () => {}),
    ).rejects.toMatchObject({ code: "dataset-not-found" });

    for (const datasetId of ["dataset-a", "dataset-c", "dataset-d"]) {
      const responses: WorkerResponse[] = [];
      await engine.query(queryRequest({ requestId: `kept-${datasetId}`, datasetId }), (response) =>
        responses.push(response),
      );
      expect(responses).toHaveLength(1);
    }
  });
});
