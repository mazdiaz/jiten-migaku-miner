import { describe, expect, it } from "vitest";
import {
  WorkerProtocolError,
  createErrorResponse,
  isWorkerRequest,
  parseWorkerRequest,
  serializeError,
} from "../../src/worker/protocol";
import type { WorkerRequest } from "../../src/worker/protocol";
import { dispatchWorkerRequest } from "../../src/worker/miner.worker";
import { WorkerEngine } from "../../src/worker/worker-engine";
import type { WorkerResponse } from "../../src/worker/protocol";

const validQueryRequest: WorkerRequest = {
  protocolVersion: 1,
  type: "query",
  requestId: "query-1",
  datasetId: "dataset-1",
  knownWords: [],
  decisions: [],
  query: {
    search: "",
    hideKnown: false,
    hideKanaOnly: false,
    sentence: "any",
    minOccurrences: 0,
    sort: "original",
    pageSize: 25,
    page: 1,
    decision: "all",
  },
  window: { start: 10, size: 5 },
};

describe("worker protocol", () => {
  it("rejects unsupported protocol versions with a typed error", () => {
    const request = { ...validQueryRequest, protocolVersion: 2 };

    expect(() => parseWorkerRequest(request)).toThrow(WorkerProtocolError);
    expect(() => parseWorkerRequest(request)).toThrowError(
      expect.objectContaining({ code: "invalid-protocol-version" }),
    );
    expect(isWorkerRequest(request)).toBe(false);
  });

  it("rejects unknown message types with a typed error", () => {
    const request = { ...validQueryRequest, type: "unknown" };

    expect(() => parseWorkerRequest(request)).toThrow(WorkerProtocolError);
    expect(() => parseWorkerRequest(request)).toThrowError(
      expect.objectContaining({ code: "unknown-message-type" }),
    );
    expect(isWorkerRequest(request)).toBe(false);
  });

  it("accepts valid discriminated requests without losing optional window data", () => {
    expect(parseWorkerRequest(validQueryRequest)).toEqual(validQueryRequest);
    expect(isWorkerRequest(validQueryRequest)).toBe(true);
  });

  it("round-trips decisions through query requests", () => {
    const request: WorkerRequest = {
      ...validQueryRequest,
      decisions: [["猫", "known"], ["犬", "mined"], ["鳥", "skip"], ["魚", "later"]],
    };

    expect(parseWorkerRequest(request)).toEqual(request);
    expect(isWorkerRequest(request)).toBe(true);
    expect(parseWorkerRequest(request)).not.toBe(request);
  });

  it("accepts an empty decisions array and every decision status", () => {
    const statuses = ["known", "mined", "skip", "later"] as const;
    for (const status of statuses) {
      const request: WorkerRequest = { ...validQueryRequest, decisions: [[`word-${status}`, status]] };
      expect(parseWorkerRequest(request)).toEqual(request);
    }
  });

  it("rejects invalid decisions payloads on query requests", () => {
    const malformedRequests = [
      { ...validQueryRequest, decisions: "known" },
      { ...validQueryRequest, decisions: ["猫"] },
      { ...validQueryRequest, decisions: [["猫"]] },
      { ...validQueryRequest, decisions: [["猫", "known", "extra"]] },
      { ...validQueryRequest, decisions: [[42, "known"]] },
      { ...validQueryRequest, decisions: [["猫", 1]] },
      { ...validQueryRequest, decisions: [["猫", "unreviewed"]] },
      { ...validQueryRequest, decisions: [["猫", "unknown-status"]] },
    ];

    for (const request of malformedRequests) {
      expect(() => parseWorkerRequest(request), JSON.stringify(request)).toThrow(WorkerProtocolError);
      expect(() => parseWorkerRequest(request)).toThrowError(
        expect.objectContaining({ code: "invalid-message" }),
      );
    }
  });

  it("validates the query decision filter", () => {
    for (const decision of ["all", "unreviewed", "known", "mined", "skip", "later"] as const) {
      const request = { ...validQueryRequest, query: { ...validQueryRequest.query, decision } };
      expect(parseWorkerRequest(request)).toMatchObject({ query: { decision } });
    }

    for (const decision of ["ALL", "unknown", "", null, 42]) {
      const request = { ...validQueryRequest, query: { ...validQueryRequest.query, decision } };
      expect(() => parseWorkerRequest(request), JSON.stringify(decision)).toThrow(
        expect.objectContaining({ code: "invalid-message" }),
      );
    }
  });

  it("rejects non-integer pages and non-positive numeric page sizes", () => {
    const malformedRequests = [
      { ...validQueryRequest, query: { ...validQueryRequest.query, page: 1.5 } },
      { ...validQueryRequest, query: { ...validQueryRequest.query, page: 0 } },
      { ...validQueryRequest, query: { ...validQueryRequest.query, page: -1 } },
      { ...validQueryRequest, query: { ...validQueryRequest.query, pageSize: 0 } },
      { ...validQueryRequest, query: { ...validQueryRequest.query, pageSize: -1 } },
      { ...validQueryRequest, query: { ...validQueryRequest.query, pageSize: 1.5 } },
    ];

    for (const request of malformedRequests) {
      expect(() => parseWorkerRequest(request)).toThrow(WorkerProtocolError);
      expect(() => parseWorkerRequest(request)).toThrowError(
        expect.objectContaining({ code: "invalid-message" }),
      );
    }
  });

  it("rejects negative and fractional query window bounds", () => {
    const malformedRequests = [
      { ...validQueryRequest, window: { start: -1, size: 1 } },
      { ...validQueryRequest, window: { start: 1, size: -1 } },
      { ...validQueryRequest, window: { start: 1.5, size: 1 } },
      { ...validQueryRequest, window: { start: 1, size: 1.5 } },
    ];

    for (const request of malformedRequests) {
      expect(() => parseWorkerRequest(request)).toThrow(WorkerProtocolError);
      expect(() => parseWorkerRequest(request)).toThrowError(
        expect.objectContaining({ code: "invalid-message" }),
      );
    }

    expect(parseWorkerRequest({ ...validQueryRequest, window: { start: 0, size: 0 } })).toMatchObject({
      window: { start: 0, size: 0 },
    });
  });

  it("serializes only safe error fields and preserves request IDs", () => {
    const error = new Error("bad source");
    Object.assign(error, { code: "source-failed", stack: "secret stack" });

    expect(serializeError(error)).toEqual({ code: "source-failed", message: "bad source" });
    expect(createErrorResponse("request-7", error)).toEqual({
      protocolVersion: 1,
      type: "error",
      requestId: "request-7",
      code: "source-failed",
      message: "bad source",
    });
  });

  it("dispatches operation failures as safe typed error responses", async () => {
    const responses: WorkerResponse[] = [];

    await dispatchWorkerRequest(
      {
        protocolVersion: 1,
        type: "load-complete",
        requestId: "load-7",
        datasetId: "missing",
      },
      new WorkerEngine(),
      (response) => responses.push(response),
    );

    expect(responses).toEqual([
      {
        protocolVersion: 1,
        type: "error",
        requestId: "load-7",
        code: "dataset-not-ready",
        message: "Dataset has not been started: missing",
      },
    ]);
  });

  it("acknowledges completed dataset loads with loaded entry count", async () => {
    const responses: WorkerResponse[] = [];
    const entry = {
      id: "entry-0",
      originalIndex: 0,
      word: "猫",
      normalizedWord: "猫",
      occurrences: 1,
      sentenceRaw: "",
      hasSentence: false,
      definitions: "",
      furiganaRuns: [],
    };
    const engine = new WorkerEngine();

    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-start", requestId: "load-1", datasetId: "dataset-1" },
      engine,
      (response) => responses.push(response),
    );
    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-chunk", requestId: "load-1", datasetId: "dataset-1", chunkIndex: 0, entries: [entry] },
      engine,
      (response) => responses.push(response),
    );
    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-complete", requestId: "load-1", datasetId: "dataset-1" },
      engine,
      (response) => responses.push(response),
    );

    expect(responses).toEqual([
      {
        protocolVersion: 1,
        type: "load-complete",
        requestId: "load-1",
        datasetId: "dataset-1",
        entryCount: 1,
      },
    ]);
  });

  it("cleans partial load staging after cancellation and releases request ID", async () => {
    const responses: WorkerResponse[] = [];
    const engine = new WorkerEngine();

    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-start", requestId: "load-1", datasetId: "dataset-1" },
      engine,
      (response) => responses.push(response),
    );
    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-chunk", requestId: "load-1", datasetId: "dataset-1", chunkIndex: 0, entries: [] },
      engine,
      (response) => responses.push(response),
    );
    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "cancel", requestId: "load-1" },
      engine,
      (response) => responses.push(response),
    );
    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-complete", requestId: "load-1", datasetId: "dataset-1" },
      engine,
      (response) => responses.push(response),
    );

    expect(responses).toEqual([
      {
        protocolVersion: 1,
        type: "error",
        requestId: "load-1",
        code: "dataset-not-ready",
        message: "Dataset has not been started: dataset-1",
      },
    ]);

    const importResponses: WorkerResponse[] = [];
    await engine.importKnown("load-1", "known.txt", "猫", (response) => importResponses.push(response));
    expect(importResponses.at(-1)).toMatchObject({ type: "import-complete", requestId: "load-1" });
  });

  it("cleans partial load staging after a load error", async () => {
    const responses: WorkerResponse[] = [];
    const engine = new WorkerEngine();

    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-start", requestId: "load-2", datasetId: "dataset-2" },
      engine,
      (response) => responses.push(response),
    );
    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-chunk", requestId: "load-2", datasetId: "dataset-2", chunkIndex: 1, entries: [] },
      engine,
      (response) => responses.push(response),
    );
    await dispatchWorkerRequest(
      { protocolVersion: 1, type: "load-complete", requestId: "load-2", datasetId: "dataset-2" },
      engine,
      (response) => responses.push(response),
    );

    expect(responses).toEqual([
      {
        protocolVersion: 1,
        type: "error",
        requestId: "load-2",
        code: "invalid-chunk",
        message: "Unexpected dataset chunk index: 1",
      },
      {
        protocolVersion: 1,
        type: "error",
        requestId: "load-2",
        code: "dataset-not-ready",
        message: "Dataset has not been started: dataset-2",
      },
    ]);
  });
});
