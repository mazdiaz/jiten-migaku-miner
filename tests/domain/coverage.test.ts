import { describe, expect, it } from "vitest";
import {
  buildEffectiveKnownIndex,
  computeCoverage,
  DEFAULT_COVERAGE_TARGETS,
} from "../../src/domain/coverage";
import type { Entry, WordDecision, WordDecisionStatus } from "../../src/domain/types";

function makeEntry(
  overrides: Partial<Entry> & Pick<Entry, "normalizedWord" | "occurrences">,
): Entry {
  return {
    id: `entry-${overrides.normalizedWord}-${overrides.originalIndex ?? 0}`,
    originalIndex: 0,
    word: overrides.normalizedWord,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
    ...overrides,
  };
}

function statusMap(
  statuses: Record<string, WordDecisionStatus>,
): ReadonlyMap<string, WordDecisionStatus> {
  return new Map(Object.entries(statuses));
}

function decisionMap(
  statuses: Record<string, WordDecisionStatus>,
): ReadonlyMap<string, WordDecision> {
  return new Map(
    Object.entries(statuses).map(([normalizedWord, status]) => [
      normalizedWord,
      { normalizedWord, status, updatedAt: "2026-01-01T00:00:00.000Z" } satisfies WordDecision,
    ]),
  );
}

const basicEntries: Entry[] = [
  makeEntry({ normalizedWord: "a", occurrences: 50, originalIndex: 0 }),
  makeEntry({ normalizedWord: "b", occurrences: 30, originalIndex: 1 }),
  makeEntry({ normalizedWord: "c", occurrences: 20, originalIndex: 2 }),
];

