import { canonicalWord } from "./text";
import type {
  CoverageStats,
  CoverageTargetResult,
  Entry,
  WordDecision,
  WordDecisionStatus,
} from "./types";

export const DEFAULT_COVERAGE_TARGETS: readonly number[] = [98, 98.5, 99, 99.5];

const TARGET_EPSILON = 1e-9;

export type EffectiveKnownLookup = (normalizedWord: string) => boolean;

export type DecisionMapSource =
  | ReadonlyMap<string, WordDecisionStatus>
  | ReadonlyMap<string, WordDecision>;

export function buildEffectiveKnownIndex(
  knownWords: ReadonlySet<string>,
  decisions: DecisionMapSource,
): EffectiveKnownLookup {
  const knownCanonical = new Set<string>();
  for (const word of knownWords) knownCanonical.add(canonicalWord(word));
  const decisionsCanonical = new Map<string, WordDecisionStatus>();
  for (const [word, value] of decisions) {
    const status = typeof value === "string" ? value : value.status;
    decisionsCanonical.set(canonicalWord(word), status);
  }
  return (normalizedWord: string): boolean => {
    const canonical = canonicalWord(normalizedWord);
    return knownCanonical.has(canonical) || decisionsCanonical.get(canonical) === "known";
  };
}

function trackedWeight(entry: Entry): number {
  const value = Number(entry.occurrences);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function computeCoverage(
  entries: readonly Entry[],
  knownWords: ReadonlySet<string>,
  decisions: DecisionMapSource,
  targets: readonly number[] = DEFAULT_COVERAGE_TARGETS,
): CoverageStats {
  const isEffectivelyKnown = buildEffectiveKnownIndex(knownWords, decisions);

  let totalUniqueWords = 0;
  let knownUniqueWords = 0;
  let totalTrackedOccurrences = 0;
  let knownTrackedOccurrences = 0;
  const unknownWeights: Array<{ originalIndex: number; weight: number }> = [];

  for (const entry of entries) {
    totalUniqueWords += 1;
    const weight = trackedWeight(entry);
    totalTrackedOccurrences += weight;
    if (isEffectivelyKnown(entry.normalizedWord)) {
      knownUniqueWords += 1;
      knownTrackedOccurrences += weight;
    } else {
      unknownWeights.push({ originalIndex: entry.originalIndex, weight });
    }
  }

  const unknownUniqueWords = totalUniqueWords - knownUniqueWords;
  const unknownTrackedOccurrences = totalTrackedOccurrences - knownTrackedOccurrences;
  const coveragePercent =
    totalTrackedOccurrences === 0
      ? null
      : (knownTrackedOccurrences / totalTrackedOccurrences) * 100;

  unknownWeights.sort((a, b) => b.weight - a.weight || a.originalIndex - b.originalIndex);

  const targetResults: CoverageTargetResult[] = targets.map((targetPercent) => {
    if (coveragePercent !== null && coveragePercent + TARGET_EPSILON >= targetPercent) {
      return {
        targetPercent,
        reached: true,
        additionalWords: 0,
        additionalTrackedOccurrences: 0,
      };
    }
    if (totalTrackedOccurrences === 0) {
      return {
        targetPercent,
        reached: false,
        additionalWords: 0,
        additionalTrackedOccurrences: 0,
      };
    }

    let additionalWords = 0;
    let additionalTrackedOccurrences = 0;
    for (const { weight } of unknownWeights) {
      additionalWords += 1;
      additionalTrackedOccurrences += weight;
      const projected =
        ((knownTrackedOccurrences + additionalTrackedOccurrences) / totalTrackedOccurrences) * 100;
      if (projected + TARGET_EPSILON >= targetPercent) break;
    }
    return {
      targetPercent,
      reached: false,
      additionalWords,
      additionalTrackedOccurrences,
    };
  });

  return {
    totalUniqueWords,
    knownUniqueWords,
    unknownUniqueWords,
    totalTrackedOccurrences,
    knownTrackedOccurrences,
    unknownTrackedOccurrences,
    coveragePercent,
    targets: targetResults,
  };
}
