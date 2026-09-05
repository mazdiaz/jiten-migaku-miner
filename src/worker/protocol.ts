import type {
  Entry,
  QueryResult,
  QueryState,
  QueryWindow,
  WordDecisionFilter,
  WordDecisionStatus,
} from "../domain/types";

export const WORKER_PROTOCOL_VERSION = 1 as const;
export const WORKER_IMPORT_CHUNK_SIZE = 2_000 as const;

const DECISION_STATUSES: readonly WordDecisionStatus[] = ["known", "mined", "skip", "later"];

export type WorkerRequest =
  | { protocolVersion: 1; type: "import-jiten"; requestId: string; name: string; text: string }
  | { protocolVersion: 1; type: "import-known"; requestId: string; name: string; text: string }
  | { protocolVersion: 1; type: "load-start"; requestId: string; datasetId: string }
  | {
      protocolVersion: 1;
      type: "load-chunk";
      requestId: string;
      datasetId: string;
      chunkIndex: number;
      entries: Entry[];
    }
  | { protocolVersion: 1; type: "load-complete"; requestId: string; datasetId: string }
  | {
      protocolVersion: 1;
      type: "query";
      requestId: string;
      datasetId: string;
      knownWords: string[];
      decisions: Array<[string, WordDecisionStatus]>;
      query: QueryState;
      includeNormalizedWords?: string[];
      window?: QueryWindow;
    }
  | { protocolVersion: 1; type: "cancel"; requestId: string }
  | { protocolVersion: 1; type: "dispose"; requestId: string };

export type QueryRequest = Extract<WorkerRequest, { type: "query" }>;

export type ImportChunkResponse =
  | {
      protocolVersion: 1;
      type: "import-chunk";
      requestId: string;
      kind: "jiten";
      name: string;
      chunkIndex: number;
      entries: Entry[];
    }
  | {
      protocolVersion: 1;
      type: "import-chunk";
      requestId: string;
      kind: "known";
      name: string;
      chunkIndex: number;
      words: string[];
    };

export type ImportCompleteResponse =
  | {
      protocolVersion: 1;
      type: "import-complete";
      requestId: string;
      kind: "jiten";
      name: string;
      headers: string[];
      entryCount: number;
      skippedRows: number;
    }
  | {
      protocolVersion: 1;
      type: "import-complete";
      requestId: string;
      kind: "known";
      name: string;
      wordCount: number;
    };

export type LoadCompleteResponse = {
  protocolVersion: 1;
  type: "load-complete";
  requestId: string;
  datasetId: string;
  entryCount: number;
};

export type WorkerResponse =
  | ImportChunkResponse
  | ImportCompleteResponse
  | LoadCompleteResponse
  | {
      protocolVersion: 1;
      type: "query-result";
      requestId: string;
      datasetId: string;
      result: QueryResult;
    }
  | {
      protocolVersion: 1;
      type: "error";
      requestId: string;
      code: string;
      message: string;
    };

export type SendResponse = (response: WorkerResponse) => void;

export type WorkerProtocolErrorCode =
  | "invalid-protocol-version"
  | "unknown-message-type"
  | "invalid-message";

export class WorkerProtocolError extends Error {
  readonly code: WorkerProtocolErrorCode;

  constructor(code: WorkerProtocolErrorCode, message: string) {
    super(message);
    this.name = "WorkerProtocolError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function invalidMessage(message: string): WorkerProtocolError {
  return new WorkerProtocolError("invalid-message", message);
}

function requiredString(record: UnknownRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidMessage(`${field} must be a non-empty string`);
  }

  return value;
}

function stringValue(record: UnknownRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw invalidMessage(`${field} must be a string`);
  return value;
}

function finiteNumber(record: UnknownRecord, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidMessage(`${field} must be a finite number`);
  }

  return value;
}

function integer(record: UnknownRecord, field: string): number {
  const value = finiteNumber(record, field);
  if (!Number.isInteger(value)) throw invalidMessage(`${field} must be an integer`);
  return value;
}

function positiveInteger(record: UnknownRecord, field: string): number {
  const value = integer(record, field);
  if (value < 1) throw invalidMessage(`${field} must be at least 1`);
  return value;
}

function nonNegativeInteger(record: UnknownRecord, field: string): number {
  const value = integer(record, field);
  if (value < 0) throw invalidMessage(`${field} must not be negative`);
  return value;
}

function boolean(record: UnknownRecord, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw invalidMessage(`${field} must be a boolean`);
  return value;
}

function validateFuriganaRuns(value: unknown): Entry["furiganaRuns"] {
  if (!Array.isArray(value)) throw invalidMessage("entries.furiganaRuns must be an array");

  return value.map((run, index) => {
    if (!isRecord(run) || typeof run.text !== "string" || (run.reading !== null && typeof run.reading !== "string")) {
      throw invalidMessage(`entries.furiganaRuns[${index}] is invalid`);
    }

    return { text: run.text, reading: run.reading };
  });
}

function validateEntry(value: unknown, index: number): Entry {
  if (!isRecord(value)) throw invalidMessage(`entries[${index}] must be an object`);

  return {
    id: requiredString(value, "id"),
    originalIndex: integer(value, "originalIndex"),
    word: requiredString(value, "word"),
    normalizedWord: requiredString(value, "normalizedWord"),
    occurrences: finiteNumber(value, "occurrences"),
    sentenceRaw: stringValue(value, "sentenceRaw"),
    hasSentence: boolean(value, "hasSentence"),
    definitions: stringValue(value, "definitions"),
    furiganaRuns: validateFuriganaRuns(value.furiganaRuns),
  };
}

function validateEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) throw invalidMessage("entries must be an array");
  return value.map((entry, index) => validateEntry(entry, index));
}

