import { describe, expect, it } from "vitest";
import type { QueryResult, QueryState } from "../../src/domain/types";
import {
  createWorkerClient,
  type WorkerClientEvent,
  type WorkerLike,
  type WorkerQueryInput,
} from "../../src/app/worker-client";
import type {
  ImportCompleteResponse,
  WorkerRequest,
  WorkerResponse,
} from "../../src/worker/protocol";

class FakeWorker implements WorkerLike {
  readonly messages: WorkerRequest[] = [];
  terminated = false;
  postHook: ((message: WorkerRequest) => void) | undefined;
  private readonly messageListeners: Array<(event: WorkerClientEvent) => void> = [];
  private readonly errorListeners: Array<(event: WorkerClientEvent) => void> = [];

  postMessage(message: WorkerRequest): void {
    this.messages.push(message);
    this.postHook?.(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: "message" | "error", listener: (event: WorkerClientEvent) => void): void {
    (type === "message" ? this.messageListeners : this.errorListeners).push(listener);
  }

  removeEventListener(type: "message" | "error", listener: (event: WorkerClientEvent) => void): void {
    const listeners = type === "message" ? this.messageListeners : this.errorListeners;
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }

  emit(response: WorkerResponse): void {
    for (const listener of [...this.messageListeners]) listener({ data: response });
  }

  fail(message: string): void {
    for (const listener of [...this.errorListeners]) listener({ message });
  }
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
    ...overrides,
  };
}

function queryResult(page: number): QueryResult {
  return {
    items: [],
    page,
    totalPages: 1,
    totalEntries: 0,
    startIndex: 0,
    endIndex: 0,
    pageSize: 50,
    knownCount: 0,
    windowed: false,
  };
}

function queryResponse(requestId: string, page: number): WorkerResponse {
  return {
    protocolVersion: 1,
    type: "query-result",
    requestId,
    datasetId: "dataset-1",
    result: queryResult(page),
  };
}

