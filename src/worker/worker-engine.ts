import { parseJitenCsv } from "../domain/import";
import { isKanaOnly, normalizeText, parseKnownWords, sentencePlain } from "../domain/text";
import { paginateEntries } from "../domain/query";
import type { Entry, EntryWithKnown, QueryState, WordDecisionStatus } from "../domain/types";
import {
  WORKER_IMPORT_CHUNK_SIZE,
  WORKER_PROTOCOL_VERSION,
  type QueryRequest,
  type SendResponse,
  type WorkerResponse,
} from "./protocol";

export type WorkerEngineErrorCode = "dataset-not-found" | "dataset-not-ready" | "invalid-chunk" | "disposed";

export class WorkerEngineError extends Error {
  readonly code: WorkerEngineErrorCode;

  constructor(code: WorkerEngineErrorCode, message: string) {
    super(message);
    this.name = "WorkerEngineError";
    this.code = code;
  }
}

interface SearchFields {
  normalizedWord: string;
  word: string;
  sentence: string;
}

interface WindowCache {
  signature: string;
  orderedIndexes: number[];
  knownByMigakuByIndex: Map<number, boolean>;
  decisionByIndex: Map<number, WordDecisionStatus | "unreviewed">;
  knownCount: number;
}

interface DatasetState {
  loadRequestId: string;
  entries: Entry[];
  searchFields: SearchFields[];
  sortIndexes: Record<QueryState["sort"], number[]>;
  nextChunkIndex: number;
  complete: boolean;
}

const EMPTY_SORT_INDEXES: Record<QueryState["sort"], number[]> = {
  "occ-desc": [],
  "occ-asc": [],
  original: [],
};

function createDatasetState(loadRequestId: string): DatasetState {
  return {
    loadRequestId,
    entries: [],
    searchFields: [],
    sortIndexes: {
      "occ-desc": [...EMPTY_SORT_INDEXES["occ-desc"]],
      "occ-asc": [...EMPTY_SORT_INDEXES["occ-asc"]],
      original: [...EMPTY_SORT_INDEXES.original],
    },
    nextChunkIndex: 0,
    complete: false,
  };
}

