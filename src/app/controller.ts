import type {
  Entry,
  QueryResult,
  QueryState,
  ViewState,
  WordDecision,
  WordDecisionStatus,
} from "../domain/types";
import { createSessionQueueStore, type SessionQueueStore } from "../platform/session-queue";
import type { AppStore, DatasetMetadata } from "../storage/contracts";
import { isStorageUnavailableError } from "../storage/fallback";
import { createIndexedDbAppStore } from "../storage/indexed-db";
import { clearLegacyData } from "../storage/legacy";
import { createMemoryAppStore } from "../storage/memory-store";
import { migrateLegacy } from "./migrate-legacy";
import { BackupService, MAX_BACKUP_BYTES } from "./services/backup-service";
import { type ControllerCore, errorMessage } from "./services/context";
import { CoverageService } from "./services/coverage-service";
import { DecisionService } from "./services/decision-service";
import { MiningQueueService } from "./services/mining-queue-service";
import { ReviewSession } from "./services/review-session";
import {
  type AppState,
  cloneAppState,
  createInitialAppState,
  DEFAULT_QUERY,
  DEFAULT_VIEW,
  type FileSource,
  type MinerController,
  snapshotAppState,
} from "./state";
import {
  createWorkerClient,
  type JitenImportChunk,
  type KnownImportChunk,
  type WorkerClient,
} from "./worker-client";

export { MAX_BACKUP_BYTES };

export interface MinerControllerOptions {
  store?: AppStore;
  indexedDbStoreFactory?: () => AppStore;
  worker?: WorkerClient;
  legacyStorage?: Storage | null;
  sessionQueueStore?: SessionQueueStore;
  now?: () => string;
  createId?: (kind: "dataset" | "known") => string;
}

