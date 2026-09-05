import type { QueryResult, QueryState, ViewState } from "../domain/types";
import type { DatasetMetadata } from "../storage/contracts";

export interface AppState {
  dataset: DatasetMetadata | null;
  knownWords: Set<string>;
  knownWordsName: string | null;
  query: QueryState;
  view: ViewState;
  page: number;
  result: QueryResult | null;
  status: "empty" | "loading" | "ready" | "error";
  errorMessage: string | null;
  persistence: "indexeddb" | "memory";
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

export function createInitialAppState(
  persistence: AppState["persistence"] = "indexeddb",
): AppState {
  return {
    dataset: null,
    knownWords: new Set<string>(),
    knownWordsName: null,
    query: { ...DEFAULT_QUERY },
    view: { ...DEFAULT_VIEW },
    page: 1,
    result: null,
    status: "empty",
    errorMessage: null,
    persistence,
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

export function cloneAppState(value: AppState): AppState {
  return {
    ...value,
    dataset: cloneDataset(value.dataset),
    knownWords: new Set(value.knownWords),
    query: cloneQuery(value.query),
    view: cloneView(value.view),
    result: cloneResult(value.result),
  };
}

export function snapshotAppState(value: AppState): Readonly<AppState> {
  const snapshot = cloneAppState(value);
  Object.freeze(snapshot.query);
  Object.freeze(snapshot.view);
  if (snapshot.result !== null) Object.freeze(snapshot.result);
  Object.freeze(snapshot);
  return snapshot;
}
