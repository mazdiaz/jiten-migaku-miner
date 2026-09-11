import { parseHighlightSegments } from "../../domain/text";
import type { EntryWithKnown, ViewState, WordDecisionStatus } from "../../domain/types";

const DECISION_LABELS: Record<WordDecisionStatus, string> = {
  known: "Known",
  mined: "Mined",
  skip: "Skip",
  later: "Later",
};

const DECISION_STATUSES: readonly WordDecisionStatus[] = ["known", "mined", "skip", "later"];

const QUEUE_ADD_LABEL = "+ Queue";
const QUEUE_QUEUED_LABEL = "✓ Queued";

export interface EntryRenderOptions {
  queued?: boolean;
  queueMode?: boolean;
}

function appendFuriganaTarget(
  container: HTMLElement,
  surface: string,
  runs: readonly { text: string; reading: string | null }[],
  word: string,
): void {
  const appendPlain = (text: string): void => {
    if (!text) return;
    const span = document.createElement("span");
    span.className = "th-run";
    span.textContent = text;
    container.appendChild(span);
  };
  let covered = 0;
  if (surface.startsWith(word) || word.startsWith(surface)) {
    for (const run of runs) {
      if (run.reading) {
        const ruby = document.createElement("ruby");
        const rb = document.createElement("rb");
        rb.textContent = run.text;
        const rt = document.createElement("rt");
        rt.textContent = run.reading;
        ruby.append(rb, rt);
        container.appendChild(ruby);
      } else {
        appendPlain(run.text);
      }
      covered += run.text.length;
    }
  }
  if (covered < surface.length) appendPlain(surface.slice(covered));
}

function renderSentence(entry: EntryWithKnown, view: ViewState): HTMLElement {
  const sentence = document.createElement("p");
  sentence.className = "sentence";
  const showFurigana = Boolean(view.showFurigana);
  const segments = parseHighlightSegments(entry.sentenceRaw);
  segments.forEach((segment, index) => {
    if (segment.highlighted && view.showHighlight) {
      // Occurrence ordinal among identical-text segments: the adapter marks
      // the nth match of the surface, so repeated targets stay reconciled.
      const ordinal = segments
        .slice(0, index)
        .filter((prior) => prior.text === segment.text).length;
      sentence.dataset.surface = segment.text;
      sentence.dataset.word = entry.word;
      sentence.dataset.surfaceIndex = String(ordinal);
      const span = document.createElement("span");
      span.className = "target-highlight";
      if (showFurigana && entry.furiganaRuns.length > 0) {
        appendFuriganaTarget(span, segment.text, entry.furiganaRuns, entry.word);
      } else {
        span.textContent = segment.text;
      }
      sentence.appendChild(span);
    } else {
      sentence.appendChild(document.createTextNode(segment.text));
    }
  });
  return sentence;
}

function appendBadges(header: HTMLElement, entry: EntryWithKnown): void {
  const badges = document.createElement("span");
  badges.className = "entry-badges";
  if (entry.knownByMigaku) {
    const badge = document.createElement("span");
    badge.className = "entry-badge entry-badge-migaku";
    badge.textContent = "Migaku known";
    badges.appendChild(badge);
  }
  if (entry.decision !== "unreviewed") {
    const badge = document.createElement("span");
    badge.className = "entry-badge entry-badge-decision";
    badge.textContent = `${DECISION_LABELS[entry.decision]}${entry.decisionSource === "anki" ? " · Anki" : ""}`;
    badges.appendChild(badge);
  }
  if (badges.childNodes.length > 0) header.appendChild(badges);
}

function appendDecisionButtons(actions: HTMLElement, entry: EntryWithKnown): void {
  for (const status of DECISION_STATUSES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "decision-button";
    button.textContent = DECISION_LABELS[status];
    button.dataset.word = entry.normalizedWord;
    button.dataset.decisionAction = status;
    button.setAttribute("aria-pressed", entry.decision === status ? "true" : "false");
    actions.appendChild(button);
  }
}

