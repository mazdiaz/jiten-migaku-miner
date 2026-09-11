import { type AnkiWordStatus, resolveEffectiveDecision } from "./anki";
import { canonicalWord, isKanaOnly, normalizeText, sentencePlain } from "./text";
import type {
  Entry,
  EntryWithKnown,
  PageSize,
  QueryResult,
  QueryState,
  QueryWindow,
  WordDecision,
} from "./types";

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function occurrenceCount(entry: EntryWithKnown): number {
  return nonNegative(Number(entry.occurrences));
}

function originalOrder(a: EntryWithKnown, b: EntryWithKnown): number {
  return a.originalIndex - b.originalIndex;
}

export function applyKnownWords(
  entries: readonly Entry[],
  knownWords: ReadonlySet<string>,
  decisions: ReadonlyMap<string, WordDecision> = new Map(),
  ankiStatuses: ReadonlyMap<string, AnkiWordStatus> = new Map(),
): EntryWithKnown[] {
  const knownCanonical = new Set<string>();
  for (const word of knownWords) knownCanonical.add(canonicalWord(word));
  const decisionsCanonical = new Map<string, WordDecision>();
  for (const [word, decision] of decisions) {
    decisionsCanonical.set(canonicalWord(word), decision);
  }
  const ankiStatusesCanonical = new Map<string, AnkiWordStatus>();
  for (const [word, status] of ankiStatuses) {
    ankiStatusesCanonical.set(canonicalWord(word), status);
  }

  return entries.map((entry) => {
    const canonical = canonicalWord(entry.normalizedWord);
    const knownByMigaku = knownCanonical.has(canonical);
    const manualStatus = decisionsCanonical.get(canonical)?.status ?? null;
    const ankiStatus = ankiStatusesCanonical.get(canonical) ?? null;
    const effective = resolveEffectiveDecision(manualStatus, ankiStatus);
    const knownByDecision = effective.source === "manual" && effective.decision === "known";
    const knownByAnki = effective.source === "anki" && effective.decision === "known";
    return {
      ...entry,
      known: knownByMigaku || knownByDecision || knownByAnki,
      decision: effective.decision,
      decisionSource: effective.source,
      knownByMigaku,
      knownByDecision,
      knownByAnki,
    };
  });
}

export function filterEntries(
  entries: readonly EntryWithKnown[],
  query: QueryState,
): EntryWithKnown[] {
  const search = normalizeText(query.search).toLocaleLowerCase();
  const minOccurrences = nonNegative(query.minOccurrences);

  return entries.filter((entry) => {
    if (search) {
      const wordMatch = normalizeText(entry.normalizedWord).toLocaleLowerCase();
      const rawWordMatch = normalizeText(entry.word).toLocaleLowerCase();
      const sentenceMatch = sentencePlain(entry.sentenceRaw).toLocaleLowerCase();
      if (
        !wordMatch.includes(search) &&
        !rawWordMatch.includes(search) &&
        !sentenceMatch.includes(search)
      )
        return false;
    }
    if (query.hideKnown && entry.known) return false;
    if (query.hideKanaOnly && isKanaOnly(entry.normalizedWord)) return false;
    if (query.sentence === "has" && !entry.hasSentence) return false;
    if (query.sentence === "none" && entry.hasSentence) return false;
    if (occurrenceCount(entry) < minOccurrences) return false;
    if (query.decision !== "all" && entry.decision !== query.decision) return false;
    return true;
  });
}

export function sortEntries(
  entries: readonly EntryWithKnown[],
  mode: QueryState["sort"],
): EntryWithKnown[] {
  const sorted = Array.from(entries);

  if (mode === "occ-asc") {
    sorted.sort((a, b) => occurrenceCount(a) - occurrenceCount(b) || originalOrder(a, b));
  } else if (mode === "original") {
    sorted.sort(originalOrder);
  } else {
    sorted.sort((a, b) => occurrenceCount(b) - occurrenceCount(a) || originalOrder(a, b));
  }

  return sorted;
}

