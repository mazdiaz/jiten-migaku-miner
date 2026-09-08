import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT,
  BackupError,
  type MinerBackupV1,
  parseBackup,
  serializeBackup,
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
  sentenceSize: "large" as const,
  density: "compact" as const,
};

function decision(
  word: string,
  status: WordDecision["status"],
  updatedAt = EXPORTED_AT,
): WordDecision {
  return { normalizedWord: word, status, updatedAt };
}

function validBackupJson(): string {
  return JSON.stringify({
    format: "jiten-migaku-miner-backup",
    version: 1,
    exportedAt: "2026-09-06T00:00:00.000Z",
    knownWords: { name: "Migaku known words", words: ["新しい", "透過"] },
    wordDecisions: [
      {
        normalizedWord: "新しい",
        status: "known",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
    preferences: {
      query: {
        search: "",
        hideKnown: false,
        hideKanaOnly: false,
        sentence: "any",
        minOccurrences: 1,
        sort: "occ-desc",
        pageSize: 50,
        page: 1,
        decision: "all",
      },
      view: {
        showFurigana: false,
        pillHighlight: false,
        showHighlight: false,
        showDefinitions: true,
      },
      page: 1,
    },
  });
}

function mutatedBackup(mutate: (backup: any) => void): string {
  const backup = JSON.parse(validBackupJson());
  mutate(backup);
  return JSON.stringify(backup);
}

function expectBackupError(code: string, fragment: RegExp, action: () => unknown): void {
  try {
    action();
    expect.fail(`expected BackupError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe(code);
    expect((error as BackupError).message).toMatch(fragment);
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
    expect(backup.knownWords).toEqual({
      name: "k.txt",
      words: ["決めて", "ｶﾞ"],
    });
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
      {
        normalizedWord: "一",
        status: "skip",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        normalizedWord: "二",
        status: "later",
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
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
        {
          normalizedWord: "古い",
          status: "known",
          updatedAt: EXPORTED_AT,
          futureDecisionField: "x",
        },
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

  const invalidCases: Array<{
    name: string;
    text: string;
    code: string;
    fragment: RegExp;
  }> = [
    {
      name: "invalid JSON",
      text: "{not json",
      code: "invalid-json",
      fragment: /not valid JSON/,
    },
    {
      name: "JSON array root",
      text: "[]",
      code: "invalid-format",
      fragment: /must be a JSON object/,
    },
    {
      name: "missing format",
      text: mutatedBackup((backup) => {
        delete backup.format;
      }),
      code: "invalid-format",
      fragment: /Backup format must be/,
    },
    {
      name: "wrong format string",
      text: mutatedBackup((backup) => {
        backup.format = "wrong";
      }),
      code: "invalid-format",
      fragment: /Backup format must be/,
    },
    {
      name: "unsupported version",
      text: mutatedBackup((backup) => {
        backup.version = 99;
      }),
      code: "unsupported-version",
      fragment: /Unsupported backup version/,
    },
    {
      name: "missing version",
      text: mutatedBackup((backup) => {
        delete backup.version;
      }),
      code: "unsupported-version",
      fragment: /Unsupported backup version/,
    },
    {
      name: "knownWords not an object",
      text: mutatedBackup((backup) => {
        backup.knownWords = "nope";
      }),
      code: "invalid-shape",
      fragment: /knownWords must be an object or null/,
    },
    {
      name: "knownWords words not array",
      text: mutatedBackup((backup) => {
        backup.knownWords = { name: "k", words: "nope" };
      }),
      code: "invalid-shape",
      fragment: /knownWords\.words must be an array/,
    },
    {
      name: "knownWords word not string",
      text: mutatedBackup((backup) => {
        backup.knownWords = { name: "k", words: [42] };
      }),
      code: "invalid-shape",
      fragment: /knownWords\.words\[0\] must be a non-empty string/,
    },
    {
      name: "decisions not array",
      text: mutatedBackup((backup) => {
        backup.wordDecisions = {};
      }),
      code: "invalid-shape",
      fragment: /wordDecisions must be an array/,
    },
    {
      name: "decision missing normalizedWord",
      text: mutatedBackup((backup) => {
        backup.wordDecisions = [{ status: "known", updatedAt: EXPORTED_AT }];
      }),
      code: "invalid-shape",
      fragment: /wordDecisions\[0\]\.normalizedWord must be a non-empty string/,
    },
    {
      name: "decision empty normalizedWord",
      text: mutatedBackup((backup) => {
        backup.wordDecisions = [{ normalizedWord: "", status: "known", updatedAt: EXPORTED_AT }];
      }),
      code: "invalid-shape",
      fragment: /wordDecisions\[0\]\.normalizedWord must be a non-empty string/,
    },
    {
      name: "decision invalid status",
      text: mutatedBackup((backup) => {
        backup.wordDecisions = [
          { normalizedWord: "躊躇う", status: "maybe", updatedAt: EXPORTED_AT },
        ];
      }),
      code: "invalid-shape",
      fragment: /wordDecisions\[0\]\.status must be one of/,
    },
    {
      name: "decision missing updatedAt",
      text: mutatedBackup((backup) => {
        backup.wordDecisions = [{ normalizedWord: "躊躇う", status: "mined" }];
      }),
      code: "invalid-shape",
      fragment: /wordDecisions\[0\]\.updatedAt must be a non-empty string/,
    },
    {
      name: "duplicate decision normalizedWord",
      text: mutatedBackup((backup) => {
        backup.wordDecisions = [
          { normalizedWord: "跳ぶ", status: "mined", updatedAt: EXPORTED_AT },
          { normalizedWord: "跳ぶ", status: "skip", updatedAt: EXPORTED_AT },
        ];
      }),
      code: "invalid-shape",
      fragment: /duplicate normalizedWord/,
    },
    {
      name: "invalid query sort",
      text: mutatedBackup((backup) => {
        backup.preferences.query.sort = "random";
      }),
      code: "invalid-shape",
      fragment: /preferences\.query\.sort must be/,
    },
    {
      name: "invalid decision filter",
      text: mutatedBackup((backup) => {
        backup.preferences.query.decision = "sometimes";
      }),
      code: "invalid-shape",
      fragment: /preferences\.query\.decision must be/,
    },
    {
      name: "negative minOccurrences",
      text: mutatedBackup((backup) => {
        backup.preferences.query.minOccurrences = -1;
      }),
      code: "invalid-shape",
      fragment: /preferences\.query\.minOccurrences must be a nonnegative/,
    },
    {
      name: "invalid page size",
      text: mutatedBackup((backup) => {
        backup.preferences.query.pageSize = 0;
      }),
      code: "invalid-shape",
      fragment: /preferences\.query\.pageSize must be a positive integer/,
    },
    {
      name: "non-finite page",
      text: mutatedBackup((backup) => {
        backup.preferences.page = null;
      }),
      code: "invalid-shape",
      fragment: /preferences\.page must be a positive integer/,
    },
    {
      name: "view missing boolean",
      text: mutatedBackup((backup) => {
        backup.preferences.view.showDefinitions = "yes";
      }),
      code: "invalid-shape",
      fragment: /preferences\.view\.showDefinitions must be a boolean/,
    },
  ];

  for (const invalid of invalidCases) {
    it(`rejects ${invalid.name}`, () => {
      expectBackupError(invalid.code, invalid.fragment, () => parseBackup(invalid.text));
    });
  }

  it("rejects non-object JSON roots with a clear message", () => {
    expectBackupError("invalid-format", /must be a JSON object/, () => parseBackup("42"));
  });

  it("reports the offending version in unsupported-version errors", () => {
    try {
      parseBackup(
        mutatedBackup((backup) => {
          backup.version = 7;
        }),
      );
      expect.fail("expected throw");
    } catch (error) {
      expect((error as BackupError).message).toContain("7");
    }
  });
});

describe("parseBackup canonical identities", () => {
  it("rejects whitespace-only decision identities", () => {
    const backup = JSON.parse(validBackupJson());
    backup.wordDecisions.push({
      normalizedWord: "   ",
      status: "known",
      updatedAt: "2026-09-05T00:00:00.000Z",
    });
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(/must not be empty/);
  });

  it("rejects noncanonical decision identities", () => {
    const backup = JSON.parse(validBackupJson());
    backup.wordDecisions.push({
      normalizedWord: " 新しい ",
      status: "known",
      updatedAt: "2026-09-05T00:00:00.000Z",
    });
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(/canonical/);
  });

  it("rejects duplicates that differ only by normalization", () => {
    const backup = JSON.parse(validBackupJson());
    backup.wordDecisions.push({
      normalizedWord: "新しい",
      status: "mined",
      updatedAt: "2026-09-05T00:00:00.000Z",
    });
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(/duplicate/);
  });

  it("every accepted backup survives a serialize/parse round-trip", () => {
    const parsed = parseBackup(validBackupJson());
    const serialized = serializeBackup({
      exportedAt: parsed.exportedAt,
      knownWords: parsed.knownWords,
      wordDecisions: parsed.wordDecisions,
      preferences: parsed.preferences,
    });
    expect(parseBackup(serialized)).toEqual(parsed);
  });
});

describe("parseBackup display preferences", () => {
  it("round-trips sentenceSize and density with the new fields", () => {
    const json = serializeBackup({
      exportedAt: EXPORTED_AT,
      knownWords: null,
      wordDecisions: [],
      preferences: { query, view, page: 3 },
    });
    const backup = parseBackup(json);
    expect(backup.preferences?.view.sentenceSize).toBe("large");
    expect(backup.preferences?.view.density).toBe("compact");
  });

  it("fills the DEFAULT_VIEW display values when an old backup omits the new keys", () => {
    const backup = parseBackup(
      mutatedBackup((record) => {
        delete record.preferences.view.sentenceSize;
        delete record.preferences.view.density;
      }),
    );
    expect(backup.preferences?.view.sentenceSize).toBe("medium");
    expect(backup.preferences?.view.density).toBe("comfortable");
  });

  it("rejects an out-of-set sentenceSize", () => {
    expectBackupError(
      "invalid-shape",
      /preferences\.view\.sentenceSize must be "medium" or "large"/,
      () =>
        parseBackup(
          mutatedBackup((record) => {
            record.preferences.view.sentenceSize = "huge";
          }),
        ),
    );
  });

  it("rejects an out-of-set density", () => {
    expectBackupError(
      "invalid-shape",
      /preferences\.view\.density must be "comfortable" or "compact"/,
      () =>
        parseBackup(
          mutatedBackup((record) => {
            record.preferences.view.density = "cozy";
          }),
        ),
    );
  });
});

describe("MinerBackupV1 shape", () => {
  it("keeps the parsed type assignable to the documented interface", () => {
    const backup: MinerBackupV1 = parseBackup(
      serializeBackup({
        exportedAt: EXPORTED_AT,
        knownWords: null,
        wordDecisions: [],
        preferences: null,
      }),
    );
    expect(backup.preferences).toBeNull();
  });
});
