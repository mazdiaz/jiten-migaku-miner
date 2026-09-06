export interface DomMap {
  readonly jitenInput: HTMLInputElement;
  readonly knownInput: HTMLInputElement;
  readonly jitenDropzone: HTMLElement;
  readonly knownDropzone: HTMLElement;
  readonly jitenStatus: HTMLElement;
  readonly knownStatus: HTMLElement;
  readonly clearData: HTMLButtonElement;
  readonly exportBackup: HTMLButtonElement;
  readonly restoreBackup: HTMLButtonElement;
  readonly restoreBackupInput: HTMLInputElement;
  readonly backupStatus: HTMLElement;
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
  readonly reviewButton: HTMLButtonElement;
  readonly reviewOverlay: HTMLElement;
  readonly reviewPanel: HTMLElement;
  readonly reviewHeading: HTMLElement;
  readonly reviewProgress: HTMLElement;
  readonly reviewContent: HTMLElement;
  readonly reviewComplete: HTMLElement;
  readonly reviewReturn: HTMLButtonElement;
  readonly reviewExit: HTMLButtonElement;
  readonly reviewKnown: HTMLButtonElement;
  readonly reviewMined: HTMLButtonElement;
  readonly reviewSkip: HTMLButtonElement;
  readonly reviewLater: HTMLButtonElement;
  readonly queueToggle: HTMLButtonElement;
  readonly queueHeader: HTMLElement;
  readonly queueHeading: HTMLElement;
  readonly queueStats: HTMLElement;
  readonly exitQueue: HTMLButtonElement;
  readonly clearQueue: HTMLButtonElement;
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
    exportBackup: byId<HTMLButtonElement>("exportBackup"),
    restoreBackup: byId<HTMLButtonElement>("restoreBackup"),
    restoreBackupInput: byId<HTMLInputElement>("restoreBackupInput"),
    backupStatus: byId<HTMLElement>("backupStatus"),
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
    reviewButton: byId<HTMLButtonElement>("reviewButton"),
    reviewOverlay: byId<HTMLElement>("reviewOverlay"),
    reviewPanel: byId<HTMLElement>("reviewPanel"),
    reviewHeading: byId<HTMLElement>("reviewHeading"),
    reviewProgress: byId<HTMLElement>("reviewProgress"),
    reviewContent: byId<HTMLElement>("reviewContent"),
    reviewComplete: byId<HTMLElement>("reviewComplete"),
    reviewReturn: byId<HTMLButtonElement>("reviewReturn"),
    reviewExit: byId<HTMLButtonElement>("reviewExit"),
    reviewKnown: byId<HTMLButtonElement>("reviewKnown"),
    reviewMined: byId<HTMLButtonElement>("reviewMined"),
    reviewSkip: byId<HTMLButtonElement>("reviewSkip"),
    reviewLater: byId<HTMLButtonElement>("reviewLater"),
    queueToggle: byId<HTMLButtonElement>("queueToggle"),
    queueHeader: byId<HTMLElement>("queueHeader"),
    queueHeading: byId<HTMLElement>("queueHeading"),
    queueStats: byId<HTMLElement>("queueStats"),
    exitQueue: byId<HTMLButtonElement>("exitQueue"),
    clearQueue: byId<HTMLButtonElement>("clearQueue"),
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
