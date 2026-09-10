import type { AnkiDeckScope, AnkiSyncConfig, AnkiSyncSnapshot, AnkiWordStatus } from "./anki";
import { isAnkiWordStatus } from "./anki";
import { normalizeText } from "./text";
import type {
  QueryState,
  ViewState,
  WordDecision,
  WordDecisionFilter,
  WordDecisionStatus,
} from "./types";

export const BACKUP_FORMAT = "jiten-migaku-miner-backup" as const;
export const BACKUP_VERSION = 2 as const;
const LEGACY_BACKUP_VERSION = 1 as const;
export const DECISION_STATUSES: readonly WordDecisionStatus[] = ["known", "mined", "skip", "later"];
export const SENTENCE_SIZES: readonly ViewState["sentenceSize"][] = ["medium", "large"];
export const DENSITIES: readonly ViewState["density"][] = ["comfortable", "compact"];

function isDecisionFilter(value: unknown): value is WordDecisionFilter {
  return (
    value === "all" ||
    value === "unreviewed" ||
    DECISION_STATUSES.includes(value as WordDecisionStatus)
  );
}

export interface MinerBackupV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof LEGACY_BACKUP_VERSION | typeof BACKUP_VERSION;
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

export interface AnkiSyncBackupSection {
  config: AnkiSyncConfig | null;
  snapshot: AnkiSyncSnapshot | null;
}

export interface MinerBackupV2 extends Omit<MinerBackupV1, "version"> {
  version: typeof BACKUP_VERSION;
  ankiSync: AnkiSyncBackupSection;
}

export interface ParsedMinerBackup extends MinerBackupV1 {
  version: typeof LEGACY_BACKUP_VERSION | typeof BACKUP_VERSION;
  ankiSync: AnkiSyncBackupSection | null;
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

function validTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    fail("invalid-shape", `${label} must be a valid timestamp`);
  }
  return timestamp;
}

function nonEmptyConfigString(value: unknown, label: string): string {
  if (typeof value !== "string" || normalizeText(value).length === 0) {
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
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
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
    if (typeof word !== "string" || normalizeText(word).length === 0) {
      fail("invalid-shape", `knownWords.words[${index}] must be a non-empty string`);
    }
  }
  return { name, words: [...(value.words as string[])] };
}

function validateDecision(value: unknown, index: number, strictTimestamp = false): WordDecision {
  if (!isRecord(value)) fail("invalid-shape", `wordDecisions[${index}] must be an object`);
  const rawWord = requiredString(value.normalizedWord, `wordDecisions[${index}].normalizedWord`);
  const normalizedWord = normalizeText(rawWord);
  if (normalizedWord.length === 0) {
    fail(
      "invalid-shape",
      `wordDecisions[${index}].normalizedWord must not be empty or whitespace-only`,
    );
  }
  if (normalizedWord !== rawWord) {
    fail(
      "invalid-shape",
      `wordDecisions[${index}].normalizedWord must be canonical: ${JSON.stringify(rawWord)}`,
    );
  }
  const status = value.status;
  if (typeof status !== "string" || !DECISION_STATUSES.includes(status as WordDecisionStatus)) {
    fail(
      "invalid-shape",
      `wordDecisions[${index}].status must be one of: ${DECISION_STATUSES.join(", ")}`,
    );
  }
  const updatedAt = strictTimestamp
    ? validTimestamp(value.updatedAt, `wordDecisions[${index}].updatedAt`)
    : requiredString(value.updatedAt, `wordDecisions[${index}].updatedAt`);
  return { normalizedWord, status: status as WordDecisionStatus, updatedAt };
}

