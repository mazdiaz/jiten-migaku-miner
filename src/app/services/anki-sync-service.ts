import {
  type AnkiSyncConfig,
  type AnkiSyncSnapshot,
  type AnkiWordStatus,
  aggregateAnkiStatuses,
  ankiCardStatus,
} from "../../domain/anki";
import type { AnkiSyncBackupSection } from "../../domain/backup";
import { canonicalWord } from "../../domain/text";
import {
  AnkiConnectError,
  type AnkiConnectPort,
  buildAnkiBaseSearch,
} from "../../platform/anki-connect";
import { EMPTY_ANKI } from "../state";
import { type ControllerCore, errorMessage } from "./context";
import type { CoverageService } from "./coverage-service";
import type { DecisionService } from "./decision-service";

export type AnkiSyncServiceErrorCode =
  | "not-configured"
  | "stale-preview"
  | "invalid-config"
  | "scan-failed";

export class AnkiSyncServiceError extends Error {
  constructor(
    public readonly code: AnkiSyncServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnkiSyncServiceError";
  }
}

export function configLabel(config: AnkiSyncConfig | null): string | null {
  if (config === null) return null;
  return config.deckScope.kind === "all-decks" ? "All decks" : config.deckScope.name;
}

function cloneConfig(config: AnkiSyncConfig | null): AnkiSyncConfig | null {
  if (config === null) return null;
  return {
    deckScope:
      config.deckScope.kind === "all-decks"
        ? { kind: "all-decks" }
        : { kind: "deck", name: config.deckScope.name },
    noteType: config.noteType,
    targetField: config.targetField,
  };
}

function sameConfig(left: AnkiSyncConfig | null, right: AnkiSyncConfig): boolean {
  if (left === null || left.noteType !== right.noteType || left.targetField !== right.targetField)
    return false;
  if (left.deckScope.kind === "all-decks") return right.deckScope.kind === "all-decks";
  return right.deckScope.kind === "deck" && left.deckScope.name === right.deckScope.name;
}

function snapshotMap(snapshot: AnkiSyncSnapshot | null): Map<string, AnkiWordStatus> {
  const result = new Map<string, AnkiWordStatus>();
  if (snapshot === null) return result;
  for (const [word, status] of snapshot.statuses) {
    const canonical = canonicalWord(word);
    if (canonical.length === 0) continue;
    if (result.get(canonical) !== "known" || status === "known") result.set(canonical, status);
  }
  return result;
}

function snapshotCounts(snapshot: ReadonlyMap<string, AnkiWordStatus>): {
  wordCount: number;
  knownCount: number;
  minedCount: number;
} {
  let knownCount = 0;
  let minedCount = 0;
  for (const status of snapshot.values()) {
    if (status === "known") knownCount += 1;
    else minedCount += 1;
  }
  return { wordCount: snapshot.size, knownCount, minedCount };
}

function snapshotRecord(
  syncedAt: string | null,
  statuses: ReadonlyMap<string, AnkiWordStatus>,
): AnkiSyncSnapshot | null {
  return syncedAt === null ? null : { syncedAt, statuses: [...statuses] };
}

interface PreviewCandidate {
  statuses: Map<string, AnkiWordStatus>;
  scannedCards: number;
  uniqueWords: number;
  emptyTargetFields: number;
  configRevision: number;
  userStateEpoch: number;
  datasetId: string | null;
  previewGeneration: number;
}

function validConfig(config: AnkiSyncConfig): string | null {
  if (config === null || typeof config !== "object") return "Anki configuration must be an object";
  if (config.deckScope === null || typeof config.deckScope !== "object") {
    return "Anki configuration deck scope is invalid";
  }
  if (
    config.deckScope.kind !== "all-decks" &&
    (config.deckScope.kind !== "deck" ||
      typeof config.deckScope.name !== "string" ||
      config.deckScope.name.trim().length === 0)
  ) {
    return "Anki configuration deck scope is invalid";
  }
  if (typeof config.noteType !== "string" || config.noteType.trim().length === 0) {
    return "Anki configuration note type must be non-empty";
  }
  if (typeof config.targetField !== "string" || config.targetField.trim().length === 0) {
    return "Anki configuration target field must be non-empty";
  }
  return null;
}

