import { canonicalWord, parseHighlightSegments } from "../domain/text";
import type { EntryWithKnown, QueryResult, ViewState, WordDecisionStatus } from "../domain/types";
import type { AppState } from "../app/state";
import type { DomMap } from "./dom";

export interface Renderer {
  render(state: Readonly<AppState>): void;
  toggleImportsExpanded(): void;
  toggleAdvancedPanel(): void;
}

const DECISION_LABELS: Record<WordDecisionStatus, string> = {
  known: "Known",
  mined: "Mined",
  skip: "Skip",
  later: "Later",
};

const DECISION_STATUSES: readonly WordDecisionStatus[] = ["known", "mined", "skip", "later"];

const EMPTY_LOAD_MESSAGE = "Load a Jiten CSV above.";
const EMPTY_FILTER_MESSAGE = "No entries match the current filters.";
const REVIEW_COMPLETE_MESSAGE = "No unreviewed candidates remain for the current filters.";
const QUEUE_COMPLETE_MESSAGE = "Mining queue complete.";
const QUEUE_ADD_LABEL = "+ Queue";
const QUEUE_QUEUED_LABEL = "✓ Queued";

export interface EntryRenderOptions {
  queued?: boolean;
  queueMode?: boolean;
}

function renderReviewSurface(dom: DomMap, state: Readonly<AppState>): void {
  const review = state.review;
  dom.reviewOverlay.hidden = !review.active;
  document.body.classList.toggle("review-open", review.active);
  // Inert the background shell so background controls are unfocusable while
  // the modal review overlay is open; the overlay lives outside main.app-shell.
  document.querySelector("main.app-shell")?.toggleAttribute("inert", review.active);
  dom.reviewButton.disabled = state.dataset === null || state.status === "loading" || review.active;

  const triageButtons = [dom.reviewKnown, dom.reviewMined, dom.reviewSkip, dom.reviewLater];
  for (const button of triageButtons) button.disabled = review.status !== "ready";

  const complete = review.active && review.status === "complete";
  dom.reviewComplete.hidden = !complete;
  dom.reviewContent.hidden = !review.active || complete;

  if (!review.active) {
    dom.reviewContent.textContent = "";
    dom.reviewProgress.textContent = "";
    return;
  }

  dom.reviewProgress.textContent = `${review.processed} processed · ${review.remaining} remaining`;

  // The error renders whenever it is set, regardless of status: a failed
  // decision returns to "ready" with the card kept, so retry stays possible.
  const appendReviewError = (message: string): void => {
    const error = document.createElement("div");
    error.className = "review-error";
    error.setAttribute("role", "alert");
    error.textContent = message;
    dom.reviewContent.appendChild(error);
  };

  if (review.current === null) {
    if (review.errorMessage !== null) {
      dom.reviewContent.textContent = "";
      appendReviewError(review.errorMessage);
      return;
    }
    dom.reviewContent.textContent = review.status === "loading" ? "Loading review queue…" : REVIEW_COMPLETE_MESSAGE;
    return;
  }
  dom.reviewContent.textContent = "";
  dom.reviewContent.appendChild(renderReviewEntryNode(review.current, state.view));
  if (review.errorMessage !== null) appendReviewError(review.errorMessage);
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
    badge.textContent = DECISION_LABELS[entry.decision];
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
function appendEntryActions(article: HTMLElement, entry: EntryWithKnown, options: EntryRenderOptions): void {
  const actions = document.createElement("div");
  actions.className = options.queueMode === true
    ? "entry-actions entry-queue-actions"
    : "entry-actions";
  actions.setAttribute("role", "toolbar");
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

function buildEntryHeader(entry: EntryWithKnown, view: ViewState, number: number | null): HTMLElement {
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
  const parts = entry.definitions.split(",").map((part) => part.trim()).filter(Boolean);
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

export function createRenderer(dom: DomMap): Renderer {
  // Import-panel expansion is renderer-internal UI state (not AppState):
  // collapsed-by-default after a clean load, expandable via the Change Files
  // button. The flag resets whenever the import identity (dataset id +
  // known-words name) changes, so a new import re-collapses the panel.
  let importsExpanded = false;
  let importsKey: string | null = null;
  let importsKeySeen = false;
  // Advanced-panel expansion mirrors the import-panel pattern: UI-local state
  // collapsed by default, toggled by #advancedToggle, and reset whenever the
  // dataset identity changes so each import starts collapsed.
  let advancedExpanded = false;
  let advancedDatasetId: string | null = null;
  let lastState: Readonly<AppState> | null = null;

  const setPager = (result: QueryResult | null): void => {
    const page = result?.page ?? 0;
    const totalPages = result?.totalPages ?? 0;
    const pageText = `Page ${page} / ${totalPages}`;
    for (const node of [dom.bottomPage, dom.stickyPage]) node.textContent = pageText;
    const atStart = page <= 1;
    const atEnd = page === 0 || page >= totalPages;
    for (const button of [dom.bottomPrev, dom.stickyPrev]) button.disabled = atStart;
    for (const button of [dom.bottomNext, dom.stickyNext]) button.disabled = atEnd;
  };

  const renderItems = (state: Readonly<AppState>, hasData: boolean): void => {
    if (state.result?.windowed === true && state.result.totalEntries > 0) {
      return;
    }
    dom.resultsList.textContent = "";
    if (!hasData) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = EMPTY_LOAD_MESSAGE;
      dom.resultsList.appendChild(empty);
      return;
    }
    const items = state.result?.items ?? [];
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = state.queue.mode === "queue" ? QUEUE_COMPLETE_MESSAGE : EMPTY_FILTER_MESSAGE;
      dom.resultsList.appendChild(empty);
      return;
    }
    const queueMode = state.queue.mode === "queue";
    // Queue contents are canonical lowercase keys; imported entries keep their
    // original case, so compare on the entry's lowercase identity.
    const queued = new Set(state.queue.normalizedWords);
    const startIndex = state.result?.startIndex ?? 1;
    const fragment = document.createDocumentFragment();
    items.forEach((entry, index) => fragment.appendChild(
      renderEntryNode(entry, startIndex + index, state.view, {
        queueMode,
        queued: queued.has(canonicalWord(entry.normalizedWord)),
      }),
    ));
    dom.resultsList.appendChild(fragment);
  };

  const syncControls = (state: Readonly<AppState>, hasData: boolean): void => {
    const datasetId = state.dataset?.id ?? null;
    if (datasetId !== advancedDatasetId) {
      advancedDatasetId = datasetId;
      advancedExpanded = false;
    }
    dom.advancedToggle.disabled = !hasData;
    dom.advancedPanel.hidden = !(hasData && advancedExpanded);
    dom.advancedToggle.setAttribute("aria-expanded", advancedExpanded ? "true" : "false");
    dom.stickySearch.value = state.query.search;
    const hasKnownSource = state.knownWords.size > 0
      || [...state.wordDecisions.values()].some((entryDecision) => entryDecision.status === "known");
    dom.hideKnown.checked = state.query.hideKnown;
    dom.hideKnown.disabled = !hasKnownSource;
    dom.hideKanaOnly.checked = state.query.hideKanaOnly;
    dom.showFurigana.checked = state.view.showFurigana;
    dom.pillHighlight.checked = state.view.pillHighlight;
    dom.showHighlight.checked = state.view.showHighlight;
    dom.showDefinitions.checked = state.view.showDefinitions;
    dom.sentenceFilter.value = state.query.sentence;
    dom.decisionFilter.value = state.query.decision;
    dom.minOccurrences.value = String(state.query.minOccurrences);
    dom.sortSelect.value = state.query.sort;
    dom.pageSize.value = String(state.query.pageSize);
    const queueCount = state.queue.normalizedWords.length;
    dom.queueToggle.textContent = `Queue (${queueCount})`;
    dom.queueToggle.disabled = hasData === false || queueCount === 0;
    dom.queueToggle.setAttribute("aria-pressed", state.queue.mode === "queue" ? "true" : "false");
    dom.clearQueue.disabled = queueCount === 0;
    document.body.classList.toggle("hl-pill", state.view.pillHighlight);
    document.body.classList.toggle("queue-mode", state.queue.mode === "queue");
  };

  const renderImportPanel = (state: Readonly<AppState>): void => {
    const importKey = state.dataset === null ? null : `${state.dataset.id}::${state.knownWordsName ?? ""}`;
    if (!importsKeySeen || importKey !== importsKey) {
      importsKey = importKey;
      importsKeySeen = true;
      importsExpanded = false;
    }

    const collapsed = state.dataset !== null && state.errorMessage === null && !importsExpanded;
    dom.importGrid.hidden = collapsed;
    dom.importSummary.hidden = !collapsed;
    if (collapsed) {
      const datasetLine = dom.importSummary.querySelector<HTMLElement>(".import-dataset-line");
      const knownLineEl = dom.importSummary.querySelector<HTMLElement>(".import-known-line");
      if (datasetLine !== null) {
        datasetLine.textContent = `${state.dataset.sourceName} · ${state.dataset.entryCount.toLocaleString()} entries`;
      }
      if (knownLineEl !== null) {
        knownLineEl.textContent = state.knownWordsName === null
          ? "No known list"
          : `${state.knownWordsName} · ${state.knownWords.size.toLocaleString()} entries`;
      }
    }
    dom.changeFiles.hidden = state.dataset === null;
    dom.changeFiles.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };

  const renderState = (state: Readonly<AppState>): void => {
    lastState = state;
    const hasData = state.dataset !== null && state.dataset.entryCount > 0;
    syncControls(state, hasData);

    renderImportPanel(state);

    if (state.errorMessage === null) {
      dom.errorBox.textContent = "";
      dom.errorBox.hidden = true;
    } else {
      dom.errorBox.textContent = state.errorMessage;
      dom.errorBox.hidden = false;
    }

    dom.stickyToolbar.hidden = !hasData;
    dom.stickyTitle.textContent = state.dataset === null
      ? "Jiten media"
      : state.dataset.name.replace(/\.csv$/i, "");

    dom.jitenStatus.textContent = state.dataset === null
      ? "No CSV loaded"
      : `${state.dataset.sourceName} ✓`;
    dom.knownStatus.textContent = state.knownWordsName === null
      ? "Optional · no list loaded"
      : `${state.knownWordsName} ✓ · ${state.knownWords.size.toLocaleString()} entries`;
    dom.knownStatus.classList.toggle("optional", state.knownWordsName === null);

    dom.resultStats.textContent = !hasData
      ? "Load a Jiten CSV to begin."
      : `Loaded ${state.dataset.entryCount.toLocaleString()} · ${(state.result?.totalEntries ?? 0).toLocaleString()} currently shown${state.knownWords.size > 0 ? ` · ${(state.result?.knownCount ?? 0).toLocaleString()} match Migaku known words` : ""}`;

    setPager(state.result);
    renderItems(state, hasData);
    renderReviewSurface(dom, state);

    const queueMode = state.queue.mode === "queue";
    dom.queueHeader.hidden = !queueMode;
    if (queueMode) {
      dom.queueHeading.textContent = `Mining Queue — ${state.queue.normalizedWords.length} words`;
      dom.queueStats.textContent = state.queue.normalizedWords.length === 0
        ? QUEUE_COMPLETE_MESSAGE
        : "Work through each queued word, then exit to return to the full list.";
    }
  };

  return {
    render: renderState,
    toggleImportsExpanded(): void {
      importsExpanded = !importsExpanded;
      if (lastState !== null) renderState(lastState);
    },
    toggleAdvancedPanel(): void {
      advancedExpanded = !advancedExpanded;
      if (lastState !== null) renderState(lastState);
    },
  };
}
