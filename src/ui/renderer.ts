import type { AppState } from "../app/state";
import { canonicalWord } from "../domain/text";
import type { QueryResult } from "../domain/types";
import type { DomMap } from "./dom";
import { createCoveragePanelView } from "./views/coverage-view";
import {
  type EntryRenderOptions,
  renderEntryNode,
  renderReviewEntryNode,
} from "./views/entry-view";
import {
  deriveFilterChips,
  type FilterChipKey,
  formatDecisionSummary,
  renderFilterChips,
} from "./views/filter-view";
import { QUEUE_COMPLETE_MESSAGE, renderQueueHeader } from "./views/queue-view";
import { renderReviewSurface } from "./views/review-view";

// Re-exported for existing callers (tests, virtual-list wiring in main.ts):
// entry rendering lives in views/entry-view.ts.
export {
  deriveFilterChips,
  type EntryRenderOptions,
  type FilterChipKey,
  formatDecisionSummary,
  renderEntryNode,
  renderReviewEntryNode,
};

export interface Renderer {
  render(state: Readonly<AppState>): void;
  toggleImportsExpanded(): void;
  toggleAdvancedPanel(): void;
  toggleCoveragePanel(): void;
}

const EMPTY_LOAD_MESSAGE = "Load a Jiten CSV above.";
const EMPTY_FILTER_MESSAGE = "No entries match the current filters.";
const EMPTY_FILTER_HINT = "Try removing a filter.";
const UNDO_BASE_LABEL = "Undo";

export const NO_EXPORT_MESSAGE = "No export this session";
// Audit: copy must not imply the exported download was retained — the line
// itself stays neutral and this tooltip carries the caveat.
export const BACKUP_FRESHNESS_TITLE = "Exporting does not guarantee the downloaded file was kept.";

