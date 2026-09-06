import { normalizeText } from "./text";
import type { QueryState, ViewState, WordDecision, WordDecisionFilter, WordDecisionStatus } from "./types";

export const BACKUP_FORMAT = "jiten-migaku-miner-backup" as const;
export const BACKUP_VERSION = 1 as const;
export const DECISION_STATUSES: readonly WordDecisionStatus[] = ["known", "mined", "skip", "later"];

function isDecisionFilter(value: unknown): value is WordDecisionFilter {
  return value === "all" || value === "unreviewed" || DECISION_STATUSES.includes(value as WordDecisionStatus);
}

export interface MinerBackupV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  knownWords: null | {
    name: string;
    words: string[];
  };
  wordDecisions: WordDecision[];
  preferences: {
    query: QueryState;
    view: ViewState;
    page: number;
  } | null;
}

export type BackupErrorCode =
  | "invalid-json"
  | "invalid-format"
  | "unsupported-version"
  | "invalid-shape";

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: BackupErrorCode, message: string): never {
  throw new BackupError(code, message);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid-shape", `${label} must be a non-empty string`);
  }
  return value;
}

function plainString(value: unknown, label: string): string {
  if (typeof value !== "string") fail("invalid-shape", `${label} must be a string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail("invalid-shape", `${label} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    fail("invalid-shape", `${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("invalid-shape", `${label} must be a nonnegative finite number`);
  }
  return value;
}

function validateKnownWords(value: unknown): MinerBackupV1["knownWords"] {
  if (value === null) return null;
  if (!isRecord(value)) fail("invalid-shape", "knownWords must be an object or null");
  const name = requiredString(value.name, "knownWords.name");
  if (!Array.isArray(value.words)) fail("invalid-shape", "knownWords.words must be an array");
  for (const [index, word] of value.words.entries()) {
    if (typeof word !== "string") fail("invalid-shape", `knownWords.words[${index}] must be a string`);
  }
  return { name, words: [...(value.words as string[])] };
}

function validateDecision(value: unknown, index: number): WordDecision {
  if (!isRecord(value)) fail("invalid-shape", `wordDecisions[${index}] must be an object`);
  const normalizedWord = requiredString(value.normalizedWord, `wordDecisions[${index}].normalizedWord`);
  const status = value.status;
  if (typeof status !== "string" || !DECISION_STATUSES.includes(status as WordDecisionStatus)) {
    fail("invalid-shape", `wordDecisions[${index}].status must be one of: ${DECISION_STATUSES.join(", ")}`);
  }
  const updatedAt = requiredString(value.updatedAt, `wordDecisions[${index}].updatedAt`);
  return { normalizedWord, status: status as WordDecisionStatus, updatedAt };
}

function validateDecisions(value: unknown): WordDecision[] {
  if (!Array.isArray(value)) fail("invalid-shape", "wordDecisions must be an array");
  const decisions = value.map((entry, index) => validateDecision(entry, index));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.normalizedWord)) {
      fail("invalid-shape", `wordDecisions contains a duplicate normalizedWord: ${decision.normalizedWord}`);
    }
    seen.add(decision.normalizedWord);
  }
  return decisions;
}

function validateQuery(value: unknown): QueryState {
  if (!isRecord(value)) fail("invalid-shape", "preferences.query must be an object");
  const sentence = value.sentence;
  if (sentence !== "any" && sentence !== "has" && sentence !== "none") {
    fail("invalid-shape", 'preferences.query.sentence must be "any", "has", or "none"');
  }
  const sort = value.sort;
  if (sort !== "occ-desc" && sort !== "occ-asc" && sort !== "original") {
    fail("invalid-shape", 'preferences.query.sort must be "occ-desc", "occ-asc", or "original"');
  }
  const pageSize = value.pageSize;
  if (
    pageSize !== "all" &&
    (typeof pageSize !== "number" || !Number.isFinite(pageSize) || !Number.isInteger(pageSize) || pageSize < 1)
  ) {
    fail("invalid-shape", "preferences.query.pageSize must be a positive integer or \"all\"");
  }
  if (!isDecisionFilter(value.decision)) {
    fail("invalid-shape", "preferences.query.decision must be \"all\", \"unreviewed\", \"known\", \"mined\", \"skip\", or \"later\"");
  }
  return {
    search: plainString(value.search, "preferences.query.search"),
    hideKnown: boolean(value.hideKnown, "preferences.query.hideKnown"),
    hideKanaOnly: boolean(value.hideKanaOnly, "preferences.query.hideKanaOnly"),
    sentence,
    minOccurrences: nonNegativeNumber(value.minOccurrences, "preferences.query.minOccurrences"),
    sort,
    pageSize,
    page: positiveInteger(value.page, "preferences.query.page"),
    decision: value.decision,
  };
}

function validateView(value: unknown): ViewState {
  if (!isRecord(value)) fail("invalid-shape", "preferences.view must be an object");
  return {
    showFurigana: boolean(value.showFurigana, "preferences.view.showFurigana"),
    pillHighlight: boolean(value.pillHighlight, "preferences.view.pillHighlight"),
    showHighlight: boolean(value.showHighlight, "preferences.view.showHighlight"),
    showDefinitions: boolean(value.showDefinitions, "preferences.view.showDefinitions"),
  };
}

function validatePreferences(value: unknown): MinerBackupV1["preferences"] {
  if (value === null) return null;
  if (!isRecord(value)) fail("invalid-shape", "preferences must be an object or null");
  return {
    query: validateQuery(value.query),
    view: validateView(value.view),
    page: positiveInteger(value.page, "preferences.page"),
  };
}

export function serializeBackup(input: {
  exportedAt: string;
  knownWords: { name: string; words: Iterable<string> } | null;
  wordDecisions: Iterable<WordDecision>;
  preferences: MinerBackupV1["preferences"];
}): string {
  const knownWords = input.knownWords === null
    ? null
    : {
        name: input.knownWords.name,
        words: [...new Set([...input.knownWords.words].map((word) => normalizeText(word)))].sort(),
      };
  const wordDecisions = [...input.wordDecisions]
    .map((decision) => ({
      normalizedWord: normalizeText(decision.normalizedWord),
      status: decision.status,
      updatedAt: decision.updatedAt,
    }))
    .sort((left, right) => left.normalizedWord.localeCompare(right.normalizedWord));

  const backup: MinerBackupV1 = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: input.exportedAt,
    knownWords,
    wordDecisions,
    preferences: input.preferences === null
      ? null
      : {
          query: { ...input.preferences.query },
          view: { ...input.preferences.view },
          page: input.preferences.page,
        },
  };
  return JSON.stringify(backup, null, 2);
}

export function parseBackup(text: string): MinerBackupV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("invalid-json", "Backup is not valid JSON");
  }
  if (!isRecord(parsed)) fail("invalid-format", "Backup must be a JSON object");

  if (parsed.format !== BACKUP_FORMAT) {
    fail("invalid-format", `Backup format must be "${BACKUP_FORMAT}"`);
  }
  if (parsed.version !== BACKUP_VERSION) {
    fail("unsupported-version", `Unsupported backup version: ${String(parsed.version)}. This application supports version ${BACKUP_VERSION}.`);
  }
  const exportedAt = requiredString(parsed.exportedAt, "exportedAt");

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    knownWords: validateKnownWords(parsed.knownWords),
    wordDecisions: validateDecisions(parsed.wordDecisions),
    preferences: validatePreferences(parsed.preferences),
  };
}
