import { describe, expect, it } from "vitest";
import type { Entry, QueryState } from "../../src/domain/types";
import type { QueryRequest, WorkerResponse } from "../../src/worker/protocol";
import { parseWorkerRequest } from "../../src/worker/protocol";
import { WorkerEngine } from "../../src/worker/worker-engine";

function entry(index: number, word: string, occurrences = index): Entry {
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

function queryState(overrides: Partial<QueryState> = {}): QueryState {
  return {
    search: "",
    hideKnown: false,
    hideKanaOnly: false,
    sentence: "any",
    minOccurrences: 0,
    sort: "occ-desc",
    pageSize: 50,
    page: 1,
    decision: "all",
    ...overrides,
  };
}

function queryRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    protocolVersion: 1,
    type: "query",
    requestId: "query-1",
    datasetId: "dataset-1",
    knownWords: [],
    decisions: [],
    query: queryState(),
    ...overrides,
  };
}

async function loadDataset(engine: WorkerEngine, entries: Entry[]): Promise<void> {
  engine.loadStart("dataset-1", "load-1");
  engine.loadChunk("dataset-1", 0, entries, "load-1");
  engine.loadComplete("dataset-1", "load-1");
}

async function queryOnce(engine: WorkerEngine, request: QueryRequest): Promise<WorkerResponse> {
  let response: WorkerResponse | undefined;
  await engine.query(request, (sent) => {
    response = sent;
  });
  if (response === undefined) throw new Error("worker produced no response");
  return response;
}

const FOUR_ENTRIES: Entry[] = [
  entry(0, "一", 10),
  entry(1, "二", 8),
  entry(2, "三", 6),
  entry(3, "四", 4),
];

describe("worker include-list queries", () => {
  it("returns only entries whose normalizedWord is in the include set", async () => {
    const engine = new WorkerEngine();
    await loadDataset(engine, FOUR_ENTRIES);

    const response = await queryOnce(engine, queryRequest({
      includeNormalizedWords: ["二", "四"],
    }));

    expect(response.type).toBe("query-result");
    if (response.type !== "query-result") return;
    expect(response.result.items.map((item) => item.normalizedWord)).toEqual(["二", "四"]);
    expect(response.result.totalEntries).toBe(2);
  });

  it("ignores include words missing from the dataset", async () => {
    const engine = new WorkerEngine();
    await loadDataset(engine, FOUR_ENTRIES);

    const response = await queryOnce(engine, queryRequest({
      includeNormalizedWords: ["一", "存在しない"],
    }));

    if (response.type !== "query-result") throw new Error("expected query-result");
    expect(response.result.items.map((item) => item.normalizedWord)).toEqual(["一"]);
  });

  it("leaves normal queries without an include list unchanged", async () => {
    const engine = new WorkerEngine();
    await loadDataset(engine, FOUR_ENTRIES);

    const response = await queryOnce(engine, queryRequest());

    if (response.type !== "query-result") throw new Error("expected query-result");
    expect(response.result.items.map((item) => item.normalizedWord)).toEqual(["一", "二", "三", "四"]);
    expect(response.result.totalEntries).toBe(4);
  });

  it("applies the include filter before pagination", async () => {
    const engine = new WorkerEngine();
    await loadDataset(engine, FOUR_ENTRIES);

    // Without the include list, page 1 of size 1 would be 一 (10 occurrences).
    const response = await queryOnce(engine, queryRequest({
      includeNormalizedWords: ["三", "四"],
      query: queryState({ pageSize: 1, page: 1 }),
    }));

    if (response.type !== "query-result") throw new Error("expected query-result");
    expect(response.result.items.map((item) => item.normalizedWord)).toEqual(["三"]);
    expect(response.result.totalEntries).toBe(2);
    expect(response.result.totalPages).toBe(2);
  });

  it("applies the include filter before windowing for paged-all queries", async () => {
    const engine = new WorkerEngine();
    await loadDataset(engine, FOUR_ENTRIES);

    const response = await queryOnce(engine, queryRequest({
      includeNormalizedWords: ["三", "四"],
      query: queryState({ pageSize: "all" }),
      window: { start: 0, size: 1 },
    }));

    if (response.type !== "query-result") throw new Error("expected query-result");
    expect(response.result.items.map((item) => item.normalizedWord)).toEqual(["三"]);
    expect(response.result.totalEntries).toBe(2);
    expect(response.result.windowed).toBe(true);
  });

  it("does not serve a stale window cache across different include lists", async () => {
    const engine = new WorkerEngine();
    await loadDataset(engine, FOUR_ENTRIES);

    const first = await queryOnce(engine, queryRequest({
      includeNormalizedWords: ["一"],
      query: queryState({ pageSize: "all" }),
      window: { start: 0, size: 10 },
    }));
    const second = await queryOnce(engine, queryRequest({
      includeNormalizedWords: ["四"],
      query: queryState({ pageSize: "all" }),
      window: { start: 0, size: 10 },
    }));

    if (first.type !== "query-result" || second.type !== "query-result") throw new Error("expected query-results");
    expect(first.result.items.map((item) => item.normalizedWord)).toEqual(["一"]);
    expect(second.result.items.map((item) => item.normalizedWord)).toEqual(["四"]);
  });

  it("combines the include filter with decision and known filters", async () => {
    const engine = new WorkerEngine();
    await loadDataset(engine, FOUR_ENTRIES);

    const response = await queryOnce(engine, queryRequest({
      knownWords: ["二"],
      includeNormalizedWords: ["一", "二", "三"],
      query: queryState({ hideKnown: true }),
    }));

    if (response.type !== "query-result") throw new Error("expected query-result");
    expect(response.result.items.map((item) => item.normalizedWord)).toEqual(["一", "三"]);
  });
});

describe("worker include-list protocol", () => {
  it("parses an optional include list of non-empty strings", () => {
    const parsed = parseWorkerRequest({
      protocolVersion: 1,
      type: "query",
      requestId: "query-1",
      datasetId: "dataset-1",
      knownWords: [],
      decisions: [],
      query: queryState(),
      includeNormalizedWords: ["一", "二"],
    });

    expect(parsed).toMatchObject({ type: "query", includeNormalizedWords: ["一", "二"] });
  });

  it("omits the include list when absent", () => {
    const parsed = parseWorkerRequest({
      protocolVersion: 1,
      type: "query",
      requestId: "query-1",
      datasetId: "dataset-1",
      knownWords: [],
      decisions: [],
      query: queryState(),
    });

    expect(parsed).toMatchObject({ type: "query" });
    expect((parsed as QueryRequest).includeNormalizedWords).toBeUndefined();
  });

  it("rejects include lists containing non-string or empty values", () => {
    expect(() => parseWorkerRequest({
      protocolVersion: 1,
      type: "query",
      requestId: "query-1",
      datasetId: "dataset-1",
      knownWords: [],
      decisions: [],
      query: queryState(),
      includeNormalizedWords: ["一", 3],
    })).toThrow();

    expect(() => parseWorkerRequest({
      protocolVersion: 1,
      type: "query",
      requestId: "query-1",
      datasetId: "dataset-1",
      knownWords: [],
      decisions: [],
      query: queryState(),
      includeNormalizedWords: [""],
    })).toThrow();
  });
});