export class AnkiSyncService {
  private config: AnkiSyncConfig | null = null;
  private snapshot = new Map<string, AnkiWordStatus>();
  private snapshotSyncedAt: string | null = null;
  private port: AnkiConnectPort | null = null;
  private previewCandidate: PreviewCandidate | null = null;
  private configRevision = 0;
  private previewGeneration = 0;
  private previewAbortController: AbortController | null = null;

  constructor(
    private readonly core: ControllerCore,
    private readonly portFactory: () => AnkiConnectPort,
    readonly decisions: Pick<DecisionService, "clearUndo">,
    readonly coverage: Pick<CoverageService, "request">,
  ) {}

  async initialize(): Promise<void> {
    try {
      const [config, snapshot] = await this.core.storageOperation((store) =>
        Promise.all([store.ankiSync.loadConfig(), store.ankiSync.loadSnapshot()]),
      );
      const nextConfig = cloneConfig(config);
      const nextSnapshot = snapshotMap(snapshot);
      const nextSnapshotSyncedAt = snapshot?.syncedAt ?? null;
      this.config = nextConfig;
      this.snapshot = nextSnapshot;
      this.snapshotSyncedAt = nextSnapshotSyncedAt;
      this.invalidatePreview();
      this.publishSummary("idle", null);
    } catch (error) {
      this.publishError(error);
      throw error;
    }
  }

  async connect(): Promise<{ decks: string[]; models: string[] }> {
    this.setStatus("connecting", null);
    try {
      const port = this.getPort();
      await port.requestPermission();
      const [decks, models] = await Promise.all([port.deckNames(), port.modelNames()]);
      this.publishSummary("idle", null);
      return { decks, models };
    } catch (error) {
      this.publishError(error);
      throw error;
    }
  }

  async loadModelFields(noteType: string): Promise<string[]> {
    try {
      const fields = await this.getPort().modelFieldNames(noteType);
      this.publishSummary("idle", null);
      return fields;
    } catch (error) {
      this.publishError(error);
      throw error;
    }
  }

  async validateAndSaveConfig(config: AnkiSyncConfig): Promise<void> {
    const validationError = validConfig(config);
    if (validationError !== null) {
      const error = new AnkiSyncServiceError("invalid-config", validationError);
      this.publishError(error);
      throw error;
    }

    this.setStatus("connecting", null);
    try {
      const port = this.getPort();
      await port.requestPermission();
      await this.validateConfigAgainstAnki(port, config);

      await this.core.withUserStateLock(async () => {
        const changed = !sameConfig(this.config, config);
        if (changed) {
          await this.core.storageOperation((store) => store.ankiSync.saveConfig(config));
          this.config = cloneConfig(config);
          this.core.countChangeSinceExport();
        }
        this.invalidatePreview();
        this.publishSummary("idle", null);
      });
    } catch (error) {
      this.publishError(error);
      throw error;
    }
  }

  ankiStatusTuples(): Array<[string, AnkiWordStatus]> {
    return [...this.snapshot].map(([word, status]) => [word, status]);
  }

  storageState(): AnkiSyncBackupSection {
    return {
      config: cloneConfig(this.config),
      snapshot:
        this.snapshotSyncedAt === null
          ? null
          : { syncedAt: this.snapshotSyncedAt, statuses: this.ankiStatusTuples() },
    };
  }