function validateDecisions(value: unknown, strictTimestamp = false): WordDecision[] {
  if (!Array.isArray(value)) fail("invalid-shape", "wordDecisions must be an array");
  const decisions = value.map((entry, index) => validateDecision(entry, index, strictTimestamp));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.normalizedWord)) {
      fail(
        "invalid-shape",
        `wordDecisions contains a duplicate normalizedWord: ${decision.normalizedWord}`,
      );
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
    (typeof pageSize !== "number" ||
      !Number.isFinite(pageSize) ||
      !Number.isInteger(pageSize) ||
      pageSize < 1)
  ) {
    fail("invalid-shape", 'preferences.query.pageSize must be a positive integer or "all"');
  }
  if (!isDecisionFilter(value.decision)) {
    fail(
      "invalid-shape",
      'preferences.query.decision must be "all", "unreviewed", "known", "mined", "skip", or "later"',
    );
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

// Display preferences are additive-optional: backups written before the
// reading display controls shipped omit sentenceSize/density, and those
// missing keys restore to the DEFAULT_VIEW values (medium/comfortable —
// kept in sync with DEFAULT_VIEW in src/app/state.ts by round-trip tests).
function validateView(value: unknown): ViewState {
  if (!isRecord(value)) fail("invalid-shape", "preferences.view must be an object");
  const sentenceSize = value.sentenceSize;
  if (
    sentenceSize !== undefined &&
    !SENTENCE_SIZES.includes(sentenceSize as ViewState["sentenceSize"])
  ) {
    fail("invalid-shape", 'preferences.view.sentenceSize must be "medium" or "large"');
  }
  const density = value.density;
  if (density !== undefined && !DENSITIES.includes(density as ViewState["density"])) {
    fail("invalid-shape", 'preferences.view.density must be "comfortable" or "compact"');
  }
  return {
    showFurigana: boolean(value.showFurigana, "preferences.view.showFurigana"),
    pillHighlight: boolean(value.pillHighlight, "preferences.view.pillHighlight"),
    showHighlight: boolean(value.showHighlight, "preferences.view.showHighlight"),
    showDefinitions: boolean(value.showDefinitions, "preferences.view.showDefinitions"),
    sentenceSize: (sentenceSize as ViewState["sentenceSize"] | undefined) ?? "medium",
    density: (density as ViewState["density"] | undefined) ?? "comfortable",
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

function validateAnkiDeckScope(value: unknown): AnkiDeckScope {
  if (!isRecord(value)) fail("invalid-shape", "ankiSync.config.deckScope must be an object");
  if (value.kind === "all-decks") return { kind: "all-decks" };
  if (value.kind === "deck") {
    return {
      kind: "deck",
      name: nonEmptyConfigString(value.name, "ankiSync.config.deckScope.name"),
    };
  }
  fail("invalid-shape", 'ankiSync.config.deckScope.kind must be "all-decks" or "deck"');
}

function validateAnkiConfig(value: unknown): AnkiSyncConfig | null {
  if (value === null) return null;
  if (!isRecord(value)) fail("invalid-shape", "ankiSync.config must be an object or null");
  return {
    deckScope: validateAnkiDeckScope(value.deckScope),
    noteType: nonEmptyConfigString(value.noteType, "ankiSync.config.noteType"),
    targetField: nonEmptyConfigString(value.targetField, "ankiSync.config.targetField"),
  };
}

function validateAnkiStatuses(value: unknown): Array<[string, AnkiWordStatus]> {
  if (!Array.isArray(value)) fail("invalid-shape", "ankiSync.snapshot.statuses must be an array");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      fail("invalid-shape", `ankiSync.snapshot.statuses[${index}] must be a [key, status] pair`);
    }
    const key = requiredString(entry[0], `ankiSync.snapshot.statuses[${index}][0]`);
    const normalizedKey = normalizeText(key);
    if (normalizedKey.length === 0) {
      fail(
        "invalid-shape",
        `ankiSync.snapshot.statuses[${index}][0] must not be empty or whitespace-only`,
      );
    }
    if (normalizedKey !== key) {
      fail(
        "invalid-shape",
        `ankiSync.snapshot.statuses[${index}][0] must be canonical: ${JSON.stringify(key)}`,
      );
    }
    if (!isAnkiWordStatus(entry[1])) {
      fail("invalid-shape", `ankiSync.snapshot.statuses[${index}][1] must be "known" or "mined"`);
    }
    if (seen.has(key)) {
      fail("invalid-shape", `ankiSync.snapshot.statuses contains a duplicate key: ${key}`);
    }
    seen.add(key);
    return [key, entry[1]];
  });
}

function validateAnkiSnapshot(value: unknown): AnkiSyncSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value)) fail("invalid-shape", "ankiSync.snapshot must be an object or null");
  return {
    syncedAt: validTimestamp(value.syncedAt, "ankiSync.snapshot.syncedAt"),
    statuses: validateAnkiStatuses(value.statuses),
  };
}

function validateAnkiSync(value: unknown): AnkiSyncBackupSection {
  if (!isRecord(value)) fail("invalid-shape", "ankiSync must be an object");
  return {
    config: validateAnkiConfig(value.config),
    snapshot: validateAnkiSnapshot(value.snapshot),
  };
}

export function serializeBackup(input: {
  exportedAt: string;
  knownWords: { name: string; words: Iterable<string> } | null;
  wordDecisions: Iterable<WordDecision>;
  preferences: MinerBackupV1["preferences"];
  ankiSync?: AnkiSyncBackupSection | null;
}): string {
  const knownWords =
    input.knownWords === null
      ? null
      : {
          name: input.knownWords.name,
          words: [
            ...new Set([...input.knownWords.words].map((word) => normalizeText(word))),
          ].sort(),
        };
  const wordDecisions = [...input.wordDecisions]
    .map((decision) => ({
      normalizedWord: normalizeText(decision.normalizedWord),
      status: decision.status,
      updatedAt: decision.updatedAt,
    }))
    .sort((left, right) => left.normalizedWord.localeCompare(right.normalizedWord));
  const ankiSync = validateAnkiSync(input.ankiSync ?? { config: null, snapshot: null });

  const backup: MinerBackupV2 = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: input.exportedAt,
    knownWords,
    wordDecisions,
    preferences:
      input.preferences === null
        ? null
        : {
            query: { ...input.preferences.query },
            view: { ...input.preferences.view },
            page: input.preferences.page,
          },
    ankiSync,
  };
  return JSON.stringify(backup, null, 2);
}

export function parseBackup(text: string): ParsedMinerBackup {
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
  if (parsed.version !== LEGACY_BACKUP_VERSION && parsed.version !== BACKUP_VERSION) {
    fail(
      "unsupported-version",
      `Unsupported backup version: ${String(parsed.version)}. This application supports version ${BACKUP_VERSION}.`,
    );
  }
  const isV2 = parsed.version === BACKUP_VERSION;
  const exportedAt = isV2
    ? validTimestamp(parsed.exportedAt, "exportedAt")
    : requiredString(parsed.exportedAt, "exportedAt");

  return {
    format: BACKUP_FORMAT,
    version: parsed.version,
    exportedAt,
    knownWords: validateKnownWords(parsed.knownWords),
    wordDecisions: validateDecisions(parsed.wordDecisions, isV2),
    preferences: validatePreferences(parsed.preferences),
    ankiSync: isV2 ? validateAnkiSync(parsed.ankiSync) : null,
  };
}
