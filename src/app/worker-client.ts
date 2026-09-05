import type {
  Entry,
  QueryResult,
  QueryState,
  QueryWindow,
  WordDecisionStatus,
} from "../domain/types";
import {
  WORKER_PROTOCOL_VERSION,
  type ImportChunkResponse,
  type ImportCompleteResponse,
  type QueryRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "../worker/protocol";

export interface WorkerClientEvent {
  data?: unknown;
  message?: string;
  error?: unknown;
}

export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  addEventListener(type: "message" | "error", listener: (event: WorkerClientEvent) => void): void;
  removeEventListener(type: "message" | "error", listener: (event: WorkerClientEvent) => void): void;
}

export type WorkerFactory = () => WorkerLike;
export type JitenImportChunk = Extract<ImportChunkResponse, { kind: "jiten" }>;
export type KnownImportChunk = Extract<ImportChunkResponse, { kind: "known" }>;
export type JitenImportComplete = Extract<ImportCompleteResponse, { kind: "jiten" }>;
export type KnownImportComplete = Extract<ImportCompleteResponse, { kind: "known" }>;
export type WorkerQueryChannel = "user" | "candidate" | "review" | "queue";

export interface WorkerQueryInput {
  datasetId: string;
  knownWords: Iterable<string>;
  decisions?: Array<[string, WordDecisionStatus]>;
  includeNormalizedWords?: string[];
  query: QueryState;
  window?: QueryWindow;
  queryChannel?: WorkerQueryChannel;
}

export interface WorkerClient {
  importJiten(
    name: string,
    text: string,
    onChunk?: (chunk: JitenImportChunk) => void,
  ): Promise<JitenImportComplete>;
  importKnown(
    name: string,
    text: string,
    onChunk?: (chunk: KnownImportChunk) => void,
  ): Promise<KnownImportComplete>;
  loadDataset(datasetId: string, chunks: AsyncIterable<readonly Entry[]>): Promise<void>;
  query(input: WorkerQueryInput): Promise<QueryResult>;
  dispose(): void;
}

export class WorkerClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkerClientError";
    this.code = code;
  }
}

type OperationKind = "import-jiten" | "import-known" | "load" | "query";
type PendingValue = JitenImportComplete | KnownImportComplete | QueryResult | void;

interface PendingOperation {
  kind: OperationKind;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  expectedEntryCount: number | null;
  datasetId: string | null;
  queryChannel: WorkerQueryChannel | null;
  onChunk?: (chunk: ImportChunkResponse) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== WORKER_PROTOCOL_VERSION || typeof value.requestId !== "string") return false;

  return value.type === "import-chunk" || value.type === "import-complete" || value.type === "load-complete" || value.type === "query-result" || value.type === "error";
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function isValidLoadCompleteResponse(
  response: Extract<WorkerResponse, { type: "load-complete" }>,
): boolean {
  return typeof response.datasetId === "string" &&
    response.datasetId.length > 0 &&
    typeof response.entryCount === "number" &&
    Number.isSafeInteger(response.entryCount) &&
    response.entryCount >= 0;
}

