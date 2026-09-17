import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../domain/anki";
import type { Entry, QueryState, ViewState, WordDecision } from "../domain/types";
import type { DatasetMetadata } from "../storage/contracts";

export type PreferencesValue = { query: QueryState; view: ViewState; page: number };

export interface SessionQueueSnapshot {
  version: 1;
  datasetId: string;
  normalizedWords: string[];
}

export type SyncMutationKind =
  | "dataset.upload"
  | "dataset.remove"
  | "dataset.activate"
  | "known.replace"
  | "decision.set"
  | "decision.remove"
  | "preferences.replace"
  | "queue.replace"
  | "queue.remove"
  | "anki.replace";

export interface CloudBootstrapManifest {
  eventId: number;
  activeDatasetId: string | null;
  datasets: DatasetMetadata[];
}

export type MaterializedSyncMutation =
  | { mutationId: string; kind: "dataset.remove"; datasetId: string }
  | { mutationId: string; kind: "dataset.activate"; datasetId: string | null }
  | {
      mutationId: string;
      kind: "known.replace";
      value: { id: string; name: string; words: string[] } | null;
    }
  | { mutationId: string; kind: "decision.set"; decision: WordDecision }
  | { mutationId: string; kind: "decision.remove"; normalizedWord: string }
  | { mutationId: string; kind: "preferences.replace"; value: PreferencesValue }
  | { mutationId: string; kind: "queue.replace"; value: SessionQueueSnapshot }
  | { mutationId: string; kind: "queue.remove"; datasetId: string }
  | {
      mutationId: string;
      kind: "anki.replace";
      config: AnkiSyncConfig | null;
      snapshot: AnkiSyncSnapshot | null;
    };

export type RemoteChange =
  | { id: number; kind: "dataset.upsert"; dataset: DatasetMetadata }
  | { id: number; kind: "dataset.remove"; datasetId: string }
  | { id: number; kind: "dataset.activate"; datasetId: string | null }
  | { id: number; kind: "known.replace" }
  | { id: number; kind: "decision.set"; decision: WordDecision }
  | { id: number; kind: "decision.remove"; normalizedWord: string }
  | { id: number; kind: "preferences.replace"; value: PreferencesValue }
  | { id: number; kind: "queue.replace"; datasetId: string }
  | { id: number; kind: "queue.remove"; datasetId: string }
  | { id: number; kind: "anki.replace" }
  | { id: number; kind: "full-reset" };

export interface SyncPullPage {
  changes: RemoteChange[];
  nextEventId: number;
}

export interface AcceptedMutationReceipt {
  mutationId: string;
  eventId: number | null;
}

export interface SyncPushReceipt {
  accepted: AcceptedMutationReceipt[];
  acceptedMutationIds: string[];
}

export interface CloudSyncPort {
  bootstrap(): Promise<CloudBootstrapManifest>;
  readKnownWords(): Promise<{ id: string; name: string; words: string[] } | null>;
  readDecisions(): Promise<WordDecision[]>;
  readPreferences(): Promise<PreferencesValue | null>;
  readQueues(): Promise<SessionQueueSnapshot[]>;
  readAnki(): Promise<{ config: AnkiSyncConfig | null; snapshot: AnkiSyncSnapshot | null }>;
  pull(afterEventId: number, limit?: number): Promise<SyncPullPage>;
  push(deviceId: string, mutations: readonly MaterializedSyncMutation[]): Promise<SyncPushReceipt>;
  uploadDataset(
    deviceId: string,
    mutationId: string,
    metadata: DatasetMetadata,
    chunks: AsyncIterable<readonly Entry[]>,
  ): Promise<SyncPushReceipt>;
  readDataset(datasetId: string, chunkSize: number): AsyncIterable<Entry[]>;
}
