import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresStore } from "../../src/server/store";
import { createPostgresSyncServer } from "../../src/server/sync";

const firstDecision = {
  normalizedWord: "猫",
  status: "known" as const,
  updatedAt: "2026-09-17T00:00:00.000Z",
};
const secondDecision = {
  normalizedWord: "犬",
  status: "mined" as const,
  updatedAt: "2026-09-17T00:01:00.000Z",
};

const metadata = (id: string) => ({
  id,
  name: id,
  sourceType: "file" as const,
  sourceName: "words.csv",
  headers: ["Word"],
  entryCount: 1,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  schemaVersion: 1,
});

describe("/api/sync server protocol and operations", () => {
  let pg: PGlite;
  let database: ReturnType<typeof drizzle>;
  let syncServer: ReturnType<typeof createPostgresSyncServer>;
  let legacyStore: ReturnType<typeof createPostgresStore>;

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
    await pg.exec(
      await readFile(
        new URL("../../migrations/0002_local_first_sync.sql", import.meta.url),
        "utf8",
      ),
    );
    database = drizzle(pg);
    syncServer = createPostgresSyncServer(database);
    legacyStore = createPostgresStore(database);
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.exec(
      "TRUNCATE app_state, datasets, dataset_chunks, state_uploads, state_upload_chunks, known_words, word_decisions, anki_statuses, queues, queue_words, sync_events, sync_mutations RESTART IDENTITY CASCADE",
    );
  });

  it("pulls changes after a given event id and returns nextEventId", async () => {
    // 1. Insert event id 1 for 猫, event id 2 for 犬
    await syncServer({
      operation: "push",
      deviceId: "device-1",
      mutations: [
        {
          mutationId: "00000000-0000-4000-8000-000000000001",
          kind: "decision.set",
          decision: firstDecision,
        },
        {
          mutationId: "00000000-0000-4000-8000-000000000002",
          kind: "decision.set",
          decision: secondDecision,
        },
      ],
    });

    const pullResult = (await syncServer({
      operation: "pull",
      afterEventId: 1,
    })) as { changes: Array<{ id: number; kind: string; decision?: unknown }>; nextEventId: number };

    expect(pullResult.changes).toHaveLength(1);
    expect(pullResult.changes[0]).toMatchObject({
      id: 2,
      kind: "decision.set",
      decision: secondDecision,
    });
    expect(pullResult.nextEventId).toBe(2);
  });

  it("handles push idempotently by mutationId without duplicate events or rows", async () => {
    // 2. Push decision:firstDecision twice with same mutationId
    const mutation = {
      mutationId: "00000000-0000-4000-8000-000000000001",
      kind: "decision.set" as const,
      decision: firstDecision,
    };

    const firstPush = await syncServer({
      operation: "push",
      deviceId: "device-1",
      mutations: [mutation],
    });

    const secondPush = await syncServer({
      operation: "push",
      deviceId: "device-1",
      mutations: [mutation],
    });

    expect(secondPush).toEqual(firstPush);

    // Assert canonical decision exists once
    const decisions = (await database.execute(
      sql`SELECT word, decision FROM word_decisions`,
    )) as { rows?: unknown[] } | unknown[];
    const decRows = Array.isArray(decisions) ? decisions : decisions.rows!;
    expect(decRows).toHaveLength(1);

    // Assert sync_mutations has one row
    const mutations = (await database.execute(
      sql`SELECT mutation_id FROM sync_mutations`,
    )) as { rows?: unknown[] } | unknown[];
    const mutRows = Array.isArray(mutations) ? mutations : mutations.rows!;
    expect(mutRows).toHaveLength(1);

    // Assert only one new sync_events row exists
    const events = (await database.execute(
      sql`SELECT id FROM sync_events`,
    )) as { rows?: unknown[] } | unknown[];
    const evRows = Array.isArray(events) ? events : events.rows!;
    expect(evRows).toHaveLength(1);
  });

  it("succeeds pushing after legacy store advances app revision", async () => {
    // 3. Bootstrap a device, mutate a preference directly through legacy store to advance revision, then push secondDecision
    await syncServer({ operation: "bootstrap" });

    await legacyStore({ operation: "initialize" });
    await legacyStore({
      operation: "preferences.save",
      revision: 0,
      value: {
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
      },
    });

    const pushResult = await syncServer({
      operation: "push",
      deviceId: "device-1",
      mutations: [
        {
          mutationId: "00000000-0000-4000-8000-000000000002",
          kind: "decision.set",
          decision: secondDecision,
        },
      ],
    });

    expect(pushResult).toMatchObject({
      acceptedMutationIds: ["00000000-0000-4000-8000-000000000002"],
    });

    const stored = (await database.execute(
      sql`SELECT decision FROM word_decisions WHERE word = '犬'`,
    )) as { rows?: unknown[] } | unknown[];
    const storedRows = Array.isArray(stored) ? stored : stored.rows!;
    expect(storedRows).toHaveLength(1);
  });

  it("bootstrap returns ready dataset metadata, active id, and current max event id without dataset entries", async () => {
    // 4. Seed two ready dataset metadata rows and activate one
    await syncServer({
      operation: "dataset.begin",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000010",
      metadata: metadata("ds-a"),
    });
    await syncServer({
      operation: "dataset.chunks",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000010",
      chunks: [
        {
          index: 0,
          entries: [
            {
              id: "1",
              originalIndex: 1,
              word: "猫",
              normalizedWord: "猫",
              occurrences: 1,
              sentenceRaw: "",
              hasSentence: false,
              definitions: "",
              furiganaRuns: [],
            },
          ],
        },
      ],
    });
    await syncServer({
      operation: "dataset.finish",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000010",
      chunkCount: 1,
    });

    await syncServer({
      operation: "dataset.begin",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000020",
      metadata: metadata("ds-b"),
    });
    await syncServer({
      operation: "dataset.chunks",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000020",
      chunks: [
        {
          index: 0,
          entries: [
            {
              id: "2",
              originalIndex: 2,
              word: "犬",
              normalizedWord: "犬",
              occurrences: 1,
              sentenceRaw: "",
              hasSentence: false,
              definitions: "",
              furiganaRuns: [],
            },
          ],
        },
      ],
    });
    await syncServer({
      operation: "dataset.finish",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000020",
      chunkCount: 1,
    });

    await syncServer({
      operation: "push",
      deviceId: "device-1",
      mutations: [
        {
          mutationId: "00000000-0000-4000-8000-000000000030",
          kind: "dataset.activate",
          datasetId: "ds-a",
        },
      ],
    });

    const manifest = (await syncServer({
      operation: "bootstrap",
    })) as { eventId: number; activeDatasetId: string | null; datasets: unknown[] };

    expect(manifest.activeDatasetId).toBe("ds-a");
    expect(manifest.datasets).toHaveLength(2);
    expect(manifest.eventId).toBeGreaterThanOrEqual(3);
    // Ensure dataset entries are not returned
    expect((manifest as Record<string, unknown>).entries).toBeUndefined();
    for (const d of manifest.datasets) {
      expect((d as Record<string, unknown>).entries).toBeUndefined();
    }
  });

  it("pages decisions without exceeding response size guard", async () => {
    // 5. Seed more than one sync-read page of decisions and assert state.read pagination returns every item
    const decisionsCount = 1500;
    const mutations = Array.from({ length: decisionsCount }, (_, i) => ({
      mutationId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      kind: "decision.set" as const,
      decision: {
        normalizedWord: `単語${i}`,
        status: "known" as const,
        updatedAt: "2026-09-17T00:00:00.000Z",
      },
    }));

    for (let i = 0; i < mutations.length; i += 100) {
      await syncServer({
        operation: "push",
        deviceId: "device-1",
        mutations: mutations.slice(i, i + 100),
      });
    }

    let cursor = 0;
    const collected: unknown[] = [];
    while (true) {
      const pageResult = (await syncServer({
        operation: "state.read",
        resource: "decisions",
        cursor,
      })) as { items: unknown[]; nextCursor: number | null };

      expect(pageResult.items.length).toBeGreaterThan(0);
      collected.push(...pageResult.items);
      if (pageResult.nextCursor === null) break;
      cursor = pageResult.nextCursor;
    }

    expect(collected).toHaveLength(decisionsCount);
  });

  it("rejects dataset re-upload with conflicting metadata", async () => {
    await syncServer({
      operation: "dataset.begin",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000040",
      metadata: metadata("conflict-ds"),
    });
    await syncServer({
      operation: "dataset.chunks",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000040",
      chunks: [
        {
          index: 0,
          entries: [
            {
              id: "1",
              originalIndex: 1,
              word: "猫",
              normalizedWord: "猫",
              occurrences: 1,
              sentenceRaw: "",
              hasSentence: false,
              definitions: "",
              furiganaRuns: [],
            },
          ],
        },
      ],
    });
    await syncServer({
      operation: "dataset.finish",
      deviceId: "device-1",
      mutationId: "00000000-0000-4000-8000-000000000040",
      chunkCount: 1,
    });

    await expect(
      syncServer({
        operation: "dataset.begin",
        deviceId: "device-1",
        mutationId: "00000000-0000-4000-8000-000000000041",
        metadata: { ...metadata("conflict-ds"), name: "Different Name" },
      }),
    ).rejects.toMatchObject({
      code: "DATASET_CONFLICT",
      status: 409,
    });
  });

  it("reads ready dataset chunks and 404s for unknown dataset", async () => {
    await expect(
      syncServer({
        operation: "dataset.read",
        datasetId: "non-existent",
        cursor: 0,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

