import { describe, expect, it } from "vitest";
import {
  applyKnownWords,
  filterEntries,
  paginateEntries,
  queryEntries,
  sortEntries,
} from "../../src/domain/query";
import type { Entry, EntryWithKnown, QueryState, WordDecision } from "../../src/domain/types";

const entries: Entry[] = Array.from({ length: 150 }, (_, originalIndex) => ({
  id: `entry-${originalIndex}`,
  originalIndex,
  word: `word-${originalIndex}`,
  normalizedWord: `word-${originalIndex}`,
  occurrences: originalIndex % 12,
  sentenceRaw: originalIndex % 2 === 0 ? `sentence ${originalIndex}` : "",
  hasSentence: originalIndex % 2 === 0,
  definitions: "",
  furiganaRuns: [],
}));

function entryWithKnown(overrides: Partial<Entry>, known = false): EntryWithKnown {
  return {
    id: "entry",
    originalIndex: 0,
    word: "語",
    normalizedWord: "語",
    occurrences: 1,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
    ...overrides,
    known,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed",
  };
}

function queryState(overrides: Partial<QueryState> = {}): QueryState {
  return {
    search: "",
    hideKnown: false,
    hideKanaOnly: false,
    sentence: "any",
    minOccurrences: 0,
    sort: "original",
    pageSize: 50,
    page: 1,
    decision: "all",
    ...overrides,
  };
}

describe("applyKnownWords", () => {
  it("marks entries whose normalized words are known", () => {
    const source: Entry[] = [
      entryWithKnown({ id: "known", normalizedWord: "知っている" }),
      entryWithKnown({ id: "new", normalizedWord: "知らない" }),
    ].map(({ known, ...entry }) => entry);

    expect(applyKnownWords(source, new Set(["知っている"]))).toEqual([
      expect.objectContaining({ id: "known", known: true }),
      expect.objectContaining({ id: "new", known: false }),
    ]);
    expect(source[0]).not.toHaveProperty("known");
  });
});

describe("filterEntries", () => {
  const searchableEntries: EntryWithKnown[] = [
    entryWithKnown({
      id: "word-match",
      word: "気になる",
      normalizedWord: "気になる",
      sentenceRaw: "彼は**別の語**。",
      hasSentence: true,
    }),
    entryWithKnown({
      id: "sentence-match",
      word: "泳ぐ",
      normalizedWord: "泳ぐ",
      sentenceRaw: "夏は**プール**で泳ぐ。",
      hasSentence: true,
    }),
    entryWithKnown({
      id: "raw-word-match",
      word: "raw-word-value",
      normalizedWord: "normalized-word-value",
    }),
    entryWithKnown({
      id: "neither",
      word: "猫",
      normalizedWord: "猫",
      sentenceRaw: "犬がいる。",
      hasSentence: true,
    }),
  ];

  it("searches normalized words and plain sentence text", () => {
    expect(
      filterEntries(searchableEntries, queryState({ search: "  気になる  " })).map((entry) => entry.id),
    ).toEqual(["word-match"]);
    expect(filterEntries(searchableEntries, queryState({ search: "プール" })).map((entry) => entry.id)).toEqual([
      "sentence-match",
    ]);
    expect(
      filterEntries(searchableEntries, queryState({ search: "raw-word-value" })).map((entry) => entry.id),
    ).toEqual(["raw-word-match"]);
  });

  it("hides known and kana-only entries independently", () => {
    const source = [
      entryWithKnown({ id: "known", normalizedWord: "漢字" }, true),
      entryWithKnown({ id: "kana", word: "プール", normalizedWord: "プール" }),
      entryWithKnown({ id: "kanji", word: "静か", normalizedWord: "静か" }),
    ];

    expect(filterEntries(source, queryState({ hideKnown: true })).map((entry) => entry.id)).toEqual([
      "kana",
      "kanji",
    ]);
    expect(filterEntries(source, queryState({ hideKanaOnly: true })).map((entry) => entry.id)).toEqual([
      "known",
      "kanji",
    ]);
  });

  it("filters by sentence presence and minimum occurrences", () => {
    const source = [
      entryWithKnown({ id: "none", hasSentence: false, sentenceRaw: "", occurrences: 0 }),
      entryWithKnown({ id: "low", hasSentence: true, sentenceRaw: "例文", occurrences: 3 }),
      entryWithKnown({ id: "high", hasSentence: true, sentenceRaw: "別の例文", occurrences: 8 }),
    ];

    expect(filterEntries(source, queryState({ sentence: "has" })).map((entry) => entry.id)).toEqual([
      "low",
      "high",
    ]);
    expect(filterEntries(source, queryState({ sentence: "none" })).map((entry) => entry.id)).toEqual(["none"]);
    expect(filterEntries(source, queryState({ minOccurrences: 4 })).map((entry) => entry.id)).toEqual(["high"]);
    expect(filterEntries(source, queryState({ minOccurrences: -4 })).map((entry) => entry.id)).toEqual([
      "none",
      "low",
      "high",
    ]);
  });
});

