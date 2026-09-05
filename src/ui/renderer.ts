import { parseHighlightSegments } from "../domain/text";
import type { EntryWithKnown, QueryResult, ViewState } from "../domain/types";
import type { AppState } from "../app/state";
import type { DomMap } from "./dom";

export interface Renderer {
  render(state: Readonly<AppState>): void;
}

const EMPTY_LOAD_MESSAGE = "Load a Jiten CSV above. Everything stays in this browser tab.";
const EMPTY_FILTER_MESSAGE = "No entries match the current filters.";

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
  for (const segment of parseHighlightSegments(entry.sentenceRaw)) {
    if (segment.highlighted && view.showHighlight) {
      sentence.dataset.surface = segment.text;
      sentence.dataset.word = entry.word;
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
  }
  return sentence;
}

export function renderEntryNode(entry: EntryWithKnown, number: number, view: ViewState): HTMLElement {
  const article = document.createElement("article");
  article.className = "mining-entry";

  const header = document.createElement("div");
  header.className = "entry-header";

  const numberEl = document.createElement("span");
  numberEl.className = "entry-number";
  numberEl.textContent = `${number}.`;

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

  header.append(numberEl, target, occurrences);
  if (entry.definitions && view.showDefinitions) {
    const parts = entry.definitions.split(",").map((part) => part.trim()).filter(Boolean);
    const max = 3;
    const shown = parts.slice(0, max).join(", ");
    const truncated = parts.length > max;
    const definitions = document.createElement("div");
    definitions.className = "entry-definitions";
    definitions.textContent = truncated ? `${shown}, …` : shown;
    if (truncated) {
      definitions.title = entry.definitions;
      definitions.style.cursor = "help";
    }
    header.insertBefore(definitions, occurrences);
  }
  article.appendChild(header);

  if (entry.hasSentence && entry.sentenceRaw) {
    const sentence = renderSentence(entry, view);
    sentence.lang = "ja";
    article.appendChild(sentence);
  }

  return article;
}

export function createRenderer(dom: DomMap): Renderer {
  const setPager = (result: QueryResult | null): void => {
    const page = result?.page ?? 0;
    const totalPages = result?.totalPages ?? 0;
    const pageText = `Page ${page} / ${totalPages}`;
    for (const node of [dom.topPage, dom.bottomPage, dom.stickyPage]) node.textContent = pageText;
    const atStart = page <= 1;
    const atEnd = page === 0 || page >= totalPages;
    for (const button of [dom.topPrev, dom.bottomPrev, dom.stickyPrev]) button.disabled = atStart;
    for (const button of [dom.topNext, dom.bottomNext, dom.stickyNext]) button.disabled = atEnd;
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
      empty.textContent = EMPTY_FILTER_MESSAGE;
      dom.resultsList.appendChild(empty);
      return;
    }
    const startIndex = state.result?.startIndex ?? 1;
    const fragment = document.createDocumentFragment();
    items.forEach((entry, index) => fragment.appendChild(renderEntryNode(entry, startIndex + index, state.view)));
    dom.resultsList.appendChild(fragment);
  };

  const syncControls = (state: Readonly<AppState>, hasData: boolean): void => {
    dom.filtersFieldset.disabled = !hasData;
    dom.searchInput.value = state.query.search;
    dom.stickySearch.value = state.query.search;
    dom.hideKnown.checked = state.query.hideKnown;
    dom.hideKnown.disabled = state.knownWords.size === 0;
    dom.stickyHideKnown.checked = state.query.hideKnown;
    dom.stickyHideKnown.disabled = state.knownWords.size === 0;
    dom.hideKanaOnly.checked = state.query.hideKanaOnly;
    dom.stickyHideKana.checked = state.query.hideKanaOnly;
    dom.showFurigana.checked = state.view.showFurigana;
    dom.stickyFurigana.checked = state.view.showFurigana;
    dom.pillHighlight.checked = state.view.pillHighlight;
    dom.stickyPill.checked = state.view.pillHighlight;
    dom.showHighlight.checked = state.view.showHighlight;
    dom.stickyHl.checked = state.view.showHighlight;
    dom.showDefinitions.checked = state.view.showDefinitions;
    dom.stickyDefs.checked = state.view.showDefinitions;
    dom.sentenceFilter.value = state.query.sentence;
    dom.stickySentence.value = state.query.sentence;
    dom.minOccurrences.value = String(state.query.minOccurrences);
    dom.stickyMin.value = String(state.query.minOccurrences);
    dom.sortSelect.value = state.query.sort;
    dom.stickySort.value = state.query.sort;
    dom.pageSize.value = String(state.query.pageSize);
    dom.stickyPageSize.value = String(state.query.pageSize);
    document.body.classList.toggle("hl-pill", state.view.pillHighlight);
  };

  return {
    render(state: Readonly<AppState>): void {
      const hasData = state.dataset !== null && state.dataset.entryCount > 0;
      syncControls(state, hasData);

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
    },
  };
}
