import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Entry } from "../../src/domain/types";
import { createPostgresStore } from "../../src/server/store";
import { createRemoteAppStore } from "../../src/storage/remote-store";

const metadata = (id = "one", entryCount = 1) => ({
  id,
  name: id,
  sourceType: "file" as const,
  sourceName: "words.csv",
  headers: ["Word"],
  entryCount,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  schemaVersion: 1,
});
const entry = (id = "1"): Entry => ({
  id,
  originalIndex: Number(id),
  word: "猫",
  normalizedWord: "猫",
  occurrences: 4,
  sentenceRaw: "猫がいる",
  hasSentence: true,
  definitions: "cat",
  furiganaRuns: [],
});
const preferences = {
  query: {
    search: "",
    hideKnown: false,
    hideKanaOnly: false,
    sentence: "any" as const,
    minOccurrences: 1,
    sort: "occ-desc" as const,
    pageSize: 50,
    page: 1,
    decision: "all" as const,
  },
  view: {
    showFurigana: false,
    pillHighlight: false,
    showHighlight: false,
    showDefinitions: true,
    sentenceSize: "medium" as const,
    density: "comfortable" as const,
  },
  page: 1,
};
async function* chunks(...values: Entry[][]) {
  yield* values;
}

describe("PostgreSQL store over the real HTTP adapter", () => {
  let pg: PGlite;
  let dispatch: ReturnType<typeof createPostgresStore>;
  let requestSizes: number[];
  let responseSizes: number[];
  let capturedRequests: Array<Record<string, unknown>>;
  const remote = () =>
    createRemoteAppStore({
      fetch: (async (_url, init) => {
        const body = String(init?.body);
        requestSizes.push(new TextEncoder().encode(body).length);
        const parsed = JSON.parse(body);
        capturedRequests.push(parsed);
        try {
          const value = await dispatch(parsed);
          const json = JSON.stringify(value);
          responseSizes.push(new TextEncoder().encode(json).length);
          return new Response(json, { status: 200 });
        } catch (error) {
          const fault = error as Error & { status?: number; code?: string };
          return new Response(JSON.stringify({ error: fault.message, code: fault.code }), {
            status: fault.status ?? 500,
          });
        }
      }) as typeof fetch,
    });

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(
      await readFile(new URL("../../migrations/0000_postgres_store.sql", import.meta.url), "utf8"),
    );
    await pg.exec(
      await readFile(
        new URL("../../migrations/0001_dataset_upload_counters.sql", import.meta.url),
        "utf8",
      ),
    );
    dispatch = createPostgresStore(drizzle(pg));
  }, 60_000);
  afterAll(async () => {
    await pg?.close();
  });
  beforeEach(async () => {
    await pg.exec(
      "TRUNCATE app_state, datasets, state_uploads, known_words, word_decisions, anki_statuses RESTART IDENTITY CASCADE",
    );
    requestSizes = [];
    responseSizes = [];
    capturedRequests = [];
  });

  it("persists ordered datasets, decisions, known words, preferences and Anki state across clients", async () => {
    const store = remote();
    await store.initialize();
    await store.datasets.stage(metadata("one", 2), chunks([entry("1"), entry("2")]));
    await store.datasets.activate("one");
    await store.knownWords.save("known", "Migaku", ["猫", "犬", "猫"]);
    await store.wordDecisions.set({
      normalizedWord: "犬",
      status: "later",
      updatedAt: "2026-09-14",
    });
    await store.preferences.save(preferences);
    await store.ankiSync.saveConfig({
      deckScope: { kind: "all-decks" },
      noteType: "Japanese",
      targetField: "Word",
    });
    await store.ankiSync.replaceSnapshot({ syncedAt: "2026-09-14", statuses: [["猫", "known"]] });
    const reloaded = remote();
    await reloaded.initialize();
    expect((await reloaded.datasets.getActive())?.id).toBe("one");
    const rows: Entry[] = [];
    for await (const chunk of reloaded.datasets.readChunks("one", 1)) rows.push(...chunk);
    expect(rows.map((row) => row.id)).toEqual(["1", "2"]);
    expect((await reloaded.knownWords.getActive())?.words).toEqual(new Set(["猫", "犬"]));
    expect((await reloaded.wordDecisions.get("犬"))?.status).toBe("later");
    expect(await reloaded.preferences.load()).toEqual(preferences);
    expect((await reloaded.ankiSync.loadConfig())?.targetField).toBe("Word");
    expect((await reloaded.ankiSync.loadSnapshot())?.statuses).toEqual([["猫", "known"]]);
  });

  it("keeps the previous active dataset when a staged import is incomplete", async () => {
    const store = remote();
    await store.initialize();
    await store.datasets.stage(metadata(), chunks([entry()]));
    await store.datasets.activate("one");
    await expect(store.datasets.stage(metadata("bad", 2), chunks([entry()]))).rejects.toThrow(
      /count|incomplete/i,
    );
    expect((await store.datasets.getActive())?.id).toBe("one");
    expect((await store.datasets.list()).map((item) => item.id)).toEqual(["one"]);
    await expect(store.datasets.activate("bad")).rejects.toThrow(/ready|found|incomplete/i);
  });

  it("rejects stale writes and reads without silently replacing newer data", async () => {
    const a = remote(),
      b = remote();
    await a.initialize();
    await b.initialize();
    await a.preferences.save(preferences);
    await expect(b.preferences.save({ ...preferences, page: 8 })).rejects.toThrow(
      /another|reload|conflict/i,
    );
    await expect(b.preferences.load()).rejects.toThrow(/another|reload|conflict/i);
    expect((await a.preferences.load())?.page).toBe(1);
  });

  it("restores user state atomically and rejects duplicate manual decisions", async () => {
    const store = remote();
    await store.initialize();
    await store.knownWords.save("old", "Old", ["前"]);
    const decision = { normalizedWord: "猫", status: "known" as const, updatedAt: "2026-09-14" };
    await expect(
      store.restoreUserState!({ knownWords: null, decisions: [decision, decision], preferences }),
    ).rejects.toThrow(/duplicate/i);
    expect((await store.knownWords.getActive())?.id).toBe("old");
    await store.restoreUserState!({
      knownWords: { id: "new", name: "New", words: new Set(["後"]) },
      decisions: [decision],
      preferences,
    });
    expect((await store.knownWords.getActive())?.id).toBe("new");
    expect(await store.wordDecisions.list()).toEqual([decision]);
  });

  it("stores a queue per dataset and removes it with its dataset", async () => {
    const store = remote();
    await store.initialize();
    await store.datasets.stage(metadata(), chunks([entry()]));
    await store.datasets.activate("one");
    await store.queue.save({ version: 1, datasetId: "one", normalizedWords: ["猫"] });
    const reloaded = remote();
    await reloaded.initialize();
    expect(await reloaded.queue.load()).toEqual({
      version: 1,
      datasetId: "one",
      normalizedWords: ["猫"],
    });
    await reloaded.datasets.remove("one");
    expect(await reloaded.queue.load()).toBeNull();
  });

  it("uploads and reads Japanese datasets and large state in sub-megabyte requests", async () => {
    const store = remote();
    await store.initialize();
    const rows = Array.from({ length: 900 }, (_, index) => ({
      ...entry(String(index)),
      definitions: "日本語".repeat(1600),
    }));
    await store.datasets.stage(metadata("large", rows.length), chunks(rows));
    await store.datasets.activate("large");
    const read: Entry[] = [];
    for await (const chunk of store.datasets.readChunks("large", 51)) read.push(...chunk);
    expect(read.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    await store.knownWords.save(
      "many",
      "Many",
      Array.from({ length: 20_000 }, (_, i) => `言葉${i}`),
    );
    expect((await store.knownWords.getActive())?.words.size).toBe(20_000);
    expect(Math.max(...requestSizes)).toBeLessThan(1_000_000);
    expect(Math.max(...responseSizes)).toBeLessThan(1_000_000);
  }, 60_000);

  it.each(["😀", "𠮷"])(
    "preserves %s across a PostgreSQL staged-text chunk boundary",
    async (character) => {
      const store = remote();
      await store.initialize();
      const prefixLength =
        JSON.stringify({ id: "known", name: "", words: [] }).indexOf('"name":"') + 8;
      const name = "a".repeat(59_999 - prefixLength) + character;
      await store.knownWords.save("known", name, ["猫"]);
      expect((await store.knownWords.getActive())?.name === name).toBe(true);
      expect(Math.max(...requestSizes)).toBeLessThan(750_000);
    },
  );

  it("rejects complete exports above the UTF-8 restore byte limit", async () => {
    // Isolate the client export limit from storage: a valid, bounded page is repeated
    // until individually admissible data exceeds the aggregate restore limit.
    const largeEntry = { ...entry(), definitions: "猫".repeat(90_000) };
    const store = createRemoteAppStore({
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        let value: unknown = null;
        if (request.operation === "dataset.list")
          value = { items: [metadata("large", 1000)], nextCursor: null };
        if (request.operation === "dataset.read")
          value = {
            items: [{ ...largeEntry, id: String(request.cursor) }],
            nextCursor: request.cursor < 999 ? request.cursor + 1 : null,
          };
        if (
          request.operation === "state.read" &&
          ["decisions", "queues"].includes(request.resource)
        )
          value = { items: [], nextCursor: null };
        // The HTTP response fixture retains repeated source strings to keep this
        // boundary test small; production export still serializes and counts bytes.
        return { ok: true, status: 200, json: async () => ({ revision: 0, value }) } as Response;
      }) as typeof fetch,
    });
    await expect(store.exportCompleteBackup().then(() => "exported")).rejects.toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  }, 60_000);

  it("round trips a complete backup and leaves all data intact on invalid restore", async () => {
    const store = remote();
    await store.initialize();
    await store.datasets.stage(metadata(), chunks([entry()]));
    await store.datasets.activate("one");
    await store.queue.save({ version: 1, datasetId: "one", normalizedWords: ["猫"] });
    await store.knownWords.save("known", "Known", ["猫"]);
    const backup = await store.exportCompleteBackup();
    await expect(
      store.restoreCompleteBackup(
        JSON.stringify({ ...JSON.parse(backup), activeDatasetId: "missing" }),
      ),
    ).rejects.toThrow();
    expect((await store.datasets.getActive())?.id).toBe("one");
    await store.clearAll();
    expect(await store.datasets.list()).toEqual([]);
    await store.restoreCompleteBackup(backup);
    expect((await store.datasets.getActive())?.id).toBe("one");
    expect((await store.queue.load())?.normalizedWords).toEqual(["猫"]);
    expect((await store.knownWords.getActive())?.words.has("猫")).toBe(true);
  });

  it("rejects malformed and oversized wire operations", async () => {
    await expect(dispatch({ operation: "unknown" })).rejects.toThrow();
    await expect(dispatch({ operation: "initialize", unexpected: true })).rejects.toThrow();
    await expect(
      dispatch({ operation: "initialize", payload: "あ".repeat(400_000) }),
    ).rejects.toThrow(/large|size|limit/i);
  });

  it("captures values when a save is requested, even while earlier writes are queued", async () => {
    const store = remote();
    await store.initialize();
    const first = store.knownWords.save("known", "Known", ["猫"]);
    const draft = structuredClone(preferences);
    const saved = store.preferences.save(draft);
    draft.query.search = "unsaved edits";
    await Promise.all([first, saved]);
    expect((await store.preferences.load())?.query.search).toBe("");
  });

  it("rolls back every dataset and queue when complete restore fails after deleting old data", async () => {
    const store = remote();
    await store.initialize();
    await store.datasets.stage(metadata(), chunks([entry()]));
    await store.datasets.activate("one");
    await store.queue.save({ version: 1, datasetId: "one", normalizedWords: ["猫"] });
    const backup = JSON.parse(await store.exportCompleteBackup());
    const duplicate = { normalizedWord: "猫", status: "later", updatedAt: "2026-09-14" };
    backup.datasets = [{ metadata: metadata("replacement"), entries: [entry()] }];
    backup.activeDatasetId = "replacement";
    backup.queues = [];
    backup.decisions = [duplicate, duplicate];
    await expect(store.restoreCompleteBackup(JSON.stringify(backup))).rejects.toThrow(/duplicate/i);
    expect((await store.datasets.list()).map((item) => item.id)).toEqual(["one"]);
    expect((await store.queue.load())?.normalizedWords).toEqual(["猫"]);
  });

  it("keeps separate queues when switching active datasets", async () => {
    const store = remote();
    await store.initialize();
    await store.datasets.stage(metadata(), chunks([entry()]));
    await store.datasets.activate("one");
    await store.queue.save({ version: 1, datasetId: "one", normalizedWords: ["猫"] });
    await store.datasets.stage(metadata("two"), chunks([entry()]));
    await store.datasets.activate("two");
    expect(await store.queue.load()).toBeNull();
    await store.queue.save({ version: 1, datasetId: "two", normalizedWords: ["犬"] });
    await store.datasets.activate("one");
    expect((await store.queue.load())?.normalizedWords).toEqual(["猫"]);
    const backup = JSON.parse(await store.exportCompleteBackup());
    expect(backup.queues).toEqual([
      { version: 1, datasetId: "one", normalizedWords: ["猫"] },
      { version: 1, datasetId: "two", normalizedWords: ["犬"] },
    ]);
  });

  it("never activates datasets with duplicate entry IDs", async () => {
    const store = remote();
    await store.initialize();
    await expect(
      store.datasets.stage(metadata("duplicates", 2), chunks([entry(), entry()])),
    ).rejects.toThrow(/duplicate/i);
    expect(await store.datasets.list()).toEqual([]);
  });

  it("accepts identical staged chunk retries but rejects conflicting retries and gaps", async () => {
    const { revision } = await dispatch({ operation: "initialize" });
    const begin = await dispatch({ operation: "dataset.begin", revision, metadata: metadata() });
    const uploadId = (begin.value as { uploadId: string }).uploadId;
    const part = { operation: "dataset.chunk", revision, uploadId, index: 0, entries: [entry()] };
    await dispatch(part);
    await dispatch(part);
    await expect(dispatch({ ...part, entries: [{ ...entry(), word: "犬" }] })).rejects.toThrow(
      /different|conflict/i,
    );
    await expect(
      dispatch({ operation: "dataset.finish", revision, uploadId, chunkCount: 2 }),
    ).rejects.toThrow(/incomplete|chunk/i);
    await dispatch({ operation: "dataset.finish", revision, uploadId, chunkCount: 1 });
    expect(
      (await dispatch({ operation: "dataset.list", revision: revision + 1, cursor: 0 })).value,
    ).toMatchObject({ items: [metadata()] });
  });

  it("accepts two valid logical chunks in one dataset.chunks request", async () => {
    const { revision } = await dispatch({ operation: "initialize" });
    const begin = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("batch-test", 2),
    });
    const uploadId = (begin.value as { uploadId: string }).uploadId;
    await dispatch({
      operation: "dataset.chunks",
      revision,
      uploadId,
      chunks: [
        { index: 0, entries: [entry("1")] },
        { index: 1, entries: [entry("2")] },
      ],
    });
    const finish = await dispatch({
      operation: "dataset.finish",
      revision,
      uploadId,
      chunkCount: 2,
    });
    const activated = await dispatch({
      operation: "dataset.activate",
      revision: finish.revision,
      datasetId: "batch-test",
    });
    const active = await dispatch({ operation: "dataset.active", revision: activated.revision });
    expect(active.value).toMatchObject({ id: "batch-test" });
    const read0 = await dispatch({
      operation: "dataset.read",
      revision: activated.revision,
      datasetId: "batch-test",
      cursor: 0,
    });
    const read1 = await dispatch({
      operation: "dataset.read",
      revision: activated.revision,
      datasetId: "batch-test",
      cursor: 1,
    });
    const items = [
      ...(read0.value as { items: Entry[] }).items,
      ...(read1.value as { items: Entry[] }).items,
    ];
    expect(items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("rejects an individual logical chunk above MAX_CHUNK_BYTES in dataset.chunks", async () => {
    const { revision } = await dispatch({ operation: "initialize" });
    const begin = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("oversized", 5),
    });
    const uploadId = (begin.value as { uploadId: string }).uploadId;
    const entries: Entry[] = Array.from({ length: 5 }, (_, i) => ({
      ...entry(String(i + 1)),
      definitions: "x".repeat(80_500),
    }));
    await expect(
      dispatch({
        operation: "dataset.chunks",
        revision,
        uploadId,
        chunks: [{ index: 0, entries }],
      }),
    ).rejects.toThrow(/limit|size/i);
  });

  it("rejects non-contiguous new ordinals in dataset.chunks", async () => {
    const { revision } = await dispatch({ operation: "initialize" });
    const begin = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("gap", 2),
    });
    const uploadId = (begin.value as { uploadId: string }).uploadId;
    await expect(
      dispatch({
        operation: "dataset.chunks",
        revision,
        uploadId,
        chunks: [
          { index: 0, entries: [entry("1")] },
          { index: 2, entries: [entry("2")] },
        ],
      }),
    ).rejects.toThrow(/ordinal|gap|contiguous/i);
  });

  it("accepts identical retries and rejects conflicting retries in dataset.chunks without advancing totals", async () => {
    const { revision } = await dispatch({ operation: "initialize" });
    const begin = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("retry-test", 2),
    });
    const uploadId = (begin.value as { uploadId: string }).uploadId;
    const batchOp = {
      operation: "dataset.chunks",
      revision,
      uploadId,
      chunks: [
        { index: 0, entries: [entry("1")] },
        { index: 1, entries: [entry("2")] },
      ],
    };
    await dispatch(batchOp);
    await dispatch(batchOp);
    await expect(
      dispatch({
        operation: "dataset.chunks",
        revision,
        uploadId,
        chunks: [
          { index: 0, entries: [entry("1")] },
          { index: 1, entries: [{ ...entry("2"), word: "犬" }] },
        ],
      }),
    ).rejects.toThrow(/different|conflict/i);

    const finish = await dispatch({
      operation: "dataset.finish",
      revision,
      uploadId,
      chunkCount: 2,
    });
    const activated = await dispatch({
      operation: "dataset.activate",
      revision: finish.revision,
      datasetId: "retry-test",
    });
    const active = await dispatch({ operation: "dataset.active", revision: activated.revision });
    expect(active.value).toMatchObject({ id: "retry-test" });
  });

  it("keeps active dataset unchanged on batch failure", async () => {
    const { revision } = await dispatch({ operation: "initialize" });
    const beginInitial = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("initial", 1),
    });
    const initialUploadId = (beginInitial.value as { uploadId: string }).uploadId;
    await dispatch({
      operation: "dataset.chunk",
      revision,
      uploadId: initialUploadId,
      index: 0,
      entries: [entry("1")],
    });
    const finish = await dispatch({
      operation: "dataset.finish",
      revision,
      uploadId: initialUploadId,
      chunkCount: 1,
    });
    const activated = await dispatch({
      operation: "dataset.activate",
      revision: finish.revision,
      datasetId: "initial",
    });
    const currentRev = activated.revision;

    const beginBad = await dispatch({
      operation: "dataset.begin",
      revision: currentRev,
      metadata: metadata("bad-batch", 2),
    });
    const badUploadId = (beginBad.value as { uploadId: string }).uploadId;
    await expect(
      dispatch({
        operation: "dataset.chunks",
        revision: currentRev,
        uploadId: badUploadId,
        chunks: [
          { index: 0, entries: [entry("1")] },
          { index: 5, entries: [entry("2")] },
        ],
      }),
    ).rejects.toThrow();

    const active = await dispatch({ operation: "dataset.active", revision: currentRev });
    expect(active.value).toMatchObject({ id: "initial" });
  });

  it("batches multiple logical dataset chunks into fewer wire requests", async () => {
    const store = remote();
    await store.initialize();
    const rows = Array.from({ length: 400 }, (_, index) => ({
      ...entry(String(index)),
      definitions: "x".repeat(3000),
    }));
    await store.datasets.stage(metadata("wire-batch", rows.length), chunks(rows));
    await store.datasets.activate("wire-batch");

    const chunkRequests = capturedRequests.filter((r) => r.operation === "dataset.chunks");
    expect(chunkRequests.length).toBeGreaterThan(0);

    const logicalChunkCount = chunkRequests.reduce(
      (sum, r) => sum + (Array.isArray(r.chunks) ? r.chunks.length : 0),
      0,
    );
    expect(logicalChunkCount).toBeGreaterThanOrEqual(3);
    expect(chunkRequests.length).toBeLessThan(logicalChunkCount);

    for (const size of requestSizes) {
      expect(size).toBeLessThan(750_000);
    }

    const read: Entry[] = [];
    for await (const chunk of store.datasets.readChunks("wire-batch", 50)) {
      read.push(...chunk);
    }
    expect(read.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("tracks dataset upload progress incrementally with counters", async () => {
    const { revision } = await dispatch({ operation: "initialize" });
    const begin = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("counter-test", 3),
    });
    const uploadId = (begin.value as { uploadId: string }).uploadId;

    const getCounters = async () => {
      const result = await pg.query<{
        uploaded_rows: string;
        uploaded_bytes: string;
        next_ordinal: number;
      }>("SELECT uploaded_rows, uploaded_bytes, next_ordinal FROM datasets WHERE id = $1", [
        "counter-test",
      ]);
      const row = result.rows[0]!;
      return {
        rows: Number(row.uploaded_rows),
        bytes: Number(row.uploaded_bytes),
        nextOrdinal: Number(row.next_ordinal),
      };
    };

    // new upload starts at zero
    expect(await getCounters()).toEqual({ rows: 0, bytes: 0, nextOrdinal: 0 });

    const chunk0 = [entry("1")];
    const chunk0Bytes = new TextEncoder().encode(JSON.stringify(chunk0)).length;

    // new logical chunks advance counters exactly once
    await dispatch({
      operation: "dataset.chunk",
      revision,
      uploadId,
      index: 0,
      entries: chunk0,
    });
    expect(await getCounters()).toEqual({ rows: 1, bytes: chunk0Bytes, nextOrdinal: 1 });

    // identical retry does not advance counters
    await dispatch({
      operation: "dataset.chunk",
      revision,
      uploadId,
      index: 0,
      entries: chunk0,
    });
    expect(await getCounters()).toEqual({ rows: 1, bytes: chunk0Bytes, nextOrdinal: 1 });

    // failed conflicting retry does not advance counters
    await expect(
      dispatch({
        operation: "dataset.chunk",
        revision,
        uploadId,
        index: 0,
        entries: [{ ...entry("1"), word: "犬" }],
      }),
    ).rejects.toThrow(/different|conflict/i);
    expect(await getCounters()).toEqual({ rows: 1, bytes: chunk0Bytes, nextOrdinal: 1 });

    // multiple chunks in one request advance counters by combined totals
    const chunk1 = [entry("2")];
    const chunk2 = [entry("3")];
    const chunk1Bytes = new TextEncoder().encode(JSON.stringify(chunk1)).length;
    const chunk2Bytes = new TextEncoder().encode(JSON.stringify(chunk2)).length;

    await dispatch({
      operation: "dataset.chunks",
      revision,
      uploadId,
      chunks: [
        { index: 1, entries: chunk1 },
        { index: 2, entries: chunk2 },
      ],
    });
    expect(await getCounters()).toEqual({
      rows: 3,
      bytes: chunk0Bytes + chunk1Bytes + chunk2Bytes,
      nextOrdinal: 3,
    });
  });

  it("bulk inserts several logical chunks in one request preserving ordinals and order", async () => {
    const { revision } = await dispatch({ operation: "initialize" });
    const begin = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("bulk-test", 6),
    });
    const uploadId = (begin.value as { uploadId: string }).uploadId;

    const chunk0 = [entry("1"), entry("2")];
    const chunk1 = [entry("3"), entry("4")];
    const chunk2 = [entry("5"), entry("6")];

    await dispatch({
      operation: "dataset.chunks",
      revision,
      uploadId,
      chunks: [
        { index: 0, entries: chunk0 },
        { index: 1, entries: chunk1 },
        { index: 2, entries: chunk2 },
      ],
    });

    const storedChunks = await pg.query<{
      ordinal: number;
      row_count: number;
      byte_count: number;
    }>(
      "SELECT ordinal, row_count, byte_count FROM dataset_chunks WHERE dataset_id = $1 ORDER BY ordinal ASC",
      ["bulk-test"],
    );
    expect(storedChunks.rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    expect(storedChunks.rows.map((r) => r.row_count)).toEqual([2, 2, 2]);

    const finish = await dispatch({
      operation: "dataset.finish",
      revision,
      uploadId,
      chunkCount: 3,
    });
    const activated = await dispatch({
      operation: "dataset.activate",
      revision: finish.revision,
      datasetId: "bulk-test",
    });

    const readItems: Entry[] = [];
    for (let cursor = 0; cursor < 3; cursor++) {
      const page = await dispatch({
        operation: "dataset.read",
        revision: activated.revision,
        datasetId: "bulk-test",
        cursor,
      });
      readItems.push(...(page.value as { items: Entry[] }).items);
    }
    expect(readItems.map((e) => e.id)).toEqual(["1", "2", "3", "4", "5", "6"]);

    const counterRow = (
      await pg.query<{ uploaded_rows: string; next_ordinal: number }>(
        "SELECT uploaded_rows, next_ordinal FROM datasets WHERE id = $1",
        ["bulk-test"],
      )
    ).rows[0]!;
    expect(Number(counterRow.uploaded_rows)).toBe(6);
    expect(Number(counterRow.next_ordinal)).toBe(3);
  });

  it("validates dataset.finish with upload counters and prevents incomplete activation", async () => {
    const { revision } = await dispatch({ operation: "initialize" });

    // 1. wrong chunkCount fails
    const begin1 = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("finish-chunk-count", 2),
    });
    const uploadId1 = (begin1.value as { uploadId: string }).uploadId;
    await dispatch({
      operation: "dataset.chunk",
      revision,
      uploadId: uploadId1,
      index: 0,
      entries: [entry("1"), entry("2")],
    });
    await expect(
      dispatch({ operation: "dataset.finish", revision, uploadId: uploadId1, chunkCount: 2 }),
    ).rejects.toThrow(/incomplete|chunk/i);

    // 2. wrong metadata entryCount fails
    const begin2 = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("finish-entry-count", 5),
    });
    const uploadId2 = (begin2.value as { uploadId: string }).uploadId;
    await dispatch({
      operation: "dataset.chunk",
      revision,
      uploadId: uploadId2,
      index: 0,
      entries: [entry("1"), entry("2")],
    });
    await expect(
      dispatch({ operation: "dataset.finish", revision, uploadId: uploadId2, chunkCount: 1 }),
    ).rejects.toThrow(/incomplete|entry/i);

    // 3. duplicate entry IDs still fail
    const begin3 = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("finish-dup", 2),
    });
    const uploadId3 = (begin3.value as { uploadId: string }).uploadId;
    await dispatch({
      operation: "dataset.chunk",
      revision,
      uploadId: uploadId3,
      index: 0,
      entries: [entry("1"), { ...entry("2"), id: "1" }],
    });
    await expect(
      dispatch({ operation: "dataset.finish", revision, uploadId: uploadId3, chunkCount: 1 }),
    ).rejects.toThrow(/duplicate/i);

    // 4. valid complete dataset becomes ready
    const begin4 = await dispatch({
      operation: "dataset.begin",
      revision,
      metadata: metadata("finish-valid", 2),
    });
    const uploadId4 = (begin4.value as { uploadId: string }).uploadId;
    await dispatch({
      operation: "dataset.chunk",
      revision,
      uploadId: uploadId4,
      index: 0,
      entries: [entry("1"), entry("2")],
    });
    const finish4 = await dispatch({
      operation: "dataset.finish",
      revision,
      uploadId: uploadId4,
      chunkCount: 1,
    });
    const activated4 = await dispatch({
      operation: "dataset.activate",
      revision: finish4.revision,
      datasetId: "finish-valid",
    });
    const active = await dispatch({ operation: "dataset.active", revision: activated4.revision });
    expect(active.value).toMatchObject({ id: "finish-valid" });

    // 5. incomplete dataset never activates
    await expect(
      dispatch({
        operation: "dataset.activate",
        revision: activated4.revision,
        datasetId: "finish-chunk-count",
      }),
    ).rejects.toThrow(/not found|ready/i);
  });
});