describe("sortEntries", () => {
  const source = [
    entryWithKnown({ id: "original-9", originalIndex: 9, occurrences: 2 }),
    entryWithKnown({ id: "original-1", originalIndex: 1, occurrences: 2 }),
    entryWithKnown({ id: "original-4", originalIndex: 4, occurrences: 5 }),
    entryWithKnown({ id: "original-3", originalIndex: 3, occurrences: 2 }),
  ];

  it("breaks occurrence ties by original index for both directions", () => {
    expect(sortEntries(source, "occ-desc").map((entry) => entry.id)).toEqual([
      "original-4",
      "original-1",
      "original-3",
      "original-9",
    ]);
    expect(sortEntries(source, "occ-asc").map((entry) => entry.id)).toEqual([
      "original-1",
      "original-3",
      "original-9",
      "original-4",
    ]);
  });

  it("sorts original mode by original index", () => {
    expect(sortEntries(source, "original").map((entry) => entry.id)).toEqual([
      "original-1",
      "original-3",
      "original-4",
      "original-9",
    ]);
  });
});

describe("paginateEntries", () => {
  const source = entries.slice(0, 5).map((entry, index) => ({
    ...entry,
    known: index % 2 === 0,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed" as const,
  }));

  it("returns empty result metadata for empty input", () => {
    expect(paginateEntries([], 3, 25)).toEqual({
      items: [],
      page: 0,
      totalPages: 0,
      totalEntries: 0,
      startIndex: 0,
      endIndex: 0,
      pageSize: 25,
      knownCount: 0,
      windowed: false,
    });
  });

  it("clamps numeric page to available pages", () => {
    expect(paginateEntries(source, 99, 2)).toMatchObject({
      items: [source[4]],
      page: 3,
      totalPages: 3,
      totalEntries: 5,
      startIndex: 5,
      endIndex: 5,
      knownCount: 3,
      windowed: false,
    });
    expect(paginateEntries(source, 0, 2).page).toBe(1);
  });

  it("returns all entries when page size is all and no window is supplied", () => {
    const result = paginateEntries(source, 1, "all");

    expect(result).toMatchObject({
      items: source,
      page: 1,
      totalPages: 1,
      totalEntries: source.length,
      startIndex: 1,
      endIndex: source.length,
      pageSize: "all",
      knownCount: 3,
      windowed: false,
    });
  });
});

describe("queryEntries", () => {
  it("applies known-word marking, filters, sorting, and pagination", () => {
    const source = [
      entryWithKnown({ id: "first", originalIndex: 2, normalizedWord: "猫", occurrences: 5 }),
      entryWithKnown({ id: "known", originalIndex: 1, normalizedWord: "犬", occurrences: 9 }),
      entryWithKnown({ id: "last", originalIndex: 0, normalizedWord: "鳥", occurrences: 7 }),
    ];

    const result = queryEntries(
      source,
      new Set(["犬"]),
      queryState({ hideKnown: true, sort: "occ-desc", pageSize: "all" }),
    );

    expect(result.items.map((entry) => entry.id)).toEqual(["last", "first"]);
    expect(result.items.every((entry) => !entry.known)).toBe(true);
    expect(result.knownCount).toBe(1);
  });

  it("windows all-results without changing logical total", () => {
    const query: QueryState = {
      search: "",
      hideKnown: false,
      hideKanaOnly: false,
      sentence: "any",
      minOccurrences: 0,
      sort: "original",
      pageSize: "all",
      page: 1,
      decision: "all",
    };
    const result = queryEntries(entries, new Set(), query, { start: 100, size: 25 });
    expect(result.windowed).toBe(true);
    expect(result.items).toHaveLength(25);
    expect(result.totalEntries).toBe(entries.length);
    expect(result.startIndex).toBe(101);
  });
});