// Backup freshness line copy: absolute short time only (HH:MM) when the
// export happened earlier today, short date + time otherwise. Simple absolute
// format by ruling — no relative "3 minutes ago" churn. Locale pinned to
// en-US to match the app's hardcoded English copy and keep output stable.
export function formatBackupFreshness(
  lastExportAt: string | null,
  changesSinceExport: number,
  now: Date = new Date(),
): string {
  if (lastExportAt === null) return NO_EXPORT_MESSAGE;
  const exported = new Date(lastExportAt);
  const time = exported.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const sameDay =
    exported.getFullYear() === now.getFullYear() &&
    exported.getMonth() === now.getMonth() &&
    exported.getDate() === now.getDate();
  const stamp = sameDay
    ? time
    : `${exported.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
  const changes = `${changesSinceExport.toLocaleString()} ${changesSinceExport === 1 ? "change" : "changes"}`;
  return `Last export: ${stamp} · ${changes} since export`;
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
  const coveragePanel = createCoveragePanelView(dom);
  // Identity of the last non-windowed list render: null until the first
  // render, then the (result, view, queue) signature that produced the
  // currently mounted rows. Result snapshots are cloned per publish, so the
  // result is compared by content signature, not reference.
  let itemsRendered: { resultSig: string; viewSig: string; queueSig: string } | null = null;
  let lastState: Readonly<AppState> | null = null;

  const resultSignature = (
    result: Readonly<AppState>["result"],
    datasetId: string | null,
  ): string => {
    if (result === null) return `null/${datasetId}`;
    // Entry ids are positional, so a same-shape re-import (edited CSV, same
    // counts) produces identical ids; the dataset id and each entry's word
    // disambiguate content changes from pure reference changes.
    const items = result.items
      .map(
        (item) =>
          `${item.id}·${item.word}·${item.decision}·${item.known}·${item.knownByMigaku}·${item.knownByDecision}·${item.occurrences}`,
      )
      .join(",");
    return `${datasetId}/${result.page}/${result.totalPages}/${result.totalEntries}/${result.startIndex}/${result.endIndex}/${String(result.pageSize)}/${result.knownCount}/${result.windowed}|${items}`;
  };

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
      // Windowed results own the list DOM (virtual list mounts spacers +
      // container straight into resultsList). Invalidate the paged skip
      // cache: without this, returning to a paged result whose signature
      // matches the pre-windowed render would skip the rebuild and leave
      // the virtual-list DOM mounted in paged mode.
      itemsRendered = null;
      return;
    }
    // Rebuild only when a render input actually changed. Coverage-only
    // publishes (loading/ready/error) share the same result content, view,
    // and queue; rebuilding anyway would detach the focused action button
    // after the focus-restoration intent has been spent, dropping focus to
    // <body> (and racing list clicks mid-rebuild).
    const viewSig = JSON.stringify(state.view);
    const queueSig = `${state.queue.mode}|${state.queue.normalizedWords.join("\n")}`;
    const resultSig = resultSignature(state.result, state.dataset?.id ?? null);
    const rendered = itemsRendered;
    if (
      rendered !== null &&
      rendered.resultSig === resultSig &&
      rendered.viewSig === viewSig &&
      rendered.queueSig === queueSig &&
      dom.resultsList.childElementCount > 0
    ) {
      return;
    }
    itemsRendered = { resultSig, viewSig, queueSig };
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
      if (state.queue.mode === "queue") {
        empty.textContent = QUEUE_COMPLETE_MESSAGE;
      } else {
        empty.textContent = EMPTY_FILTER_MESSAGE;
        // Filtered-empty recovery: the chips row (rendered in the results
        // head regardless) is the single source of removable filters — the
        // hint just points at it; no duplicate chip DOM here.
        const hint = document.createElement("p");
        hint.className = "empty-hint";
        hint.textContent = EMPTY_FILTER_HINT;
        empty.appendChild(hint);
      }
      dom.resultsList.appendChild(empty);
      return;
    }
    const queueMode = state.queue.mode === "queue";
    // Queue contents are canonical lowercase keys; imported entries keep their
    // original case, so compare on the entry's lowercase identity.
    const queued = new Set(state.queue.normalizedWords);
    const startIndex = state.result?.startIndex ?? 1;
    const fragment = document.createDocumentFragment();
    items.forEach((entry, index) => {
      fragment.appendChild(
        renderEntryNode(entry, startIndex + index, state.view, {
          queueMode,
          queued: queued.has(canonicalWord(entry.normalizedWord)),
        }),
      );
    });
    dom.resultsList.appendChild(fragment);
  };

  const syncControls = (state: Readonly<AppState>, hasData: boolean): void => {
    const datasetId = state.dataset?.id ?? null;
    if (datasetId !== advancedDatasetId) {
      advancedDatasetId = datasetId;
      advancedExpanded = false;
    }
    dom.advancedToggle.disabled = !hasData;
    const advancedVisible = hasData && advancedExpanded;
    dom.advancedPanel.hidden = !advancedVisible;
    // Mirrors panel visibility so CSS can size scroll-margin to the expanded
    // toolbar (body.advanced-open #resultsHeading).
    document.body.classList.toggle("advanced-open", advancedVisible);
    dom.advancedToggle.setAttribute("aria-expanded", advancedExpanded ? "true" : "false");
    dom.stickySearch.value = state.query.search;
    const hasKnownSource =
      state.knownWords.size > 0 ||
      [...state.wordDecisions.values()].some((entryDecision) => entryDecision.status === "known");
    dom.hideKnown.checked = state.query.hideKnown;
    dom.hideKnown.disabled = !hasKnownSource;
    dom.hideKanaOnly.checked = state.query.hideKanaOnly;
    dom.showFurigana.checked = state.view.showFurigana;
    dom.pillHighlight.checked = state.view.pillHighlight;
    dom.showHighlight.checked = state.view.showHighlight;
    dom.showDefinitions.checked = state.view.showDefinitions;
    dom.sentenceSize.value = state.view.sentenceSize;
    dom.density.value = state.view.density;
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
    // Reading display preferences: a body class exists ONLY when a
    // preference moves away from its default, so default rendering keeps
    // the exact current look (no class, no CSS override).
    document.body.classList.toggle("sent-size-lg", state.view.sentenceSize === "large");
    document.body.classList.toggle("density-compact", state.view.density === "compact");
  };

  const renderImportPanel = (state: Readonly<AppState>): void => {
    const importKey =
      state.dataset === null ? null : `${state.dataset.id}::${state.knownWordsName ?? ""}`;
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
        knownLineEl.textContent =
          state.knownWordsName === null
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
    dom.stickyTitle.textContent =
      state.dataset === null ? "Jiten media" : state.dataset.name.replace(/\.csv$/i, "");

    dom.jitenStatus.textContent =
      state.dataset === null ? "No CSV loaded" : `${state.dataset.sourceName} ✓`;
    dom.knownStatus.textContent =
      state.knownWordsName === null
        ? "Optional · no list loaded"
        : `${state.knownWordsName} ✓ · ${state.knownWords.size.toLocaleString()} entries`;
    dom.knownStatus.classList.toggle("optional", state.knownWordsName === null);

    // Backup freshness line in the Data area: session-only signal, always
    // visible (the no-export message is itself informative). Title re-set
    // here so the no-retention caveat survives even if the static HTML
    // attribute is dropped.
    dom.backupFreshness.title = BACKUP_FRESHNESS_TITLE;
    dom.backupFreshness.textContent = formatBackupFreshness(
      state.lastExportAt,
      state.changesSinceExport,
    );

    dom.resultStats.textContent = !hasData
      ? "Load a Jiten CSV to begin."
      : `Loaded ${state.dataset.entryCount.toLocaleString()} · ${(state.result?.totalEntries ?? 0).toLocaleString()} currently shown${state.knownWords.size > 0 ? ` · ${(state.result?.knownCount ?? 0).toLocaleString()} match Migaku known words` : ""}`;

    // Compact decision summary under the stats line: hidden only when there
    // is nothing to summarize at all (no dataset, no decisions, no known
    // words). Lives outside #resultsList, so it re-derives on every publish.
    const summaryVisible = hasData || state.wordDecisions.size > 0 || state.knownWords.size > 0;
    dom.decisionSummary.hidden = !summaryVisible;
    dom.decisionSummary.textContent = summaryVisible
      ? formatDecisionSummary(state.wordDecisions, state.knownWords.size)
      : "";

    setPager(state.result);
    coveragePanel.render(state, hasData);
    renderFilterChips(dom, state, hasData);
    renderItems(state, hasData);
    renderReviewSurface(dom, state);

    // Results-head undo button mirrors state.undo; disabled without a
    // record, labeled with the record when one exists.
    dom.undoButton.disabled = !state.undo.available;
    dom.undoButton.textContent =
      state.undo.available && state.undo.label !== null ? state.undo.label : UNDO_BASE_LABEL;

    renderQueueHeader(dom, state);
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
    toggleCoveragePanel(): void {
      coveragePanel.toggle();
      if (lastState !== null) renderState(lastState);
    },
  };
}
