import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT,
  BackupError,
  parseBackup,
  serializeBackup,
  type MinerBackupV1,
} from "../../src/domain/backup";
import type { WordDecision } from "../../src/domain/types";

const EXPORTED_AT = "2026-09-06T12:00:00.000Z";

const query = {
  search: "",
  hideKnown: true,
  hideKanaOnly: false,
  sentence: "has" as const,
  minOccurrences: 2,
  sort: "occ-asc" as const,
  pageSize: 25,
  page: 3,
  decision: "mined" as const,
};

const view = {
  showFurigana: true,
  pillHighlight: false,
  showHighlight: true,
  showDefinitions: false,
};

function decision(word: string, status: WordDecision["status"], updatedAt = EXPORTED_AT): WordDecision {
  return { normalizedWord: word, status, updatedAt };
}

function expectBackupError(code: string, action: () => unknown): void {
  try {
    action();
    expect.fail(`expected BackupError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe(code);
  }
}

describe("serializeBackup", () => {
  it("writes the exact envelope with stable sorting and 2-space pretty JSON", () => {
    const json = serializeBackup({
      exportedAt: EXPORTED_AT,
      knownWords: { name: "known.txt", words: ["ばら", "あめ", "アメ"] },
      wordDecisions: [decision("躊躇う", "mined"), decision("あめ", "known")],
      preferences: { query, view, page: 3 },
    });

    expect(JSON.parse(json)).toEqual({
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: EXPORTED_AT,
      knownWords: { name: "known.txt", words: ["あめ", "ばら", "アメ"] },
      wordDecisions: [
        { normalizedWord: "あめ", status: "known", updatedAt: EXPORTED_AT },
        { normalizedWord: "躊躇う", status: "mined", updatedAt: EXPORTED_AT },
      ],
      preferences: { query, view, page: 3 },
    });
    expect(json).toContain('\n  "format"');
    expect(json).toContain('\n      "normalizedWord"');
  });

  it("normalizes and dedupes known words deterministically", () => {
    const json = serializeBackup({
      exportedAt: EXPORTED_AT,
      knownWords: { name: "k.txt", words: ["  決めて ", "決めて", "ｶﾞ"] },
      wordDecisions: [],
      preferences: null,
    });
    const backup = parseBackup(json);
    expect(backup.knownWords).toEqual({ name: "k.txt", words: ["決めて", "ｶﾞ"] });
  });

  it("keeps null known words and null preferences", () => {
    const json = serializeBackup({
      exportedAt: EXPORTED_AT,
      knownWords: null,
      wordDecisions: [decision("跳ぶ", "later")],
      preferences: null,
    });
    const backup = parseBackup(json);
    expect(backup.knownWords).toBeNull();
    expect(backup.preferences).toBeNull();
    expect(backup.wordDecisions).toEqual([decision("跳ぶ", "later")]);
  });

  it("preserves decision records exactly including per-record updatedAt", () => {
    const json = serializeBackup({
      exportedAt: EXPORTED_AT,
      knownWords: null,
      wordDecisions: [
        decision("一", "skip", "2026-01-01T00:00:00.000Z"),
        decision("二", "later", "2026-02-02T00:00:00.000Z"),
      ],
      preferences: null,
    });
    const backup = parseBackup(json);
    expect(backup.wordDecisions).toEqual([
      { normalizedWord: "一", status: "skip", updatedAt: "2026-01-01T00:00:00.000Z" },
      { normalizedWord: "二", status: "later", updatedAt: "2026-02-02T00:00:00.000Z" },
    ]);
  });
});

describe("parseBackup", () => {
  it("round-trips a serialized backup", () => {
    const json = serializeBackup({
      exportedAt: EXPORTED_AT,
      knownWords: { name: "known.txt", words: ["古い"] },
      wordDecisions: [decision("古い", "known")],
      preferences: { query, view, page: 3 },
    });
    const backup = parseBackup(json);
    expect(backup.format).toBe("jiten-migaku-miner-backup");
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBe(EXPORTED_AT);
    expect(backup.knownWords).toEqual({ name: "known.txt", words: ["古い"] });
    expect(backup.preferences?.query.decision).toBe("mined");
  });

  it("accepts unknown extra fields for forward compatibility", () => {
    const json = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: EXPORTED_AT,
      futureTopLevel: { nested: true },
      knownWords: { name: "k.txt", words: ["古い"], futureKnownField: 1 },
      wordDecisions: [
        { normalizedWord: "古い", status: "known", updatedAt: EXPORTED_AT, futureDecisionField: "x" },
      ],
      preferences: {
        query: { ...query, futureQueryField: true },
        view: { ...view, futureViewField: 7 },
        page: 3,
        futurePreferenceField: null,
      },
    });
    const backup = parseBackup(json);
    expect(backup.wordDecisions).toHaveLength(1);
    expect(backup.preferences?.query.decision).toBe("mined");
  });

  const invalidCases: Array<{ name: string; text: string; code: string }> = [
    { name: "invalid JSON", text: "{not json", code: "invalid-json" },
    { name: "JSON array root", text: "[]", code: "invalid-format" },
    { name: "empty object", text: "{}", code: "invalid-format" },
    {
      name: "wrong format string",
      text: JSON.stringify({ format: "wrong", version: 1 }),
      code: "invalid-format",
    },
    {
      name: "unsupported version",
      text: JSON.stringify({ format: BACKUP_FORMAT, version: 99 }),
      code: "unsupported-version",
    },
    {
      name: "missing version",
      text: JSON.stringify({ format: BACKUP_FORMAT }),
      code: "unsupported-version",
    },
    {
      name: "knownWords malformed object",
      text: JSON.stringify({ format: BACKUP_FORMAT, version: 1, knownWords: { name: "k" } }),
      code: "invalid-shape",
    },
    {
      name: "knownWords words not array",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        knownWords: { name: "k", words: "nope" },
      }),
      code: "invalid-shape",
    },
    {
      name: "knownWords word not string",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        knownWords: { name: "k", words: [42] },
      }),
      code: "invalid-shape",
    },
    {
      name: "decisions not array",
      text: JSON.stringify({ format: BACKUP_FORMAT, version: 1, wordDecisions: {} }),
      code: "invalid-shape",
    },
    {
      name: "decision missing normalizedWord",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        wordDecisions: [{ status: "known", updatedAt: EXPORTED_AT }],
      }),
      code: "invalid-shape",
    },
    {
      name: "decision empty normalizedWord",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        wordDecisions: [{ normalizedWord: "", status: "known", updatedAt: EXPORTED_AT }],
      }),
      code: "invalid-shape",
    },
    {
      name: "decision invalid status",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        wordDecisions: [{ normalizedWord: "躊躇う", status: "maybe", updatedAt: EXPORTED_AT }],
      }),
      code: "invalid-shape",
    },
    {
      name: "decision missing updatedAt",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        wordDecisions: [{ normalizedWord: "躊躇う", status: "mined" }],
      }),
      code: "invalid-shape",
    },
    {
      name: "duplicate decision normalizedWord",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        wordDecisions: [
          { normalizedWord: "跳ぶ", status: "mined", updatedAt: EXPORTED_AT },
          { normalizedWord: "跳ぶ", status: "skip", updatedAt: EXPORTED_AT },
        ],
      }),
      code: "invalid-shape",
    },
    {
      name: "invalid query sort",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        preferences: { query: { ...query, sort: "random" }, view, page: 1 },
      }),
      code: "invalid-shape",
    },
    {
      name: "invalid decision filter",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        preferences: { query: { ...query, decision: "sometimes" }, view, page: 1 },
      }),
      code: "invalid-shape",
    },
    {
      name: "negative minOccurrences",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        preferences: { query: { ...query, minOccurrences: -1 }, view, page: 1 },
      }),
      code: "invalid-shape",
    },
    {
      name: "invalid page size",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        preferences: { query: { ...query, pageSize: 0 }, view, page: 1 },
      }),
      code: "invalid-shape",
    },
    {
      name: "non-finite page",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        preferences: { query, view, page: Number.NaN },
      }),
      code: "invalid-shape",
    },
    {
      name: "view missing boolean",
      text: JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        preferences: { query, view: { ...view, showDefinitions: "yes" }, page: 1 },
      }),
      code: "invalid-shape",
    },
  ];

  for (const invalid of invalidCases) {
    it(`rejects ${invalid.name}`, () => {
      expectBackupError(invalid.code, () => parseBackup(invalid.text));
    });
  }

  it("rejects non-object JSON roots with a clear message", () => {
    expectBackupError("invalid-format", () => parseBackup("42"));
  });

  it("reports the offending version in unsupported-version errors", () => {
    try {
      parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 7 }));
      expect.fail("expected throw");
    } catch (error) {
      expect((error as BackupError).message).toContain("7");
    }
  });
});

describe("MinerBackupV1 shape", () => {
  it("keeps the parsed type assignable to the documented interface", () => {
    const backup: MinerBackupV1 = parseBackup(
      serializeBackup({ exportedAt: EXPORTED_AT, knownWords: null, wordDecisions: [], preferences: null }),
    );
    expect(backup.preferences).toBeNull();
  });
});
