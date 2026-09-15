import { canonicalWord } from "../../domain/text";
import type { WordDecision, WordDecisionStatus } from "../../domain/types";
import { EMPTY_UNDO } from "../state";
import { type ControllerCore, errorMessage, UNDO_STATUS_LABELS, type UndoRecord } from "./context";
import type { CoverageService } from "./coverage-service";
import type { MiningQueueService } from "./mining-queue-service";

/**
 * Owns word decisions and the single-step undo record. All decision writes
 * funnel through applyWordDecision: it canonicalizes the word, holds
 * userStateLock, checks the captured epoch, persists, auto-removes the word
 * from the mining queue, captures/consumes undo records, counts the change,
 * and refreshes the list and coverage.
 */
export class DecisionService {
  // The last successfully applied decision's undo record, mirrored into
  // state.undo for the UI. Null when undo is unavailable.
  private undoRecord: UndoRecord | null = null;

  constructor(
    private readonly core: ControllerCore,
    private readonly queue: MiningQueueService,
    private readonly coverage: CoverageService,
  ) {}

  /** Drop the pending undo record: its context no longer describes live state. */
  clearUndo(): void {
    this.undoRecord = null;
    this.core.state.undo = { ...EMPTY_UNDO };
  }

  async setWordDecision(
    normalizedWord: string,
    status: WordDecisionStatus | "unreviewed",
  ): Promise<void> {
    if (canonicalWord(normalizedWord).length === 0) {
      throw new Error("Word decision requires a non-empty normalized word");
    }
    const epoch = this.core.getUserStateEpoch();
    await this.applyWordDecision(normalizedWord, status, epoch).catch((error: unknown) => {
      if (epoch !== this.core.getUserStateEpoch()) return;
      this.core.setState({
        errorMessage: `Word decision could not be saved: ${errorMessage(error)}`,
      });
    });
  }

  async undoLastDecision(): Promise<void> {
    const record = this.undoRecord;
    if (record === null) return;
    // Consume the record first: undo is single-step, and a second call while
    // a re-apply is still in flight must no-op.
    this.undoRecord = null;
    const priorUndo = this.core.state.undo;
    this.core.state.undo = { ...EMPTY_UNDO };
    // Undo is itself a user action: capture its own epoch so a concurrent
    // clear/restore that wins the lock first drops this re-apply.
    const epoch = this.core.getUserStateEpoch();
    try {
      // Re-apply through the SAME decision path (locks, epoch checks, queue
      // removal, coverage refresh) rather than a raw store write — without
      // capturing a fresh undo record, so one undo does not become redo.
      await this.applyWordDecision(record.normalizedWord, record.previousStatus, epoch, {
        captureUndo: false,
      });
      // A concurrent clear/restore bumped the epoch and dropped the re-apply:
      // the record stays consumed (the restored/cleared world replaced the
      // context it described), and the queue re-add must not half-apply on
      // top of that replaced state.
      if (epoch !== this.core.getUserStateEpoch()) return;
      // Restore queue membership the decision's auto-removal dropped. The
      // word is APPENDED to the end: original position is not tracked, and
      // one-step undo only promises the word returns to the queue.
      if (record.previousQueueMembership) {
        const queueDatasetId = this.core.state.queue.datasetId;
        if (
          queueDatasetId !== null &&
          !this.core.state.queue.normalizedWords.includes(record.normalizedWord)
        ) {
          this.queue.setQueueWords(queueDatasetId, [
            ...this.core.state.queue.normalizedWords,
            record.normalizedWord,
          ]);
        }
      }
    } catch (error) {
      if (epoch === this.core.getUserStateEpoch()) {
        // The re-apply failed without mutating anything: put the record back
        // so undo can be retried once the cause is resolved.
        this.undoRecord = record;
        this.core.state.undo = priorUndo;
        this.core.setState({ errorMessage: `Undo could not be saved: ${errorMessage(error)}` });
      }
    }
  }

  async applyWordDecision(
    normalizedWord: string,
    status: WordDecisionStatus | "unreviewed",
    epoch: number,
    options: { captureUndo?: boolean } = {},
  ): Promise<void> {
    // Single canonicalization choke point: every caller (list clicks, review
    // triage) funnels raw words through here so persisted keys always use the
    // canonical lowercase identity.
    const canonical = canonicalWord(normalizedWord);
    if (canonical.length === 0) {
      throw new Error("Word decision requires a non-empty normalized word");
    }
    await this.core.withUserStateLock(async () => {
      if (epoch !== this.core.getUserStateEpoch()) return;
      // Snapshot the undo record BEFORE any mutation: the prior decision
      // status and the prior queue membership (a decision auto-removes
      // queued words further down). Only committed once the write succeeds,
      // so a failed decision leaves the previous record intact.
      const pendingUndo =
        options.captureUndo === false
          ? null
          : {
              normalizedWord: canonical,
              previousStatus:
                this.core.state.wordDecisions.get(canonical)?.status ?? ("unreviewed" as const),
              previousQueueMembership: this.core.state.queue.normalizedWords.includes(canonical),
            };
      if (status === "unreviewed") {
        await this.core.storageOperation((store) => store.wordDecisions.remove(canonical));
        if (epoch !== this.core.getUserStateEpoch()) return;
        this.core.state.wordDecisions.delete(canonical);
      } else {
        const decision: WordDecision = {
          normalizedWord: canonical,
          status,
          updatedAt: this.core.now(),
        };
        await this.core.storageOperation((store) => store.wordDecisions.set(decision));
        if (epoch !== this.core.getUserStateEpoch()) return;
        this.core.state.wordDecisions.set(canonical, decision);
      }
      // A successful decision removes the word from the mining queue; a failed
      // write leaves the queue untouched so the word can be retried.
      const queueDatasetId = this.core.state.queue.datasetId;
      if (queueDatasetId !== null && this.core.state.queue.normalizedWords.includes(canonical)) {
        const remaining = this.core.state.queue.normalizedWords.filter(
          (queued) => queued !== canonical,
        );
        this.core.state.queue = { ...this.core.state.queue, normalizedWords: remaining };
        this.core.sessionQueue.save({
          version: 1,
          datasetId: queueDatasetId,
          normalizedWords: remaining,
        });
      }
      if (pendingUndo !== null) {
        this.undoRecord = pendingUndo;
        this.core.state.undo = {
          available: true,
          label: `Undo ${UNDO_STATUS_LABELS[status]} — ${normalizedWord}`,
        };
      }
    });
    if (epoch !== this.core.getUserStateEpoch()) return;
    // Counted change (see ControllerCore.countChangeSinceExport): the write
    // committed and the epoch survived, so this decision genuinely landed.
    // Undo re-applies through this same path and counts exactly once — never
    // doubled by a separate undo-side increment.
    this.core.countChangeSinceExport();
    this.core.publish();
    await this.core.runQuery();
    await this.coverage.request();
  }
}
