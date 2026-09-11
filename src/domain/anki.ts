import type { WordDecisionStatus } from "./types";

export type AnkiWordStatus = "known" | "mined";
export type DecisionSource = "manual" | "anki" | null;
export type AnkiDeckScope = { kind: "deck"; name: string } | { kind: "all-decks" };

export interface AnkiSyncConfig {
  deckScope: AnkiDeckScope;
  noteType: string;
  targetField: string;
}

export interface AnkiSyncSnapshot {
  syncedAt: string;
  statuses: Array<[string, AnkiWordStatus]>;
}

export interface AnkiPreviewMatchStats {
  matchedWords: number;
  knownCount: number;
  minedCount: number;
  manualProtected: number;
}

export interface EffectiveDecision {
  decision: WordDecisionStatus | "unreviewed";
  source: DecisionSource;
}

export const ANKI_STATUSES: readonly AnkiWordStatus[] = ["known", "mined"];

export function isAnkiWordStatus(value: unknown): value is AnkiWordStatus {
  return value === "known" || value === "mined";
}

export function ankiCardStatus(isNewAndNotSuspended: boolean): AnkiWordStatus {
  return isNewAndNotSuspended ? "mined" : "known";
}

export function aggregateAnkiStatuses(statuses: Iterable<AnkiWordStatus>): AnkiWordStatus | null {
  let found = false;
  for (const status of statuses) {
    found = true;
    if (status === "known") return "known";
  }
  return found ? "mined" : null;
}

export function resolveEffectiveDecision(
  manual: WordDecisionStatus | null,
  anki: AnkiWordStatus | null,
): EffectiveDecision {
  if (manual !== null) return { decision: manual, source: "manual" };
  if (anki !== null) return { decision: anki, source: "anki" };
  return { decision: "unreviewed", source: null };
}