  async previewSync(): Promise<void> {
    const config = this.config;
    if (config === null) {
      const error = new AnkiSyncServiceError(
        "not-configured",
        "Anki sync configuration has not been saved",
      );
      this.publishError(error);
      throw error;
    }

    const configRevision = this.configRevision;
    const userStateEpoch = this.core.getUserStateEpoch();
    const datasetId = this.core.state.dataset?.id ?? null;
    const previewGeneration = ++this.previewGeneration;
    this.abortPreview();
    const abortController = new AbortController();
    this.previewAbortController = abortController;
    this.dropPreview();
    this.setStatus("syncing", null);
    try {
      const port = this.getPort();
      await this.awaitPreview(port.requestPermission(), abortController.signal);
      await this.awaitPreview(this.validateConfigAgainstAnki(port, config), abortController.signal);
      const baseSearch = buildAnkiBaseSearch(config);
      const selectedCardIds = [
        ...new Set(await this.awaitPreview(port.findCards(baseSearch), abortController.signal)),
      ];
      const minedCardIds = new Set(
        await this.awaitPreview(
          port.findCards(`${baseSearch} is:new -is:suspended`),
          abortController.signal,
        ),
      );
      const selectedCardIdSet = new Set(selectedCardIds);
      const statuses = new Map<string, AnkiWordStatus>();
      let emptyTargetFields = 0;
      const cards = await this.awaitPreview(
        port.cardsInfo(selectedCardIds),
        abortController.signal,
      );
      const returnedCardIds = new Set<number>();
      for (const card of cards) {
        if (!selectedCardIdSet.has(card.cardId)) {
          throw new AnkiConnectError(
            "protocol-error",
            `cardsInfo returned an unexpected card ID: ${card.cardId}`,
          );
        }
        if (returnedCardIds.has(card.cardId)) {
          throw new AnkiConnectError(
            "protocol-error",
            `cardsInfo returned duplicate card ID: ${card.cardId}`,
          );
        }
        returnedCardIds.add(card.cardId);
        const rawValue = card.fields[config.targetField];
        if (rawValue === undefined) {
          throw new AnkiConnectError(
            "protocol-error",
            `cardsInfo card ${card.cardId} is missing configured field: ${config.targetField}`,
          );
        }
        const word = canonicalWord(rawValue);
        if (word.length === 0) {
          emptyTargetFields += 1;
          continue;
        }
        const status = ankiCardStatus(minedCardIds.has(card.cardId));
        const existing = statuses.get(word);
        if (existing === undefined) statuses.set(word, status);
        else statuses.set(word, aggregateAnkiStatuses([existing, status])!);
      }
      if (returnedCardIds.size !== selectedCardIds.length) {
        const missingCardId = selectedCardIds.find((cardId) => !returnedCardIds.has(cardId));
        throw new AnkiConnectError(
          "protocol-error",
          `cardsInfo did not return selected card ID: ${String(missingCardId)}`,
        );
      }

      let match: {
        matchedWords: number;
        knownCount: number;
        minedCount: number;
        manualProtected: number;
      } | null = null;
      if (datasetId !== null) {
        match = await this.awaitPreview(
          this.core.worker.previewAnkiMatch({
            datasetId,
            knownWords: [...this.core.state.knownWords],
            decisions: this.core.decisionTuples(),
            ankiStatuses: [...statuses],
            signal: abortController.signal,
          }),
          abortController.signal,
        );
      }

      if (
        configRevision !== this.configRevision ||
        userStateEpoch !== this.core.getUserStateEpoch() ||
        datasetId !== (this.core.state.dataset?.id ?? null) ||
        previewGeneration !== this.previewGeneration
      ) {
        throw new AnkiSyncServiceError("stale-preview", "Anki sync preview is no longer current");
      }

      const candidate: PreviewCandidate = {
        statuses,
        scannedCards: selectedCardIds.length,
        uniqueWords: statuses.size,
        emptyTargetFields,
        configRevision,
        userStateEpoch,
        datasetId,
        previewGeneration,
      };
      this.previewCandidate = candidate;
      const queueRemovals = this.queueRemovalCount(statuses, datasetId);
      this.core.state.ankiPreview = {
        scannedCards: candidate.scannedCards,
        uniqueWords: candidate.uniqueWords,
        matchedWords: match?.matchedWords ?? null,
        knownCount: match?.knownCount ?? null,
        minedCount: match?.minedCount ?? null,
        manualProtected: match?.manualProtected ?? null,
        emptyTargetFields: candidate.emptyTargetFields,
        queueRemovals,
        zeroCards: candidate.scannedCards === 0,
        datasetAvailable: datasetId !== null,
      };
      this.publishSummary("preview", null);
    } catch (error) {
      if (previewGeneration !== this.previewGeneration) throw this.stalePreviewError();
      this.dropPreview();
      this.publishError(error);
      throw error;
    } finally {
      if (this.previewAbortController === abortController) this.previewAbortController = null;
    }
  }

  cancelPreview(): void {
    const hadPreview =
      this.previewCandidate !== null ||
      this.core.state.ankiPreview !== null ||
      this.core.state.anki.status === "preview" ||
      this.core.state.anki.status === "syncing";
    this.previewGeneration += 1;
    this.abortPreview();
    this.dropPreview();
    if (hadPreview) this.publishSummary("idle", null);
  }

