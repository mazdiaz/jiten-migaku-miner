import type {
  Entry,
  EntryWithKnown,
  QueryResult,
  QueryState,
  ViewState,
  WordDecision,
  WordDecisionStatus,
} from "../domain/types";
import { normalizeText } from "../domain/text";
import { createSessionQueueStore, type SessionQueueStore } from "../platform/session-queue";
import { createIndexedDbAppStore } from "../storage/indexed-db";
import { createMemoryAppStore } from "../storage/memory-store";
import { clearLegacyData } from "../storage/legacy";
import type { AppStore, DatasetMetadata } from "../storage/contracts";
import { migrateLegacy } from "./migrate-legacy";
import {
  createInitialAppState,
  cloneAppState,
  snapshotAppState,
  DEFAULT_QUERY,
  EMPTY_REVIEW,
  type AppState,
  type FileSource,
  type MinerController,
} from "./state";
import {
  createWorkerClient,
  type JitenImportChunk,
  type KnownImportChunk,
  type WorkerClient,
} from "./worker-client";

export interface MinerControllerOptions {
  store?: AppStore;
  indexedDbStoreFactory?: () => AppStore;
  worker?: WorkerClient;
  legacyStorage?: Storage | null;
  sessionQueueStore?: SessionQueueStore;
  now?: () => string;
  createId?: (kind: "dataset" | "known") => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
const QUEUE_SAFETY_THRESHOLD = 5_000;

function orderByQueue(items: readonly EntryWithKnown[], queue: readonly string[]): EntryWithKnown[] {
  const order = new Map(queue.map((word, index) => [word, index]));
  return [...items].sort((left, right) =>
    (order.get(left.normalizedWord) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.normalizedWord) ?? Number.MAX_SAFE_INTEGER) ||
    left.originalIndex - right.originalIndex,
  );
}

async function* copiedEntryChunks(chunks: readonly Entry[][]): AsyncIterable<readonly Entry[]> {
  for (const chunk of chunks) yield chunk;
}