function defaultId(kind: "dataset" | "known"): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${kind}-${globalThis.crypto.randomUUID()}`;
  }
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultLegacyStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const VIEWPORT_WINDOW_SIZE = 100;

async function* copiedEntryChunks(chunks: readonly Entry[][]): AsyncIterable<readonly Entry[]> {
  for (const chunk of chunks) yield chunk;
}

interface ImportSnapshot {
  state: AppState;
}

/**
 * Public façade. Feature logic lives in src/app/services/*:
 * BackupService, CoverageService, DecisionService, MiningQueueService, and
 * ReviewSession. The controller owns the shared infrastructure those
 * services reach through ControllerCore: the AppState, the import/user-state
 * locks, the userStateEpoch, importGeneration, queryGeneration, viewport
 * tracking, persistence of preferences, and the storage fallback.
 *
 * Lock ordering (never violated): import commit sections and clearSavedData
 * nest userStateLock inside importLock; nothing ever acquires importLock
 * while holding userStateLock.
 */
class MinerControllerImpl implements MinerController {
  private store: AppStore;
  private readonly worker: WorkerClient;
  private readonly legacyStorage: Storage | null;
  private readonly sessionQueue: SessionQueueStore;
  private readonly indexedDbStoreFactory: () => AppStore;
  private readonly storeWasProvided: boolean;
  private readonly now: () => string;
  private readonly createId: (kind: "dataset" | "known") => string;
  private readonly listeners = new Set<(state: Readonly<AppState>) => void>();
  private state: AppState;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private queryGeneration = 0;
  private importGeneration = 0;
  private viewportStart = 0;
  private warningMessage: string | null = null;
  private fallbackWarning: string | null = null;
  private persistentStore: AppStore | null = null;
  // Imports hold importLock; user-state mutations hold userStateLock.
  private importLock: Promise<unknown> = Promise.resolve();
  private userStateLock: Promise<unknown> = Promise.resolve();
  private userStateEpoch = 0;
  // Bumped whenever the dataset/user-state identity the coverage stats
  // describe changes (see CoverageService) — owned by CoverageService.
  private readonly coverageService: CoverageService;
  private readonly reviewSession: ReviewSession;
  private readonly queueService: MiningQueueService;
  private readonly decisionService: DecisionService;
  private readonly backupService: BackupService;

  constructor(options: MinerControllerOptions) {
    this.storeWasProvided = options.store !== undefined;
    this.store =
      options.store ?? (options.indexedDbStoreFactory ?? (() => createIndexedDbAppStore()))();
    this.indexedDbStoreFactory = options.indexedDbStoreFactory ?? (() => createIndexedDbAppStore());
    this.worker = options.worker ?? createWorkerClient();
    this.legacyStorage =
      options.legacyStorage === undefined ? defaultLegacyStorage() : options.legacyStorage;
    this.sessionQueue = options.sessionQueueStore ?? createSessionQueueStore();
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? defaultId;
    this.state = createInitialAppState(this.storeWasProvided ? "memory" : "indexeddb");

    const impl = this;
    const core: ControllerCore = {
      worker: this.worker,
      sessionQueue: this.sessionQueue,
      now: this.now,
      createId: this.createId,
      get state() {
        return impl.state;
      },
      publish: () => impl.publish(),
      setState: (patch) => impl.setState(patch),
      storageOperation: (operation) => impl.storageOperation(operation),
      withUserStateLock: (action) => impl.withUserStateLock(action),
      withImportLock: (action) => impl.withImportLock(action),
      getUserStateEpoch: () => impl.userStateEpoch,
      bumpUserStateEpoch: () => {
        impl.userStateEpoch += 1;
      },
      bumpQueryGeneration: () => {
        impl.queryGeneration += 1;
        return impl.queryGeneration;
      },
      getQueryGeneration: () => impl.queryGeneration,
      invalidateQueries: () => {
        impl.queryGeneration += 1;
      },
      getWarningMessage: () => impl.warningMessage,
      getViewportStart: () => impl.viewportStart,
      setViewportStart: (value) => {
        impl.viewportStart = value;
      },
      persistPreferencesUnlocked: (triggerEpoch) => impl.persistPreferencesUnlocked(triggerEpoch),
      runQuery: (options) => impl.runQuery(options),
      loadAndQuery: (datasetId, expectedEntryCount, options) =>
        impl.loadAndQuery(datasetId, expectedEntryCount, options),
      decisionTuples: () => impl.decisionTuples(),
      ankiStatusTuples: () => [],
      countChangeSinceExport: () => impl.countChangeSinceExport(),
    };
    this.coverageService = new CoverageService(core);
    this.queueService = new MiningQueueService(core);
    this.decisionService = new DecisionService(core, this.queueService, this.coverageService);
    this.reviewSession = new ReviewSession(core, this.decisionService);
    this.backupService = new BackupService(
      core,
      this.reviewSession,
      this.coverageService,
      this.decisionService,
      this.queueService,
    );
  }

  subscribe(listener: (state: Readonly<AppState>) => void): () => void {
    this.listeners.add(listener);
    listener(snapshotAppState(this.state));
    return () => this.listeners.delete(listener);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing !== null) return this.initializing;

    this.initializing = this.initialize();
    try {
      await this.initializing;
      this.initialized = true;
    } finally {
      this.initializing = null;
    }
  }

  async importJiten(source: FileSource): Promise<void> {
    const generation = ++this.importGeneration;
    const previous: ImportSnapshot = { state: cloneAppState(this.state) };
    let stagedDataset: DatasetMetadata | null = null;
    let candidateResult: QueryResult | null = null;
    let activationAttempted = false;
    let committed = false;
    this.setState({ status: "loading", errorMessage: null });

    try {
      const text = await source.text();
      const chunks: Entry[][] = [];
      const complete = await this.worker.importJiten(
        source.name,
        text,
        (chunk: JitenImportChunk) => {
          chunks.push(chunk.entries);
        },
      );
      if (generation !== this.importGeneration) return;
      const receivedCount = chunks.reduce((count, chunk) => count + chunk.length, 0);
      if (receivedCount !== complete.entryCount) {
        throw new Error(
          `Jiten import count did not match worker output: expected ${complete.entryCount}, found ${receivedCount}`,
        );
      }

      const dataset = this.datasetMetadata(
        this.createId("dataset"),
        source.name,
        complete.headers,
        complete.entryCount,
      );
      stagedDataset = dataset;
      await this.storageOperation((store) =>
        store.datasets.stage(dataset, copiedEntryChunks(chunks)),
      );
      if (generation !== this.importGeneration) {
        this.mergeWarning(await this.removeStagedDataset(dataset.id));
        return;
      }

      const staged = await this.readDatasetChunks(dataset.id);
      if (staged.entryCount !== dataset.entryCount) {
        throw new Error(
          `Staged dataset entry count did not match metadata: expected ${dataset.entryCount}, found ${staged.entryCount}`,
        );
      }
      await this.worker.loadDataset(dataset.id, copiedEntryChunks(staged.values));
      const candidateWindow =
        this.state.query.pageSize === "all" ? { start: 0, size: VIEWPORT_WINDOW_SIZE } : undefined;
      candidateResult = await this.worker.query({
        datasetId: dataset.id,
        knownWords: [...this.state.knownWords],
        decisions: this.decisionTuples(),
        query: { ...this.state.query, page: 1 },
        queryChannel: "candidate",
        ...(candidateWindow === undefined ? {} : { window: candidateWindow }),
      });
      if (generation !== this.importGeneration) {
        this.mergeWarning(await this.removeStagedDataset(dataset.id));
        return;
      }

      activationAttempted = true;
      committed = await this.withImportLock(() =>
        this.withUserStateLock(async () => {
          await this.activateAndVerify(dataset);
          if (generation !== this.importGeneration) return false;
          this.state.dataset = dataset;
          this.state.query = { ...this.state.query, page: 1 };
          this.state.result = candidateResult;
          // A newly activated dataset starts with a fresh queue association.
          this.queueService.beginDataset(dataset.id);
          // The committed dataset change invalidates any pending undo record:
          // its word/queue context belongs to the replaced dataset.
          this.decisionService.clearUndo();
          this.viewportStart = 0;
          this.queryGeneration += 1;
          // Dataset identity changed: stale coverage responses are dead and the
          // old dataset's stats no longer describe the active dataset.
          this.coverageService.reset();
          // The dataset changed; a stale review card must not survive the commit.
          if (this.state.review.active) this.stopReview();
          this.setState({ status: "ready", errorMessage: this.warningMessage });
          // Already inside withUserStateLock: the lock-free form (see site map).
          await this.persistPreferencesUnlocked();
          return true;
        }),
      );
      if (committed) {
        await this.runQuery();
        await this.requestCoverage();
        return;
      }

      await this.withImportLock(() => this.rollbackActivation(dataset.id, previous.state.dataset));
      this.mergeWarning(await this.removeStagedDataset(dataset.id));
    } catch (error) {
      if (activationAttempted) {
        try {
          await this.withImportLock(() =>
            this.rollbackActivation(stagedDataset!.id, previous.state.dataset),
          );
        } catch {
          // The primary import error remains the actionable failure.
        }
      }
      const cleanupWarning =
        stagedDataset === null ? null : await this.removeStagedDataset(stagedDataset.id);
      if (generation !== this.importGeneration) {
        this.mergeWarning(cleanupWarning);
        return;
      }
      if (!committed) {
        if (stagedDataset !== null && this.state.dataset === stagedDataset) {
          this.state.dataset = previous.state.dataset;
        }
        if (candidateResult !== null && this.state.result === candidateResult) {
          this.state.result = previous.state.result;
        }
      }
      const message =
        cleanupWarning === null ? errorMessage(error) : `${errorMessage(error)} ${cleanupWarning}`;
      this.setState({ status: "error", errorMessage: message });
    }
  }

  async importKnown(source: FileSource): Promise<void> {
    const generation = ++this.importGeneration;
    const epoch = this.userStateEpoch;
    this.setState({ status: "loading", errorMessage: null });

    try {
      const text = await source.text();
      const chunks: string[][] = [];
      const complete = await this.worker.importKnown(
        source.name,
        text,
        (chunk: KnownImportChunk) => {
          chunks.push(chunk.words);
        },
      );
      if (generation !== this.importGeneration) return;

      const words = new Set<string>();
      for (const chunk of chunks) for (const word of chunk) words.add(word);
      if (words.size !== complete.wordCount)
        throw new Error("Known-word import count did not match worker output");
      const knownId = this.createId("known");
      const saved = await this.withImportLock(async () => {
        if (generation !== this.importGeneration) return false;
        const epoch = this.userStateEpoch;
        return this.withUserStateLock(async () => {
          if (epoch !== this.userStateEpoch) return false;
          const previousKnown = await this.storageOperation((store) =>
            store.knownWords.getActive(),
          );
          await this.storageOperation((store) =>
            store.knownWords.save(knownId, source.name, words),
          );
          try {
            const activeKnown = await this.storageOperation((store) =>
              store.knownWords.getActive(),
            );
            if (
              activeKnown === null ||
              activeKnown.id !== knownId ||
              activeKnown.words.size !== words.size ||
              [...words].some((word) => !activeKnown.words.has(word))
            ) {
              throw new Error(
                "Known-word import verification failed: saved words differ from the imported set",
              );
            }
          } catch (error) {
            const rollbackWarning = await this.rollbackKnownWords(knownId, previousKnown);
            throw rollbackWarning === null
              ? error
              : new Error(`${errorMessage(error)} ${rollbackWarning}`);
          }

          this.state.knownWords = words;
          this.state.knownWordsName = source.name;
          this.state.query = { ...this.state.query, hideKnown: true, page: 1 };
          this.state.result = null;
          this.setState({
            status: this.state.dataset === null ? "empty" : "loading",
            errorMessage: this.warningMessage,
          });
          return true;
        });
      });
      if (!saved) return;
      // A committed known-word import is a counted change (post-lock, so a
      // stale/superseded import that returned false never lands here).
      this.countChangeSinceExport();
      await this.runQuery();
      await this.requestCoverage();
    } catch (error) {
      if (generation !== this.importGeneration || epoch !== this.userStateEpoch) return;
      this.setState({ status: "error", errorMessage: errorMessage(error) });
    }
  }

  updateQuery(patch: Partial<QueryState>): void {
    const page = patch.page === undefined ? 1 : patch.page;
    this.state.query = { ...this.state.query, ...patch, page };
    this.viewportStart = 0;
    this.setState({
      status: this.state.dataset === null ? "empty" : "loading",
      errorMessage: this.warningMessage,
    });
    void this.runQuery();
  }

  updateViewport(start: number): void {
    if (this.state.dataset === null || this.state.query.pageSize !== "all") return;
    const total = this.state.result?.totalEntries ?? 0;
    const next = Math.min(Math.max(0, Math.trunc(start)), Math.max(0, total - 1));
    if (next === this.viewportStart) return;
    this.viewportStart = next;
    void this.runQuery({ silent: true });
  }

  updateView(patch: Partial<ViewState>): void {
    this.state.view = { ...this.state.view, ...patch };
    this.publish();
    void this.persistPreferences();
  }

  changePage(delta: number): void {
    const numericDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    const totalPages = this.state.result?.totalPages ?? 1;
    const currentPage = this.state.query.page > 0 ? this.state.query.page : 1;
    const nextPage = Math.min(Math.max(1, totalPages), Math.max(1, currentPage + numericDelta));
    if (nextPage === currentPage) return;

    this.state.query = { ...this.state.query, page: nextPage };
    this.setState({
      status: this.state.dataset === null ? "empty" : "loading",
      errorMessage: this.warningMessage,
    });
    void this.runQuery();
  }

  setWordDecision(
    normalizedWord: string,
    status: WordDecisionStatus | "unreviewed",
  ): Promise<void> {
    return this.decisionService.setWordDecision(normalizedWord, status);
  }

  undoLastDecision(): Promise<void> {
    return this.decisionService.undoLastDecision();
  }

  startReview(): Promise<void> {
    return this.reviewSession.start();
  }

  stopReview(): void {
    this.reviewSession.stop();
  }

  reviewDecision(status: WordDecisionStatus): Promise<void> {
    return this.reviewSession.reviewDecision(status);
  }

  toggleQueued(normalizedWord: string): void {
    this.queueService.toggleQueued(normalizedWord);
  }

  removeQueued(normalizedWord: string): void {
    this.queueService.removeQueued(normalizedWord);
  }

  clearQueue(): void {
    this.queueService.clearQueue();
  }

  startQueueMode(): Promise<void> {
    return this.queueService.startQueueMode();
  }

  stopQueueMode(): void {
    this.queueService.stopQueueMode();
  }

  exportBackup(): Promise<string> {
    return this.backupService.exportBackup();
  }

  restoreBackup(text: string): Promise<void> {
    return this.backupService.restoreBackup(text);
  }

  async clearSavedData(): Promise<void> {
    await this.withImportLock(() =>
      this.withUserStateLock(async () => {
        this.userStateEpoch += 1;
        this.importGeneration += 1;
        this.queryGeneration += 1;
        this.reviewSession.invalidate();
        this.coverageService.invalidate();
        const clearFailures: string[] = [];
        try {
          await this.storageOperation((store) => store.clearAll());
        } catch (error) {
          clearFailures.push(`Saved data could not be fully cleared: ${errorMessage(error)}`);
        }
        if (this.persistentStore !== null) {
          try {
            await this.persistentStore.clearAll();
          } catch (error) {
            clearFailures.push(
              `Saved data could not be cleared from persistent storage: ${errorMessage(error)}`,
            );
          }
        }
        if (this.legacyStorage !== null) {
          try {
            clearLegacyData(this.legacyStorage);
          } catch (error) {
            clearFailures.push(`Legacy saved data could not be cleared: ${errorMessage(error)}`);
          }
        }
        this.worker.dispose();
        this.sessionQueue.clear();
        // Fresh initial state nulls lastExportAt and zeroes changesSinceExport:
        // clearing saved data also wipes the export this session referred to.
        this.state = createInitialAppState(this.state.persistence);
        // The service-owned undo record described the cleared world; drop it.
        this.decisionService.clearUndo();
        this.warningMessage =
          [this.fallbackWarning, ...clearFailures]
            .filter((part): part is string => part !== null)
            .join(" ")
            .trim() || null;
        this.state.errorMessage = this.warningMessage;
        this.publish();
      }),
    );
  }

  // Backup freshness (session-only): bump after any logical durable user-state
  // mutation the user would back up for safety. RULING: count decision
  // mutations (applyWordDecision — undo re-applies through the same path, so
  // one undo naturally counts exactly once), known imports, and restores
  // ONLY. Preferences are deliberately excluded: they are in backups but
  // churn on every page/filter/view change, which would inflate the counter
  // without changing what the user backs up. Dataset imports and session
  // queue edits are excluded too — neither is part of a backup.
  private countChangeSinceExport(): void {
    this.state.changesSinceExport += 1;
  }

  private async initialize(): Promise<void> {
    await this.ensureStorage();

    if (this.legacyStorage !== null) {
      const migrationOptions = () => ({
        storage: this.legacyStorage!,
        store: this.store,
        persistentStore: !this.storeWasProvided && this.state.persistence === "indexeddb",
        worker: this.worker,
        query: this.state.query,
        view: this.state.view,
        now: this.now,
        createId: (kind: "media" | "known") =>
          this.createId(kind === "media" ? "dataset" : "known"),
      });
      let migration = await migrateLegacy(migrationOptions());
      if (
        migration.storageFailure &&
        !this.storeWasProvided &&
        this.state.persistence === "indexeddb"
      ) {
        await this.switchToMemory(migration.warning ?? "Legacy migration persistence failed.");
        migration = await migrateLegacy(migrationOptions());
      }
      if (migration.warning !== null) this.setWarning(migration.warning);
    }

    let active: DatasetMetadata | null;
    let known: { id: string; name: string; words: Set<string> } | null;
    let decisions: WordDecision[];
    let preferences: { query: QueryState; view: ViewState; page: number } | null;
    try {
      [active, known, decisions, preferences] = await this.storageOperation((store) =>
        Promise.all([
          store.datasets.getActive(),
          store.knownWords.getActive(),
          store.wordDecisions.list(),
          store.preferences.load(),
        ]),
      );
    } catch (error) {
      this.setState({ status: "error", errorMessage: errorMessage(error) });
      return;
    }

    if (known !== null) {
      this.state.knownWords = new Set(known.words);
      this.state.knownWordsName = known.name;
    }
    this.state.wordDecisions = new Map(
      decisions.map((decision) => [decision.normalizedWord, decision]),
    );
    if (preferences !== null) {
      // Preferences written before word decisions lack query.decision; DEFAULT_QUERY fills it as "all".
      this.state.query = {
        ...DEFAULT_QUERY,
        ...preferences.query,
        page: preferences.page,
      };
      // Same additive fill for the view: records stored before the reading
      // display controls shipped lack sentenceSize/density.
      this.state.view = { ...DEFAULT_VIEW, ...preferences.view };
    }
    this.state.dataset = active;
    this.queueService.restoreSnapshot(active);
    this.publish();

    if (active === null) {
      this.setState({ status: "empty", errorMessage: this.warningMessage });
      await this.persistPreferences();
      return;
    }

    this.setState({ status: "loading", errorMessage: this.warningMessage });
    await this.loadAndQuery(active.id, active.entryCount);
  }

  private async ensureStorage(): Promise<void> {
    if (this.storeWasProvided) return;
    await this.storageOperation((store) => store.datasets.list());
  }

  private async storageOperation<T>(operation: (store: AppStore) => Promise<T>): Promise<T> {
    try {
      return await operation(this.store);
    } catch (error) {
      if (this.storeWasProvided || this.state.persistence !== "indexeddb") throw error;
      // Only a genuinely unavailable/unusable storage backend may trigger
      // the memory fallback. Application/domain invariant failures surface
      // here so a bug or malformed record cannot silently hide behind a
      // store switch (see storage/fallback.ts).
      if (!isStorageUnavailableError(error)) throw error;
      await this.switchToMemory(error);
      return operation(this.store);
    }
  }

  private async switchToMemory(error: unknown): Promise<void> {
    if (this.persistentStore === null) this.persistentStore = this.store;
    const replacement = createMemoryAppStore();
    const transferFailures: string[] = [];
    try {
      if (this.state.knownWords.size > 0) {
        await replacement.knownWords.save(
          this.createId("known"),
          this.state.knownWordsName ?? "Recovered known words",
          this.state.knownWords,
        );
      }
    } catch (transferError) {
      transferFailures.push(`Known-word recovery failed: ${errorMessage(transferError)}`);
    }
    try {
      if (this.state.wordDecisions.size > 0) {
        await replacement.wordDecisions.replaceAll([...this.state.wordDecisions.values()]);
      }
    } catch (transferError) {
      transferFailures.push(`Word-decision recovery failed: ${errorMessage(transferError)}`);
    }
    try {
      await replacement.preferences.save({
        query: { ...this.state.query },
        view: { ...this.state.view },
        page: this.state.query.page,
      });
    } catch {
      // Preferences are non-critical; visible state retains them.
    }

    this.store = replacement;
    this.state.persistence = "memory";
    const message = `IndexedDB unavailable; using memory persistence. ${errorMessage(error)}${
      transferFailures.length > 0 ? ` ${transferFailures.join(" ")}` : ""
    }`;
    this.fallbackWarning = message;
    this.setWarning(message);
  }

  private setWarning(message: string): void {
    this.warningMessage = message;
    this.state.errorMessage = message;
    this.publish();
  }

  private setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener(snapshotAppState(this.state));
  }

  private datasetMetadata(
    id: string,
    sourceName: string,
    headers: readonly string[],
    entryCount: number,
  ): DatasetMetadata {
    const timestamp = this.now();
    return {
      id,
      name: sourceName,
      sourceType: "file",
      sourceName,
      headers: [...headers],
      entryCount,
      createdAt: timestamp,
      updatedAt: timestamp,
      schemaVersion: 1,
    };
  }

  private async activateAndVerify(dataset: DatasetMetadata): Promise<void> {
    await this.storageOperation((store) => store.datasets.activate(dataset.id));
    const active = await this.storageOperation((store) => store.datasets.getActive());
    if (active?.id !== dataset.id)
      throw new Error(`Dataset activation could not be verified: ${dataset.id}`);
  }

  private async rollbackActivation(
    datasetId: string,
    previousDataset: DatasetMetadata | null,
  ): Promise<void> {
    const current = await this.storageOperation((store) => store.datasets.getActive());
    if (current?.id !== datasetId) return;
    if (previousDataset !== null) {
      await this.storageOperation((store) => store.datasets.activate(previousDataset.id));
    }
  }

  private async rollbackKnownWords(
    knownId: string,
    previous: { id: string; name: string; words: Set<string> } | null,
  ): Promise<string | null> {
    const failures: string[] = [];
    if (previous !== null) {
      try {
        await this.storageOperation((store) =>
          store.knownWords.save(previous.id, previous.name, previous.words),
        );
      } catch (error) {
        failures.push(`Known-word rollback failed: ${errorMessage(error)}`);
      }
    } else {
      try {
        await this.storageOperation(async (store) => {
          if (store.knownWords.remove === undefined)
            throw new Error("Known-word store cannot remove records");
          await store.knownWords.remove(knownId);
        });
      } catch (error) {
        failures.push(`Known-word cleanup failed: ${errorMessage(error)}`);
      }
    }
    return failures.length === 0 ? null : failures.join(" ");
  }

  private mergeWarning(warning: string | null): void {
    if (warning === null) return;
    this.warningMessage =
      this.warningMessage === null ? warning : `${this.warningMessage} ${warning}`;
  }

  private withImportLock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.importLock.then(action, action);
    this.importLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private withUserStateLock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.userStateLock.then(action, action);
    this.userStateLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private decisionTuples(): Array<[string, WordDecisionStatus]> {
    return [...this.state.wordDecisions.values()].map((decision) => [
      decision.normalizedWord,
      decision.status,
    ]);
  }

  private async loadAndQuery(
    datasetId: string,
    expectedEntryCount: number,
    options: { callerHoldsUserStateLock?: boolean } = {},
  ): Promise<void> {
    try {
      const loaded = await this.readDatasetChunks(datasetId);
      if (loaded.entryCount !== expectedEntryCount) {
        throw new Error(
          `Dataset entry count did not match metadata: expected ${expectedEntryCount}, found ${loaded.entryCount}`,
        );
      }
      await this.worker.loadDataset(datasetId, copiedEntryChunks(loaded.values));
      await this.runQuery(options);
      await this.requestCoverage();
    } catch (error) {
      this.setState({ status: "error", errorMessage: errorMessage(error) });
    }
  }

  private requestCoverage(): Promise<void> {
    return this.coverageService.request();
  }

  private async runQuery(
    options: { silent?: boolean; callerHoldsUserStateLock?: boolean } = {},
  ): Promise<void> {
    // Single mode-aware dispatch point: every caller becomes queue-aware, so
    // filters/paging/viewport edits during Queue Mode cannot leak unqueued
    // words into the queue view.
    if (this.state.queue.mode === "queue" && this.state.dataset !== null) {
      await this.queueService.runQueueQuery();
      return;
    }
    const dataset = this.state.dataset;
    if (dataset === null) {
      this.setState({ status: "empty", errorMessage: this.warningMessage });
      await this.persistPreferences(options);
      return;
    }

    const window =
      this.state.query.pageSize === "all"
        ? { start: this.viewportStart, size: VIEWPORT_WINDOW_SIZE }
        : undefined;
    const generation = ++this.queryGeneration;
    try {
      const result = await this.worker.query({
        datasetId: dataset.id,
        knownWords: [...this.state.knownWords],
        decisions: this.decisionTuples(),
        query: { ...this.state.query },
        queryChannel: "user",
        ...(window === undefined ? {} : { window }),
      });
      if (generation !== this.queryGeneration) return;
      this.state.result = result;
      if (result.windowed) this.viewportStart = Math.max(0, result.startIndex - 1);
      const page = result.page > 0 ? result.page : 1;
      this.state.query = { ...this.state.query, page };
      this.setState({ status: "ready", errorMessage: this.warningMessage });
      if (!options.silent) await this.persistPreferences(options);
    } catch (error) {
      if (generation !== this.queryGeneration) return;
      this.setState({ status: "error", errorMessage: errorMessage(error) });
    }
  }

  private async persistPreferences(
    options: { callerHoldsUserStateLock?: boolean } = {},
  ): Promise<void> {
    // Capture the epoch BEFORE acquiring the lock: if a clear or restore
    // wins the lock first, this persist was triggered against state that has
    // since been replaced, and the stale write is skipped inside.
    const triggerEpoch = this.userStateEpoch;
    if (options.callerHoldsUserStateLock) {
      await this.persistPreferencesUnlocked(triggerEpoch);
      return;
    }
    await this.withUserStateLock(() => this.persistPreferencesUnlocked(triggerEpoch));
  }

  // Lock-free form for callers already INSIDE withUserStateLock (import
  // commit sections, restoreBackup, and the query paths they drive).
  // withUserStateLock is not reentrant — routing those callers through the
  // public persistPreferences would self-deadlock.
  private async persistPreferencesUnlocked(
    triggerEpoch: number = this.userStateEpoch,
  ): Promise<void> {
    // The epoch cannot change while the caller holds userStateLock, so a
    // mismatch means the trigger snapshot predates a committed clear/restore.
    if (triggerEpoch !== this.userStateEpoch) return;
    const epoch = this.userStateEpoch;
    try {
      await this.storageOperation((store) =>
        store.preferences.save({
          query: { ...this.state.query },
          view: { ...this.state.view },
          page: this.state.query.page,
        }),
      );
    } catch (error) {
      if (epoch !== this.userStateEpoch) return;
      this.setState({ errorMessage: `Preferences could not be saved: ${errorMessage(error)}` });
    }
  }

  private async readDatasetChunks(
    datasetId: string,
  ): Promise<{ values: Entry[][]; entryCount: number }> {
    return this.storageOperation(async (store) => {
      const values: Entry[][] = [];
      let entryCount = 0;
      for await (const chunk of store.datasets.readChunks(datasetId, 2_000)) {
        values.push(chunk);
        entryCount += chunk.length;
      }
      return { values, entryCount };
    });
  }

  private async removeStagedDataset(datasetId: string): Promise<string | null> {
    const warnings: string[] = [];
    try {
      await this.storageOperation((store) => store.datasets.remove(datasetId));
    } catch (error) {
      warnings.push(`Staged dataset cleanup failed: ${errorMessage(error)}`);
    }
    if (this.persistentStore !== null && this.persistentStore !== this.store) {
      try {
        await this.persistentStore.datasets.remove(datasetId);
      } catch (error) {
        warnings.push(`Persistent staged dataset cleanup failed: ${errorMessage(error)}`);
      }
    }
    return warnings.length === 0 ? null : warnings.join(" ");
  }
}

export function createMinerController(options: MinerControllerOptions = {}): MinerController {
  return new MinerControllerImpl(options);
}

export { MinerControllerImpl };