describe("computeCoverage", () => {
  it("computes basic tracked occurrence coverage", () => {
    const stats = computeCoverage(basicEntries, new Set(["a"]), statusMap({}));

    expect(stats.totalUniqueWords).toBe(3);
    expect(stats.knownUniqueWords).toBe(1);
    expect(stats.unknownUniqueWords).toBe(2);
    expect(stats.totalTrackedOccurrences).toBe(100);
    expect(stats.knownTrackedOccurrences).toBe(50);
    expect(stats.unknownTrackedOccurrences).toBe(50);
    expect(stats.coveragePercent).toBe(50);
  });

  it("counts local known decisions as known", () => {
    const stats = computeCoverage(basicEntries, new Set(["a"]), statusMap({ b: "known" }));

    expect(stats.knownUniqueWords).toBe(2);
    expect(stats.unknownUniqueWords).toBe(1);
    expect(stats.knownTrackedOccurrences).toBe(80);
    expect(stats.unknownTrackedOccurrences).toBe(20);
    expect(stats.coveragePercent).toBe(80);
  });

  it("accepts a WordDecision-valued decision map", () => {
    const stats = computeCoverage(basicEntries, new Set(), decisionMap({ b: "known" }));

    expect(stats.knownUniqueWords).toBe(1);
    expect(stats.knownTrackedOccurrences).toBe(30);
    expect(stats.coveragePercent).toBe(30);
  });

  it("treats mined, skip, and later decisions as not known", () => {
    const stats = computeCoverage(
      basicEntries,
      new Set(),
      statusMap({ a: "mined", b: "skip", c: "later" }),
    );

    expect(stats.knownUniqueWords).toBe(0);
    expect(stats.unknownUniqueWords).toBe(3);
    expect(stats.knownTrackedOccurrences).toBe(0);
    expect(stats.unknownTrackedOccurrences).toBe(100);
    expect(stats.coveragePercent).toBe(0);
  });

  it("clamps negative and non-finite occurrences to zero", () => {
    const entries: Entry[] = [
      makeEntry({ normalizedWord: "a", occurrences: -5, originalIndex: 0 }),
      makeEntry({ normalizedWord: "b", occurrences: Number.NaN, originalIndex: 1 }),
      makeEntry({ normalizedWord: "c", occurrences: Number.NEGATIVE_INFINITY, originalIndex: 2 }),
      makeEntry({ normalizedWord: "d", occurrences: 10, originalIndex: 3 }),
    ];

    const stats = computeCoverage(entries, new Set(["a"]), statusMap({}));

    expect(stats.totalUniqueWords).toBe(4);
    expect(stats.knownUniqueWords).toBe(1);
    expect(stats.totalTrackedOccurrences).toBe(10);
    expect(stats.knownTrackedOccurrences).toBe(0);
    expect(stats.unknownTrackedOccurrences).toBe(10);
    expect(stats.coveragePercent).toBe(0);
  });

  it("returns null coverage percent when total occurrences are zero", () => {
    const emptyStats = computeCoverage([], new Set(["a"]), statusMap({}));
    expect(emptyStats.totalUniqueWords).toBe(0);
    expect(emptyStats.coveragePercent).toBeNull();

    const zeroEntries: Entry[] = [
      makeEntry({ normalizedWord: "a", occurrences: 0, originalIndex: 0 }),
      makeEntry({ normalizedWord: "b", occurrences: 0, originalIndex: 1 }),
    ];
    const stats = computeCoverage(zeroEntries, new Set(["a"]), statusMap({}));

    expect(stats.totalUniqueWords).toBe(2);
    expect(stats.totalTrackedOccurrences).toBe(0);
    expect(stats.coveragePercent).toBeNull();
  });

  it("reports zero-mass targets as unreached with no additions", () => {
    const entries: Entry[] = [makeEntry({ normalizedWord: "a", occurrences: 0, originalIndex: 0 })];
    const stats = computeCoverage(entries, new Set(), statusMap({}));

    expect(stats.coveragePercent).toBeNull();
    expect(stats.targets).toHaveLength(4);
    for (const target of stats.targets) {
      expect(target.reached).toBe(false);
      expect(target.additionalWords).toBe(0);
      expect(target.additionalTrackedOccurrences).toBe(0);
    }
  });

  it("uses the default targets 98, 98.5, 99, 99.5", () => {
    expect(DEFAULT_COVERAGE_TARGETS).toEqual([98, 98.5, 99, 99.5]);

    const stats = computeCoverage(basicEntries, new Set(["a"]), statusMap({}));

    expect(stats.targets.map((target) => target.targetPercent)).toEqual([98, 98.5, 99, 99.5]);
    for (const target of stats.targets) {
      expect(target.reached).toBe(false);
      expect(target.additionalWords).toBe(2);
      expect(target.additionalTrackedOccurrences).toBe(50);
    }
  });

  it("reports reached targets with zero additions", () => {
    const stats = computeCoverage(basicEntries, new Set(["a", "b", "c"]), statusMap({}));

    expect(stats.coveragePercent).toBe(100);
    for (const target of stats.targets) {
      expect(target.reached).toBe(true);
      expect(target.additionalWords).toBe(0);
      expect(target.additionalTrackedOccurrences).toBe(0);
    }
  });

  it("marks a target met exactly at the boundary as reached", () => {
    const entries: Entry[] = [
      makeEntry({ normalizedWord: "k", occurrences: 80, originalIndex: 0 }),
      makeEntry({ normalizedWord: "u", occurrences: 20, originalIndex: 1 }),
    ];

    const stats = computeCoverage(entries, new Set(["k"]), statusMap({}), [80]);

    expect(stats.coveragePercent).toBe(80);
    expect(stats.targets).toEqual([
      { targetPercent: 80, reached: true, additionalWords: 0, additionalTrackedOccurrences: 0 },
    ]);
  });

  it("computes a greedy highest-occurrence-first priority path", () => {
    const entries: Entry[] = [
      makeEntry({ normalizedWord: "k", occurrences: 40, originalIndex: 0 }),
      makeEntry({ normalizedWord: "u1", occurrences: 25, originalIndex: 1 }),
      makeEntry({ normalizedWord: "u2", occurrences: 15, originalIndex: 2 }),
      makeEntry({ normalizedWord: "u3", occurrences: 10, originalIndex: 3 }),
      makeEntry({ normalizedWord: "u4", occurrences: 6, originalIndex: 4 }),
      makeEntry({ normalizedWord: "u5", occurrences: 4, originalIndex: 5 }),
    ];

    const stats = computeCoverage(entries, new Set(["k"]), statusMap({}), [50, 80, 90, 99]);

    expect(stats.totalTrackedOccurrences).toBe(100);
    expect(stats.coveragePercent).toBe(40);
    expect(stats.targets).toEqual([
      { targetPercent: 50, reached: false, additionalWords: 1, additionalTrackedOccurrences: 25 },
      { targetPercent: 80, reached: false, additionalWords: 2, additionalTrackedOccurrences: 40 },
      { targetPercent: 90, reached: false, additionalWords: 3, additionalTrackedOccurrences: 50 },
      { targetPercent: 99, reached: false, additionalWords: 5, additionalTrackedOccurrences: 60 },
    ]);
  });

  it("splits mixed reached and unreached targets", () => {
    const entries: Entry[] = [
      makeEntry({ normalizedWord: "k", occurrences: 493, originalIndex: 0 }),
      makeEntry({ normalizedWord: "u1", occurrences: 4, originalIndex: 1 }),
      makeEntry({ normalizedWord: "u2", occurrences: 2, originalIndex: 2 }),
      makeEntry({ normalizedWord: "u3", occurrences: 1, originalIndex: 3 }),
    ];

    const stats = computeCoverage(entries, new Set(["k"]), statusMap({}));

    expect(stats.totalTrackedOccurrences).toBe(500);
    expect(stats.coveragePercent).toBe(98.6);
    expect(stats.targets).toEqual([
      { targetPercent: 98, reached: true, additionalWords: 0, additionalTrackedOccurrences: 0 },
      { targetPercent: 98.5, reached: true, additionalWords: 0, additionalTrackedOccurrences: 0 },
      { targetPercent: 99, reached: false, additionalWords: 1, additionalTrackedOccurrences: 4 },
      { targetPercent: 99.5, reached: false, additionalWords: 2, additionalTrackedOccurrences: 6 },
    ]);
  });

  it("breaks occurrence ties by originalIndex and stays deterministic across array order", () => {
    const base: Entry[] = [
      makeEntry({ normalizedWord: "k", occurrences: 40, originalIndex: 0 }),
      makeEntry({ normalizedWord: "x", occurrences: 10, originalIndex: 3 }),
      makeEntry({ normalizedWord: "y", occurrences: 10, originalIndex: 1 }),
      makeEntry({ normalizedWord: "z", occurrences: 10, originalIndex: 2 }),
    ];
    const scrambled: Entry[] = [base[0]!, base[3]!, base[2]!, base[1]!];

    const expected = [
      { targetPercent: 50, reached: true, additionalWords: 0, additionalTrackedOccurrences: 0 },
      { targetPercent: 60, reached: false, additionalWords: 1, additionalTrackedOccurrences: 10 },
      { targetPercent: 80, reached: false, additionalWords: 2, additionalTrackedOccurrences: 20 },
      { targetPercent: 100, reached: false, additionalWords: 3, additionalTrackedOccurrences: 30 },
    ];

    const first = computeCoverage(base, new Set(["k"]), statusMap({}), [50, 60, 80, 100]);
    const second = computeCoverage(scrambled, new Set(["k"]), statusMap({}), [50, 60, 80, 100]);

    expect(first.targets).toEqual(expected);
    expect(second.targets).toEqual(expected);
  });

  it("matches known words and decisions on the canonical lowercase identity", () => {
    const upperEntries: Entry[] = [
      makeEntry({ normalizedWord: "NHK", occurrences: 10, originalIndex: 0 }),
      makeEntry({ normalizedWord: "其他", occurrences: 5, originalIndex: 1 }),
    ];

    const viaSet = computeCoverage(upperEntries, new Set(["nhk"]), statusMap({}));
    expect(viaSet.knownUniqueWords).toBe(1);
    expect(viaSet.knownTrackedOccurrences).toBe(10);
    expect(viaSet.coveragePercent).toBeCloseTo(10 / 15 * 100, 10);

    const viaDecision = computeCoverage(upperEntries, new Set(), statusMap({ nhk: "known" }));
    expect(viaDecision.knownTrackedOccurrences).toBe(10);

    const lowerEntries: Entry[] = [
      makeEntry({ normalizedWord: "nhk", occurrences: 10, originalIndex: 0 }),
    ];
    const upperKey = computeCoverage(lowerEntries, new Set(["NHK"]), statusMap({}));
    expect(upperKey.knownUniqueWords).toBe(1);
    expect(upperKey.coveragePercent).toBe(100);
  });

  it("does not mutate its inputs", () => {
    const known = new Set(["a"]);
    const decisions = statusMap({ b: "mined" });
    const orderBefore = basicEntries.map((entry) => entry.originalIndex);

    computeCoverage(basicEntries, known, decisions);

    expect(basicEntries.map((entry) => entry.originalIndex)).toEqual(orderBefore);
    expect([...known]).toEqual(["a"]);
    expect([...decisions.keys()]).toEqual(["b"]);
  });
});

describe("buildEffectiveKnownIndex", () => {
  it("reuses canonical lowercase identity for known sets and decisions", () => {
    const isKnown = buildEffectiveKnownIndex(new Set(["NHK"]), statusMap({ その他: "known" }));

    expect(isKnown("nhk")).toBe(true);
    expect(isKnown("その他")).toBe(true);
    expect(isKnown("みんだ")).toBe(false);
  });

  it("treats only the known status as effectively known", () => {
    const isKnown = buildEffectiveKnownIndex(new Set(), decisionMap({ a: "mined", b: "known" }));

    expect(isKnown("a")).toBe(false);
    expect(isKnown("b")).toBe(true);
  });
});