function createBrowserWorker(): WorkerLike {
  return new Worker(new URL("../worker/miner.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

class BrowserWorkerClient implements WorkerClient {
  private worker: WorkerLike | null = null;
  private nextId = 0;
  private readonly latestQueryIds = new Map<WorkerQueryChannel, string>();
  private readonly pending = new Map<string, PendingOperation>();

  private readonly onMessage = (event: WorkerClientEvent): void => {
    const response = event.data;
    if (!isWorkerResponse(response)) {
      this.rejectInvalidLoadAcknowledgement(response);
      return;
    }

    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (
      pending.kind === "query" &&
      pending.queryChannel !== null &&
      response.requestId !== this.latestQueryIds.get(pending.queryChannel)
    ) return;

    if (response.type === "error") {
      this.pending.delete(response.requestId);
      if (
        pending.kind === "query" &&
        pending.queryChannel !== null &&
        this.latestQueryIds.get(pending.queryChannel) === response.requestId
      ) {
        this.latestQueryIds.delete(pending.queryChannel);
      }
      pending.reject(new WorkerClientError(response.code, response.message));
      if (pending.kind === "load") this.postCancel(response.requestId);
      return;
    }

    if (response.type === "load-complete") {
      if (pending.kind !== "load") return;
      if (!isValidLoadCompleteResponse(response)) {
        this.pending.delete(response.requestId);
        pending.reject(new WorkerClientError(
          "malformed-load-complete",
          "Worker returned an invalid load acknowledgement.",
        ));
        this.postCancel(response.requestId);
        return;
      }
      if (response.datasetId !== pending.datasetId) {
        this.pending.delete(response.requestId);
        pending.reject(new WorkerClientError("load-dataset-mismatch", "Worker acknowledged a different dataset."));
        this.postCancel(response.requestId);
        return;
      }
      if (pending.expectedEntryCount !== response.entryCount) {
        this.pending.delete(response.requestId);
        pending.reject(new WorkerClientError("load-count-mismatch", "Worker acknowledged an unexpected entry count."));
        this.postCancel(response.requestId);
        return;
      }
      this.pending.delete(response.requestId);
      pending.resolve(undefined);
      return;
    }

    if (response.type === "import-chunk") {
      if (
        (pending.kind === "import-jiten" && response.kind !== "jiten") ||
        (pending.kind === "import-known" && response.kind !== "known")
      ) return;
      if (pending.kind === "import-jiten" || pending.kind === "import-known") {
        try {
          pending.onChunk?.(response);
        } catch (error) {
          this.pending.delete(response.requestId);
          pending.reject(error);
          this.postCancel(response.requestId);
        }
      }
      return;
    }

    if (response.type === "import-complete") {
      if (
        (pending.kind === "import-jiten" && response.kind !== "jiten") ||
        (pending.kind === "import-known" && response.kind !== "known")
      ) return;
      this.pending.delete(response.requestId);
      pending.resolve(response);
      return;
    }

    if (pending.kind !== "query") return;
    this.pending.delete(response.requestId);
    if (
      pending.queryChannel !== null &&
      this.latestQueryIds.get(pending.queryChannel) === response.requestId
    ) {
      this.latestQueryIds.delete(pending.queryChannel);
    }
    pending.resolve(response.result);
  };

  private rejectInvalidLoadAcknowledgement(value: unknown): void {
    if (!isRecord(value) || value.type !== "load-complete") return;
    if (typeof value.requestId !== "string" || value.requestId.length === 0) return;
    const pending = this.pending.get(value.requestId);
    if (pending === undefined || pending.kind !== "load") return;

    this.pending.delete(value.requestId);
    pending.reject(new WorkerClientError(
      "malformed-load-complete",
      "Worker returned an invalid load acknowledgement.",
    ));
    this.postCancel(value.requestId);
  }

  private readonly onError = (event: WorkerClientEvent): void => {
    const error = event.error ?? event.message ?? "Worker operation failed.";
    this.failWorker(error);
  };

  constructor(private readonly factory: WorkerFactory) {}

  async importJiten(
    name: string,
    text: string,
    onChunk?: (chunk: JitenImportChunk) => void,
  ): Promise<JitenImportComplete> {
    const requestId = this.requestId("import");
    const result = this.register<JitenImportComplete>(
      requestId,
      "import-jiten",
      onChunk === undefined
        ? undefined
        : (chunk) => {
            if (chunk.kind === "jiten") onChunk(chunk);
          },
    );
    try {
      this.post({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: "import-jiten",
        requestId,
        name,
        text,
      });
    } catch (error) {
      this.rejectPending(requestId, error);
    }
    return result;
  }

  async importKnown(
    name: string,
    text: string,
    onChunk?: (chunk: KnownImportChunk) => void,
  ): Promise<KnownImportComplete> {
    const requestId = this.requestId("known");
    const result = this.register<KnownImportComplete>(
      requestId,
      "import-known",
      onChunk === undefined
        ? undefined
        : (chunk) => {
            if (chunk.kind === "known") onChunk(chunk);
          },
    );
    try {
      this.post({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: "import-known",
        requestId,
        name,
        text,
      });
    } catch (error) {
      this.rejectPending(requestId, error);
    }
    return result;
  }

  async loadDataset(datasetId: string, chunks: AsyncIterable<readonly Entry[]>): Promise<void> {
    const requestId = this.requestId("load");
    const result = this.register<void>(requestId, "load", undefined, 0, datasetId);
    try {
      this.post({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: "load-start",
        requestId,
        datasetId,
      });
      this.ensurePending(requestId);

      let chunkIndex = 0;
      for await (const entries of chunks) {
        this.ensurePending(requestId);
        this.post({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          type: "load-chunk",
          requestId,
          datasetId,
          chunkIndex,
          entries: [...entries],
        });
        const pending = this.pending.get(requestId);
        if (pending?.kind === "load" && pending.expectedEntryCount !== null) {
          pending.expectedEntryCount += entries.length;
        }
        this.ensurePending(requestId);
        chunkIndex += 1;
      }

      this.post({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: "load-complete",
        requestId,
        datasetId,
      });
    } catch (error) {
      this.rejectPending(requestId, error);
      this.postCancel(requestId);
    }
    return result;
  }

  async query(input: WorkerQueryInput): Promise<QueryResult> {
    const queryChannel = input.queryChannel ?? "user";
    const previousQueryId = this.latestQueryIds.get(queryChannel) ?? null;
    if (previousQueryId !== null) {
      const previous = this.pending.get(previousQueryId);
      if (previous?.kind === "query" && previous.queryChannel === queryChannel) {
        this.pending.delete(previousQueryId);
        previous.reject(new WorkerClientError("stale-query", "Query was superseded by a newer request."));
      }
      this.postCancel(previousQueryId);
    }

    const requestId = this.requestId("query");
    this.latestQueryIds.set(queryChannel, requestId);
    const result = this.register<QueryResult>(requestId, "query", undefined, undefined, undefined, queryChannel);
    const request: QueryRequest = {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: "query",
      requestId,
      datasetId: input.datasetId,
      knownWords: [...input.knownWords],
      decisions: input.decisions ?? [],
      query: { ...input.query },
    };
    if (input.includeNormalizedWords !== undefined) request.includeNormalizedWords = [...input.includeNormalizedWords];
    if (input.window !== undefined) request.window = input.window;

    try {
      this.post(request);
    } catch (error) {
      this.rejectPending(requestId, error);
    }
    return result;
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    this.latestQueryIds.clear();
    const error = new WorkerClientError("disposed", "Worker client was disposed.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();

    if (worker !== null) {
      try {
        worker.postMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          type: "dispose",
          requestId: this.requestId("dispose"),
        });
      } catch {
        // Termination below is sufficient when disposal message cannot be sent.
      }
      this.detach(worker);
      worker.terminate();
    }
  }

  private requestId(kind: string): string {
    this.nextId += 1;
    return `${kind}-${this.nextId}`;
  }

  private register<T extends PendingValue>(
    requestId: string,
    kind: OperationKind,
    onChunk?: (chunk: ImportChunkResponse) => void,
    expectedEntryCount?: number,
    datasetId?: string,
    queryChannel?: WorkerQueryChannel,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: PendingOperation = {
        kind,
        resolve: (value: unknown) => resolve(value as T),
        reject: (reason: unknown) => reject(reason),
        expectedEntryCount: expectedEntryCount ?? null,
        datasetId: datasetId ?? null,
        queryChannel: queryChannel ?? null,
      };
      if (onChunk !== undefined) pending.onChunk = onChunk;
      this.pending.set(requestId, pending);
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker !== null) return this.worker;

    const worker = this.factory();
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    this.worker = worker;
    return worker;
  }

  private post(message: WorkerRequest): void {
    const worker = this.ensureWorker();
    try {
      worker.postMessage(message);
    } catch (error) {
      this.failWorker(error);
      throw error;
    }
  }

  private postCancel(requestId: string): void {
    if (this.worker === null) return;
    try {
      this.worker.postMessage({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: "cancel",
        requestId,
      });
    } catch (error) {
      this.failWorker(error);
    }
  }

  private ensurePending(requestId: string): void {
    if (!this.pending.has(requestId)) {
      throw new WorkerClientError("load-cancelled", "Load operation was cancelled.");
    }
  }

  private rejectPending(requestId: string, reason: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.reject(reason);
  }

  private failWorker(reason: unknown): void {
    const worker = this.worker;
    this.worker = null;
    this.latestQueryIds.clear();
    const failure = new WorkerClientError("worker-failed", messageFromError(reason));
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();

    if (worker !== null) {
      this.detach(worker);
      worker.terminate();
    }
  }

  private detach(worker: WorkerLike): void {
    worker.removeEventListener("message", this.onMessage);
    worker.removeEventListener("error", this.onError);
  }
}

export function createWorkerClient(factory: WorkerFactory = createBrowserWorker): WorkerClient {
  return new BrowserWorkerClient(factory);
}

export { createBrowserWorker };
