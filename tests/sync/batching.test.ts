import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/domain/types";
import { RemoteStoreError } from "../../src/storage/remote-store";
import { MAX_SYNC_ROW_BYTES, splitEntriesForWire } from "../../src/sync/batching";

function makeEntry(word: string, payloadSize: number): Entry {
  return {
    id: word,
    originalIndex: 0,
    occurrences: 1,
    word,
    normalizedWord: word,
    hasSentence: false,
    sentenceRaw: "",
    definitions: "x".repeat(payloadSize),
    furiganaRuns: [],
  };
}

describe("splitEntriesForWire", () => {
  it("splits entries when exceeding maxRows", () => {
    const entries: Entry[] = Array.from({ length: 5 }, (_, i) => makeEntry(`word${i}`, 10));
    const batches = splitEntriesForWire(entries, 2, 100_000);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(2);
    expect(batches[2]).toHaveLength(1);
  });

  it("splits entries when exceeding maxBytes before maxRows", () => {
    // Each entry with 2000 chars payload is ~2KB. 5 entries = ~10KB.
    // If maxBytes is 4000, it should split after 1 or 2 entries.
    const entries: Entry[] = Array.from({ length: 4 }, (_, i) => makeEntry(`word${i}`, 2000));
    const batches = splitEntriesForWire(entries, 10, 4500);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const bytes = new TextEncoder().encode(JSON.stringify(batch)).length;
      expect(bytes).toBeLessThan(4500);
    }
  });

  it("throws RemoteStoreError with 413 if a single row exceeds MAX_SYNC_ROW_BYTES", () => {
    const hugeEntry = makeEntry("huge", MAX_SYNC_ROW_BYTES + 500);
    expect(() => splitEntriesForWire([hugeEntry])).toThrow(RemoteStoreError);
    try {
      splitEntriesForWire([hugeEntry]);
    } catch (err: any) {
      expect(err.status).toBe(413);
      expect(err.code).toBe("PAYLOAD_TOO_LARGE");
    }
  });
});