  async applySync(): Promise<void> {
    const candidate = this.previewCandidate;
    if (candidate === null) {
      const error = this.stalePreviewError();
      this.publishError(error);
      throw error;
    }
    const epoch = this.core.getUserStateEpoch();
    if (!this.isCurrentCandidate(candidate)) {
      const error = this.stalePreviewError();
      this.reportApplyError(candidate, error);
      throw error;
    }

    try {
      await this.core.withUserStateLock(async () => {
        if (epoch !== this.core.getUserStateEpoch() || !this.isCurrentCandidate(candidate)) {
          throw this.stalePreviewError();
        }

        const previousSnapshot = snapshotRecord(this.snapshotSyncedAt, this.snapshot);
        const nextSnapshot: AnkiSyncSnapshot = {
          syncedAt: this.core.now(),
          statuses: [...candidate.statuses],
        };
        await this.core.storageOperation((store) => store.ankiSync.replaceSnapshot(nextSnapshot));

        if (!this.isCurrentCandidate(candidate)) {
          await this.restoreStoredSnapshot(previousSnapshot);
          throw this.stalePreviewError();
        }

        this.snapshot = new Map(candidate.statuses);
        this.snapshotSyncedAt = nextSnapshot.syncedAt;
        this.removeAppliedQueueWords(candidate.statuses, candidate.datasetId);
        this.decisions.clearUndo();
        this.previewGeneration += 1;
        this.dropPreview();
        this.core.countChangeSinceExport();
        this.publishSummary("idle", null);
      });
    } catch (error) {
      this.reportApplyError(candidate, error);
      throw error;
    }

    await this.core.runQuery();
    await this.coverage.request();
  }

  async clearSyncData(): Promise<void> {
    try {
      await this.core.withUserStateLock(async () => {
        this.core.bumpUserStateEpoch();
        await this.core.storageOperation(async (store) => {
          await store.ankiSync.clear();
        });
        this.config = null;
        this.snapshot = new Map();
        this.snapshotSyncedAt = null;
        this.invalidatePreview();
        this.core.countChangeSinceExport();
        this.publishSummary("idle", null);
      });
    } catch (error) {
      this.publishError(error);
      throw error;
    }

    await this.core.runQuery();
    await this.coverage.request();
  }

  resetLocal(): void {
    this.config = null;
    this.snapshot = new Map();
    this.snapshotSyncedAt = null;
    this.invalidatePreview();
    this.core.state.anki = { ...EMPTY_ANKI };
  }

  restoreFromBackup(section: AnkiSyncBackupSection | null): void {
    const nextConfig = cloneConfig(section?.config ?? null);
    const nextSnapshot = snapshotMap(section?.snapshot ?? null);
    const nextSnapshotSyncedAt = section?.snapshot?.syncedAt ?? null;
    this.config = nextConfig;
    this.snapshot = nextSnapshot;
    this.snapshotSyncedAt = nextSnapshotSyncedAt;
    this.invalidatePreview();
    this.updateSummary("idle", null);
  }

  private getPort(): AnkiConnectPort {
    return (this.port ??= this.portFactory());
  }

  private stalePreviewError(): AnkiSyncServiceError {
    return new AnkiSyncServiceError("stale-preview", "Anki sync preview is no longer current");
  }

