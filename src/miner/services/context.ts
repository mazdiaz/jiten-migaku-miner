import type { AnkiWordStatus } from "../../domain/anki";
import type { WordDecisionStatus } from "../../domain/types";
import type { SessionQueueStore } from "../../platform/session-queue";
import type { AppStore } from "../../storage/contracts";
import type { AppState } from "../state";
import type { WorkerClient } from "../worker-client";

/**
 * Ports the feature services use to reach controller-owned infrastructure:
 * locks, epochs, query generation, persistence, and the live AppState.
 *
 * Ownership rules (preserve during any refactor):
 * - the controller owns importLock, userStateLock, userStateEpoch,
 *   importGeneration, and queryGeneration;
 * - ReviewSession owns reviewGeneration/reviewBusyGeneration and is
 *   invalidated externally via invalidate();
 * - CoverageService owns coverageGeneration and is invalidated externally
 *   via invalidate();
 * - `state` is always read fresh through the getter: the controller may
 *   replace the AppState object on setState, so services must never cache
 *   the reference across an await.
 */
export interface ControllerCore {
  readonly worker: WorkerClient;
  readonly sessionQueue: SessionQueueStore;
  readonly now: () => string;
  readonly createId: (kind: "dataset" | "known") => string;
  get state(): AppState;
  publish(): void;
  setState(patch: Partial<AppState>): void;
  storageOperation<T>(operation: (store: AppStore) => Promise<T>): Promise<T>;
  withUserStateLock<T>(action: () => Promise<T>): Promise<T>;
  withImportLock<T>(action: () => Promise<T>): Promise<T>;
  getUserStateEpoch(): number;
  /** Bump the user-state epoch, dropping in-flight user-state continuations. */
  bumpUserStateEpoch(): void;
  /** Bump the query generation and return the new value (stale-query gate). */
  bumpQueryGeneration(): number;
  /** Current query generation for stale-response comparison. */
  getQueryGeneration(): number;
  /** Invalidate in-flight user queries (queryGeneration += 1). */
  invalidateQueries(): void;
  /** Session warning (storage fallback, cleanup failures) or null. */
  getWarningMessage(): string | null;
  getViewportStart(): number;
  setViewportStart(value: number): void;
  /** Persistence of the query/view preferences; lock-free form. */
  persistPreferencesUnlocked(triggerEpoch?: number): Promise<void>;
  /** Full query dispatch (mode-aware: normal list vs queue). */
  runQuery(options?: { silent?: boolean; callerHoldsUserStateLock?: boolean }): Promise<void>;
  /** Load the active dataset into the worker and requery (restore path). */
  loadAndQuery(
    datasetId: string,
    expectedEntryCount: number,
    options?: { callerHoldsUserStateLock?: boolean },
  ): Promise<void>;
  decisionTuples(): Array<[string, WordDecisionStatus]>;
  ankiStatusTuples(): Array<[string, AnkiWordStatus]>;
  /** Counted user-state mutation (backup freshness counter). */
  countChangeSinceExport(): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The single undo entry: the decision status and queue membership that
// existed BEFORE the last applied decision. Captured pre-mutation inside
// DecisionService.applyWordDecision; consumed by undoLastDecision (one step
// only).
export interface UndoRecord {
  normalizedWord: string;
  previousStatus: WordDecisionStatus | "unreviewed";
  previousQueueMembership: boolean;
}

export const UNDO_STATUS_LABELS: Record<WordDecisionStatus | "unreviewed", string> = {
  known: "Known",
  mined: "Mined",
  skip: "Skip",
  later: "Later",
  unreviewed: "Unreviewed",
};
