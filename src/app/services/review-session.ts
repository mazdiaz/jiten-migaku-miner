import type { WordDecisionStatus } from "../../domain/types";
import { EMPTY_REVIEW } from "../state";
import { type ControllerCore, errorMessage } from "./context";
import type { DecisionService } from "./decision-service";

/**
 * Owns the review (triage) session: entry/exit, the per-card decision flow,
 * and the review staleness generations. A session restarted mid-decision
 * does not inherit the superseded session's busy flag, and a stale
 * decision's finally cannot clear a newer generation's flag.
 */
export class ReviewSession {
  // Generation that owns the in-flight review decision, or null when idle.
  // Busy is only consulted within its own generation.
  private busyGeneration: number | null = null;
  // Bumped whenever a review session ends (stop or dataset change);
  // in-flight continuations compare their captured value to detect staleness.
  private generation = 0;

  constructor(
    private readonly core: ControllerCore,
    private readonly decisions: DecisionService,
  ) {}

  invalidate(): void {
    this.generation += 1;
  }

  async start(): Promise<void> {
    const state = this.core.state;
    if (state.review.active || state.dataset === null) return;
    state.review = { ...EMPTY_REVIEW, active: true, status: "loading" };
    this.core.publish();
    await this.runReviewQuery({ captureInitial: true });
  }

  stop(): void {
    if (!this.core.state.review.active) return;
    this.generation += 1;
    this.core.state.review = { ...EMPTY_REVIEW };
    this.core.publish();
  }

  async reviewDecision(status: WordDecisionStatus): Promise<void> {
    const review = this.core.state.review;
    if (
      !review.active ||
      review.status !== "ready" ||
      review.current === null ||
      this.busyGeneration === this.generation
    )
      return;
    const generation = this.generation;
    const word = review.current.normalizedWord;
    this.busyGeneration = generation;
    this.core.state.review = { ...review, status: "loading", errorMessage: null };
    this.core.publish();

    const epoch = this.core.getUserStateEpoch();
    try {
      await this.decisions.applyWordDecision(word, status, epoch);
      if (generation !== this.generation || !this.core.state.review.active) return;
      this.core.state.review = {
        ...this.core.state.review,
        processed: this.core.state.review.processed + 1,
        status: "loading",
      };
      this.core.publish();
      await this.runReviewQuery();
    } catch (error) {
      if (generation !== this.generation || !this.core.state.review.active) return;
      this.core.state.review = {
        ...this.core.state.review,
        status: this.core.state.review.current === null ? "complete" : "ready",
        errorMessage: `Word decision could not be saved: ${errorMessage(error)}`,
      };
      this.core.publish();
    } finally {
      if (this.busyGeneration === generation) this.busyGeneration = null;
    }
  }

  private async runReviewQuery(options: { captureInitial?: boolean } = {}): Promise<void> {
    const state = this.core.state;
    const dataset = state.dataset;
    if (dataset === null || !state.review.active) return;
    const generation = this.generation;
    // Always ask for page 1: after a decision the current entry leaves the
    // unreviewed set, so the first remaining candidate shifts into page 1.
    const reviewQuery = {
      ...state.query,
      hideKnown: true,
      decision: "unreviewed" as const,
      page: 1,
      pageSize: 1 as const,
    };
    try {
      const result = await this.core.worker.query({
        datasetId: dataset.id,
        knownWords: [...state.knownWords],
        decisions: this.core.decisionTuples(),
        query: reviewQuery,
        queryChannel: "review",
      });
      if (generation !== this.generation || !state.review.active) return;
      const current = result.items[0] ?? null;
      state.review = {
        ...state.review,
        initialTotal: options.captureInitial ? result.totalEntries : state.review.initialTotal,
        remaining: result.totalEntries,
        current,
        status: current === null ? "complete" : "ready",
        errorMessage: null,
      };
      this.core.publish();
    } catch (error) {
      if (generation !== this.generation || !state.review.active) return;
      state.review = {
        ...state.review,
        status: "error",
        errorMessage: errorMessage(error),
      };
      this.core.publish();
    }
  }
}
