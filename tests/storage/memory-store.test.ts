import { describe, expect, it } from "vitest";
import { createMemoryAppStore } from "../../src/storage/memory-store";
import type { AppStore, DatasetMetadata } from "../../src/storage/contracts";
import type {
  Entry,
  QueryState,
  ViewState,
  WordDecision,
} from "../../src/domain/types";

const metadata = (id: string): DatasetMetadata => ({
  id,
  name: `${id} dataset`,
  sourceType: "file",
  sourceName: `${id}.csv`,
  headers: ["Word", "Occurrences"],
  entryCount: 3,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  schemaVersion: 1,
});

const entry = (id: string, originalIndex: number): Entry => ({
  id,
  originalIndex,
  word: `word-${originalIndex}`,
  normalizedWord: `word-${originalIndex}`,
  occurrences: originalIndex + 1,
  sentenceRaw: "",
  hasSentence: false,
  definitions: "",
  furiganaRuns: [],
});

async function* chunks(values: readonly (readonly Entry[])[]): AsyncIterable<readonly Entry[]> {
  for (const value of values) {
    yield value;
  }
}

async function* failingChunks(first: Entry): AsyncIterable<readonly Entry[]> {
  yield [first];
  throw new Error("import failed");
}

async function collectChunks(source: AsyncIterable<Entry[]>): Promise<Entry[][]> {
  const result: Entry[][] = [];
  for await (const chunk of source) {
    result.push(chunk);
  }
  return result;
}

const query: QueryState = {
  search: "word",
  hideKnown: true,
  hideKanaOnly: false,
  sentence: "any",
  minOccurrences: 1,
  sort: "occ-desc",
  pageSize: 50,
  page: 2,
  decision: "all",
};

const view: ViewState = {
  showFurigana: true,
  pillHighlight: false,
  showHighlight: true,
  showDefinitions: false,
};

const decision = (normalizedWord: string, status: WordDecision["status"], updatedAt: string): WordDecision => ({
  normalizedWord,
  status,
  updatedAt,
});

describe("MemoryAppStore", () => {
  it("keeps staged data inactive until an explicit activation", async () => {
    const store: AppStore = createMemoryAppStore();

    await store.datasets.stage(
      metadata("first"),
      chunks([[entry("entry-0", 0), entry("entry-1", 1)]]),
    );

    expect(await store.datasets.getActive()).toBeNull();
    expect(await store.datasets.list()).toEqual([metadata("first")]);

    await store.datasets.activate("first");

    expect(await store.datasets.getActive()).toEqual(metadata("first"));
  });

  it("round-trips entries in order and requested chunk sizes", async () => {
    const store = createMemoryAppStore();
    const values = [entry("entry-0", 0), entry("entry-1", 1), entry("entry-2", 2)];

    await store.datasets.stage(
      metadata("ordered"),
      chunks([[values[0]!], [values[1]!, values[2]!]]),
    );

    await expect(
      collectChunks(store.datasets.readChunks("ordered", 2)),
    ).resolves.toEqual([[values[0]!, values[1]!], [values[2]!]]);
  });

  it("keeps multiple datasets and removes only the requested dataset", async () => {
    const store = createMemoryAppStore();

    await store.datasets.stage(metadata("one"), chunks([[entry("one-entry", 0)]]));
    await store.datasets.stage(metadata("two"), chunks([[entry("two-entry", 1)]]));
    await store.datasets.activate("two");
    await store.datasets.remove("one");

    expect(await store.datasets.list()).toEqual([metadata("two")]);
    expect(await store.datasets.getActive()).toEqual(metadata("two"));
    await expect(
      collectChunks(store.datasets.readChunks("two", 10)),
    ).resolves.toEqual([[entry("two-entry", 1)]]);
  });

  it("rejects same-ID staging without replacing the active dataset", async () => {
    const store = createMemoryAppStore();
    const active = metadata("same-id");

    await store.datasets.stage(active, chunks([[entry("old-entry", 0)]]));
    await store.datasets.activate(active.id);

    await expect(
      store.datasets.stage(active, chunks([[entry("new-entry", 1)]])),
    ).rejects.toThrow("Dataset already exists");

    expect(await store.datasets.getActive()).toEqual(active);
    await expect(
      collectChunks(store.datasets.readChunks(active.id, 10)),
    ).resolves.toEqual([[entry("old-entry", 0)]]);
  });

  it("round-trips known words and preferences", async () => {
    const store = createMemoryAppStore();

    await store.knownWords.save("known", "Known words", ["alpha", "beta", "alpha"]);
    await store.preferences.save({ query, view, page: 3 });

    expect(await store.knownWords.getActive()).toEqual({
      id: "known",
      name: "Known words",
      words: new Set(["alpha", "beta"]),
    });
    expect(await store.preferences.load()).toEqual({ query, view, page: 3 });
  });

  it("removes every store on clearAll", async () => {
    const store = createMemoryAppStore();

    await store.datasets.stage(metadata("clear-me"), chunks([[entry("entry-0", 0)]]));
    await store.datasets.activate("clear-me");
    await store.knownWords.save("known", "Known words", ["alpha"]);
    await store.preferences.save({ query, view, page: 1 });
    await store.wordDecisions.set(decision("透過", "known", "2026-09-05T00:00:00.000Z"));

    await store.clearAll();

    expect(await store.datasets.list()).toEqual([]);
    expect(await store.datasets.getActive()).toBeNull();
    expect(await store.knownWords.getActive()).toBeNull();
    expect(await store.preferences.load()).toBeNull();
    expect(await store.wordDecisions.list()).toEqual([]);
  });

  it("does not leave partial data or replace active data when staging fails", async () => {
    const store = createMemoryAppStore();
    const previous = metadata("previous");

    await store.datasets.stage(previous, chunks([[entry("previous-entry", 0)]]));
    await store.datasets.activate(previous.id);

    await expect(
      store.datasets.stage(metadata("failed"), failingChunks(entry("partial", 1))),
    ).rejects.toThrow("import failed");

    expect(await store.datasets.getActive()).toEqual(previous);
    expect(await store.datasets.list()).toEqual([previous]);
    await expect(
      collectChunks(store.datasets.readChunks("failed", 10)),
    ).rejects.toThrow("Dataset not found");
  });
});