function validateQuery(value: unknown): QueryState {
  if (!isRecord(value)) throw invalidMessage("query must be an object");

  const pageSize = value.pageSize;
  if (
    pageSize !== "all" &&
    (typeof pageSize !== "number" || !Number.isFinite(pageSize) || !Number.isInteger(pageSize) || pageSize < 1)
  ) {
    throw invalidMessage("query.pageSize must be a positive integer or all");
  }

  const sentence = value.sentence;
  if (sentence !== "any" && sentence !== "has" && sentence !== "none") {
    throw invalidMessage("query.sentence is invalid");
  }

  const sort = value.sort;
  if (sort !== "occ-desc" && sort !== "occ-asc" && sort !== "original") {
    throw invalidMessage("query.sort is invalid");
  }

  const decision = value.decision;
  if (
    typeof decision !== "string" ||
    (decision !== "all" && decision !== "unreviewed" && !DECISION_STATUSES.includes(decision as WordDecisionStatus))
  ) {
    throw invalidMessage("query.decision is invalid");
  }

  return {
    search: stringValue(value, "search"),
    hideKnown: boolean(value, "hideKnown"),
    hideKanaOnly: boolean(value, "hideKanaOnly"),
    sentence,
    minOccurrences: finiteNumber(value, "minOccurrences"),
    sort,
    pageSize,
    page: positiveInteger(value, "page"),
    decision: decision as WordDecisionFilter,
  };
}

function validateDecisions(value: unknown): Array<[string, WordDecisionStatus]> {
  if (!Array.isArray(value)) throw invalidMessage("decisions must be an array");

  return value.map((item, index) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw invalidMessage(`decisions[${index}] must be a [normalizedWord, status] pair`);
    }

    const word = item[0];
    const status = item[1];
    if (typeof word !== "string") throw invalidMessage(`decisions[${index}][0] must be a string`);
    if (typeof status !== "string" || !DECISION_STATUSES.includes(status as WordDecisionStatus)) {
      throw invalidMessage(`decisions[${index}][1] must be one of: ${DECISION_STATUSES.join(", ")}`);
    }

    return [word, status] as [string, WordDecisionStatus];
  });
}

function validateWindow(value: unknown): QueryWindow {
  if (!isRecord(value)) throw invalidMessage("window must be an object");
  return { start: nonNegativeInteger(value, "start"), size: nonNegativeInteger(value, "size") };
}

function validateKnownWords(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((word) => typeof word !== "string")) {
    throw invalidMessage("knownWords must be an array of strings");
  }

  return [...value];
}

function validateIncludeNormalizedWords(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((word) => typeof word !== "string" || word.length === 0)) {
    throw invalidMessage("includeNormalizedWords must be an array of non-empty strings");
  }

  return [...value];
}

export function parseWorkerRequest(value: unknown): WorkerRequest {
  if (!isRecord(value)) throw invalidMessage("worker request must be an object");

  if (value.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    throw new WorkerProtocolError(
      "invalid-protocol-version",
      `Unsupported worker protocol version: ${String(value.protocolVersion)}`,
    );
  }

  const type = value.type;
  if (
    type !== "import-jiten" &&
    type !== "import-known" &&
    type !== "load-start" &&
    type !== "load-chunk" &&
    type !== "load-complete" &&
    type !== "query" &&
    type !== "cancel" &&
    type !== "dispose"
  ) {
    throw new WorkerProtocolError("unknown-message-type", `Unknown worker message type: ${String(type)}`);
  }
  const requestId = requiredString(value, "requestId");

  if (type === "import-jiten" || type === "import-known") {
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type,
      requestId,
      name: requiredString(value, "name"),
      text: stringValue(value, "text"),
    };
  }

  if (type === "load-start" || type === "load-complete") {
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type,
      requestId,
      datasetId: requiredString(value, "datasetId"),
    };
  }

  if (type === "load-chunk") {
    const chunkIndex = integer(value, "chunkIndex");
    if (chunkIndex < 0) throw invalidMessage("chunkIndex must not be negative");

    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type,
      requestId,
      datasetId: requiredString(value, "datasetId"),
      chunkIndex,
      entries: validateEntries(value.entries),
    };
  }

  if (type === "query") {
    const request: QueryRequest = {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type,
      requestId,
      datasetId: requiredString(value, "datasetId"),
      knownWords: validateKnownWords(value.knownWords),
      decisions: validateDecisions(value.decisions),
      query: validateQuery(value.query),
    };
    if (value.includeNormalizedWords !== undefined) {
      request.includeNormalizedWords = validateIncludeNormalizedWords(value.includeNormalizedWords);
    }
    if (value.window !== undefined) request.window = validateWindow(value.window);
    return request;
  }

  return { protocolVersion: WORKER_PROTOCOL_VERSION, type, requestId };
}

export function validateWorkerRequest(value: unknown): WorkerRequest {
  return parseWorkerRequest(value);
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  try {
    parseWorkerRequest(value);
    return true;
  } catch {
    return false;
  }
}

export interface SerializedError {
  code: string;
  message: string;
}

export function serializeError(error: unknown): SerializedError {
  let code = "worker-error";
  let message = "Worker operation failed.";

  if (isRecord(error) && typeof error.code === "string" && error.code.length > 0) code = error.code;
  if (error instanceof Error && error.message.length > 0) {
    message = error.message;
  } else if (isRecord(error) && typeof error.message === "string" && error.message.length > 0) {
    message = error.message;
  }

  return { code, message };
}

export function createErrorResponse(requestId: string, error: unknown): WorkerResponse {
  const serialized = serializeError(error);
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    type: "error",
    requestId,
    code: serialized.code,
    message: serialized.message,
  };
}
