import {
  type AnkiSyncBackupSection,
  type ParsedMinerBackup,
  parseBackup,
  serializeBackup,
} from "../../domain/backup";
import type { QueryState, ViewState, WordDecision } from "../../domain/types";
import type { AppStore } from "../../storage/contracts";
import { DEFAULT_QUERY, DEFAULT_VIEW } from "../state";
import type { AnkiSyncService } from "./anki-sync-service";
import { type ControllerCore, errorMessage } from "./context";
import type { CoverageService } from "./coverage-service";
import type { DecisionService } from "./decision-service";
import type { MiningQueueService } from "./mining-queue-service";
import type { ReviewSession } from "./review-session";

export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

interface UserStateSnapshot {
  known: { id: string; name: string; words: Set<string> } | null;
  decisions: WordDecision[];
  preferences: { query: QueryState; view: ViewState; page: number } | null;
  ankiSync: AnkiSyncBackupSection;
}

/**
 * Owns backup export/restore: the atomic single-transaction restore fast
 * path, the app-level fallback with rollback, and applying the restored
 * state to the live AppState.
 */
export class BackupService {
  constructor(
    private readonly core: ControllerCore,
    private readonly review: ReviewSession,
    private readonly coverage: CoverageService,
    private readonly decisions: DecisionService,
    private readonly queue: MiningQueueService,
    private readonly ankiSync: Pick<AnkiSyncService, "restoreFromBackup">,
  ) {}

  async exportBackup(): Promise<string> {
    return this.core.withUserStateLock(async () => {
      const state = this.core.state;
      const known = await this.core.storageOperation((store) => store.knownWords.getActive());
      const ankiSync = await this.core.storageOperation(async (store) => ({
        config: await store.ankiSync.loadConfig(),
        snapshot: await store.ankiSync.loadSnapshot(),
      }));
      const knownWords = known === null ? null : { name: known.name, words: [...known.words] };
      const exportedAt = this.core.now();
      const json = serializeBackup({
        exportedAt,
        knownWords,
        wordDecisions: state.wordDecisions.values(),
        preferences: {
          query: { ...state.query },
          view: { ...state.view },
          page: state.query.page,
        },
        ankiSync,
      });
      // A completed export resets the freshness signal. Publish inside the
      // existing lock so the Data area line updates immediately.
      state.lastExportAt = exportedAt;
      state.changesSinceExport = 0;
      this.core.publish();
      return json;
    });
  }

