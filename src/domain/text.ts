import { ImportError } from "./types";
import type { FuriganaRun, HighlightSegment } from "./types";

export function normalizeText(value: unknown): string {
  return String(value ?? "").trim().normalize("NFC");
}

export function parseCsv(text: string): string[][] {
  const source = String(text ?? "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      if (source[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    throw new ImportError(
      "malformed-csv",
      "Could not read this as a Jiten CSV. The file contains an unclosed quoted field.",
    );
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function parseKnownWords(text: string): Set<string> {
  const known = new Set<string>();
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((line) => {
      const normalized = normalizeText(line);
      if (normalized) known.add(normalized);
    });
  return known;
}

export function parseFuriganaRuns(furigana: string): FuriganaRun[] {
  const source = normalizeText(furigana);
  const runs: FuriganaRun[] = [];
  const re = /([^\[\]]+)(?:\[([^\]]+)\])?/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source))) {
    if (match[1]) runs.push({ text: match[1], reading: match[2] || null });
  }

  return runs;
}

export function isKanaOnly(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.length > 0 && /^[\u3040-\u309F\u30A0-\u30FFー・]+$/.test(normalized);
}

export function parseHighlightSegments(sentence: string): HighlightSegment[] {
  const source = String(sentence ?? "");
  if (!source) return [];

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let sawPair = false;

  while (cursor < source.length) {
    const open = source.indexOf("**", cursor);
    if (open === -1) {
      if (cursor < source.length) segments.push({ text: source.slice(cursor), highlighted: false });
      break;
    }

    const close = source.indexOf("**", open + 2);
    if (close === -1) {
      if (!sawPair) return [{ text: source, highlighted: false }];
      segments.push({ text: source.slice(cursor), highlighted: false });
      break;
    }

    sawPair = true;
    if (open > cursor) segments.push({ text: source.slice(cursor, open), highlighted: false });
    const highlightedText = source.slice(open + 2, close);
    if (highlightedText) {
      segments.push({ text: highlightedText, highlighted: true });
    } else {
      segments.push({ text: "****", highlighted: false });
    }
    cursor = close + 2;
  }

  return segments;
}

export function sentencePlain(sentence: string): string {
  return parseHighlightSegments(sentence)
    .map((segment) => segment.text)
    .join("");
}
