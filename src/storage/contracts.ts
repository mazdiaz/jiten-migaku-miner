import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../domain/anki";
import type { Entry, QueryState, ViewState, WordDecision } from "../domain/types";

export interface DatasetMetadata {
  id: string;
  name: string;
  sourceType: "file" | "folder" | "future-remote";
  sourceName: string;
  headers: string[];
  entryCount: number;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

export interface DatasetStore {
  stage(metadata: DatasetMetadata, chunks: AsyncIterable<readonly Entry[]>): Promise<void>;
  activate(datasetId: string): Promise<void>;
  getActive(): Promise<DatasetMetadata | null>;
  list(): Promise<DatasetMetadata[]>;
  readChunks(datasetId: string, chunkSize: number): AsyncIterable<Entry[]>;
  remove(datasetId: string): Promise<void>;
}

export interface KnownWordStore {
  save(id: string, name: string, words: Iterable<string>): Promise<void>;
  getActive(): Promise<{ id: string; name: string; words: Set<string> } | null>;
  remove?(id: string): Promise<void> | void;
  clear?(): Promise<void> | void;
}

export interface PreferencesStore {
  load(): Promise<{ query: QueryState; view: ViewState; page: number } | null>;
  save(value: { query: QueryState; view: ViewState; page: number }): Promise<void>;
  clear?(): Promise<void> | void;
}

export interface WordDecisionStore {
  get(normalizedWord: string): Promise<WordDecision | null>;
  list(): Promise<WordDecision[]>;
  set(decision: WordDecision): Promise<void>;
  remove(normalizedWord: string): Promise<void>;
  replaceAll(decisions: readonly WordDecision[]): Promise<void>;
  clear?(): Promise<void> | void;
}

export interface AnkiSyncStore {
  loadConfig(): Promise<AnkiSyncConfig | null>;
  saveConfig(config: AnkiSyncConfig): Promise<void>;
  loadSnapshot(): Promise<AnkiSyncSnapshot | null>;
  replaceSnapshot(snapshot: AnkiSyncSnapshot): Promise<void>;
  clear(): Promise<void> | void;
}

export interface RestoreUserStateSnapshot {
  knownWords: { id: string; name: string; words: Iterable<string> } | null;
  decisions: readonly WordDecision[];
  preferences: { query: QueryState; view: ViewState; page: number };
  ankiSync: { config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null };
}

export interface AppStore {
  datasets: DatasetStore;
  knownWords: KnownWordStore;
  wordDecisions: WordDecisionStore;
  preferences: PreferencesStore;
  ankiSync: AnkiSyncStore;
  clearAll(): Promise<void>;
  restoreUserState?(snapshot: RestoreUserStateSnapshot): Promise<void>;
}
