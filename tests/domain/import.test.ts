import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isKanaOnly,
  normalizeText,
  parseCsv,
  parseFuriganaRuns,
  parseHighlightSegments,
  parseKnownWords,
  sentencePlain,
} from "../../src/domain/text";
import { ImportError, parseJitenCsv } from "../../src/domain/import";
import { describe, expect, it } from "vitest";

const jitenFixture = readFileSync(
  fileURLToPath(new URL("../fixtures/jiten-small.csv", import.meta.url)),
  "utf8",
);
const knownWordsFixture = readFileSync(
  fileURLToPath(new URL("../fixtures/known-small.txt", import.meta.url)),
  "utf8",
);

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("Expected action to throw");
}

describe("parseJitenCsv", () => {
  it("parses deterministic fixture into entries with stable IDs", () => {
    expect(parseJitenCsv(jitenFixture)).toEqual({
      headers: [
        "Word",
        "Occurences",
        "ExampleSentence",
        "Definitions",
        "ReadingFurigana",
      ],
      entries: [
        {
          id: "entry-0",
          originalIndex: 0,
          word: "気になる",
          normalizedWord: "気になる",
          occurrences: 12,
          sentenceRaw: "彼は**気になる**。",
          hasSentence: true,
          definitions: "to worry, to mind",
          furiganaRuns: [
            { text: "気", reading: "き" },
            { text: "になる", reading: null },
          ],
        },
        {
          id: "entry-1",
          originalIndex: 1,
          word: "プール",
          normalizedWord: "プール",
          occurrences: 8,
          sentenceRaw: "夏はプールで泳ぐ。",
          hasSentence: true,
          definitions: "pool",
          furiganaRuns: [{ text: "プール", reading: null }],
        },
        {
          id: "entry-2",
          originalIndex: 2,
          word: "静か",
          normalizedWord: "静か",
          occurrences: 3,
          sentenceRaw: "",
          hasSentence: false,
          definitions: "quiet",
          furiganaRuns: [{ text: "静", reading: "しず" }, { text: "か", reading: null }],
        },
      ],
      skippedRows: 0,
    });
  });

  it("parses quoted commas and multiline fields", () => {
    const parsed = parseJitenCsv(
      `Word,Definitions,ExampleSentence\r\n気になる,"care, mind","彼は**気になる**。\n次の行"\r\n`,
    );

    expect(parsed.entries[0]?.word).toBe("気になる");
    expect(parsed.entries[0]?.definitions).toBe("care, mind");
    expect(parsed.entries[0]?.sentenceRaw).toContain("次の行");
  });

  it("accepts a BOM and CRLF while keeping optional columns empty", () => {
    const parsed = parseJitenCsv(
      "\uFEFFWord,Occurences\r\n猫,not-a-number\r\n犬,-2\r\n",
    );

    expect(parsed.headers).toEqual(["Word", "Occurences"]);
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        id: "entry-0",
        word: "猫",
        occurrences: 0,
        sentenceRaw: "",
        hasSentence: false,
        definitions: "",
        furiganaRuns: [],
      }),
      expect.objectContaining({ id: "entry-1", word: "犬", occurrences: 0 }),
    ]);
  });

  it("treats occurrence values with trailing or decimal characters as invalid", () => {
    const parsed = parseJitenCsv(
      "Word,Occurences\n猫,12abc\n犬,1.5\n鳥, 42 \n鴨,0\n",
    );

    expect(parsed.entries.map((entry) => entry.occurrences)).toEqual([0, 0, 42, 0]);
  });

  it("ignores blank rows and counts non-empty rows without a word", () => {
    const parsed = parseJitenCsv(
      "Word,Definitions\n気,meaning\n,has data\n  ,   \n\n猫,animal\n",
    );

    expect(parsed.skippedRows).toBe(1);
    expect(parsed.entries.map((entry) => [entry.id, entry.originalIndex])).toEqual([
      ["entry-0", 0],
      ["entry-4", 4],
    ]);
  });

  it("rejects an empty file with a typed import error", () => {
    const error = captureError(() => parseJitenCsv(""));

    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ code: "empty-file" });
  });

  it("rejects Jiten CSV without the required Word column", () => {
    const error = captureError(() => parseJitenCsv("Definitions\nmeaning\n"));

    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ code: "missing-column" });
  });

  it("rejects an unclosed quoted field with a typed import error", () => {
    const error = captureError(() => parseJitenCsv('Word,Definitions\n猫,"animal\n'));

    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ code: "malformed-csv" });
  });
});

describe("text domain functions", () => {
  it("normalizes unknown values with trimming and NFC", () => {
    expect(normalizeText(undefined)).toBe("");
    expect(normalizeText("  か\u3099  ")).toBe("が");
  });

  it("parses CSV rows with escaped quotes and newlines", () => {
    expect(parseCsv('Word,"say ""hello"""\r\n猫,"line 1\nline 2"')).toEqual([
      ["Word", 'say "hello"'],
      ["猫", "line 1\nline 2"],
    ]);
  });

  it("parses known words from fixture and ignores empty lines", () => {
    expect(parseKnownWords(`${knownWordsFixture}\r\n\n`)).toEqual(new Set(["プール"]));
  });

  it("parses furigana into text and reading runs", () => {
    expect(parseFuriganaRuns("気[き]になる プール")).toEqual([
      { text: "気", reading: "き" },
      { text: "になる プール", reading: null },
    ]);
  });

  it("splits highlighted and plain sentence segments", () => {
    expect(parseHighlightSegments("彼は**気になる**。**本当**？")).toEqual([
      { text: "彼は", highlighted: false },
      { text: "気になる", highlighted: true },
      { text: "。", highlighted: false },
      { text: "本当", highlighted: true },
      { text: "？", highlighted: false },
    ]);
  });

  it("keeps an unmatched highlight marker as plain text", () => {
    expect(parseHighlightSegments("彼は**気になる")).toEqual([
      { text: "彼は**気になる", highlighted: false },
    ]);
  });

  it("does not highlight empty marker pairs", () => {
    expect(parseHighlightSegments("前****後")).toEqual([
      { text: "前", highlighted: false },
      { text: "****", highlighted: false },
      { text: "後", highlighted: false },
    ]);
  });

  it("removes highlight markup when producing plain sentence text", () => {
    expect(sentencePlain("彼は**気になる**。")).toBe("彼は気になる。");
  });

  it("recognizes non-empty hiragana and katakana-only words", () => {
    expect(isKanaOnly("プール")).toBe(true);
    expect(isKanaOnly("ひらがな・カタカナー")).toBe(true);
    expect(isKanaOnly("気になる")).toBe(false);
    expect(isKanaOnly("   ")).toBe(false);
  });
});
