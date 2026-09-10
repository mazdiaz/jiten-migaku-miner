import { describe, expect, it } from "vitest";
import {
  createWorkerClient,
  type WorkerClientEvent,
  type WorkerLike,
  type WorkerQueryInput,
} from "../../src/app/worker-client";
import type { CoverageStats, Entry, QueryResult, QueryState } from "../../src/domain/types";
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

  removeEventListener(
    type: "message" | "error",
    listener: (event: WorkerClientEvent) => void,
  ): void {
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
    decision: "all",
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
    protocolVersion: 3,
    type: "query-result",
    requestId,
    datasetId: "dataset-1",
    result: queryResult(page),
  };
}

function coverageStats(): CoverageStats {
  return {
    totalUniqueWords: 3,
    knownUniqueWords: 1,
    unknownUniqueWords: 2,
    totalTrackedOccurrences: 100,
    knownTrackedOccurrences: 50,
    unknownTrackedOccurrences: 50,
    coveragePercent: 50,
    targets: [
      {
        targetPercent: 98,
        reached: false,
        additionalWords: 2,
        additionalTrackedOccurrences: 48,
      },
    ],
  };
}

function coverageResponse(requestId: string, result: CoverageStats): WorkerResponse {
  return {
    protocolVersion: 3,
    type: "coverage-result",
    requestId,
    datasetId: "dataset-1",
    result,
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
      protocolVersion: 3,
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
    if (request?.type !== "import-jiten") throw new Error("missing import request");

    worker.emit({
      protocolVersion: 3,
      type: "import-chunk",
      requestId: request.requestId,
      kind: "jiten",
      name: "media.csv",
      chunkIndex: 0,
      entries: [],
    });
    const complete: Extract<ImportCompleteResponse, { kind: "jiten" }> = {
      protocolVersion: 3,
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
    void loading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    if (complete.type !== "load-complete") throw new Error("missing load completion request");
    worker.emit({
      protocolVersion: 3,
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
    expect(
      worker.messages
        .filter((message) => message.type === "load-chunk")
        .map((message) => (message.type === "load-chunk" ? message.chunkIndex : -1)),
    ).toEqual([0, 1]);
  });

  it("rejects load errors and stops sending remaining load messages", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    let errorSent = false;
    worker.postHook = (message) => {
      if (message.type === "load-chunk" && !errorSent) {
        errorSent = true;
        worker.emit({
          protocolVersion: 3,
          type: "error",
          requestId: message.requestId,
          code: "invalid-chunk",
          message: "load failed",
        });
      }
    };

    const loading = client.loadDataset(
      "dataset-1",
      (async function* () {
        yield [];
        yield [];
      })(),
    );

    await expect(loading).rejects.toThrow("load failed");
    expect(worker.messages.filter((message) => message.type === "load-chunk")).toHaveLength(1);
    expect(worker.messages.some((message) => message.type === "load-complete")).toBe(false);
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "cancel" }));
  });

  // Unhandled-rejection spying uses the Node process event because the test
  // environment is "node" (vitest.config.ts) and the rejected promise is a
  // plain JS promise created by the client, never routed through a window.
  it("rejects worker errors mid-load promptly without unhandled rejection", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      let _openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        _openGate = resolve;
      });
      async function* gatedSource(): AsyncIterable<readonly Entry[]> {
        await gate;
        yield [];
      }

      const loading = client.loadDataset("dataset-1", gatedSource());
      const loadStart = worker.messages.find((message) => message.type === "load-start");
      if (loadStart?.type !== "load-start") throw new Error("missing load-start request");
      worker.emit({
        protocolVersion: 3,
        type: "error",
        requestId: loadStart.requestId,
        code: "invalid-chunk",
        message: "load failed",
      });

      const outcome = await Promise.race([
        loading.then(
          () => ({ kind: "resolved" as const }),
          (error) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), 50),
        ),
      ]);

      expect(outcome.kind).toBe("rejected");
      expect(outcome.kind === "rejected" ? outcome.error : undefined).toMatchObject({
        name: "WorkerClientError",
        code: "invalid-chunk",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("stops consuming the source iterator after a mid-load failure", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);

    let nextCalls = 0;
    let returnInvoked = false;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    async function* trackedSource(): AsyncIterable<readonly Entry[]> {
      try {
        nextCalls += 1;
        await gate;
        yield [];
        nextCalls += 1;
        yield [];
        nextCalls += 1;
        yield [];
      } finally {
        returnInvoked = true;
      }
    }

    const loading = client.loadDataset("dataset-1", trackedSource());
    const loadStart = worker.messages.find((message) => message.type === "load-start");
    if (loadStart?.type !== "load-start") throw new Error("missing load-start request");
    worker.emit({
      protocolVersion: 3,
      type: "error",
      requestId: loadStart.requestId,
      code: "invalid-chunk",
      message: "load failed",
    });

    const outcome = await Promise.race([
      loading.then(
        () => ({ kind: "resolved" as const }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 50),
      ),
    ]);
    expect(outcome.kind).toBe("rejected");

    openGate();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(nextCalls).toBeLessThanOrEqual(2);
    expect(returnInvoked).toBe(true);
  });

  function countingSource(
    chunks: number,
    returns: { count: number },
  ): AsyncIterable<readonly Entry[]> {
    return {
      [Symbol.asyncIterator]: () => {
        let produced = 0;
        return {
          async next(): Promise<IteratorResult<readonly Entry[]>> {
            if (produced >= chunks) return { done: true, value: undefined };
            produced += 1;
            return { done: false, value: [] };
          },
          async return(): Promise<IteratorResult<readonly Entry[]>> {
            returns.count += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  it("closes the source iterator exactly once on normal completion", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    const returns = { count: 0 };
    worker.postHook = (message) => {
      if (message.type === "load-complete") {
        worker.emit({
          protocolVersion: 3,
          type: "load-complete",
          requestId: message.requestId,
          datasetId: message.datasetId,
          entryCount: 0,
        });
      }
    };

    await client.loadDataset("dataset-1", countingSource(2, returns));

    expect(returns.count).toBe(1);
  });

  it("closes the source iterator exactly once when a mid-load error rejects the pending load", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    const returns = { count: 0 };

    const loading = client.loadDataset("dataset-1", countingSource(3, returns));
    const loadStart = worker.messages.find((message) => message.type === "load-start");
    if (loadStart?.type !== "load-start") throw new Error("missing load-start request");
    worker.emit({
      protocolVersion: 3,
      type: "error",
      requestId: loadStart.requestId,
      code: "invalid-chunk",
      message: "load failed",
    });

    await expect(loading).rejects.toThrow("load failed");
    expect(returns.count).toBe(1);
  });

  it("closes the source iterator exactly once when posting fails mid-load", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    const returns = { count: 0 };
    worker.postHook = (message) => {
      if (message.type === "load-chunk") throw new Error("postMessage failed");
    };

    await expect(client.loadDataset("dataset-1", countingSource(3, returns))).rejects.toThrow(
      "postMessage failed",
    );

    expect(returns.count).toBe(1);
  });

  it("rejects malformed load acknowledgements instead of leaving load pending", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    worker.postHook = (message) => {
      if (message.type === "load-complete") {
        worker.emit({
          protocolVersion: 3,
          type: "load-complete",
          requestId: message.requestId,
          datasetId: message.datasetId,
        } as WorkerResponse);
      }
    };

    const loading = client.loadDataset(
      "dataset-1",
      (async function* () {
        yield [];
      })(),
    );
    const outcome = await Promise.race([
      loading.then(
        () => ({ kind: "resolved" as const }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 50),
      ),
    ]);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toMatchObject({
        name: "WorkerClientError",
        code: "malformed-load-complete",
      });
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

    const loading = client.loadDataset(
      "dataset-1",
      (async function* () {
        yield [];
      })(),
    );
    const outcome = await Promise.race([
      loading.then(
        () => ({ kind: "resolved" as const }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 50),
      ),
    ]);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toMatchObject({
        name: "WorkerClientError",
        code: "malformed-load-complete",
      });
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

    if (candidateRequest?.type !== "query" || userRequest?.type !== "query")
      throw new Error("missing query requests");
    expect(worker.messages).not.toContainEqual({
      protocolVersion: 3,
      type: "cancel",
      requestId: candidateRequest.requestId,
    });
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

    if (userRequest?.type !== "query" || candidateRequest?.type !== "query")
      throw new Error("missing query requests");
    expect(worker.messages).not.toContainEqual({
      protocolVersion: 3,
      type: "cancel",
      requestId: userRequest.requestId,
    });
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
              protocolVersion: 3,
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
    workers[0]?.fail("worker crashed");

    await expect(pending).rejects.toThrow("worker crashed");
    expect(workers[0]?.terminated).toBe(true);

    await client.loadDataset(
      "dataset-2",
      (async function* () {
        yield [];
      })(),
    );
    expect(workers).toHaveLength(2);
  });

  it("posts well-formed coverage requests and resolves on coverage results", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);
    const stats = coverageStats();

    const pending = client.coverage({
      datasetId: "dataset-1",
      knownWords: ["猫", "犬"],
      decisions: [["鳥", "mined"]],
      targets: [98, 99],
    });
    const request = worker.messages.find((message) => message.type === "coverage");
    expect(request).toMatchObject({
      protocolVersion: 3,
      type: "coverage",
      datasetId: "dataset-1",
      knownWords: ["猫", "犬"],
      decisions: [["鳥", "mined"]],
      targets: [98, 99],
    });
    if (request?.type !== "coverage") throw new Error("missing coverage request");

    worker.emit(coverageResponse(request.requestId, stats));
    await expect(pending).resolves.toEqual(stats);
  });

  it("omits the targets field when coverage input leaves targets unset", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);

    const pending = client.coverage({ datasetId: "dataset-1", knownWords: [] });
    const request = worker.messages.find((message) => message.type === "coverage");
    expect(request).toMatchObject({
      type: "coverage",
      datasetId: "dataset-1",
      knownWords: [],
      decisions: [],
    });
    if (request?.type !== "coverage") throw new Error("missing coverage request");
    expect("targets" in request).toBe(false);

    worker.emit(coverageResponse(request.requestId, coverageStats()));
    await expect(pending).resolves.toMatchObject({ coveragePercent: 50 });
  });

  it("propagates coverage errors as typed client errors", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);

    const pending = client.coverage({ datasetId: "missing", knownWords: [] });
    const request = worker.messages.find((message) => message.type === "coverage");
    if (!request) throw new Error("missing coverage request");

    worker.emit({
      protocolVersion: 3,
      type: "error",
      requestId: request.requestId,
      code: "dataset-not-found",
      message: "Dataset not found: missing",
    });

    await expect(pending).rejects.toMatchObject({
      name: "WorkerClientError",
      code: "dataset-not-found",
    });
  });

  it("keeps coverage requests independent without superseding pending queries or each other", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(() => worker);

    const query = client.query({
      datasetId: "dataset-1",
      knownWords: [],
      query: queryState(),
    });
    const queryRequestMessage = worker.messages.find((message) => message.type === "query");
    const first = client.coverage({
      datasetId: "dataset-1",
      knownWords: ["猫"],
    });
    const second = client.coverage({
      datasetId: "dataset-1",
      knownWords: ["猫", "犬"],
    });
    const coverageRequests = worker.messages.filter((message) => message.type === "coverage");

    expect(coverageRequests).toHaveLength(2);
    for (const message of worker.messages) {
      if (message.type === "cancel" && queryRequestMessage) {
        expect(message.requestId).not.toBe(queryRequestMessage.requestId);
      }
    }
    if (!queryRequestMessage || coverageRequests.length !== 2) throw new Error("missing requests");

    worker.emit(queryResponse(queryRequestMessage.requestId, 1));
    worker.emit(coverageResponse(coverageRequests[0]!.requestId, coverageStats()));
    const otherStats = { ...coverageStats(), coveragePercent: 75 };
    worker.emit(coverageResponse(coverageRequests[1]!.requestId, otherStats));

    await expect(query).resolves.toMatchObject({ page: 1 });
    await expect(first).resolves.toMatchObject({ coveragePercent: 50 });
    await expect(second).resolves.toMatchObject({ coveragePercent: 75 });
  });

  it("sends Anki tuples and resolves preview results", async () => {
    const fakeWorker = new FakeWorker();
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
    await expect(resultPromise).resolves.toEqual({
      matchedWords: 1,
      knownCount: 0,
      minedCount: 1,
      manualProtected: 0,
    });
  });
});
