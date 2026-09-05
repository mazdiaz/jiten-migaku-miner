export type FuriganaRun = { text: string; reading: string | null };
export type HighlightSegment = { text: string; highlighted: boolean };

export interface Entry {
  id: string;
  originalIndex: number;
  word: string;
  normalizedWord: string;
  occurrences: number;
  sentenceRaw: string;
  hasSentence: boolean;
  definitions: string;
  furiganaRuns: FuriganaRun[];
}

export interface ParsedJitenCsv {
  headers: string[];
  entries: Entry[];
  skippedRows: number;
}

export type ImportErrorCode = "empty-file" | "malformed-csv" | "missing-column";

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

export type PageSize = number | "all";

export interface QueryState {
  search: string;
  hideKnown: boolean;
  hideKanaOnly: boolean;
  sentence: "any" | "has" | "none";
  minOccurrences: number;
  sort: "occ-desc" | "occ-asc" | "original";
  pageSize: PageSize;
  page: number;
}

export interface ViewState {
  showFurigana: boolean;
  pillHighlight: boolean;
  showHighlight: boolean;
  showDefinitions: boolean;
}

export interface QueryWindow {
  start: number;
  size: number;
}

export type EntryWithKnown = Entry & { known: boolean };

export interface QueryResult {
  items: EntryWithKnown[];
  page: number;
  totalPages: number;
  totalEntries: number;
  startIndex: number;
  endIndex: number;
  pageSize: PageSize;
  knownCount: number;
  windowed: boolean;
}