describe("worker client", () => {
  it("rejects older query promises and ignores their late responses", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);

    const first = client.query({
      datasetId: "dataset-1",
      knownWords: [],
      query: queryState({ page: 1 }),
    });
    const firstRequest = worker.messages.find((message) => message.type === "query");
    expect(firstRequest?.type).toBe("query");

    const second = client.query({
      datasetId: "dataset-1",
      knownWords: [],
      query: queryState({ page: 2 }),
    });
    const queryRequests = worker.messages.filter((message) => message.type === "query");
    const secondRequest = queryRequests[1];
    expect(secondRequest?.type).toBe("query");
    expect(worker.messages).toContainEqual({
      protocolVersion: 1,
      type: "cancel",
      requestId: firstRequest?.requestId,
    });

    worker.emit(queryResponse(firstRequest?.requestId ?? "missing", 1));
    worker.emit(queryResponse(secondRequest?.requestId ?? "missing", 2));

    await expect(first).rejects.toMatchObject({ code: "stale-query" });
    await expect(second).resolves.toMatchObject({ page: 2 });
  });

  it("delivers import chunks and resolves on import completion", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    const chunks: WorkerResponse[] = [];

    const importing = client.importJiten("media.csv", "Word\n猫", (chunk) => chunks.push(chunk));
    const request = worker.messages[0];
    expect(request?.type).toBe("import-jiten");
    if (!request || request.type !== "import-jiten") throw new Error("missing import request");

    worker.emit({
      protocolVersion: 1,
      type: "import-chunk",
      requestId: request.requestId,
      kind: "jiten",
      name: "media.csv",
      chunkIndex: 0,
      entries: [],
    });
    const complete: Extract<ImportCompleteResponse, { kind: "jiten" }> = {
      protocolVersion: 1,
      type: "import-complete",
      requestId: request.requestId,
      kind: "jiten",
      name: "media.csv",
      headers: ["Word"],
      entryCount: 1,
      skippedRows: 0,
    };
    worker.emit(complete);

    await expect(importing).resolves.toEqual(complete);
    expect(chunks).toHaveLength(1);
  });

  it("streams dataset load messages in order", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);

    async function* chunks(): AsyncIterable<never[]> {
      yield [];
      yield [];
    }

    const completePosted = new Promise<WorkerRequest>((resolve) => {
      worker.postHook = (message) => {
        if (message.type === "load-complete") resolve(message);
      };
    });
    const loading = client.loadDataset("dataset-1", chunks());
    const complete = await completePosted;
    let settled = false;
    void loading.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    if (complete.type !== "load-complete") throw new Error("missing load completion request");
    worker.emit({
      protocolVersion: 1,
      type: "load-complete",
      requestId: complete.requestId,
      datasetId: complete.datasetId,
      entryCount: 0,
    });
    await loading;

    expect(worker.messages.map((message) => message.type)).toEqual([
      "load-start",
      "load-chunk",
      "load-chunk",
      "load-complete",
    ]);
    expect(worker.messages.filter((message) => message.type === "load-chunk").map((message) =>
      message.type === "load-chunk" ? message.chunkIndex : -1,
    )).toEqual([0, 1]);
  });

  it("rejects load errors and stops sending remaining load messages", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    let errorSent = false;
    worker.postHook = (message) => {
      if (message.type === "load-chunk" && !errorSent) {
        errorSent = true;
        worker.emit({
          protocolVersion: 1,
          type: "error",
          requestId: message.requestId,
          code: "invalid-chunk",
          message: "load failed",
        });
      }
    };

    const loading = client.loadDataset("dataset-1", (async function* () {
      yield [];
      yield [];
    })());

    await expect(loading).rejects.toThrow("load failed");
    expect(worker.messages.filter((message) => message.type === "load-chunk")).toHaveLength(1);
    expect(worker.messages.some((message) => message.type === "load-complete")).toBe(false);
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "cancel" }));
  });

  it("rejects malformed load acknowledgements instead of leaving load pending", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    worker.postHook = (message) => {
      if (message.type === "load-complete") {
        worker.emit({
          protocolVersion: 1,
          type: "load-complete",
          requestId: message.requestId,
          datasetId: message.datasetId,
        } as WorkerResponse);
      }
    };

    const loading = client.loadDataset("dataset-1", (async function* () {
      yield [];
    })());
    const outcome = await Promise.race([
      loading.then(() => ({ kind: "resolved" as const }), (error) => ({ kind: "rejected" as const, error })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 50)),
    ]);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toMatchObject({ name: "WorkerClientError", code: "malformed-load-complete" });
    }
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "cancel" }));
  });

  it("rejects load acknowledgements that fail protocol validation instead of hanging", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    worker.postHook = (message) => {
      if (message.type === "load-complete") {
        worker.emit({
          type: "load-complete",
          requestId: message.requestId,
          datasetId: message.datasetId,
          entryCount: 0,
        } as unknown as WorkerResponse);
      }
    };

    const loading = client.loadDataset("dataset-1", (async function* () {
      yield [];
    })());
    const outcome = await Promise.race([
      loading.then(() => ({ kind: "resolved" as const }), (error) => ({ kind: "rejected" as const, error })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 50)),
    ]);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toMatchObject({ name: "WorkerClientError", code: "malformed-load-complete" });
    }
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "cancel" }));
  });

  it("keeps candidate query cancellation independent from latest user query", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    const candidateInput: WorkerQueryInput = {
      datasetId: "dataset-1",
      knownWords: [],
      query: queryState(),
      queryChannel: "candidate",
    };
    const candidate = client.query(candidateInput);
    const candidateRequest = worker.messages[0];
    const user = client.query({
      datasetId: "dataset-1",
      knownWords: [],
      query: queryState({ search: "latest" }),
    });
    const userRequest = worker.messages[1];

    if (candidateRequest?.type !== "query" || userRequest?.type !== "query") throw new Error("missing query requests");
    expect(worker.messages).not.toContainEqual({ protocolVersion: 1, type: "cancel", requestId: candidateRequest.requestId });
    worker.emit(queryResponse(candidateRequest.requestId, 1));
    worker.emit(queryResponse(userRequest.requestId, 1));

    await expect(candidate).resolves.toMatchObject({ page: 1 });
    await expect(user).resolves.toMatchObject({ page: 1 });
  });

  it("does not cancel a pending user query when a candidate query starts", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    const user = client.query({
      datasetId: "dataset-1",
      knownWords: [],
      query: queryState(),
    });
    const userRequest = worker.messages[0];
    const candidateInput: WorkerQueryInput = {
      datasetId: "dataset-1",
      knownWords: [],
      query: queryState(),
      queryChannel: "candidate",
    };
    const candidate = client.query(candidateInput);
    const candidateRequest = worker.messages[1];

    if (userRequest?.type !== "query" || candidateRequest?.type !== "query") throw new Error("missing query requests");
    expect(worker.messages).not.toContainEqual({ protocolVersion: 1, type: "cancel", requestId: userRequest.requestId });
    worker.emit(queryResponse(userRequest.requestId, 1));
    worker.emit(queryResponse(candidateRequest.requestId, 2));

    await expect(user).resolves.toMatchObject({ page: 1 });
    await expect(candidate).resolves.toMatchObject({ page: 2 });
  });

  it("rejects active operations, terminates failed worker, and recreates it next time", async () => {
    const workers: FakeWorker[] = [];
    const client = createWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      if (workers.length === 2) {
        worker.postHook = (message) => {
          if (message.type === "load-complete") {
            worker.emit({
              protocolVersion: 1,
              type: "load-complete",
              requestId: message.requestId,
              datasetId: message.datasetId,
              entryCount: 0,
            });
          }
        };
      }
      return worker;
    });

    const pending = client.query({
      datasetId: "dataset-1",
      knownWords: [],
      query: queryState(),
    });
    workers[0]!.fail("worker crashed");

    await expect(pending).rejects.toThrow("worker crashed");
    expect(workers[0]!.terminated).toBe(true);

    await client.loadDataset("dataset-2", (async function* () {
      yield [];
    })());
    expect(workers).toHaveLength(2);
  });
});
