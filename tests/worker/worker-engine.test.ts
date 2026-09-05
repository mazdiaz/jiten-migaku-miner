import { describe, expect, it } from "vitest";
import type { Entry, QueryState } from "../../src/domain/types";
import { queryEntries } from "../../src/domain/query";
import type { WorkerResponse, QueryRequest } from "../../src/worker/protocol";
import { WorkerEngine } from "../../src/worker/worker-engine";

function entry(index: number, word = `word-${index}`, occurrences = index): Entry {
  return {
    id: `entry-${index}`,
    originalIndex: index,
    word,
    normalizedWord: word,
    occurrences,
    sentenceRaw: index % 2 === 0 ? `sentence ${index}` : "",
    hasSentence: index % 2 === 0,
    definitions: `definition ${index}`,
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
    sort: "original",
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

function jitenCsv(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_, index) => `語${index},${index},,,`);
  return ["Word,Occurences,ExampleSentence,Definitions,ReadingFurigana", ...rows].join("\n");
}

describe("WorkerEngine", () => {
  it("emits ordered Jiten import chunks of no more than 2,000 entries", async () => {
    const engine = new WorkerEngine();
    const responses: WorkerResponse[] = [];

    await engine.importJiten("import-1", "jiten.csv", jitenCsv(2001), (response) => {
      responses.push(response);
    });

    const chunks = responses.filter(
      (response): response is Extract<WorkerResponse, { type: "import-chunk"; kind: "jiten" }> =>
        response.type === "import-chunk" && response.kind === "jiten",
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      protocolVersion: 1,
      requestId: "import-1",
      type: "import-chunk",
      kind: "jiten",
      chunkIndex: 0,
    });
    expect(chunks[1]).toMatchObject({ chunkIndex: 1 });
    expect(chunks.every((response) => response.entries.length <= 2000)).toBe(true);
    expect(chunks[0]?.entries[0]?.id).toBe("entry-0");
    expect(chunks[1]?.entries[0]?.id).toBe("entry-2000");
    expect(responses.at(-1)).toMatchObject({
      protocolVersion: 1,
      type: "import-complete",
      requestId: "import-1",
      kind: "jiten",
      entryCount: 2001,
    });
    expect(responses.every((response) => response.requestId === "import-1")).toBe(true);
  });

  it("emits known-word imports in bounded ordered chunks", async () => {
    const engine = new WorkerEngine();
    const responses: WorkerResponse[] = [];
    const words = Array.from({ length: 2001 }, (_, index) => `word-${index}`).join("\n");

    await engine.importKnown("known-1", "known.txt", words, (response) => {
      responses.push(response);
    });

    const chunks = responses.filter(
      (response): response is Extract<WorkerResponse, { type: "import-chunk"; kind: "known" }> =>
        response.type === "import-chunk" && response.kind === "known",
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.words[0]).toBe("word-0");
    expect(chunks[1]?.words[0]).toBe("word-2000");
    expect(chunks.every((response) => response.words.length <= 2000)).toBe(true);
    expect(responses.at(-1)).toMatchObject({
      type: "import-complete",
      requestId: "known-1",
      kind: "known",
      wordCount: 2001,
    });
  });

  it("returns only requested page or all-results window entries", async () => {
    const engine = new WorkerEngine();
    const source = Array.from({ length: 5 }, (_, index) => entry(index));
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, source);
    engine.loadComplete("dataset-1");

    const pageResponses: WorkerResponse[] = [];
    await engine.query(
      queryRequest({ requestId: "page-1", query: queryState({ pageSize: 2, page: 2 }) }),
      (response) => pageResponses.push(response),
    );
    expect(pageResponses).toHaveLength(1);
    expect(pageResponses[0]?.type === "query-result" ? pageResponses[0].result.items.map((item) => item.id) : []).toEqual([
      "entry-2",
      "entry-3",
    ]);
    expect(pageResponses[0]).toMatchObject({ protocolVersion: 1, requestId: "page-1", type: "query-result" });

    const windowResponses: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "window-1",
        query: queryState({ pageSize: "all" }),
        window: { start: 2, size: 2 },
      }),
      (response) => windowResponses.push(response),
    );
    expect(windowResponses[0]?.type === "query-result" ? windowResponses[0].result.items.map((item) => item.id) : []).toEqual([
      "entry-2",
      "entry-3",
    ]);
    expect(windowResponses[0]).toMatchObject({
      protocolVersion: 1,
      requestId: "window-1",
      type: "query-result",
      result: { totalEntries: 5, windowed: true },
    });
  });

  it("does not emit a successful result after import cancellation between chunks", async () => {
    const engine = new WorkerEngine();
    const responses: WorkerResponse[] = [];

    await engine.importJiten("cancel-import", "jiten.csv", jitenCsv(2001), (response) => {
      responses.push(response);
      if (response.type === "import-chunk" && response.chunkIndex === 0) {
        engine.cancel("cancel-import");
      }
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]?.type).toBe("import-chunk");
  });

  it("does not emit a successful result when query is cancelled during chunked work", async () => {
    const engine = new WorkerEngine();
    const source = Array.from({ length: 4001 }, (_, index) => entry(index));
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, source.slice(0, 2000));
    engine.loadChunk("dataset-1", 1, source.slice(2000, 4000));
    engine.loadChunk("dataset-1", 2, source.slice(4000));
    engine.loadComplete("dataset-1");

    const responses: WorkerResponse[] = [];
    setTimeout(() => engine.cancel("cancel-query"), 0);
    await engine.query(queryRequest({ requestId: "cancel-query" }), (response) => responses.push(response));

    expect(responses.some((response) => response.type === "query-result")).toBe(false);
  });

  it("does not emit a successful result when a short query is cancelled while yielding", async () => {
    const engine = new WorkerEngine();
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, [entry(0), entry(1), entry(2)]);
    engine.loadComplete("dataset-1");

    const responses: WorkerResponse[] = [];
    setTimeout(() => engine.cancel("cancel-short-query"), 0);
    await engine.query(
      queryRequest({ requestId: "cancel-short-query" }),
      (response) => responses.push(response),
    );

    expect(responses.some((response) => response.type === "query-result")).toBe(false);
  });

  it("drops staging for canceled loads and keeps completed datasets queryable", async () => {
    const engine = new WorkerEngine();
    engine.loadStart("dataset-1", "load-1");
    engine.loadChunk("dataset-1", 0, [entry(0)], "load-1");
    engine.loadComplete("dataset-1", "load-1");

    engine.loadStart("dataset-1", "reload-1");
    engine.cancel("reload-1");
    expect(() => engine.loadChunk("dataset-1", 0, [entry(1)], "reload-1")).toThrowError();
    expect(() => engine.loadComplete("dataset-1", "reload-1")).toThrowError();

    const responses: WorkerResponse[] = [];
    await engine.query(queryRequest({ requestId: "query-after-cancel" }), (response) => responses.push(response));
    expect(responses).toHaveLength(1);
    expect(responses[0]?.type === "query-result" ? responses[0].result.items.map((item) => item.id) : []).toEqual(["entry-0"]);
  });

  it("allows a fresh load after a canceled request cleaned its staging", async () => {
    const engine = new WorkerEngine();
    engine.loadStart("dataset-2", "load-2");
    engine.cancel("load-2");
    expect(() => engine.loadComplete("dataset-2", "load-2")).toThrowError();

    engine.loadStart("dataset-2", "load-3");
    engine.loadChunk("dataset-2", 0, [entry(5)], "load-3");
    engine.loadComplete("dataset-2", "load-3");

    const responses: WorkerResponse[] = [];
    await engine.query(queryRequest({ requestId: "query-reload", datasetId: "dataset-2" }), (response) => responses.push(response));
    expect(responses[0]?.type === "query-result" ? responses[0].result.items.map((item) => item.id) : []).toEqual(["entry-5"]);
  });

  it("returns consistent windows across cached same-signature queries", async () => {
    const engine = new WorkerEngine();
    const source = Array.from({ length: 10 }, (_, index) => entry(index, `word-${index}`, 10 - index));
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, source);
    engine.loadComplete("dataset-1");

    const first: WorkerResponse[] = [];
    await engine.query(
      queryRequest({ requestId: "w1", query: queryState({ pageSize: "all" }), window: { start: 0, size: 3 } }),
      (response) => first.push(response),
    );
    const second: WorkerResponse[] = [];
    await engine.query(
      queryRequest({ requestId: "w2", query: queryState({ pageSize: "all" }), window: { start: 6, size: 3 } }),
      (response) => second.push(response),
    );

    const firstResult = first[0]?.type === "query-result" ? first[0].result : null;
    const secondResult = second[0]?.type === "query-result" ? second[0].result : null;
    expect(firstResult?.windowed).toBe(true);
    expect(firstResult?.items.map((item) => item.id)).toEqual(["entry-0", "entry-1", "entry-2"]);
    expect(firstResult?.totalEntries).toBe(10);
    expect(firstResult?.startIndex).toBe(1);
    expect(secondResult?.items.map((item) => item.id)).toEqual(["entry-6", "entry-7", "entry-8"]);
    expect(secondResult?.startIndex).toBe(7);
    expect(secondResult?.totalEntries).toBe(10);
  });

  it("invalidates the window cache when known words change", async () => {
    const engine = new WorkerEngine();
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, [entry(0, "知らない"), entry(1, "既知")]);
    engine.loadComplete("dataset-1");

    const withoutKnown: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "nk",
        knownWords: [],
        query: queryState({ pageSize: "all", hideKnown: true }),
        window: { start: 0, size: 10 },
      }),
      (response) => withoutKnown.push(response),
    );
    const withKnown: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "wk",
        knownWords: ["既知"],
        query: queryState({ pageSize: "all", hideKnown: true }),
        window: { start: 0, size: 10 },
      }),
      (response) => withKnown.push(response),
    );

    const first = withoutKnown[0]?.type === "query-result" ? withoutKnown[0].result : null;
    const second = withKnown[0]?.type === "query-result" ? withKnown[0].result : null;
    expect(first?.items.map((item) => item.id)).toEqual(["entry-0", "entry-1"]);
    expect(second?.items.map((item) => item.id)).toEqual(["entry-0"]);
    expect(second?.knownCount).toBe(1);
  });

  it("invalidates the window cache when the dataset is reloaded", async () => {
    const engine = new WorkerEngine();
    engine.loadStart("dataset-1", "load-1");
    engine.loadChunk("dataset-1", 0, [entry(0, "古い")], "load-1");
    engine.loadComplete("dataset-1", "load-1");

    const before: WorkerResponse[] = [];
    await engine.query(
      queryRequest({ requestId: "q1", query: queryState({ pageSize: "all" }), window: { start: 0, size: 10 } }),
      (response) => before.push(response),
    );

    engine.loadStart("dataset-1", "load-2");
    engine.loadChunk("dataset-1", 0, [entry(7, "新しい")], "load-2");
    engine.loadComplete("dataset-1", "load-2");

    const after: WorkerResponse[] = [];
    await engine.query(
      queryRequest({ requestId: "q2", query: queryState({ pageSize: "all" }), window: { start: 0, size: 10 } }),
      (response) => after.push(response),
    );

    const firstResult = before[0]?.type === "query-result" ? before[0].result : null;
    const secondResult = after[0]?.type === "query-result" ? after[0].result : null;
    expect(firstResult?.items.map((item) => item.id)).toEqual(["entry-0"]);
    expect(secondResult?.items.map((item) => item.id)).toEqual(["entry-7"]);
  });

  it("invalidates the window cache when sort fields change", async () => {
    const engine = new WorkerEngine();
    const source = Array.from({ length: 6 }, (_, index) => entry(index, `word-${index}`, index));
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, source);
    engine.loadComplete("dataset-1");

    const original: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "s1",
        query: queryState({ pageSize: "all", sort: "original" }),
        window: { start: 0, size: 3 },
      }),
      (response) => original.push(response),
    );
    const descending: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "s2",
        query: queryState({ pageSize: "all", sort: "occ-desc" }),
        window: { start: 0, size: 3 },
      }),
      (response) => descending.push(response),
    );

    const originalResult = original[0]?.type === "query-result" ? original[0].result : null;
    const descendingResult = descending[0]?.type === "query-result" ? descending[0].result : null;
    expect(originalResult?.items.map((item) => item.id)).toEqual(["entry-0", "entry-1", "entry-2"]);
    expect(descendingResult?.items.map((item) => item.id)).toEqual(["entry-5", "entry-4", "entry-3"]);
  });

  it("filters by decision across the full dataset before pagination", async () => {
    const engine = new WorkerEngine();
    const source = Array.from({ length: 10 }, (_, index) => entry(index));
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, source);
    engine.loadComplete("dataset-1");

    // words 0, 4, 5 are mined; word 2 locally known; word 7 skipped
    const decisions: QueryRequest["decisions"] = [
      ["word-0", "mined"],
      ["word-4", "mined"],
      ["word-5", "mined"],
      ["word-2", "known"],
      ["word-7", "skip"],
    ];

    const minedPage: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "mined-page",
        decisions,
        query: queryState({ decision: "mined", pageSize: 2, page: 1 }),
      }),
      (response) => minedPage.push(response),
    );
    const minedPageResult = minedPage[0]?.type === "query-result" ? minedPage[0].result : null;
    expect(minedPageResult?.items.map((item) => item.id)).toEqual(["entry-0", "entry-4"]);
    expect(minedPageResult?.totalEntries).toBe(3);
    expect(minedPageResult?.totalPages).toBe(2);
    expect(minedPageResult?.knownCount).toBe(1);

    const minedPage2: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "mined-page-2",
        decisions,
        query: queryState({ decision: "mined", pageSize: 2, page: 2 }),
      }),
      (response) => minedPage2.push(response),
    );
    const minedPage2Result = minedPage2[0]?.type === "query-result" ? minedPage2[0].result : null;
    expect(minedPage2Result?.items.map((item) => item.id)).toEqual(["entry-5"]);
    expect(minedPage2Result?.totalEntries).toBe(3);

    const knownOnly: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "known-only",
        decisions,
        query: queryState({ decision: "known", pageSize: 50, page: 1 }),
      }),
      (response) => knownOnly.push(response),
    );
    const knownOnlyResult = knownOnly[0]?.type === "query-result" ? knownOnly[0].result : null;
    expect(knownOnlyResult?.items.map((item) => item.id)).toEqual(["entry-2"]);

    const unreviewed: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "unreviewed",
        decisions,
        query: queryState({ decision: "unreviewed", pageSize: 50, page: 1 }),
      }),
      (response) => unreviewed.push(response),
    );
    const unreviewedResult = unreviewed[0]?.type === "query-result" ? unreviewed[0].result : null;
    expect(unreviewedResult?.items.map((item) => item.id)).toEqual([
      "entry-1",
      "entry-3",
      "entry-6",
      "entry-8",
      "entry-9",
    ]);

    // decision="known" counts as known; mined/skip do not; hideKnown removes it
    const hidden: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "hidden",
        decisions,
        query: queryState({ hideKnown: true, pageSize: 50, page: 1 }),
      }),
      (response) => hidden.push(response),
    );
    const hiddenResult = hidden[0]?.type === "query-result" ? hidden[0].result : null;
    expect(hiddenResult?.items.map((item) => item.id)).not.toContain("entry-2");
    expect(hiddenResult?.knownCount).toBe(1);
  });

  it("emits decision metadata on paged items matching the product rules", async () => {
    const engine = new WorkerEngine();
    const source = [
      entry(0, "局所"), // local known only
      entry(1, "輸入"), // Migaku known only
      entry(2, "重複"), // Migaku known AND mined (rule 7)
      entry(3, "後回し"), // later
      entry(4, "除外"), // skip
      entry(5, "未決"), // unreviewed
    ];
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, source);
    engine.loadComplete("dataset-1");

    const responses: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "meta",
        knownWords: ["輸入", "重複"],
        decisions: [
          ["局所", "known"],
          ["重複", "mined"],
          ["後回し", "later"],
          ["除外", "skip"],
        ],
        query: queryState({ pageSize: 50, page: 1 }),
      }),
      (response) => responses.push(response),
    );
    const result = responses[0]?.type === "query-result" ? responses[0].result : null;
    expect(result?.items.map((item) => [item.id, item.known, item.knownByMigaku, item.knownByDecision, item.decision])).toEqual([
      ["entry-0", true, false, true, "known"],
      ["entry-1", true, true, false, "unreviewed"],
      ["entry-2", true, true, false, "mined"],
      ["entry-3", false, false, false, "later"],
      ["entry-4", false, false, false, "skip"],
      ["entry-5", false, false, false, "unreviewed"],
    ]);
    expect(result?.knownCount).toBe(3);
  });

  it("invalidates the window cache when decisions change", async () => {
    const engine = new WorkerEngine();
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, [entry(0, "古い"), entry(1, "新しい")]);
    engine.loadComplete("dataset-1");

    const withOldKnown: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "d1",
        decisions: [["古い", "known"]],
        query: queryState({ pageSize: "all", decision: "known" }),
        window: { start: 0, size: 10 },
      }),
      (response) => withOldKnown.push(response),
    );
    const withNewKnown: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "d2",
        decisions: [["新しい", "known"]],
        query: queryState({ pageSize: "all", decision: "known" }),
        window: { start: 0, size: 10 },
      }),
      (response) => withNewKnown.push(response),
    );

    const first = withOldKnown[0]?.type === "query-result" ? withOldKnown[0].result : null;
    const second = withNewKnown[0]?.type === "query-result" ? withNewKnown[0].result : null;
    expect(first?.items.map((item) => item.id)).toEqual(["entry-0"]);
    expect(first?.totalEntries).toBe(1);
    expect(second?.items.map((item) => item.id)).toEqual(["entry-1"]);
    expect(second?.totalEntries).toBe(1);
  });

  it("returns bounded windows when decisions filter the dataset", async () => {
    const engine = new WorkerEngine();
    const source = Array.from({ length: 10 }, (_, index) => entry(index));
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, source);
    engine.loadComplete("dataset-1");

    const responses: WorkerResponse[] = [];
    await engine.query(
      queryRequest({
        requestId: "windowed-mined",
        decisions: [["word-0", "mined"], ["word-4", "mined"], ["word-5", "mined"]],
        query: queryState({ pageSize: "all", decision: "mined" }),
        window: { start: 1, size: 2 },
      }),
      (response) => responses.push(response),
    );
    const result = responses[0]?.type === "query-result" ? responses[0].result : null;
    expect(result?.windowed).toBe(true);
    expect(result?.items.map((item) => item.id)).toEqual(["entry-4", "entry-5"]);
    expect(result?.totalEntries).toBe(3);
    expect(result?.startIndex).toBe(2);
    expect(result?.endIndex).toBe(3);
  });

  it("matches the domain query pipeline semantics for decision queries", async () => {
    const engine = new WorkerEngine();
    const source = Array.from({ length: 10 }, (_, index) => entry(index, `word-${index}`, 10 - index));
    engine.loadStart("dataset-1");
    engine.loadChunk("dataset-1", 0, source);
    engine.loadComplete("dataset-1");

    const knownWords = ["word-3", "word-6"];
    const decisions: QueryRequest["decisions"] = [
      ["word-0", "mined"],
      ["word-4", "mined"],
      ["word-5", "known"],
      ["word-6", "mined"],
    ];
    const query = queryState({
      hideKnown: false,
      hideKanaOnly: true,
      decision: "mined",
      sort: "occ-desc",
      pageSize: 2,
      page: 2,
    });

    const responses: WorkerResponse[] = [];
    await engine.query(
      queryRequest({ requestId: "parity", knownWords, decisions, query }),
      (response) => responses.push(response),
    );
    const engineResult = responses[0]?.type === "query-result" ? responses[0].result : null;

    const domainDecisions = new Map(
      decisions.map(([normalizedWord, status]) => [normalizedWord, { normalizedWord, status, updatedAt: "2026-09-05T00:00:00.000Z" }]),
    );
    const domainResult = queryEntries(source, new Set(knownWords), query, undefined, domainDecisions);

    expect(engineResult?.items.map((item) => item.id)).toEqual(domainResult.items.map((item) => item.id));
    expect(engineResult?.totalEntries).toBe(domainResult.totalEntries);
    expect(engineResult?.totalPages).toBe(domainResult.totalPages);
    expect(engineResult?.page).toBe(domainResult.page);
    expect(engineResult?.knownCount).toBe(domainResult.knownCount);
    expect(engineResult?.startIndex).toBe(domainResult.startIndex);
    expect(engineResult?.endIndex).toBe(domainResult.endIndex);
  });
});