describe("word decisions", () => {
  const decisionKnownWords = new Set(["migaku-known"]);

  const decisionDecisions = new Map<string, WordDecision>(
    (
      [
        ["local-known", "known"],
        ["mined-word", "mined"],
        ["skip-word", "skip"],
        ["later-word", "later"],
      ] as const
    ).map(([normalizedWord, status]) => [
      normalizedWord,
      { normalizedWord, status, updatedAt: "2026-09-05T00:00:00.000Z" },
    ]),
  );

  function decisionSource(): Entry[] {
    return [
      "unreviewed-word",
      "migaku-known",
      "local-known",
      "mined-word",
      "skip-word",
      "later-word",
    ].map((normalizedWord, originalIndex) => ({
      id: normalizedWord,
      originalIndex,
      word: normalizedWord,
      normalizedWord,
      occurrences: 1,
      sentenceRaw: "",
      hasSentence: false,
      definitions: "",
      furiganaRuns: [],
    }));
  }

  function entriesWithDecisions(): EntryWithKnown[] {
    return applyKnownWords(decisionSource(), decisionKnownWords, decisionDecisions);
  }

  it("defaults entries to unreviewed", () => {
    const entry = entriesWithDecisions().find((item) => item.id === "unreviewed-word");
    expect(entry).toMatchObject({
      decision: "unreviewed",
      known: false,
      knownByMigaku: false,
      knownByDecision: false,
    });
  });

  it("marks local known decisions as effectively known", () => {
    const entry = entriesWithDecisions().find((item) => item.id === "local-known");
    expect(entry).toMatchObject({
      decision: "known",
      known: true,
      knownByMigaku: false,
      knownByDecision: true,
    });
  });

  it("keeps mined separate from known", () => {
    const entry = entriesWithDecisions().find((item) => item.id === "mined-word");
    expect(entry).toMatchObject({
      decision: "mined",
      known: false,
      knownByMigaku: false,
      knownByDecision: false,
    });
  });

  it("keeps imported known separate from local decision", () => {
    const entry = entriesWithDecisions().find((item) => item.id === "migaku-known");
    expect(entry).toMatchObject({
      decision: "unreviewed",
      known: true,
      knownByMigaku: true,
      knownByDecision: false,
    });
  });

  it("filters unreviewed decisions", () => {
    expect(
      filterEntries(entriesWithDecisions(), queryState({ decision: "unreviewed" })).map((entry) => entry.id),
    ).toEqual(["unreviewed-word", "migaku-known"]);
  });

  it("filters mined decisions", () => {
    expect(
      filterEntries(entriesWithDecisions(), queryState({ decision: "mined" })).map((entry) => entry.id),
    ).toEqual(["mined-word"]);
  });

  it("hideKnown removes both Migaku-known and manually-known entries", () => {
    const ids = filterEntries(entriesWithDecisions(), queryState({ hideKnown: true })).map(
      (entry) => entry.id,
    );
    expect(ids).not.toContain("migaku-known");
    expect(ids).not.toContain("local-known");
  });

  it("hideKnown does not remove mined/skip/later entries", () => {
    expect(
      filterEntries(entriesWithDecisions(), queryState({ hideKnown: true })).map((entry) => entry.id),
    ).toEqual(["unreviewed-word", "mined-word", "skip-word", "later-word"]);
  });

  it("queries by decision across the full pipeline", () => {
    const result = queryEntries(
      decisionSource(),
      decisionKnownWords,
      queryState({ decision: "mined", sort: "original", pageSize: "all" }),
      undefined,
      decisionDecisions,
    );
    expect(result.items.map((entry) => entry.id)).toEqual(["mined-word"]);
    expect(result.knownCount).toBe(2);
  });
});
