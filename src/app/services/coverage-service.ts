import { type ControllerCore, errorMessage } from "./context";

/**
 * Owns the coverage stats lifecycle and its staleness generation. Coverage
 * describes the whole active dataset, so it refreshes only after
 * dataset/known/decision identity changes (dataset load, known import,
 * decision apply, restore) — never for view/page/search-only updates that
 * route through runQuery alone. Errors are nonfatal: they land in
 * coverageStatus/coverageErrorMessage while the results list stays intact.
 */
export class CoverageService {
  // Bumped whenever the dataset/user-state identity the coverage stats
  // describe changes (dataset swap, clear, restore attempts); in-flight
  // coverage responses compare their captured value and stale ones are
  // dropped. Every request also bumps, so the newest request always wins.
  private generation = 0;

  constructor(private readonly core: ControllerCore) {}

  invalidate(): void {
    this.generation += 1;
  }

  /** Drop current stats and invalidate in-flight responses (no publish). */
  reset(): void {
    this.generation += 1;
    const state = this.core.state;
    state.coverage = null;
    state.coverageStatus = "idle";
    state.coverageErrorMessage = null;
  }

  async request(): Promise<void> {
    const dataset = this.core.state.dataset;
    if (dataset === null) {
      const state = this.core.state;
      if (
        state.coverage !== null ||
        state.coverageStatus !== "idle" ||
        state.coverageErrorMessage !== null
      ) {
        this.reset();
        this.core.publish();
      }
      return;
    }

    const generation = ++this.generation;
    const state = this.core.state;
    state.coverageStatus = "loading";
    state.coverageErrorMessage = null;
    this.core.publish();
    try {
      // Targets stay unset: the worker applies the domain defaults
      // [98, 98.5, 99, 99.5].
      const stats = await this.core.worker.coverage({
        datasetId: dataset.id,
        knownWords: [...state.knownWords],
        decisions: this.core.decisionTuples(),
      });
      if (generation !== this.generation) return;
      const current = this.core.state;
      current.coverage = stats;
      current.coverageStatus = "ready";
      this.core.publish();
    } catch (error) {
      if (generation !== this.generation) return;
      const current = this.core.state;
      current.coverageStatus = "error";
      current.coverageErrorMessage = errorMessage(error);
      this.core.publish();
    }
  }
}
