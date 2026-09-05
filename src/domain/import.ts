import {
  ImportError,
  type Entry,
  type ParsedJitenCsv,
} from "./types";
import { normalizeText, parseCsv, parseFuriganaRuns } from "./text";

export { ImportError } from "./types";

export function parseJitenCsv(text: string): ParsedJitenCsv {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new ImportError("empty-file", "Could not read this as a Jiten CSV. The file is empty.");
  }

  const headerRow = rows[0] ?? [];
  const headers = headerRow.map((value, index) => {
    const clean = normalizeText(value);
    return index === 0 ? clean.replace(/^\uFEFF/, "") : clean;
  });
  const wordIndex = headers.indexOf("Word");
  if (wordIndex === -1) {
    throw new ImportError(
      "missing-column",
      "Could not read this as a Jiten CSV.\n\nMissing required column:\nWord",
    );
  }

  const occurrencesIndex = headers.indexOf("Occurences");
  const sentenceIndex = headers.indexOf("ExampleSentence");
  const definitionsIndex = headers.indexOf("Definitions");
  const furiganaIndex = headers.indexOf("ReadingFurigana");
  const entries: Entry[] = [];
  let skippedRows = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const word = normalizeText(row[wordIndex] ?? "");
    if (!word) {
      if (row.some((value) => normalizeText(value))) skippedRows += 1;
      continue;
    }

    const rawOccurrences = occurrencesIndex >= 0 ? normalizeText(row[occurrencesIndex] ?? "") : "";
    const parsedOccurrences = /^\d+$/.test(rawOccurrences) ? Number(rawOccurrences) : Number.NaN;
    const occurrences = Number.isFinite(parsedOccurrences) ? parsedOccurrences : 0;
    const sentenceRaw = sentenceIndex >= 0 ? normalizeText(row[sentenceIndex] ?? "") : "";
    const definitions = definitionsIndex >= 0 ? normalizeText(row[definitionsIndex] ?? "") : "";
    const furiganaRuns = furiganaIndex >= 0 ? parseFuriganaRuns(row[furiganaIndex] ?? "") : [];
    const originalIndex = i - 1;

    entries.push({
      id: `entry-${originalIndex}`,
      originalIndex,
      word,
      normalizedWord: normalizeText(word),
      occurrences,
      sentenceRaw,
      hasSentence: sentenceRaw.length > 0,
      definitions,
      furiganaRuns,
    });
  }

  return { headers, entries, skippedRows };
}