  private async awaitPreview<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort = (): void => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.stalePreviewError());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private abortPreview(): void {
    const controller = this.previewAbortController;
    this.previewAbortController = null;
    controller?.abort();
  }

  private async restoreStoredSnapshot(snapshot: AnkiSyncSnapshot | null): Promise<void> {
    await this.core.storageOperation((store) => store.ankiSync.replaceSnapshot(snapshot));
  }

  private async validateConfigAgainstAnki(
    port: AnkiConnectPort,
    config: AnkiSyncConfig,
  ): Promise<void> {
    const [decks, models] = await Promise.all([port.deckNames(), port.modelNames()]);
    if (config.deckScope.kind === "deck" && !decks.includes(config.deckScope.name)) {
      throw new AnkiSyncServiceError(
        "invalid-config",
        `Anki configuration is invalid. Open Settings and choose an existing deck: ${config.deckScope.name}`,
      );
    }
    if (!models.includes(config.noteType)) {
      throw new AnkiSyncServiceError(
        "invalid-config",
        `Anki configuration is invalid. Open Settings and choose an existing note type: ${config.noteType}`,
      );
    }
    const fields = await port.modelFieldNames(config.noteType);
    if (!fields.includes(config.targetField)) {
      throw new AnkiSyncServiceError(
        "invalid-config",
        `Anki configuration is invalid. Open Settings and choose an existing target field: ${config.targetField}`,
      );
    }
  }

  private invalidatePreview(): void {
    this.configRevision = this.configRevision + 1;
    this.previewGeneration += 1;
    this.abortPreview();
    this.dropPreview();
  }

  private dropPreview(): void {
    this.previewCandidate = null;
    this.core.state.ankiPreview = null;
  }

  private isCurrentCandidate(candidate: PreviewCandidate): boolean {
    return (
      candidate.configRevision === this.configRevision &&
      candidate.userStateEpoch === this.core.getUserStateEpoch() &&
      candidate.datasetId === (this.core.state.dataset?.id ?? null) &&
      candidate.previewGeneration === this.previewGeneration &&
      this.previewCandidate === candidate
    );
  }

  private ownsCandidate(candidate: PreviewCandidate): boolean {
    return (
      candidate.previewGeneration === this.previewGeneration && this.previewCandidate === candidate
    );
  }

  private reportApplyError(candidate: PreviewCandidate, error: unknown): void {
    if (error instanceof AnkiSyncServiceError && error.code === "stale-preview") {
      if (!this.ownsCandidate(candidate)) return;
      this.dropPreview();
    }
    this.publishError(error);
  }

  private removeAppliedQueueWords(
    statuses: ReadonlyMap<string, AnkiWordStatus>,
    datasetId: string | null,
  ): void {
    const queue = this.core.state.queue;
    if (datasetId === null || queue.datasetId !== datasetId) return;
    const manual = new Set(this.core.decisionTuples().map(([word]) => canonicalWord(word)));
    const remaining = queue.normalizedWords.filter((queued) => {
      const word = canonicalWord(queued);
      return !statuses.has(word) || manual.has(word);
    });
    if (remaining.length === queue.normalizedWords.length) return;
    this.core.state.queue = { ...queue, normalizedWords: remaining };
    this.core.sessionQueue.save({ version: 1, datasetId, normalizedWords: remaining });
  }

  private queueRemovalCount(
    statuses: ReadonlyMap<string, AnkiWordStatus>,
    datasetId: string | null,
  ): number {
    if (datasetId === null || this.core.state.queue.datasetId !== datasetId) return 0;
    const manual = new Set(this.core.decisionTuples().map(([word]) => canonicalWord(word)));
    const queued = new Set(this.core.state.queue.normalizedWords.map(canonicalWord));
    let count = 0;
    for (const word of queued) {
      if (statuses.has(word) && !manual.has(word)) count += 1;
    }
    return count;
  }

  private setStatus(
    status: "idle" | "connecting" | "syncing" | "preview" | "error",
    errorMessage: string | null,
  ): void {
    this.core.state.anki = {
      ...this.core.state.anki,
      status,
      errorMessage,
    };
    this.core.publish();
  }

  private publishSummary(
    status: "idle" | "connecting" | "syncing" | "preview" | "error",
    errorMessage: string | null,
  ): void {
    this.updateSummary(status, errorMessage);
    this.core.publish();
  }

  private updateSummary(
    status: "idle" | "connecting" | "syncing" | "preview" | "error",
    errorMessage: string | null,
  ): void {
    this.core.state.anki = {
      ...this.core.state.anki,
      ...snapshotCounts(this.snapshot),
      configured: this.config !== null,
      status,
      lastSyncedAt: this.lastSyncedAt(),
      deckScopeKind: this.config?.deckScope.kind ?? null,
      deckScopeLabel: configLabel(this.config),
      noteType: this.config?.noteType ?? null,
      targetField: this.config?.targetField ?? null,
      errorMessage,
    };
  }

  private publishError(error: unknown): void {
    this.publishSummary("error", errorMessage(error));
  }

  private lastSyncedAt(): string | null {
    return this.snapshotSyncedAt;
  }
}