function occurrenceCount(entry: Entry): number {
  const value = Number(entry.occurrences);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sortedIndexes(entries: readonly Entry[], mode: QueryState["sort"]): number[] {
  const indexes = entries.map((_, index) => index);
  indexes.sort((leftIndex, rightIndex) => {
    const left = entries[leftIndex];
    const right = entries[rightIndex];
    if (left === undefined || right === undefined) return left === right ? leftIndex - rightIndex : left === undefined ? 1 : -1;

    if (mode === "original") return left.originalIndex - right.originalIndex || leftIndex - rightIndex;
    const difference = mode === "occ-asc"
      ? occurrenceCount(left) - occurrenceCount(right)
      : occurrenceCount(right) - occurrenceCount(left);
    return difference || left.originalIndex - right.originalIndex || leftIndex - rightIndex;
  });
  return indexes;
}

function cacheSearchFields(entry: Entry): SearchFields {
  return {
    normalizedWord: normalizeText(entry.normalizedWord).toLocaleLowerCase(),
    word: normalizeText(entry.word).toLocaleLowerCase(),
    sentence: sentencePlain(entry.sentenceRaw).toLocaleLowerCase(),
  };
}

function yieldsToWorker(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function windowCacheSignature(
  request: QueryRequest,
  knownWords: ReadonlySet<string>,
  decisions: ReadonlyMap<string, WordDecisionStatus>,
): string {
  return JSON.stringify({
    datasetId: request.datasetId,
    knownWords: [...knownWords].sort(),
    decisions: [...decisions].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    decision: request.query.decision,
    search: request.query.search,
    hideKnown: request.query.hideKnown,
    hideKanaOnly: request.query.hideKanaOnly,
    sentence: request.query.sentence,
    minOccurrences: request.query.minOccurrences,
    sort: request.query.sort,
  });
}

export class WorkerEngine {
  private readonly datasets = new Map<string, DatasetState>();
  private readonly staging = new Map<string, DatasetState>();
  private readonly loadRequests = new Map<string, string>();
  private readonly activeOperations = new Set<string>();
  private readonly cancelledRequests = new Set<string>();
  private activeDatasetId: string | null = null;
  private windowCache: WindowCache | null = null;
  private disposed = false;

  async importJiten(requestId: string, name: string, text: string, send: SendResponse): Promise<void> {
    this.ensureUsable();
    this.activeOperations.add(requestId);
    try {
      if (this.isCancelled(requestId)) return;
      const parsed = parseJitenCsv(text);
      const completed = await this.emitChunks(requestId, parsed.entries, (chunkIndex, entries) => {
        const response: WorkerResponse = {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          type: "import-chunk",
          requestId,
          kind: "jiten",
          name,
          chunkIndex,
          entries,
        };
        send(response);
      });
      if (!completed || this.isCancelled(requestId)) return;

      send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: "import-complete",
        requestId,
        kind: "jiten",
        name,
        headers: parsed.headers,
        entryCount: parsed.entries.length,
        skippedRows: parsed.skippedRows,
      });
    } finally {
      this.activeOperations.delete(requestId);
      this.cancelledRequests.delete(requestId);
    }
  }

  async importKnown(requestId: string, name: string, text: string, send: SendResponse): Promise<void> {
    this.ensureUsable();
    this.activeOperations.add(requestId);
    try {
      if (this.isCancelled(requestId)) return;
      const words = [...parseKnownWords(text)];
      const completed = await this.emitChunks(requestId, words, (chunkIndex, chunkWords) => {
        const response: WorkerResponse = {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          type: "import-chunk",
          requestId,
          kind: "known",
          name,
          chunkIndex,
          words: chunkWords,
        };
        send(response);
      });
      if (!completed || this.isCancelled(requestId)) return;

      send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: "import-complete",
        requestId,
        kind: "known",
        name,
        wordCount: words.length,
      });
    } finally {
      this.activeOperations.delete(requestId);
      this.cancelledRequests.delete(requestId);
    }
  }

  loadStart(datasetId: string, requestId = datasetId): void {
    this.ensureUsable();
    if (datasetId.length === 0) throw new WorkerEngineError("dataset-not-ready", "Dataset ID must not be empty");
    if (requestId.length === 0) throw new WorkerEngineError("dataset-not-ready", "Load request ID must not be empty");

    const previousDatasetId = this.loadRequests.get(requestId);
    if (previousDatasetId !== undefined) {
      this.staging.delete(previousDatasetId);
      this.loadRequests.delete(requestId);
    }
    const previous = this.staging.get(datasetId);
    if (previous !== undefined) {
      this.loadRequests.delete(previous.loadRequestId);
      this.cancelledRequests.delete(previous.loadRequestId);
    }
    this.loadRequests.set(requestId, datasetId);
    this.staging.set(datasetId, createDatasetState(requestId));
  }

  loadChunk(datasetId: string, chunkIndex: number, entries: Entry[], requestId = datasetId): void {
    this.ensureUsable();
    const dataset = this.staging.get(datasetId);
    if (dataset === undefined || dataset.loadRequestId !== requestId) {
      throw new WorkerEngineError("dataset-not-ready", `Dataset has not been started: ${datasetId}`);
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex !== dataset.nextChunkIndex) {
      throw new WorkerEngineError("invalid-chunk", `Unexpected dataset chunk index: ${chunkIndex}`);
    }
    if (entries.length > WORKER_IMPORT_CHUNK_SIZE) {
      throw new WorkerEngineError("invalid-chunk", `Dataset chunks cannot exceed ${WORKER_IMPORT_CHUNK_SIZE} entries`);
    }

    for (const value of entries) {
      dataset.entries.push(value);
      dataset.searchFields.push(cacheSearchFields(value));
    }
    dataset.nextChunkIndex += 1;
  }

  loadComplete(datasetId: string, requestId = datasetId): void {
    this.ensureUsable();
    const dataset = this.staging.get(datasetId);
    if (dataset === undefined || dataset.loadRequestId !== requestId) {
      throw new WorkerEngineError("dataset-not-ready", `Dataset has not been started: ${datasetId}`);
    }

    dataset.sortIndexes = {
      "occ-desc": sortedIndexes(dataset.entries, "occ-desc"),
      "occ-asc": sortedIndexes(dataset.entries, "occ-asc"),
      original: sortedIndexes(dataset.entries, "original"),
    };
    dataset.complete = true;
    this.datasets.set(datasetId, dataset);
    this.staging.delete(datasetId);
    this.loadRequests.delete(requestId);
    this.activeDatasetId = datasetId;
    this.windowCache = null;
  }

  getDatasetEntryCount(datasetId: string): number {
    this.ensureUsable();
    const dataset = this.datasets.get(datasetId);
    if (dataset === undefined || !dataset.complete) {
      throw new WorkerEngineError("dataset-not-ready", `Dataset is not complete: ${datasetId}`);
    }
    return dataset.entries.length;
  }

  async query(request: QueryRequest, send: SendResponse): Promise<void> {
    this.ensureUsable();
    this.activeOperations.add(request.requestId);
    try {
      if (this.isCancelled(request.requestId)) return;
      const dataset = this.datasets.get(request.datasetId);
      if (dataset === undefined) {
        throw new WorkerEngineError("dataset-not-found", `Dataset not found: ${request.datasetId}`);
      }
      if (!dataset.complete) {
        throw new WorkerEngineError("dataset-not-ready", `Dataset is not complete: ${request.datasetId}`);
      }

      const knownWords = new Set(request.knownWords);
      const decisions = new Map(request.decisions);
      const cacheable = request.query.pageSize === "all";
      const signature = cacheable ? windowCacheSignature(request, knownWords, decisions) : "";
      const cache = cacheable ? this.windowCache : null;

      let orderedIndexes: number[];
      let knownByMigakuByIndex: Map<number, boolean>;
      let decisionByIndex: Map<number, WordDecisionStatus | "unreviewed">;
      let knownCount: number;

      if (cache !== null && cache.signature === signature) {
        orderedIndexes = cache.orderedIndexes;
        knownByMigakuByIndex = cache.knownByMigakuByIndex;
        decisionByIndex = cache.decisionByIndex;
        knownCount = cache.knownCount;
      } else {
        const scan = await this.scanDataset(request, dataset, knownWords, decisions);
        if (scan === null || this.isCancelled(request.requestId)) return;
        orderedIndexes = scan.orderedIndexes;
        knownByMigakuByIndex = scan.knownByMigakuByIndex;
        decisionByIndex = scan.decisionByIndex;
        knownCount = scan.knownCount;
        if (cacheable) {
          this.windowCache = { signature, orderedIndexes, knownByMigakuByIndex, decisionByIndex, knownCount };
        }
      }

      const entryWithMetadata = (entryIndex: number, value: Entry): EntryWithKnown => {
        const knownByMigaku = knownByMigakuByIndex.get(entryIndex) === true;
        const decision = decisionByIndex.get(entryIndex) ?? "unreviewed";
        const knownByDecision = decision === "known";
        return {
          ...value,
          known: knownByMigaku || knownByDecision,
          knownByMigaku,
          knownByDecision,
          decision,
        };
      };

      if (request.window !== undefined) {
        const start = Math.min(orderedIndexes.length, Math.max(0, Math.floor(request.window.start)));
        const end = Math.min(orderedIndexes.length, start + Math.floor(request.window.size));
        const items: EntryWithKnown[] = [];
        for (let offset = start; offset < end; offset += 1) {
          const entryIndex = orderedIndexes[offset];
          if (entryIndex === undefined) continue;
          const value = dataset.entries[entryIndex];
          if (value !== undefined) items.push(entryWithMetadata(entryIndex, value));
        }
        if (this.isCancelled(request.requestId)) return;

        send({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          type: "query-result",
          requestId: request.requestId,
          datasetId: request.datasetId,
          result: {
            items,
            page: orderedIndexes.length === 0 ? 0 : 1,
            totalPages: orderedIndexes.length === 0 ? 0 : 1,
            totalEntries: orderedIndexes.length,
            startIndex: items.length > 0 ? start + 1 : 0,
            endIndex: items.length > 0 ? end : 0,
            pageSize: "all",
            knownCount,
            windowed: true,
          },
        });
        return;
      }

      const ordered: EntryWithKnown[] = [];
      for (let offset = 0; offset < orderedIndexes.length; offset += 1) {
        const entryIndex = orderedIndexes[offset];
        if (entryIndex === undefined) continue;
        const value = dataset.entries[entryIndex];
        if (value !== undefined) ordered.push(entryWithMetadata(entryIndex, value));
        if ((offset + 1) % WORKER_IMPORT_CHUNK_SIZE === 0 && await this.chunkFinished(request.requestId)) return;
      }
      if (await this.chunkFinished(request.requestId)) return;

      const result = {
        ...paginateEntries(ordered, request.query.page, request.query.pageSize),
        knownCount,
      };
      if (this.isCancelled(request.requestId)) return;

      send({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: "query-result",
        requestId: request.requestId,
        datasetId: request.datasetId,
        result,
      });
    } finally {
      this.activeOperations.delete(request.requestId);
      this.cancelledRequests.delete(request.requestId);
    }
  }

  private async scanDataset(
    request: QueryRequest,
    dataset: DatasetState,
    knownWords: ReadonlySet<string>,
    decisions: ReadonlyMap<string, WordDecisionStatus>,
  ): Promise<{
    orderedIndexes: number[];
    knownByMigakuByIndex: Map<number, boolean>;
    decisionByIndex: Map<number, WordDecisionStatus | "unreviewed">;
    knownCount: number;
  } | null> {
    const knownByMigakuByIndex = new Map<number, boolean>();
    const decisionByIndex = new Map<number, WordDecisionStatus | "unreviewed">();
    const matching = new Set<number>();
    const search = normalizeText(request.query.search).toLocaleLowerCase();
    const minimumOccurrences = Number.isFinite(request.query.minOccurrences)
      ? Math.max(0, request.query.minOccurrences)
      : 0;
    let knownCount = 0;

    for (let index = 0; index < dataset.entries.length; index += 1) {
      const value = dataset.entries[index];
      const fields = dataset.searchFields[index];
      if (value === undefined || fields === undefined) continue;

      const knownByMigaku = knownWords.has(value.normalizedWord);
      const decision = decisions.get(value.normalizedWord) ?? "unreviewed";
      const knownByDecision = decision === "known";
      const known = knownByMigaku || knownByDecision;
      knownByMigakuByIndex.set(index, knownByMigaku);
      decisionByIndex.set(index, decision);
      if (known) knownCount += 1;

      const searchMatches =
        search.length === 0 ||
        fields.normalizedWord.includes(search) ||
        fields.word.includes(search) ||
        fields.sentence.includes(search);
      const passes =
        searchMatches &&
        !(request.query.hideKnown && known) &&
        !(request.query.hideKanaOnly && isKanaOnly(value.normalizedWord)) &&
        !(request.query.sentence === "has" && !value.hasSentence) &&
        !(request.query.sentence === "none" && value.hasSentence) &&
        occurrenceCount(value) >= minimumOccurrences &&
        !(request.query.decision !== "all" && decision !== request.query.decision);

      if (passes) matching.add(index);
      if ((index + 1) % WORKER_IMPORT_CHUNK_SIZE === 0 && await this.chunkFinished(request.requestId)) return null;
    }
    if (await this.chunkFinished(request.requestId)) return null;

    const orderedIndexes: number[] = [];
    const indexes = dataset.sortIndexes[request.query.sort];
    for (let index = 0; index < indexes.length; index += 1) {
      const entryIndex = indexes[index];
      if (entryIndex !== undefined && matching.has(entryIndex)) orderedIndexes.push(entryIndex);
      if ((index + 1) % WORKER_IMPORT_CHUNK_SIZE === 0 && await this.chunkFinished(request.requestId)) return null;
    }
    if (await this.chunkFinished(request.requestId)) return null;

    return { orderedIndexes, knownByMigakuByIndex, decisionByIndex, knownCount };
  }

  cancel(requestId: string): void {
    const datasetId = this.loadRequests.get(requestId);
    if (datasetId !== undefined) {
      const dataset = this.staging.get(datasetId);
      if (dataset?.loadRequestId === requestId) this.staging.delete(datasetId);
      this.loadRequests.delete(requestId);
      this.cancelledRequests.delete(requestId);
      return;
    }
    if (!this.activeOperations.has(requestId)) return;
    this.cancelledRequests.add(requestId);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelledRequests.clear();
    this.activeOperations.clear();
    this.loadRequests.clear();
    this.datasets.clear();
    this.staging.clear();
    this.activeDatasetId = null;
    this.windowCache = null;
  }

  private ensureUsable(): void {
    if (this.disposed) throw new WorkerEngineError("disposed", "Worker engine has been disposed");
  }

  private isCancelled(requestId: string): boolean {
    return this.disposed || this.cancelledRequests.has(requestId);
  }

  private async chunkFinished(requestId: string): Promise<boolean> {
    if (this.isCancelled(requestId)) return true;
    await yieldsToWorker();
    return this.isCancelled(requestId);
  }

  private async emitChunks<T>(
    requestId: string,
    values: readonly T[],
    sendChunk: (chunkIndex: number, values: T[]) => void,
  ): Promise<boolean> {
    for (let offset = 0, chunkIndex = 0; offset < values.length; offset += WORKER_IMPORT_CHUNK_SIZE, chunkIndex += 1) {
      if (this.isCancelled(requestId)) return false;
      sendChunk(chunkIndex, values.slice(offset, offset + WORKER_IMPORT_CHUNK_SIZE));
      if (await this.chunkFinished(requestId)) return false;
    }
    return !this.isCancelled(requestId);
  }
}

