import type { AnkiDeckScope, AnkiSyncConfig } from "../domain/anki";
import type {
  CoverageStats,
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

export interface UndoState {
  available: boolean;
  label: string | null;
}

export type AnkiUiStatus = "idle" | "connecting" | "syncing" | "preview" | "error";

export interface AnkiUiState {
  configured: boolean;
  status: AnkiUiStatus;
  lastSyncedAt: string | null;
  wordCount: number;
  knownCount: number;
  minedCount: number;
  deckScopeKind: AnkiDeckScope["kind"] | null;
  deckScopeLabel: string | null;
  noteType: string | null;
  targetField: string | null;
  errorMessage: string | null;
}

export interface AnkiPreviewState {
  scannedCards: number;
  uniqueWords: number;
  matchedWords: number | null;
  knownCount: number | null;
  minedCount: number | null;
  manualProtected: number | null;
  emptyTargetFields: number;
  queueRemovals: number;
  zeroCards: boolean;
  datasetAvailable: boolean;
}

export interface AppState {
  dataset: DatasetMetadata | null;
  knownWords: Set<string>;
  knownWordsName: string | null;
  wordDecisions: Map<string, WordDecision>;
  query: QueryState;
  view: ViewState;
  // Pagination lives solely in query.page; there is deliberately no
  // AppState.page duplicate to keep in sync.
  result: QueryResult | null;
  status: "empty" | "loading" | "ready" | "error";
  errorMessage: string | null;
  persistence: "indexeddb" | "memory";
  review: ReviewState;
  queue: MiningQueueState;
  undo: UndoState;
  coverage: CoverageStats | null;
  coverageStatus: "idle" | "loading" | "ready" | "error";
  coverageErrorMessage: string | null;
  anki: AnkiUiState;
  ankiPreview: AnkiPreviewState | null;
  // Session-only backup freshness signal (never persisted, never in backups):
  // when the last exportBackup() of THIS session ran, and how many counted
  // user-state mutations have landed since.
  lastExportAt: string | null;
  changesSinceExport: number;
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
  undoLastDecision(): Promise<void>;
  startReview(): Promise<void>;
  stopReview(): void;
  reviewDecision(status: WordDecisionStatus): Promise<void>;
  toggleQueued(normalizedWord: string): void;
  removeQueued(normalizedWord: string): void;
  clearQueue(): void;
  startQueueMode(): Promise<void>;
  stopQueueMode(): void;
  exportBackup(): Promise<string>;
  restoreBackup(text: string): Promise<void>;
  clearSavedData(): Promise<void>;
  connectAnki(): Promise<{ decks: string[]; models: string[] }>;
  loadAnkiModelFields(noteType: string): Promise<string[]>;
  validateAndSaveAnkiConfig(config: AnkiSyncConfig): Promise<void>;
  previewAnkiSync(): Promise<void>;
  applyAnkiSync(): Promise<void>;
  cancelAnkiSyncPreview(): void;
  clearAnkiSyncData(): Promise<void>;
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
  // Reading display preferences: the defaults must leave the current look
  // byte-unchanged (no body class, no CSS override).
  sentenceSize: "medium",
  density: "comfortable",
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

export const EMPTY_UNDO: UndoState = {
  available: false,
  label: null,
};

export const EMPTY_ANKI: AnkiUiState = {
  configured: false,
  status: "idle",
  lastSyncedAt: null,
  wordCount: 0,
  knownCount: 0,
  minedCount: 0,
  deckScopeKind: null,
  deckScopeLabel: null,
  noteType: null,
  targetField: null,
  errorMessage: null,
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
    result: null,
    status: "empty",
    errorMessage: null,
    persistence,
    review: { ...EMPTY_REVIEW },
    queue: { ...EMPTY_QUEUE, normalizedWords: [] },
    undo: { ...EMPTY_UNDO },
    coverage: null,
    coverageStatus: "idle",
    coverageErrorMessage: null,
    anki: { ...EMPTY_ANKI },
    ankiPreview: null,
    lastExportAt: null,
    changesSinceExport: 0,
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

// Entry-level isolation: furiganaRuns are mutable objects shared between the
// controller's entry instances and any published snapshot. Cloning them (and
// the entry shell) keeps subscriber mutations from reaching controller state.
export function cloneEntryWithKnown(value: EntryWithKnown): EntryWithKnown {
  return {
    ...value,
    furiganaRuns: value.furiganaRuns.map((run) => ({ ...run })),
  };
}

function cloneResult(value: QueryResult | null): QueryResult | null {
  return value === null ? null : { ...value, items: value.items.map(cloneEntryWithKnown) };
}

function cloneWordDecisions(value: ReadonlyMap<string, WordDecision>): Map<string, WordDecision> {
  return new Map([...value].map(([word, decision]) => [word, { ...decision }]));
}

function cloneReview(value: ReviewState): ReviewState {
  return {
    ...value,
    current: value.current === null ? null : cloneEntryWithKnown(value.current),
  };
}

function cloneQueue(value: MiningQueueState): MiningQueueState {
  return { ...value, normalizedWords: [...value.normalizedWords] };
}

function cloneUndo(value: UndoState): UndoState {
  return { ...value };
}

function cloneCoverage(value: CoverageStats | null): CoverageStats | null {
  return value === null
    ? null
    : { ...value, targets: value.targets.map((target) => ({ ...target })) };
}

function cloneAnki(value: AnkiUiState): AnkiUiState {
  return { ...value };
}

function cloneAnkiPreview(value: AnkiPreviewState | null): AnkiPreviewState | null {
  return value === null ? null : { ...value };
}

export function cloneAppState(value: AppState): AppState {
  return {
    ...value,
    dataset: cloneDataset(value.dataset),
    knownWords: new Set(value.knownWords),
    wordDecisions: cloneWordDecisions(value.wordDecisions),
    query: cloneQuery(value.query),
    view: cloneView(value.view),
    result: cloneResult(value.result),
    review: cloneReview(value.review),
    queue: cloneQueue(value.queue),
    undo: cloneUndo(value.undo),
    coverage: cloneCoverage(value.coverage),
    anki: cloneAnki(value.anki),
    ankiPreview: cloneAnkiPreview(value.ankiPreview),
  };
}

export function snapshotAppState(value: AppState): Readonly<AppState> {
  const snapshot = cloneAppState(value);
  Object.freeze(snapshot.query);
  Object.freeze(snapshot.view);
  Object.freeze(snapshot.review);
  Object.freeze(snapshot.queue);
  Object.freeze(snapshot.undo);
  if (snapshot.result !== null) Object.freeze(snapshot.result);
  if (snapshot.coverage !== null) Object.freeze(snapshot.coverage);
  Object.freeze(snapshot);
  return snapshot;
}
