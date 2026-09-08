import type { AppState } from "../../app/state";
import type { QueryState, WordDecision, WordDecisionStatus } from "../../domain/types";
import type { DomMap } from "../dom";

const SEARCH_CHIP_MAX_CHARS = 20;
const RESET_FILTERS_LABEL = "Reset Filters";

// Restrictive filter keys that can produce an active chip. Sort/page/pageSize
// are deliberately absent: changing them never narrows what is visible, so
// they are not "restrictive" for recoverability purposes.
export type FilterChipKey =
  | "search"
  | "hideKnown"
  | "hideKanaOnly"
  | "sentence"
  | "decision"
  | "minOccurrences";

interface ActiveFilterChip {
  key: FilterChipKey;
  label: string;
}

const DECISION_FILTER_CHIP_LABELS: Record<QueryState["decision"], string> = {
  all: "",
  unreviewed: "unreviewed",
  known: "known",
  mined: "mined",
  skip: "skip",
  later: "later",
};

// Derives the active chips from the query: one chip per restrictive filter
// currently set away from its default. Pure derivation — no DOM.
export function deriveFilterChips(query: Readonly<QueryState>): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  const search = query.search.trim();
  if (search !== "") {
    const truncated =
      search.length > SEARCH_CHIP_MAX_CHARS ? `${search.slice(0, SEARCH_CHIP_MAX_CHARS)}…` : search;
    chips.push({ key: "search", label: `Search: "${truncated}"` });
  }
  if (query.hideKnown) chips.push({ key: "hideKnown", label: "Hide known" });
  if (query.hideKanaOnly) chips.push({ key: "hideKanaOnly", label: "Hide kana-only" });
  if (query.sentence !== "any") {
    chips.push({
      key: "sentence",
      label: `Sentence: ${query.sentence === "has" ? "has" : "none"}`,
    });
  }
  if (query.decision !== "all") {
    chips.push({
      key: "decision",
      label: `Decision: ${DECISION_FILTER_CHIP_LABELS[query.decision]}`,
    });
  }
  if (query.minOccurrences > 1) {
    chips.push({ key: "minOccurrences", label: `Min occurrences: ${query.minOccurrences}` });
  }
  return chips;
}

// Summary order follows the audit's "Known/Mined/Later/Skipped" wording, not
// the button order above.
const DECISION_SUMMARY_STATUSES: readonly WordDecisionStatus[] = [
  "known",
  "mined",
  "later",
  "skip",
];

// Compact decision summary line: status counts from wordDecisions in
// known/mined/later/skip order, plus the imported knownness labeled separately
// (audit: "Label imported knownness separately from local decisions"). All
// four counts always render while the line is visible — consistent shape.
// Pure derivation — no DOM.
export function formatDecisionSummary(
  wordDecisions: ReadonlyMap<string, WordDecision>,
  knownWordsCount: number,
): string {
  const counts = new Map<WordDecisionStatus, number>();
  for (const decision of wordDecisions.values()) {
    counts.set(decision.status, (counts.get(decision.status) ?? 0) + 1);
  }
  const parts = DECISION_SUMMARY_STATUSES.map(
    (status) => `${(counts.get(status) ?? 0).toLocaleString()} ${status}`,
  );
  return `Decisions: ${parts.join(" · ")} · Migaku-known: ${knownWordsCount.toLocaleString()}`;
}

// Active-filter chips row: rebuilt from state.query on every publish (the
// row lives outside #resultsList, so the paged render-skip machinery never
// applies to it). Hidden without a dataset, in queue mode, and when no
// restrictive filter is away from its default (the Reset Filters button
// only exists while at least one chip does).
export function renderFilterChips(dom: DomMap, state: Readonly<AppState>, hasData: boolean): void {
  const chips = deriveFilterChips(state.query);
  const visible = hasData && state.queue.mode !== "queue" && chips.length > 0;
  dom.filterChips.hidden = !visible;
  if (!visible) {
    dom.filterChips.textContent = "";
    return;
  }
  dom.filterChips.textContent = "";
  for (const { key, label } of chips) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip";
    chip.textContent = label;
    chip.dataset.filterChip = key;
    chip.setAttribute("aria-label", `Remove ${label} filter`);
    dom.filterChips.appendChild(chip);
  }
  const reset = document.createElement("button");
  reset.type = "button";
  reset.id = "resetFilters";
  reset.className = "filter-chip filter-chip-reset";
  reset.textContent = RESET_FILTERS_LABEL;
  dom.filterChips.appendChild(reset);
}