interface ImportSnapshot {
  state: AppState;
}

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
  private importLock: Promise<unknown> = Promise.resolve();
  private reviewBusy = false;
  private decisionLock: Promise<unknown> = Promise.resolve();

  constructor(options: MinerControllerOptions) {
    this.storeWasProvided = options.store !== undefined;
    this.store = options.store ?? (options.indexedDbStoreFactory ?? (() => createIndexedDbAppStore()))();
    this.indexedDbStoreFactory = options.indexedDbStoreFactory ?? (() => createIndexedDbAppStore());
    this.worker = options.worker ?? createWorkerClient();
    this.legacyStorage = options.legacyStorage === undefined ? defaultLegacyStorage() : options.legacyStorage;
    this.sessionQueue = options.sessionQueueStore ?? createSessionQueueStore();
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? defaultId;
    this.state = createInitialAppState(this.storeWasProvided ? "memory" : "indexeddb");
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
      const complete = await this.worker.importJiten(source.name, text, (chunk: JitenImportChunk) => {
        chunks.push(chunk.entries);
      });
      if (generation !== this.importGeneration) return;
      const receivedCount = chunks.reduce((count, chunk) => count + chunk.length, 0);
      if (receivedCount !== complete.entryCount) {
        throw new Error(`Jiten import count did not match worker output: expected ${complete.entryCount}, found ${receivedCount}`);
      }

      const dataset = this.datasetMetadata(
        this.createId("dataset"),
        source.name,
        complete.headers,
        complete.entryCount,
      );
      stagedDataset = dataset;
      await this.storageOperation((store) => store.datasets.stage(dataset, copiedEntryChunks(chunks)));
      if (generation !== this.importGeneration) {
        this.mergeWarning(await this.removeStagedDataset(dataset.id));
        return;
      }

      const staged = await this.readDatasetChunks(dataset.id);
      if (staged.entryCount !== dataset.entryCount) {
        throw new Error(`Staged dataset entry count did not match metadata: expected ${dataset.entryCount}, found ${staged.entryCount}`);
      }
      await this.worker.loadDataset(dataset.id, copiedEntryChunks(staged.values));
      const candidateWindow = this.state.query.pageSize === "all"
        ? { start: 0, size: VIEWPORT_WINDOW_SIZE }
        : undefined;
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
      committed = await this.withImportLock(async () => {
        await this.activateAndVerify(dataset);
        if (generation !== this.importGeneration) return false;
        this.state.dataset = dataset;
        this.state.page = 1;
        this.state.query = { ...this.state.query, page: 1 };
        this.state.result = candidateResult;
        // A newly activated dataset starts with a fresh queue association.
        this.state.queue = { datasetId: dataset.id, normalizedWords: [], mode: "normal" };
        this.sessionQueue.clear();
        this.viewportStart = 0;
        this.queryGeneration += 1;
        this.setState({ status: "ready", errorMessage: this.warningMessage });
        await this.persistPreferences();
        return true;
      });
      if (committed) {
        await this.runQuery();
        return;
      }

      await this.withImportLock(() => this.rollbackActivation(dataset.id, previous.state.dataset));
      this.mergeWarning(await this.removeStagedDataset(dataset.id));
    } catch (error) {
      if (activationAttempted) {
        try {
          await this.withImportLock(() => this.rollbackActivation(stagedDataset!.id, previous.state.dataset));
        } catch {
          // The primary import error remains the actionable failure.
        }
      }
      const cleanupWarning = stagedDataset === null ? null : await this.removeStagedDataset(stagedDataset.id);
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
      const message = cleanupWarning === null ? errorMessage(error) : `${errorMessage(error)} ${cleanupWarning}`;
      this.setState({ status: "error", errorMessage: message });
    }
  }

  async importKnown(source: FileSource): Promise<void> {
    const generation = ++this.importGeneration;
    this.setState({ status: "loading", errorMessage: null });

    try {
      const text = await source.text();
      const chunks: string[][] = [];
      const complete = await this.worker.importKnown(source.name, text, (chunk: KnownImportChunk) => {
        chunks.push(chunk.words);
      });
      if (generation !== this.importGeneration) return;

      const words = new Set<string>();
      for (const chunk of chunks) for (const word of chunk) words.add(word);
      if (words.size !== complete.wordCount) throw new Error("Known-word import count did not match worker output");
      const knownId = this.createId("known");
      const saved = await this.withImportLock(async () => {
        if (generation !== this.importGeneration) return false;
        const previousKnown = await this.storageOperation((store) => store.knownWords.getActive());
        await this.storageOperation((store) => store.knownWords.save(knownId, source.name, words));
        try {
          const activeKnown = await this.storageOperation((store) => store.knownWords.getActive());
          if (
            activeKnown === null ||
            activeKnown.id !== knownId ||
            activeKnown.words.size !== words.size ||
            [...words].some((word) => !activeKnown.words.has(word))
          ) {
            throw new Error("Known-word import verification failed: saved words differ from the imported set");
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
        this.state.page = 1;
        this.state.result = null;
        this.setState({ status: this.state.dataset === null ? "empty" : "loading", errorMessage: this.warningMessage });
        return true;
      });
      if (!saved) return;
      await this.runQuery();
    } catch (error) {
      if (generation !== this.importGeneration) return;
      this.setState({ status: "error", errorMessage: errorMessage(error) });
    }
  }

  updateQuery(patch: Partial<QueryState>): void {
    const page = patch.page === undefined ? 1 : patch.page;
    this.state.query = { ...this.state.query, ...patch, page };
    this.state.page = page;
    this.viewportStart = 0;
    this.setState({ status: this.state.dataset === null ? "empty" : "loading", errorMessage: this.warningMessage });
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
    const currentPage = this.state.page > 0 ? this.state.page : 1;
    const nextPage = Math.min(Math.max(1, totalPages), Math.max(1, currentPage + numericDelta));
    if (nextPage === currentPage) return;

    this.state.page = nextPage;
    this.state.query = { ...this.state.query, page: nextPage };
    this.setState({ status: this.state.dataset === null ? "empty" : "loading", errorMessage: this.warningMessage });
    void this.runQuery();
  }

  async setWordDecision(normalizedWord: string, status: WordDecisionStatus | "unreviewed"): Promise<void> {
    const normalized = normalizeText(normalizedWord).toLocaleLowerCase();
    if (normalized.length === 0) {
      throw new Error("Word decision requires a non-empty normalized word");
    }
    const write = this.decisionLock.then(
      () => this.applyWordDecision(normalized, status).catch((error: unknown) => {
        this.setState({ errorMessage: `Word decision could not be saved: ${errorMessage(error)}` });
      }),
      () => this.applyWordDecision(normalized, status).catch((error: unknown) => {
        this.setState({ errorMessage: `Word decision could not be saved: ${errorMessage(error)}` });
      }),
    );
    this.decisionLock = write.then(() => undefined, () => undefined);
    await write;
  }

  async startReview(): Promise<void> {
    if (this.state.review.active || this.state.dataset === null) return;
    this.state.review = { ...EMPTY_REVIEW, active: true, status: "loading" };
    this.publish();
    await this.runReviewQuery({ captureInitial: true });
  }

  stopReview(): void {
    if (!this.state.review.active) return;
    this.state.review = { ...EMPTY_REVIEW };
    this.publish();
  }

  async reviewDecision(status: WordDecisionStatus): Promise<void> {
    const review = this.state.review;
    if (!review.active || review.status !== "ready" || review.current === null || this.reviewBusy) return;
    const word = review.current.normalizedWord;
    this.reviewBusy = true;
    this.state.review = { ...review, status: "loading", errorMessage: null };
    this.publish();

    const write = this.decisionLock.then(
      () => this.applyWordDecision(word, status),
      () => this.applyWordDecision(word, status),
    );
    this.decisionLock = write.then(() => undefined, () => undefined);
    try {
      await write;
      if (!this.state.review.active) return;
      this.state.review = {
        ...this.state.review,
        processed: this.state.review.processed + 1,
        status: "loading",
      };
      this.publish();
      await this.runReviewQuery();
    } catch (error) {
      if (!this.state.review.active) return;
      this.state.review = {
        ...this.state.review,
        status: this.state.review.current === null ? "complete" : "ready",
        errorMessage: `Word decision could not be saved: ${errorMessage(error)}`,
      };
      this.publish();
    } finally {
      this.reviewBusy = false;
    }
  }

  toggleQueued(normalizedWord: string): void {
    const dataset = this.state.dataset;
    if (dataset === null) return;
    const word = normalizeText(normalizedWord).toLocaleLowerCase();
    if (word.length === 0) return;
    const words = this.state.queue.normalizedWords;
    // Adding an already-queued word leaves the queue unchanged; removal is a
    // separate explicit action.
    if (words.includes(word)) return;
    this.setQueueWords(dataset.id, [...words, word]);
  }

  removeQueued(normalizedWord: string): void {
    const dataset = this.state.dataset;
    if (dataset === null) return;
    const word = normalizeText(normalizedWord).toLocaleLowerCase();
    this.setQueueWords(dataset.id, this.state.queue.normalizedWords.filter((queued) => queued !== word));
  }  clearQueue(): void {
    const dataset = this.state.dataset;
    if (dataset === null) return;
    this.setQueueWords(dataset.id, []);
  }

  async startQueueMode(): Promise<void> {
    const dataset = this.state.dataset;
    if (dataset === null || this.state.queue.mode === "queue") return;
    // An empty queue cannot enter mining mode.
    if (this.state.queue.normalizedWords.length === 0) return;
    this.state.queue = { ...this.state.queue, mode: "queue" };
    this.publish();
    await this.runQueueQuery();
  }

  stopQueueMode(): void {
    if (this.state.queue.mode !== "queue") return;
    this.state.queue = { ...this.state.queue, mode: "normal" };
    this.publish();
    void this.runQuery();
  }

  async clearSavedData(): Promise<void> {
    this.importGeneration += 1;
    this.queryGeneration += 1;
    await this.storageOperation((store) => store.clearAll());
    if (this.persistentStore !== null) {
      try {
        await this.persistentStore.clearAll();
      } catch (error) {
        this.setWarning(`Saved data could not be cleared from persistent storage: ${errorMessage(error)}`);
      }
    }
    if (this.legacyStorage !== null) {
      try {
        clearLegacyData(this.legacyStorage);
      } catch (error) {
        this.setWarning(`Legacy saved data could not be cleared: ${errorMessage(error)}`);
      }
    }
    this.worker.dispose();
    this.sessionQueue.clear();
    this.state = createInitialAppState(this.state.persistence);
    this.warningMessage = this.fallbackWarning;
    this.state.errorMessage = this.fallbackWarning;
    this.publish();
  }

  private async initialize(): Promise<void> {
    await this.ensureStorage();

    if (this.legacyStorage !== null) {
      const migrationOptions = () => ({
        storage: this.legacyStorage!,
        store: this.store,
        worker: this.worker,
        query: this.state.query,
        view: this.state.view,
        now: this.now,
        createId: (kind: "media" | "known") => this.createId(kind === "media" ? "dataset" : "known"),
      });
      let migration = await migrateLegacy(migrationOptions());
      if (migration.storageFailure && !this.storeWasProvided && this.state.persistence === "indexeddb") {
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
      [active, known, decisions, preferences] = await this.storageOperation((store) => Promise.all([
        store.datasets.getActive(),
        store.knownWords.getActive(),
        store.wordDecisions.list(),
        store.preferences.load(),
      ]));
    } catch (error) {
      this.setState({ status: "error", errorMessage: errorMessage(error) });
      return;
    }

    if (known !== null) {
      this.state.knownWords = new Set(known.words);
      this.state.knownWordsName = known.name;
    }
    this.state.wordDecisions = new Map(decisions.map((decision) => [decision.normalizedWord, decision]));
    if (preferences !== null) {
      // Preferences written before word decisions lack query.decision; DEFAULT_QUERY fills it as "all".
      this.state.query = { ...DEFAULT_QUERY, ...preferences.query, page: preferences.page };
      this.state.view = { ...preferences.view };
      this.state.page = preferences.page;
    }
    this.state.dataset = active;
    this.restoreQueueSnapshot(active);
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
      await this.switchToMemory(error);
      return operation(this.store);
    }
  }

  private async switchToMemory(error: unknown): Promise<void> {
    if (this.persistentStore === null) this.persistentStore = this.store;
    this.store = createMemoryAppStore();
    this.state.persistence = "memory";
    const message = `IndexedDB unavailable; using memory persistence. ${errorMessage(error)}`;
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
    if (active?.id !== dataset.id) throw new Error(`Dataset activation could not be verified: ${dataset.id}`);
  }

  private async rollbackActivation(datasetId: string, previousDataset: DatasetMetadata | null): Promise<void> {
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
        await this.storageOperation((store) => store.knownWords.save(previous.id, previous.name, previous.words));
      } catch (error) {
        failures.push(`Known-word rollback failed: ${errorMessage(error)}`);
      }
    } else {
      try {
        await this.storageOperation(async (store) => {
          if (store.knownWords.remove === undefined) throw new Error("Known-word store cannot remove records");
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
    this.warningMessage = this.warningMessage === null ? warning : `${this.warningMessage} ${warning}`;
  }

  private withImportLock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.importLock.then(action, action);
    this.importLock = result.then(() => undefined, () => undefined);
    return result;
  }

  private decisionTuples(): Array<[string, WordDecisionStatus]> {
    return [...this.state.wordDecisions.values()].map((decision) => [decision.normalizedWord, decision.status]);
  }

  private setQueueWords(datasetId: string, words: string[]): void {
    this.state.queue = { ...this.state.queue, datasetId, normalizedWords: words };
    this.sessionQueue.save({ version: 1, datasetId, normalizedWords: words });
    this.publish();
    if (this.state.queue.mode === "queue") void this.runQueueQuery();
  }

  private restoreQueueSnapshot(active: DatasetMetadata | null): void {
    if (active === null) return;
    const snapshot = this.sessionQueue.load();
    const words = snapshot !== null && snapshot.datasetId === active.id ? [...snapshot.normalizedWords] : [];
    this.state.queue = { datasetId: active.id, normalizedWords: words, mode: "normal" };
  }

  private async runQueueQuery(): Promise<void> {
    const dataset = this.state.dataset;
    if (dataset === null || this.state.queue.mode !== "queue") return;
    const words = this.state.queue.normalizedWords;
    // Above the safety threshold keep worker paging / the virtual list; the
    // simple path mounts every queued entry ordered by time added.
    const bounded = words.length > QUEUE_SAFETY_THRESHOLD;
    const queueQuery: QueryState = bounded
      ? { ...this.state.query, page: Math.max(1, this.state.page) }
      : { ...this.state.query, pageSize: "all", page: 1 };
    const window = bounded && this.state.query.pageSize === "all"
      ? { start: this.viewportStart, size: VIEWPORT_WINDOW_SIZE }
      : undefined;
    const generation = ++this.queryGeneration;
    try {
      const result = await this.worker.query({
        datasetId: dataset.id,
        knownWords: [...this.state.knownWords],
        decisions: this.decisionTuples(),
        includeNormalizedWords: [...words],
        query: queueQuery,
        queryChannel: "queue",
        ...(window === undefined ? {} : { window }),
      });
      if (generation !== this.queryGeneration || this.state.queue.mode !== "queue") return;
      this.state.result = {
        ...result,
        items: bounded ? result.items : orderByQueue(result.items, words),
      };
      this.setState({ status: "ready", errorMessage: this.warningMessage });
    } catch (error) {
      if (generation !== this.queryGeneration) return;
      this.setState({ status: "error", errorMessage: errorMessage(error) });
    }
  }

  private async runReviewQuery(options: { captureInitial?: boolean } = {}): Promise<void> {
    const dataset = this.state.dataset;
    if (dataset === null || !this.state.review.active) return;
    // Always ask for page 1: after a decision the current entry leaves the
    // unreviewed set, so the first remaining candidate shifts into page 1.
    const reviewQuery: QueryState = {
      ...this.state.query,
      hideKnown: true,
      decision: "unreviewed",
      page: 1,
      pageSize: 1,
    };
    try {
      const result = await this.worker.query({
        datasetId: dataset.id,
        knownWords: [...this.state.knownWords],
        decisions: this.decisionTuples(),
        query: reviewQuery,
        queryChannel: "review",
      });
      if (!this.state.review.active) return;
      const current = result.items[0] ?? null;
      this.state.review = {
        ...this.state.review,
        initialTotal: options.captureInitial ? result.totalEntries : this.state.review.initialTotal,
        remaining: result.totalEntries,
        current,
        status: current === null ? "complete" : "ready",
        errorMessage: null,
      };
      this.publish();
    } catch (error) {
      if (!this.state.review.active) return;
      this.state.review = {
        ...this.state.review,
        status: "error",
        errorMessage: errorMessage(error),
      };
      this.publish();
    }
  }

  private async applyWordDecision(normalizedWord: string, status: WordDecisionStatus | "unreviewed"): Promise<void> {
    if (status === "unreviewed") {
      await this.storageOperation((store) => store.wordDecisions.remove(normalizedWord));
      this.state.wordDecisions.delete(normalizedWord);
    } else {
      const decision: WordDecision = { normalizedWord, status, updatedAt: this.now() };
      await this.storageOperation((store) => store.wordDecisions.set(decision));
      this.state.wordDecisions.set(normalizedWord, decision);
    }
    // A successful decision removes the word from the mining queue; a failed
    // write leaves the queue untouched so the word can be retried.
    const queueDatasetId = this.state.queue.datasetId;
    if (queueDatasetId !== null && this.state.queue.normalizedWords.includes(normalizedWord)) {
      const remaining = this.state.queue.normalizedWords.filter((queued) => queued !== normalizedWord);
      this.state.queue = { ...this.state.queue, normalizedWords: remaining };
      this.sessionQueue.save({ version: 1, datasetId: queueDatasetId, normalizedWords: remaining });
    }
    this.publish();
    if (this.state.queue.mode === "queue") await this.runQueueQuery();
    else await this.runQuery();
  }

  private async loadAndQuery(datasetId: string, expectedEntryCount: number): Promise<void> {
    try {
      const loaded = await this.readDatasetChunks(datasetId);
      if (loaded.entryCount !== expectedEntryCount) {
        throw new Error(`Dataset entry count did not match metadata: expected ${expectedEntryCount}, found ${loaded.entryCount}`);
      }
      await this.worker.loadDataset(datasetId, copiedEntryChunks(loaded.values));
      await this.runQuery();
    } catch (error) {
      this.setState({ status: "error", errorMessage: errorMessage(error) });
    }
  }

  private async runQuery(options: { silent?: boolean } = {}): Promise<void> {
    const dataset = this.state.dataset;
    if (dataset === null) {
      this.setState({ status: "empty", errorMessage: this.warningMessage });
      await this.persistPreferences();
      return;
    }

    const window = this.state.query.pageSize === "all"
      ? { start: this.viewportStart, size: VIEWPORT_WINDOW_SIZE }
      : undefined;
    const generation = ++this.queryGeneration;
    try {
      const result = await this.worker.query({
        datasetId: dataset.id,
        knownWords: [...this.state.knownWords],
        decisions: this.decisionTuples(),
        query: { ...this.state.query, page: this.state.page },
        queryChannel: "user",
        ...(window === undefined ? {} : { window }),
      });
      if (generation !== this.queryGeneration) return;
      this.state.result = result;
      if (result.windowed) this.viewportStart = Math.max(0, result.startIndex - 1);
      const page = result.page > 0 ? result.page : 1;
      this.state.page = page;
      this.state.query = { ...this.state.query, page };
      this.setState({ status: "ready", errorMessage: this.warningMessage });
      if (!options.silent) await this.persistPreferences();
    } catch (error) {
      if (generation !== this.queryGeneration) return;
      this.setState({ status: "error", errorMessage: errorMessage(error) });
    }
  }

  private async persistPreferences(): Promise<void> {
    try {
      await this.storageOperation((store) => store.preferences.save({
        query: { ...this.state.query, page: this.state.page },
        view: { ...this.state.view },
        page: this.state.page,
      }));
    } catch (error) {
      this.setState({ errorMessage: `Preferences could not be saved: ${errorMessage(error)}` });
    }
  }

  private async readDatasetChunks(datasetId: string): Promise<{ values: Entry[][]; entryCount: number }> {
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