  async restoreBackup(text: string): Promise<void> {
    if (text.length > MAX_BACKUP_BYTES) {
      const message = `Backup is too large: ${text.length} bytes exceeds the ${MAX_BACKUP_BYTES} byte limit`;
      this.invalidateAndReport(`Backup could not be restored: ${message}`);
      throw new Error(message);
    }
    let backup: ParsedMinerBackup;
    try {
      backup = parseBackup(text);
    } catch (error) {
      this.invalidateAndReport(`Backup could not be restored: ${errorMessage(error)}`);
      throw error;
    }
    const ankiSync = backup.ankiSync ?? { config: null, snapshot: null };

    await this.core.withUserStateLock(async () => {
      this.core.bumpUserStateEpoch();
      const snapshot = await this.core.storageOperation(async (store) => ({
        known: await store.knownWords.getActive(),
        decisions: await store.wordDecisions.list(),
        preferences: await store.preferences.load(),
        ankiSync: {
          config: await store.ankiSync.loadConfig(),
          snapshot: await store.ankiSync.loadSnapshot(),
        },
      }));

      const knownId = this.core.createId("known");
      const preferences = backup.preferences ?? {
        query: { ...DEFAULT_QUERY, page: 1 },
        view: { ...DEFAULT_VIEW },
        page: 1,
      };

      // Single-transaction fast path: stores implementing restoreUserState
      // commit every category in one durable transaction, so process death
      // mid-restore leaves the pre-restore state intact and app-level
      // rollback is unnecessary. Presence is checked inside the operation
      // because storageOperation may retry on a different (memory) store.
      const restoredAtomically = await this.core
        .storageOperation(async (store) => {
          if (store.restoreUserState === undefined) return false;
          await store.restoreUserState({
            knownWords:
              backup.knownWords === null
                ? null
                : {
                    id: knownId,
                    name: backup.knownWords.name,
                    words: new Set(backup.knownWords.words),
                  },
            decisions: backup.wordDecisions,
            preferences,
            ankiSync,
          });
          return true;
        })
        .catch((error: unknown) => {
          // The atomic transaction aborted; the storage engine rolled
          // everything back, so no app-level rollback writes are needed.
          this.invalidateAndReport(`Backup could not be restored: ${errorMessage(error)}`);
          throw error;
        });

      if (!restoredAtomically) {
        let decisionsWritten = false;
        let preferencesWritten = false;
        let ankiWritten = false;
        try {
          await this.writeRestoredKnownWords(knownId, backup);
          await this.core.storageOperation((store) =>
            store.wordDecisions.replaceAll(backup.wordDecisions),
          );
          decisionsWritten = true;
          await this.core.storageOperation((store) => store.preferences.save(preferences));
          preferencesWritten = true;
          ankiWritten = true;
          await this.writeRestoredAnkiSync(ankiSync);
        } catch (error) {
          const rollbackWarning = await this.rollbackUserState(snapshot, {
            knownWritten: true,
            decisionsWritten,
            preferencesWritten,
            ankiWritten,
          });
          const message =
            rollbackWarning === null
              ? errorMessage(error)
              : `${errorMessage(error)} ${rollbackWarning}`;
          this.invalidateAndReport(`Backup could not be restored: ${message}`);
          throw error;
        }
      }

      this.applyRestoredState(backup);
      this.ankiSync.restoreFromBackup(ankiSync);
      // Queue contents and review session are transient; restore never injects
      // them, and mining/review mode cannot continue over replaced decisions.
      this.queue.exitWithoutRequery();
      if (this.core.state.review.active) this.review.stop();
      // One committed restore is one counted change regardless of how many
      // decisions/known words it replaced (single logical user action).
      this.core.countChangeSinceExport();
      const dataset = this.core.state.dataset;
      if (dataset === null) {
        this.core.setState({ status: "empty", errorMessage: this.core.getWarningMessage() });
        // Already inside withUserStateLock: the lock-free form.
        await this.core.persistPreferencesUnlocked();
        return;
      }
      this.core.setState({ status: "loading", errorMessage: this.core.getWarningMessage() });
      await this.core.loadAndQuery(dataset.id, dataset.entryCount, {
        callerHoldsUserStateLock: true,
      });
    });
  }

  private invalidateAndReport(message: string): void {
    this.core.invalidateQueries();
    // A review continuation in flight across the failure must not publish
    // into the post-failure state; mirror clearSavedData's invalidation.
    this.review.invalidate();
    this.coverage.invalidate();
    this.core.setState({ errorMessage: message });
  }

  private async writeRestoredKnownWords(knownId: string, backup: ParsedMinerBackup): Promise<void> {
    if (backup.knownWords === null) {
      const active = await this.core.storageOperation((store) => store.knownWords.getActive());
      if (active === null) return;
      await this.core.storageOperation(async (store) => {
        if (store.knownWords.remove === undefined)
          throw new Error("Known-word store cannot remove records");
        await store.knownWords.remove(active.id);
      });
      return;
    }
    const words = new Set(backup.knownWords.words);
    await this.core.storageOperation((store) =>
      store.knownWords.save(knownId, backup.knownWords!.name, words),
    );
  }

