import type {
  EntryWithKnown,
  QueryResult,
  QueryState,
  ViewState,
  WordDecision,
  WordDecisionStatus,
} from "../domain/types";
import type { DatasetMetadata } from "../storage/contracts";

export interface ReviewState {
  active: boolean;
  initialTotal: number;
  processed: number;
  remaining: number;
  current: EntryWithKnown | null;
  status: "idle" | "loading" | "ready" | "complete" | "error";
  errorMessage: string | null;
}

export interface MiningQueueState {
  datasetId: string | null;
  normalizedWords: string[];
  mode: "normal" | "queue";
}

export interface AppState {
  dataset: DatasetMetadata | null;
  knownWords: Set<string>;
  knownWordsName: string | null;
  wordDecisions: Map<string, WordDecision>;
  query: QueryState;
  view: ViewState;
  page: number;
  result: QueryResult | null;
  status: "empty" | "loading" | "ready" | "error";
  errorMessage: string | null;
  persistence: "indexeddb" | "memory";
  review: ReviewState;
  queue: MiningQueueState;
}

export interface FileSource {
  name: string;
  text(): Promise<string>;
}

export interface FolderSource {
  newest(directory: string, extension: string): Promise<FileSource | null>;
}

export interface MinerController {
  subscribe(listener: (state: Readonly<AppState>) => void): () => void;
  importJiten(source: FileSource): Promise<void>;
  importKnown(source: FileSource): Promise<void>;
  updateQuery(patch: Partial<QueryState>): void;
  updateView(patch: Partial<ViewState>): void;
  updateViewport(start: number): void;
  changePage(delta: number): void;
  setWordDecision(normalizedWord: string, status: WordDecisionStatus | "unreviewed"): Promise<void>;
  startReview(): Promise<void>;
  stopReview(): void;
  reviewDecision(status: WordDecisionStatus): Promise<void>;
  toggleQueued(normalizedWord: string): void;
  removeQueued(normalizedWord: string): void;
  clearQueue(): void;
  startQueueMode(): Promise<void>;
  stopQueueMode(): void;
  clearSavedData(): Promise<void>;
  init(): Promise<void>;
}

export const DEFAULT_QUERY: QueryState = {
  search: "",
  hideKnown: false,
  hideKanaOnly: false,
  sentence: "any",
  minOccurrences: 1,
  sort: "occ-desc",
  pageSize: 50,
  page: 1,
  decision: "all",
};

export const DEFAULT_VIEW: ViewState = {
  showFurigana: false,
  pillHighlight: false,
  showHighlight: false,
  showDefinitions: true,
};

export const EMPTY_REVIEW: ReviewState = {
  active: false,
  initialTotal: 0,
  processed: 0,
  remaining: 0,
  current: null,
  status: "idle",
  errorMessage: null,
};

export const EMPTY_QUEUE: MiningQueueState = {
  datasetId: null,
  normalizedWords: [],
  mode: "normal",
};

export function createInitialAppState(
  persistence: AppState["persistence"] = "indexeddb",
): AppState {
  return {
    dataset: null,
    knownWords: new Set<string>(),
    knownWordsName: null,
    wordDecisions: new Map<string, WordDecision>(),
    query: { ...DEFAULT_QUERY },
    view: { ...DEFAULT_VIEW },
    page: 1,
    result: null,
    status: "empty",
    errorMessage: null,
    persistence,
    review: { ...EMPTY_REVIEW },
    queue: { ...EMPTY_QUEUE, normalizedWords: [] },
  };
}

function cloneDataset(value: DatasetMetadata | null): DatasetMetadata | null {
  return value === null ? null : { ...value, headers: [...value.headers] };
}

function cloneQuery(value: QueryState): QueryState {
  return { ...value };
}

function cloneView(value: ViewState): ViewState {
  return { ...value };
}

function cloneResult(value: QueryResult | null): QueryResult | null {
  return value === null ? null : { ...value, items: [...value.items] };
}

function cloneReview(value: ReviewState): ReviewState {
  return { ...value };
}

function cloneQueue(value: MiningQueueState): MiningQueueState {
  return { ...value, normalizedWords: [...value.normalizedWords] };
}

export function cloneAppState(value: AppState): AppState {
  return {
    ...value,
    dataset: cloneDataset(value.dataset),
    knownWords: new Set(value.knownWords),
    wordDecisions: new Map(value.wordDecisions),
    query: cloneQuery(value.query),
    view: cloneView(value.view),
    result: cloneResult(value.result),
    review: cloneReview(value.review),
    queue: cloneQueue(value.queue),
  };
}

export function snapshotAppState(value: AppState): Readonly<AppState> {
  const snapshot = cloneAppState(value);
  Object.freeze(snapshot.query);
  Object.freeze(snapshot.view);
  Object.freeze(snapshot.review);
  Object.freeze(snapshot.queue);
  if (snapshot.result !== null) Object.freeze(snapshot.result);
  Object.freeze(snapshot);
  return snapshot;
}