function emptyResult<T>(pageSize: PageSize, windowed = false): PaginatedEntries<T> {
  return {
    items: [],
    page: 0,
    totalPages: 0,
    totalEntries: 0,
    startIndex: 0,
    endIndex: 0,
    pageSize,
    knownCount: 0,
    windowed,
  };
}

function windowBounds(totalEntries: number, window: QueryWindow): { start: number; end: number } {
  const start = Math.min(totalEntries, Math.floor(nonNegative(window.start)));
  const size = Math.floor(nonNegative(window.size));
  return { start, end: Math.min(totalEntries, start + size) };
}

export type PaginatedEntries<T> = Omit<QueryResult, "items"> & { items: T[] };

export interface PaginateEntriesOptions {
  /**
   * Skip the per-item `known` tally. Index-list callers (the worker passes
   * raw entry indexes) always override `knownCount` from their own scan, so
   * the decorated count is dead work for them. Defaults to true so existing
   * EntryWithKnown callers keep the computed `knownCount`.
   */
  countKnown?: boolean;
}

export function paginateEntries<T>(
  entries: readonly T[],
  page: number,
  pageSize: PageSize,
  window?: QueryWindow,
  options?: PaginateEntriesOptions,
): PaginatedEntries<T> {
  const countKnown = options?.countKnown !== false;
  // Array inputs are never mutated below and every returned items array is a
  // fresh slice, so arrays can be used directly instead of being copied.
  const source = Array.isArray(entries) ? entries : Array.from(entries);
  const totalEntries = source.length;
  if (totalEntries === 0)
    return emptyResult<T>(pageSize, pageSize === "all" && window !== undefined);

  // Item-type-agnostic so callers may paginate raw index lists; the worker
  // passes entry indexes with countKnown disabled and overrides knownCount
  // from its own scan.
  const knownCount = countKnown
    ? source.reduce((count, entry) => count + ((entry as EntryWithKnown).known ? 1 : 0), 0)
    : 0;
  if (pageSize === "all") {
    if (window !== undefined) {
      const bounds = windowBounds(totalEntries, window);
      const items = source.slice(bounds.start, bounds.end);
      return {
        items,
        page: 1,
        totalPages: 1,
        totalEntries,
        startIndex: items.length > 0 ? bounds.start + 1 : 0,
        endIndex: items.length > 0 ? bounds.end : 0,
        pageSize: "all",
        knownCount,
        windowed: true,
      };
    }

    return {
      items: source.slice(),
      page: 1,
      totalPages: 1,
      totalEntries,
      startIndex: 1,
      endIndex: totalEntries,
      pageSize: "all",
      knownCount,
      windowed: false,
    };
  }

  const numericSize = Math.max(1, Number.parseInt(String(pageSize), 10) || 50);
  const totalPages = Math.max(1, Math.ceil(totalEntries / numericSize));
  const numericPage = Number.parseInt(String(page), 10) || 1;
  const safePage = Math.min(totalPages, Math.max(1, numericPage));
  const start = (safePage - 1) * numericSize;
  const end = Math.min(start + numericSize, totalEntries);

  return {
    items: source.slice(start, end),
    page: safePage,
    totalPages,
    totalEntries,
    startIndex: start + 1,
    endIndex: end,
    pageSize: numericSize,
    knownCount,
    windowed: false,
  };
}

export function queryEntries(
  entries: readonly Entry[],
  knownWords: ReadonlySet<string>,
  query: QueryState,
  window?: QueryWindow,
  decisions: ReadonlyMap<string, WordDecision> = new Map(),
  ankiStatuses: ReadonlyMap<string, AnkiWordStatus> = new Map(),
): QueryResult {
  const withKnown = applyKnownWords(entries, knownWords, decisions, ankiStatuses);
  const knownCount = withKnown.reduce((count, entry) => count + (entry.known ? 1 : 0), 0);
  const filtered = filterEntries(withKnown, query);
  const sorted = sortEntries(filtered, query.sort);
  return {
    ...paginateEntries(sorted, query.page, query.pageSize, window),
    knownCount,
  };
}