  private async writeRestoredAnkiSync(section: AnkiSyncBackupSection | null): Promise<void> {
    const restored = section ?? { config: null, snapshot: null };
    await this.core.storageOperation(async (store) => {
      await store.ankiSync.clear();
      if (restored.config !== null) await store.ankiSync.saveConfig(restored.config);
      if (restored.snapshot !== null) await store.ankiSync.replaceSnapshot(restored.snapshot);
    });
  }

  private async rollbackUserState(
    snapshot: UserStateSnapshot,
    written: {
      knownWritten: boolean;
      decisionsWritten: boolean;
      preferencesWritten: boolean;
      ankiWritten: boolean;
    },
  ): Promise<string | null> {
    const failures: string[] = [];
    if (written.ankiWritten) {
      try {
        await this.core.storageOperation((store) => this.restoreAnkiSync(store, snapshot.ankiSync));
      } catch (error) {
        failures.push(`Anki sync rollback failed: ${errorMessage(error)}`);
      }
    }
    if (written.preferencesWritten) {
      try {
        if (snapshot.preferences !== null) {
          await this.core.storageOperation((store) =>
            store.preferences.save(snapshot.preferences!),
          );
        } else {
          await this.core.storageOperation(async (store) => {
            if (store.preferences.clear === undefined)
              throw new Error("Preference store cannot clear records");
            await store.preferences.clear();
          });
        }
      } catch (error) {
        failures.push(`Preferences rollback failed: ${errorMessage(error)}`);
      }
    }
    if (written.decisionsWritten) {
      try {
        await this.core.storageOperation((store) =>
          store.wordDecisions.replaceAll(snapshot.decisions),
        );
      } catch (error) {
        failures.push(`Word decision rollback failed: ${errorMessage(error)}`);
      }
    }
    if (written.knownWritten) {
      try {
        if (snapshot.known !== null) {
          await this.core.storageOperation((store) =>
            store.knownWords.save(snapshot.known!.id, snapshot.known!.name, snapshot.known!.words),
          );
        } else {
          const active = await this.core.storageOperation((store) => store.knownWords.getActive());
          if (active !== null) {
            await this.core.storageOperation(async (store) => {
              if (store.knownWords.remove === undefined)
                throw new Error("Known-word store cannot remove records");
              await store.knownWords.remove(active.id);
            });
          }
        }
      } catch (error) {
        failures.push(`Known-word rollback failed: ${errorMessage(error)}`);
      }
    }
    return failures.length === 0 ? null : failures.join(" ");
  }

  private async restoreAnkiSync(store: AppStore, section: AnkiSyncBackupSection): Promise<void> {
    await store.ankiSync.clear();
    if (section.config !== null) await store.ankiSync.saveConfig(section.config);
    if (section.snapshot !== null) await store.ankiSync.replaceSnapshot(section.snapshot);
  }

  private applyRestoredState(backup: ParsedMinerBackup): void {
    const state = this.core.state;
    if (backup.knownWords === null) {
      state.knownWords = new Set<string>();
      state.knownWordsName = null;
    } else {
      state.knownWords = new Set(backup.knownWords.words);
      state.knownWordsName = backup.knownWords.name;
    }
    state.wordDecisions = new Map(
      backup.wordDecisions.map((decision) => [decision.normalizedWord, { ...decision }]),
    );
    const preferences = backup.preferences;
    if (preferences === null) {
      state.query = { ...DEFAULT_QUERY };
      state.view = { ...DEFAULT_VIEW };
    } else {
      state.query = {
        ...DEFAULT_QUERY,
        ...preferences.query,
        page: preferences.page,
      };
      state.view = { ...preferences.view };
    }
    this.core.setViewportStart(0);
    this.core.invalidateQueries();
    state.result = null;
    // Restored decisions replaced the pre-restore ones, so the pending undo
    // record no longer describes any live decision.
    this.decisions.clearUndo();
    // Restored user state invalidates any in-flight coverage computation, and
    // the pre-restore stats no longer describe the restored known/decisions.
    this.coverage.reset();
  }
}
