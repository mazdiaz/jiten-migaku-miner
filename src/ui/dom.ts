export interface DomMap {
  readonly jitenInput: HTMLInputElement;
  readonly knownInput: HTMLInputElement;
  readonly jitenDropzone: HTMLElement;
  readonly knownDropzone: HTMLElement;
  readonly jitenStatus: HTMLElement;
  readonly knownStatus: HTMLElement;
  readonly clearData: HTMLButtonElement;
  readonly errorBox: HTMLElement;
  readonly filtersFieldset: HTMLFieldSetElement;
  readonly searchInput: HTMLInputElement;
  readonly stickySearch: HTMLInputElement;
  readonly hideKnown: HTMLInputElement;
  readonly hideKanaOnly: HTMLInputElement;
  readonly showFurigana: HTMLInputElement;
  readonly pillHighlight: HTMLInputElement;
  readonly stickyPill: HTMLInputElement;
  readonly showHighlight: HTMLInputElement;
  readonly stickyHl: HTMLInputElement;
  readonly showDefinitions: HTMLInputElement;
  readonly stickyDefs: HTMLInputElement;
  readonly sentenceFilter: HTMLSelectElement;
  readonly decisionFilter: HTMLSelectElement;
  readonly minOccurrences: HTMLInputElement;
  readonly sortSelect: HTMLSelectElement;
  readonly pageSize: HTMLSelectElement;
  readonly results: HTMLElement;
  readonly resultsHeading: HTMLElement;
  readonly resultStats: HTMLElement;
  readonly resultsList: HTMLElement;
  readonly stickyToolbar: HTMLElement;
  readonly stickyTitle: HTMLElement;
  readonly stickySort: HTMLSelectElement;
  readonly stickySentence: HTMLSelectElement;
  readonly stickyDecision: HTMLSelectElement;
  readonly stickyMin: HTMLInputElement;
  readonly stickyHideKnown: HTMLInputElement;
  readonly stickyHideKana: HTMLInputElement;
  readonly stickyFurigana: HTMLInputElement;
  readonly stickyPageSize: HTMLSelectElement;
  readonly stickyPrev: HTMLButtonElement;
  readonly stickyNext: HTMLButtonElement;
  readonly stickyPage: HTMLElement;
  readonly topPrev: HTMLButtonElement;
  readonly topNext: HTMLButtonElement;
  readonly topPage: HTMLElement;
  readonly bottomPrev: HTMLButtonElement;
  readonly bottomNext: HTMLButtonElement;
  readonly bottomPage: HTMLElement;
}

export function getDomMap(): DomMap {
  const byId = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`Missing required element: #${id}`);
    return found as T;
  };

  return {
    jitenInput: byId<HTMLInputElement>("jitenInput"),
    knownInput: byId<HTMLInputElement>("knownInput"),
    jitenDropzone: byId<HTMLElement>("jitenDropzone"),
    knownDropzone: byId<HTMLElement>("knownDropzone"),
    jitenStatus: byId<HTMLElement>("jitenStatus"),
    knownStatus: byId<HTMLElement>("knownStatus"),
    clearData: byId<HTMLButtonElement>("clearData"),
    errorBox: byId<HTMLElement>("errorBox"),
    filtersFieldset: byId<HTMLFieldSetElement>("filtersFieldset"),
    searchInput: byId<HTMLInputElement>("searchInput"),
    stickySearch: byId<HTMLInputElement>("stickySearch"),
    hideKnown: byId<HTMLInputElement>("hideKnown"),
    hideKanaOnly: byId<HTMLInputElement>("hideKanaOnly"),
    showFurigana: byId<HTMLInputElement>("showFurigana"),
    pillHighlight: byId<HTMLInputElement>("pillHighlight"),
    stickyPill: byId<HTMLInputElement>("stickyPill"),
    showHighlight: byId<HTMLInputElement>("showHighlight"),
    stickyHl: byId<HTMLInputElement>("stickyHl"),
    showDefinitions: byId<HTMLInputElement>("showDefinitions"),
    stickyDefs: byId<HTMLInputElement>("stickyDefs"),
    sentenceFilter: byId<HTMLSelectElement>("sentenceFilter"),
    decisionFilter: byId<HTMLSelectElement>("decisionFilter"),
    minOccurrences: byId<HTMLInputElement>("minOccurrences"),
    sortSelect: byId<HTMLSelectElement>("sortSelect"),
    pageSize: byId<HTMLSelectElement>("pageSize"),
    results: byId<HTMLElement>("results"),
    resultsHeading: byId<HTMLElement>("resultsHeading"),
    resultStats: byId<HTMLElement>("resultStats"),
    resultsList: byId<HTMLElement>("resultsList"),
    stickyToolbar: byId<HTMLElement>("stickyToolbar"),
    stickyTitle: byId<HTMLElement>("stickyTitle"),
    stickySort: byId<HTMLSelectElement>("stickySort"),
    stickySentence: byId<HTMLSelectElement>("stickySentence"),
    stickyDecision: byId<HTMLSelectElement>("stickyDecision"),
    stickyMin: byId<HTMLInputElement>("stickyMin"),
    stickyHideKnown: byId<HTMLInputElement>("stickyHideKnown"),
    stickyHideKana: byId<HTMLInputElement>("stickyHideKana"),
    stickyFurigana: byId<HTMLInputElement>("stickyFurigana"),
    stickyPageSize: byId<HTMLSelectElement>("stickyPageSize"),
    stickyPrev: byId<HTMLButtonElement>("stickyPrev"),
    stickyNext: byId<HTMLButtonElement>("stickyNext"),
    stickyPage: byId<HTMLElement>("stickyPage"),
    topPrev: byId<HTMLButtonElement>("topPrev"),
    topNext: byId<HTMLButtonElement>("topNext"),
    topPage: byId<HTMLElement>("topPage"),
    bottomPrev: byId<HTMLButtonElement>("bottomPrev"),
    bottomNext: byId<HTMLButtonElement>("bottomNext"),
    bottomPage: byId<HTMLElement>("bottomPage"),
  };
}
