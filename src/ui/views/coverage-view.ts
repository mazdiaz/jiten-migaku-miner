import type { AppState } from "../../app/state";
import type { DomMap } from "../dom";

/**
 * Owns the coverage panel: expansion state (collapsed by default, reset on
 * dataset identity change) and stat rendering. Visible only with an active
 * dataset; stats render from state.coverage while null (idle/loading/zero-
 * total) shows N/A. Errors are nonfatal — a line inside the panel, never
 * touching the results surface.
 */
export function createCoveragePanelView(dom: DomMap) {
  let expanded = false;
  let datasetId: string | null = null;

  const formatCoveragePercent = (value: number | null): string =>
    value === null ? "N/A" : `${value.toFixed(2)}%`;

  return {
    toggle(): void {
      expanded = !expanded;
    },
    render(state: Readonly<AppState>, hasData: boolean): void {
      const nextDatasetId = state.dataset?.id ?? null;
      if (nextDatasetId !== datasetId) {
        datasetId = nextDatasetId;
        expanded = false;
      }
      dom.coveragePanel.hidden = !hasData;
      const bodyVisible = hasData && expanded;
      dom.coverageBody.hidden = !bodyVisible;
      dom.coverageToggle.disabled = !hasData;
      dom.coverageToggle.setAttribute("aria-expanded", expanded && hasData ? "true" : "false");

      const stats = state.coverage;
      dom.coverageSummary.textContent = formatCoveragePercent(stats?.coveragePercent ?? null);

      if (!bodyVisible) return;

      dom.coverageUniqueWords.textContent =
        stats === null
          ? "—"
          : `${stats.knownUniqueWords.toLocaleString()} / ${stats.totalUniqueWords.toLocaleString()}`;
      dom.coverageKnownOccurrences.textContent =
        stats === null
          ? "—"
          : `${stats.knownTrackedOccurrences.toLocaleString()} / ${stats.totalTrackedOccurrences.toLocaleString()}`;
      dom.coveragePercent.textContent = formatCoveragePercent(stats?.coveragePercent ?? null);

      dom.coverageTargets.textContent = "";
      for (const target of stats?.targets ?? []) {
        const row = document.createElement("li");
        row.className = "coverage-target";
        const label = document.createElement("span");
        label.className = "coverage-target-label";
        label.textContent = `${target.targetPercent.toFixed(1)}%`;
        const value = document.createElement("span");
        value.className = "coverage-target-value";
        value.textContent = target.reached
          ? "reached"
          : `+${target.additionalWords.toLocaleString()} ${target.additionalWords === 1 ? "word" : "words"}`;
        row.append(label, value);
        dom.coverageTargets.appendChild(row);
      }

      const coverageFailed = state.coverageStatus === "error";
      dom.coverageError.hidden = !coverageFailed;
      if (coverageFailed) {
        dom.coverageError.textContent = `Coverage unavailable: ${state.coverageErrorMessage ?? "unknown error"}`;
      }
      dom.coverageFocus.disabled = !hasData;
    },
  };
}