// Single merged actions row at the end of each entry. Button DOM (classes,
// data-word / data-decision-action / data-queue-action, aria-pressed) is
// identical to the pre-merge rows: controls.ts click delegation and the
// focus-restoration tiers select on those attributes.
function appendEntryActions(
  article: HTMLElement,
  entry: EntryWithKnown,
  options: EntryRenderOptions,
): void {
  const actions = document.createElement("div");
  actions.className = "entry-actions";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", `Actions for ${entry.word}`);

  appendDecisionButtons(actions, entry);

  if (options.queueMode === true) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "decision-button queue-remove";
    remove.textContent = "Remove from queue";
    remove.dataset.word = entry.normalizedWord;
    remove.dataset.queueAction = "remove";
    actions.appendChild(remove);
  } else {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "decision-button decision-reset";
    reset.textContent = "Reset";
    reset.dataset.word = entry.normalizedWord;
    reset.dataset.decisionAction = "unreviewed";
    reset.disabled = entry.decision === "unreviewed";
    actions.appendChild(reset);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "queue-toggle-button";
    toggle.textContent = options.queued === true ? QUEUE_QUEUED_LABEL : QUEUE_ADD_LABEL;
    toggle.dataset.word = entry.normalizedWord;
    toggle.dataset.queueAction = "toggle";
    toggle.setAttribute("aria-pressed", options.queued === true ? "true" : "false");
    actions.appendChild(toggle);
  }

  article.appendChild(actions);
}

function buildEntryHeader(
  entry: EntryWithKnown,
  view: ViewState,
  number: number | null,
): HTMLElement {
  const header = document.createElement("div");
  header.className = "entry-header";

  if (number !== null) {
    const numberEl = document.createElement("span");
    numberEl.className = "entry-number";
    numberEl.textContent = `${number}.`;
    header.appendChild(numberEl);
  }

  const target = document.createElement("div");
  target.className = "target-word";
  target.lang = "ja";
  if (view.showFurigana && entry.furiganaRuns.length > 0) {
    appendFuriganaTarget(target, entry.word, entry.furiganaRuns, entry.word);
  } else {
    target.textContent = entry.word;
  }

  const occurrences = document.createElement("span");
  occurrences.className = "occurrence-count";
  occurrences.textContent = `×${entry.occurrences}`;

  header.append(target, occurrences);
  appendBadges(header, entry);
  return header;
}

// Definitions render as a full-width row after the sentence, not inside the
// header: the header stays number/target/occurrences/badges only. When more
// than three definitions exist, the preview is followed by a native
// details/summary disclosure (keyboard operable, no title tooltip).
function buildEntryDefinitions(entry: EntryWithKnown, view: ViewState): HTMLElement | null {
  if (!entry.definitions || !view.showDefinitions) return null;
  const parts = entry.definitions
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const max = 3;
  const shown = parts.slice(0, max).join(", ");
  const truncated = parts.length > max;
  const definitions = document.createElement("div");
  definitions.className = "entry-definitions";
  definitions.textContent = truncated ? `${shown}, …` : shown;
  if (truncated) {
    const details = document.createElement("details");
    details.className = "entry-defs-details";
    const summary = document.createElement("summary");
    summary.textContent = "Show full definition";
    const full = document.createElement("div");
    full.className = "entry-defs-full";
    full.textContent = entry.definitions;
    details.append(summary, full);
    definitions.appendChild(details);
  }
  return definitions;
}

function buildSentenceBlock(entry: EntryWithKnown, view: ViewState): HTMLElement | null {
  if (!entry.hasSentence || !entry.sentenceRaw) return null;
  const sentence = renderSentence(entry, view);
  sentence.lang = "ja";
  return sentence;
}

// Audit order: header (number/target/occurrence/badges) → sentence →
// definitions → merged actions row last. Virtual-list rows reuse this node,
// so windowed rows get the same order automatically.
export function renderEntryNode(
  entry: EntryWithKnown,
  number: number,
  view: ViewState,
  options: EntryRenderOptions = {},
): HTMLElement {
  const article = document.createElement("article");
  article.className = "mining-entry";
  article.appendChild(buildEntryHeader(entry, view, number));
  const sentence = buildSentenceBlock(entry, view);
  if (sentence !== null) article.appendChild(sentence);
  const definitions = buildEntryDefinitions(entry, view);
  if (definitions !== null) article.appendChild(definitions);
  appendEntryActions(article, entry, options);
  return article;
}

export function renderReviewEntryNode(entry: EntryWithKnown, view: ViewState): HTMLElement {
  const article = document.createElement("article");
  article.className = "mining-entry review-entry";
  article.appendChild(buildEntryHeader(entry, view, null));
  const sentence = buildSentenceBlock(entry, view);
  if (sentence !== null) article.appendChild(sentence);
  const definitions = buildEntryDefinitions(entry, view);
  if (definitions !== null) article.appendChild(definitions);
  return article;
}