describe("MemoryAppStore wordDecisions", () => {
  it("saves and reads a decision by normalized word", async () => {
    const store = createMemoryAppStore();
    const record = decision("透過", "known", "2026-09-05T00:00:00.000Z");

    await store.wordDecisions.set(record);

    expect(await store.wordDecisions.get("透過")).toEqual(record);
    expect(await store.wordDecisions.get("unknown-word")).toBeNull();
  });

  it("overwrites the status for the same normalized word", async () => {
    const store = createMemoryAppStore();

    await store.wordDecisions.set(decision("透過", "known", "2026-09-05T00:00:00.000Z"));
    await store.wordDecisions.set(decision("透過", "mined", "2026-09-05T01:00:00.000Z"));

    expect(await store.wordDecisions.get("透過")).toEqual(
      decision("透過", "mined", "2026-09-05T01:00:00.000Z"),
    );
    expect(await store.wordDecisions.list()).toEqual([
      decision("透過", "mined", "2026-09-05T01:00:00.000Z"),
    ]);
  });

  it("returns defensive copies from get and list", async () => {
    const store = createMemoryAppStore();

    const record = decision("透過", "later", "2026-09-05T00:00:00.000Z");
    await store.wordDecisions.set(record);
    record.status = "skip";

    const fetched = await store.wordDecisions.get("透過");
    expect(fetched).toEqual(decision("透過", "later", "2026-09-05T00:00:00.000Z"));
    fetched!.status = "mined";

    const listed = await store.wordDecisions.list();
    expect(listed).toEqual([decision("透過", "later", "2026-09-05T00:00:00.000Z")]);
    listed[0]!.status = "skip";

    expect(await store.wordDecisions.get("透過")).toEqual(
      decision("透過", "later", "2026-09-05T00:00:00.000Z"),
    );
    expect(await store.wordDecisions.list()).toEqual([
      decision("透過", "later", "2026-09-05T00:00:00.000Z"),
    ]);
  });

  it("removes a decision by normalized word", async () => {
    const store = createMemoryAppStore();

    await store.wordDecisions.set(decision("透過", "skip", "2026-09-05T00:00:00.000Z"));
    await store.wordDecisions.remove("透過");

    expect(await store.wordDecisions.get("透過")).toBeNull();
    expect(await store.wordDecisions.list()).toEqual([]);
  });

  it("treats removing an unknown word as a no-op", async () => {
    const store = createMemoryAppStore();

    await store.wordDecisions.set(decision("透過", "skip", "2026-09-05T00:00:00.000Z"));
    await store.wordDecisions.remove("unknown-word");

    expect(await store.wordDecisions.get("透過")).toEqual(
      decision("透過", "skip", "2026-09-05T00:00:00.000Z"),
    );
  });

  it("clears every decision", async () => {
    const store = createMemoryAppStore();

    await store.wordDecisions.set(decision("透過", "known", "2026-09-05T00:00:00.000Z"));
    await store.wordDecisions.set(decision("遠い", "later", "2026-09-05T01:00:00.000Z"));

    await store.wordDecisions.clear?.();

    expect(await store.wordDecisions.list()).toEqual([]);
    expect(await store.wordDecisions.get("透過")).toBeNull();
  });
});
