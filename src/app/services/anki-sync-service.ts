import type { AnkiSyncConfig, AnkiSyncSnapshot, AnkiWordStatus } from "../../domain/anki";
import { canonicalWord } from "../../domain/text";
import type { AnkiConnectPort } from "../../platform/anki-connect";
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
      this.config = cloneConfig(config);
      this.snapshot = snapshotMap(snapshot);
      this.snapshotSyncedAt = snapshot?.syncedAt ?? null;
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
      const [decks, models] = await Promise.all([port.deckNames(), port.modelNames()]);
      if (config.deckScope.kind === "deck" && !decks.includes(config.deckScope.name)) {
        throw new AnkiSyncServiceError(
          "invalid-config",
          `Anki deck was not found: ${config.deckScope.name}`,
        );
      }
      if (!models.includes(config.noteType)) {
        throw new AnkiSyncServiceError(
          "invalid-config",
          `Anki note type was not found: ${config.noteType}`,
        );
      }
      const fields = await port.modelFieldNames(config.noteType);
      if (!fields.includes(config.targetField)) {
        throw new AnkiSyncServiceError(
          "invalid-config",
          `Anki target field was not found: ${config.targetField}`,
        );
      }

      const changed = !sameConfig(this.config, config);
      await this.core.withUserStateLock(async () => {
        if (changed) {
          await this.core.storageOperation((store) => store.ankiSync.saveConfig(config));
          this.config = cloneConfig(config);
          this.invalidatePreview();
          this.core.countChangeSinceExport();
        }
        if (!changed) this.core.state.ankiPreview = null;
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

  private getPort(): AnkiConnectPort {
    return (this.port ??= this.portFactory());
  }

  private invalidatePreview(): void {
    this.core.state.ankiPreview = null;
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
    this.core.state.anki = {
      ...this.core.state.anki,
      ...snapshotCounts(this.snapshot),
      configured: this.config !== null,
      status,
      lastSyncedAt: this.lastSyncedAt(),
      deckScopeLabel: configLabel(this.config),
      noteType: this.config?.noteType ?? null,
      targetField: this.config?.targetField ?? null,
      errorMessage,
    };
    this.core.publish();
  }

  private publishError(error: unknown): void {
    this.publishSummary("error", errorMessage(error));
  }

  private lastSyncedAt(): string | null {
    return this.snapshotSyncedAt;
  }
}
