import type { AppState } from "../app/state";
import type { WordDecisionStatus } from "../domain/types";
import type { DomMap } from "./dom";

const QUICK_TOGGLES: readonly [
  keyof Pick<
    DomMap,
    | "hideKnown"
    | "hideKanaOnly"
    | "showDefinitions"
    | "showHighlight"
    | "pillHighlight"
    | "showFurigana"
  >,
  string,
][] = [
  ["hideKnown", "Hide Known"],
  ["hideKanaOnly", "Hide Kana"],
  ["showDefinitions", "Definitions"],
  ["showHighlight", "Highlight"],
  ["pillHighlight", "Pill"],
  ["showFurigana", "Furigana"],
];

const SUMMARY_ORDER: readonly WordDecisionStatus[] = ["known", "mined", "later", "skip"];
const SUMMARY_LABELS: Record<WordDecisionStatus, string> = {
  known: "known",
  mined: "mined",
  later: "later",
  skip: "skipped",
};

function ensureQuickControls(dom: DomMap): HTMLDivElement {
  const document = dom.advancedPanel.ownerDocument;
  const existing = document.getElementById("quickControls");
  if (existing instanceof HTMLDivElement) return existing;

  const quickControls = document.createElement("div");
  quickControls.id = "quickControls";
  quickControls.className = "quick-controls";
  quickControls.setAttribute("aria-label", "Quick mining controls");
  dom.advancedPanel.before(quickControls);
  return quickControls;
}

function moveQuickToggles(dom: DomMap, quickControls: HTMLDivElement): void {
  for (const [key, shortLabel] of QUICK_TOGGLES) {
    const input = dom[key];
    const label = input.closest("label");
    if (!(label instanceof HTMLLabelElement)) continue;
    label.classList.add("quick-toggle");
    label.dataset.shortLabel = shortLabel;
    if (label.parentElement !== quickControls) quickControls.appendChild(label);
  }
}

function compactDecisionSummary(dom: DomMap, state: Readonly<AppState>): void {
  const counts = new Map<WordDecisionStatus, number>();
  for (const decision of state.wordDecisions.values()) {
    counts.set(decision.status, (counts.get(decision.status) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const status of SUMMARY_ORDER) {
    const count = counts.get(status) ?? 0;
    if (count > 0) parts.push(`${count.toLocaleString()} ${SUMMARY_LABELS[status]}`);
  }
  if (state.knownWords.size > 0) {
    parts.push(`${state.knownWords.size.toLocaleString()} Migaku-known`);
  }

  dom.decisionSummary.hidden = parts.length === 0;
  dom.decisionSummary.textContent = parts.join(" · ");
}

/**
 * Pulls the six high-frequency toggles into their own persistent row inside
 * the sticky toolbar. The existing advanced panel remains a normal disclosure
 * and therefore contains only the lower-frequency controls after this runs.
 */
export function syncStickyToolbarClarity(dom: DomMap, state: Readonly<AppState>): void {
  const hasData = state.dataset !== null && state.dataset.entryCount > 0;
  const quickControls = ensureQuickControls(dom);

  dom.advancedToggle.textContent = "More";
  quickControls.hidden = !hasData;
  moveQuickToggles(dom, quickControls);

  if (!hasData) return;
  compactDecisionSummary(dom, state);
}
