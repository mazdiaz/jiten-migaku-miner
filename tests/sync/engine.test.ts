import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { Entry, QueryState, ViewState, WordDecision } from "../../src/domain/types";
import { DatasetNotCachedError, type DatasetMetadata } from "../../src/storage/contracts";
import { createIndexedDbAppStore } from "../../src/storage/indexed-db";
import { createLocalSyncStore } from "../../src/storage/local-sync";
import { RemoteStoreError } from "../../src/storage/remote-store";
import { createCloudSyncClient } from "../../src/sync/cloud-client";
import type {
  CloudBootstrapManifest,
  CloudSyncPort,
  MaterializedSyncMutation,
  PreferencesValue,
  SessionQueueSnapshot,
  SyncPullPage,
  SyncPushReceipt,
} from "../../src/sync/contracts";
import {
  bootstrapLocalCache,
  createSyncEngine,
  ensureDatasetCached,
} from "../../src/sync/engine";

function sampleMetadata(id: string, entryCount: number): DatasetMetadata {
  return {
    id,
    name: `Dataset ${id}`,
    sourceType: "file",
    sourceName: `${id}.csv`,
    headers: ["id", "word", "sentence"],
    entryCount,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    schemaVersion: 1,
  };
}

function sampleEntry(id: string, word: string): Entry {
  return {
    id,
    originalIndex: 0,
    word,
    normalizedWord: word,
    occurrences: 1,
    sentenceRaw: `${word}の例文です。`,
    hasSentence: true,
    definitions: "definition",
    furiganaRuns: [],
  };
}

const defaultQuery: QueryState = {
  search: "",
  hideKnown: true,
  hideKanaOnly: false,
  sentence: "any",
  minOccurrences: 1,
  sort: "occ-desc",
  pageSize: 50,
  page: 4,
  decision: "all",
};

const defaultView: ViewState = {
  showFurigana: true,
  pillHighlight: true,
  showHighlight: true,
  showDefinitions: true,
  sentenceSize: "medium",
  density: "comfortable",
};

describe("Task 5: Cloud client and bootstrap local cache hydration", () => {
  it("bootstraps all user state locally, caches active dataset, leaves others metadata-only, and sets meta last", async () => {
    const dbName = `test-bootstrap-${crypto.randomUUID()}`;
    const localSyncStore = createLocalSyncStore(dbName);
    const remoteApplyStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    const datasetA = sampleMetadata("dataset-a", 3);
    const datasetB = sampleMetadata("dataset-b", 10);
    const entriesA: Entry[] = [
      sampleEntry("e-1", "猫"),
      sampleEntry("e-2", "犬"),
      sampleEntry("e-3", "鳥"),
    ];

    const manifest: CloudBootstrapManifest = {
      eventId: 12,
      activeDatasetId: "dataset-a",
      datasets: [datasetA, datasetB],
    };

    const decisions: WordDecision[] = [
      {
        normalizedWord: "騒ぐ",
        status: "known",
        updatedAt: "2026-09-17T00:00:00.000Z",
      },
    ];

    const preferences: PreferencesValue = {
      page: 4,
      query: { ...defaultQuery, hideKnown: true },
      view: defaultView,
    };

    const queueA: SessionQueueSnapshot = {
      version: 1,
      datasetId: "dataset-a",
      normalizedWords: ["騒ぐ"],
    };

    let datasetAReadCalls = 0;
    let datasetBReadCalls = 0;

    const fakeCloud: CloudSyncPort = {
      async bootstrap() {
        return manifest;
      },
      async readKnownWords() {
        return {
          id: "known-set-1",
          name: "Default Known Words",
          words: ["猫", "犬"],
        };
      },
      async readDecisions() {
        return decisions;
      },
      async readPreferences() {
        return preferences;
      },
      async readQueues() {
        return [queueA];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull() {
        return { changes: [], nextEventId: 12 };
      },
      async push() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async uploadDataset() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset(datasetId: string) {
        if (datasetId === "dataset-a") {
          datasetAReadCalls++;
          yield entriesA;
        } else if (datasetId === "dataset-b") {
          datasetBReadCalls++;
          yield [sampleEntry("b-1", "走る")];
        }
      },
    };

    try {
      await bootstrapLocalCache({
        cloud: fakeCloud,
        remoteApplyStore,
        localSyncStore,
      });

      // 1. User state verified
      const known = await remoteApplyStore.knownWords.getActive();
      expect(known).not.toBeNull();
      expect(known?.id).toBe("known-set-1");
      expect(known?.words).toEqual(new Set(["猫", "犬"]));

      const loadedDecisions = await remoteApplyStore.wordDecisions.list();
      expect(loadedDecisions).toHaveLength(1);
      expect(loadedDecisions[0]?.normalizedWord).toBe("騒ぐ");
      expect(loadedDecisions[0]?.status).toBe("known");

      const loadedPrefs = await remoteApplyStore.preferences.load();
      expect(loadedPrefs?.page).toBe(4);
      expect(loadedPrefs?.query.hideKnown).toBe(true);

      const loadedQueue = await localSyncStore.loadQueue("dataset-a");
      expect(loadedQueue).toEqual(queueA);

      // 2. Active dataset is cache-ready with exactly 3 entries
      const stateA = await remoteApplyStore.datasets.cacheState!("dataset-a");
      expect(stateA).toBe("ready");
      const chunksA: Entry[][] = [];
      for await (const chunk of remoteApplyStore.datasets.readChunks("dataset-a", 10)) {
        chunksA.push(chunk);
      }
      expect(chunksA.flat()).toHaveLength(3);
      expect(chunksA.flat().map((e) => e.word)).toEqual(["猫", "犬", "鳥"]);

      // 3. dataset-b stays metadata-only
      const stateB = await remoteApplyStore.datasets.cacheState!("dataset-b");
      expect(stateB).toBe("metadata-only");
      await expect(async () => {
        for await (const _ of remoteApplyStore.datasets.readChunks("dataset-b", 10)) {
          // should throw
        }
      }).rejects.toThrowError(DatasetNotCachedError);

      // 4. Sync meta is bootstrapComplete: true, serverEventId: 12
      const meta = await localSyncStore.getMeta();
      expect(meta.bootstrapComplete).toBe(true);
      expect(meta.serverEventId).toBe(12);
      expect(meta.lastSyncAt).not.toBeNull();

      // Outbox must be empty because bootstrap is silent
      const outbox = await localSyncStore.listOutbox(10);
      expect(outbox).toHaveLength(0);

      // 5. ensureDatasetCached("dataset-b") downloads once, and second call performs zero reads
      expect(datasetBReadCalls).toBe(0);
      await ensureDatasetCached("dataset-b", fakeCloud, remoteApplyStore);
      expect(datasetBReadCalls).toBe(1);
      expect(await remoteApplyStore.datasets.cacheState!("dataset-b")).toBe("ready");

      await ensureDatasetCached("dataset-b", fakeCloud, remoteApplyStore);
      expect(datasetBReadCalls).toBe(1);
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("leaves bootstrapComplete=false if active dataset chunk download throws", async () => {
    const dbName = `test-bootstrap-fail-${crypto.randomUUID()}`;
    const localSyncStore = createLocalSyncStore(dbName);
    const remoteApplyStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    const datasetA = sampleMetadata("dataset-a", 3);
    const manifest: CloudBootstrapManifest = {
      eventId: 12,
      activeDatasetId: "dataset-a",
      datasets: [datasetA],
    };

    const failingCloud: CloudSyncPort = {
      async bootstrap() {
        return manifest;
      },
      async readKnownWords() {
        return null;
      },
      async readDecisions() {
        return [];
      },
      async readPreferences() {
        return null;
      },
      async readQueues() {
        return [];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull() {
        return { changes: [], nextEventId: 12 };
      },
      async push() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async uploadDataset() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset() {
        yield [sampleEntry("e-1", "猫")];
        yield [sampleEntry("e-2", "犬")];
        throw new Error("Network connection dropped while reading chunk 3");
      },
    };

    try {
      await expect(
        bootstrapLocalCache({
          cloud: failingCloud,
          remoteApplyStore,
          localSyncStore,
        }),
      ).rejects.toThrow("Network connection dropped while reading chunk 3");

      const meta = await localSyncStore.getMeta();
      expect(meta.bootstrapComplete).toBe(false);
      expect(meta.serverEventId).toBe(0);
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("createCloudSyncClient executes all sync protocol operations through transport", async () => {
    const requests: Array<{ url: string; body: any }> = [];

    const mockTransport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsedBody = JSON.parse(String(init?.body));
      requests.push({ url: String(url), body: parsedBody });

      switch (parsedBody.operation) {
        case "bootstrap":
          return new Response(
            JSON.stringify({
              eventId: 42,
              activeDatasetId: "ds-test",
              datasets: [sampleMetadata("ds-test", 1)],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );

        case "state.read":
          if (parsedBody.resource === "knownWords") {
            if (parsedBody.cursor === 0) {
              return new Response(
                JSON.stringify({
                  id: "kw-1",
                  name: "Known",
                  items: ["word1"],
                  nextCursor: 1,
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({
                id: "kw-1",
                name: "Known",
                items: ["word2"],
                nextCursor: null,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsedBody.resource === "decisions") {
            return new Response(
              JSON.stringify({
                items: [
                  {
                    normalizedWord: "猫",
                    decision: "known",
                    updatedAt: "2026-09-17T00:00:00.000Z",
                  },
                ],
                nextCursor: null,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsedBody.resource === "preferences") {
            return new Response(
              JSON.stringify({
                page: 4,
                query: defaultQuery,
                view: defaultView,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsedBody.resource === "queues") {
            return new Response(
              JSON.stringify({
                items: ["ds-test"],
                nextCursor: null,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsedBody.resource === "queue") {
            return new Response(
              JSON.stringify({
                version: 1,
                datasetId: "ds-test",
                items: ["猫"],
                nextCursor: null,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsedBody.resource === "ankiConfig") {
            return new Response(
              JSON.stringify({
                deckScope: { kind: "all-decks" },
                noteType: "Basic",
                targetField: "Word",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsedBody.resource === "ankiSnapshot") {
            return new Response(
              JSON.stringify({
                syncedAt: "2026-09-17T00:00:00.000Z",
                items: [["猫", "known"]],
                nextCursor: null,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          break;

        case "pull":
          return new Response(
            JSON.stringify({
              changes: [{ id: 1, kind: "known.replace" }],
              nextEventId: 1,
            } satisfies SyncPullPage),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );

        case "push":
          return new Response(
            JSON.stringify({
              accepted: [{ mutationId: parsedBody.mutations[0].mutationId, eventId: 1 }],
              acceptedMutationIds: [parsedBody.mutations[0].mutationId],
            } satisfies SyncPushReceipt),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );

        case "dataset.begin":
          return new Response(
            JSON.stringify({ uploadId: parsedBody.mutationId }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );

        case "dataset.chunks":
          return new Response(
            JSON.stringify({ ok: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );

        case "dataset.finish":
          return new Response(
            JSON.stringify({
              accepted: [{ mutationId: parsedBody.mutationId, eventId: 2 }],
              acceptedMutationIds: [parsedBody.mutationId],
            } satisfies SyncPushReceipt),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );

        case "dataset.read":
          if (parsedBody.cursor === 0) {
            return new Response(
              JSON.stringify({
                items: [sampleEntry("1", "猫")],
                nextCursor: 1,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              items: [],
              nextCursor: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
      }

      return new Response(JSON.stringify({ error: "Unhandled operation" }), { status: 400 });
    });

    const client = createCloudSyncClient("/api/sync", mockTransport as any);

    // Bootstrap
    const boot = await client.bootstrap();
    expect(boot.eventId).toBe(42);

    // Known words (paged 2 requests)
    const known = await client.readKnownWords();
    expect(known).toEqual({
      id: "kw-1",
      name: "Known",
      words: ["word1", "word2"],
    });

    // Decisions
    const decisions = await client.readDecisions();
    expect(decisions).toHaveLength(1);

    // Preferences
    const prefs = await client.readPreferences();
    expect(prefs?.page).toBe(4);

    // Queues
    const queues = await client.readQueues();
    expect(queues).toEqual([
      {
        version: 1,
        datasetId: "ds-test",
        normalizedWords: ["猫"],
      },
    ]);

    // Anki
    const anki = await client.readAnki();
    expect(anki.config?.noteType).toBe("Basic");
    expect(anki.snapshot?.statuses).toEqual([["猫", "known"]]);

    // Pull
    const pullPage = await client.pull(0, 100);
    expect(pullPage.nextEventId).toBe(1);

    // Push
    const pushMutation: MaterializedSyncMutation = {
      mutationId: "00000000-0000-0000-0000-000000000001",
      kind: "dataset.activate",
      datasetId: "ds-test",
    };
    const pushRes = await client.push("dev-1", [pushMutation]);
    expect(pushRes.acceptedMutationIds).toEqual(["00000000-0000-0000-0000-000000000001"]);

    // Upload dataset
    async function* genChunks() {
      yield [sampleEntry("1", "猫")];
    }
    const uploadRes = await client.uploadDataset(
      "dev-1",
      "00000000-0000-0000-0000-000000000002",
      sampleMetadata("ds-test", 1),
      genChunks(),
    );
    expect(uploadRes.acceptedMutationIds).toEqual(["00000000-0000-0000-0000-000000000002"]);

    // Read dataset
    const readEntries: Entry[] = [];
    for await (const chunk of client.readDataset("ds-test", 1000)) {
      readEntries.push(...chunk);
    }
    expect(readEntries).toHaveLength(1);
    expect(readEntries[0]?.word).toBe("猫");
  });

  it("createCloudSyncClient wraps fetch errors with RemoteStoreError", async () => {
    const failingTransport = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const client = createCloudSyncClient("/api/sync", failingTransport as any);

    await expect(client.bootstrap()).rejects.toThrowError(RemoteStoreError);
    await expect(client.bootstrap()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
    });
  });

  it("createCloudSyncClient wraps server domain errors with RemoteStoreError", async () => {
    const errorTransport = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "Dataset conflict", code: "DATASET_CONFLICT" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = createCloudSyncClient("/api/sync", errorTransport as any);

    await expect(client.bootstrap()).rejects.toThrowError(RemoteStoreError);
    await expect(client.bootstrap()).rejects.toMatchObject({
      code: "DATASET_CONFLICT",
      status: 409,
    });
  });
});

describe("Task 6: Push-first/pull-second SyncEngine", () => {
  it("enforces push-before-pull order in serialized sync loop", async () => {
    const dbName = `test-order-${crypto.randomUUID()}`;
    const localSyncStore = createLocalSyncStore(dbName);
    const recordingStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });
    const remoteApplyStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    const calls: string[] = [];
    const fakeCloud: CloudSyncPort = {
      async bootstrap() {
        return { eventId: 0, activeDatasetId: null, datasets: [] };
      },
      async readKnownWords() {
        return null;
      },
      async readDecisions() {
        return [];
      },
      async readPreferences() {
        return null;
      },
      async readQueues() {
        return [];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull() {
        calls.push("pull");
        return { changes: [], nextEventId: 0 };
      },
      async push(_deviceId, mutations) {
        calls.push("push");
        return {
          accepted: mutations.map((m) => ({ mutationId: m.mutationId, eventId: 1 })),
          acceptedMutationIds: mutations.map((m) => m.mutationId),
        };
      },
      async uploadDataset() {
        calls.push("uploadDataset");
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset() {},
    };

    // Pre-record a decision
    await recordingStore.wordDecisions.set({
      normalizedWord: "猫",
      status: "known",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });

    const engine = createSyncEngine({
      cloud: fakeCloud,
      localAppStore: recordingStore,
      remoteApplyStore,
      localSyncStore,
    });

    try {
      await engine.syncNow();
      expect(calls.slice(0, 2)).toEqual(["push", "pull"]);
    } finally {
      engine.dispose();
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("handles durable retry across engine instances on network error", async () => {
    const dbName = `test-retry-${crypto.randomUUID()}`;
    const localSyncStore = createLocalSyncStore(dbName);
    const recordingStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });
    const remoteApplyStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    await recordingStore.wordDecisions.set({
      normalizedWord: "猫",
      status: "known",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });

    let attempts = 0;
    const fakeCloud: CloudSyncPort = {
      async bootstrap() {
        return { eventId: 0, activeDatasetId: null, datasets: [] };
      },
      async readKnownWords() {
        return null;
      },
      async readDecisions() {
        return [];
      },
      async readPreferences() {
        return null;
      },
      async readQueues() {
        return [];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull() {
        return { changes: [], nextEventId: 0 };
      },
      async push(_deviceId, mutations) {
        attempts++;
        if (attempts === 1) {
          throw new RemoteStoreError("Network failure", 0, "NETWORK_ERROR");
        }
        return {
          accepted: mutations.map((m) => ({ mutationId: m.mutationId, eventId: 1 })),
          acceptedMutationIds: mutations.map((m) => m.mutationId),
        };
      },
      async uploadDataset() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset() {},
    };

    // First engine instance fails push
    const engine1 = createSyncEngine({
      cloud: fakeCloud,
      localAppStore: recordingStore,
      remoteApplyStore,
      localSyncStore,
    });

    let status1: any;
    engine1.subscribe((s) => (status1 = s));

    await expect(engine1.syncNow()).rejects.toThrowError(RemoteStoreError);
    expect(status1.state).toBe("offline");

    // Outbox must still contain the pending mutation
    const pendingAfterFail = await localSyncStore.listOutbox(10);
    expect(pendingAfterFail).toHaveLength(1);
    expect(pendingAfterFail[0]?.dedupeKey).toBe("decision:猫");
    engine1.dispose();

    // Second engine instance against same database succeeds
    const engine2 = createSyncEngine({
      cloud: fakeCloud,
      localAppStore: recordingStore,
      remoteApplyStore,
      localSyncStore,
    });

    await engine2.syncNow();
    const pendingAfterSuccess = await localSyncStore.listOutbox(10);
    expect(pendingAfterSuccess).toHaveLength(0);
    engine2.dispose();

    indexedDB.deleteDatabase(dbName);
  });

  it("acknowledgement race: newer mutation on same dedupe key is preserved when older mutation resolves", async () => {
    const dbName = `test-race-${crypto.randomUUID()}`;
    const localSyncStore = createLocalSyncStore(dbName);
    const recordingStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });
    const remoteApplyStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    await recordingStore.wordDecisions.set({
      normalizedWord: "猫",
      status: "known",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });

    const pendingA = await localSyncStore.listOutbox(10);
    const mutationIdA = pendingA[0]!.mutationId;

    let resolvePush: (val: any) => void;
    const pushPromise = new Promise((resolve) => {
      resolvePush = resolve;
    });

    const fakeCloud: CloudSyncPort = {
      async bootstrap() {
        return { eventId: 0, activeDatasetId: null, datasets: [] };
      },
      async readKnownWords() {
        return null;
      },
      async readDecisions() {
        return [];
      },
      async readPreferences() {
        return null;
      },
      async readQueues() {
        return [];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull() {
        return { changes: [], nextEventId: 0 };
      },
      async push() {
        return await pushPromise as any;
      },
      async uploadDataset() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset() {},
    };

    const engine = createSyncEngine({
      cloud: fakeCloud,
      localAppStore: recordingStore,
      remoteApplyStore,
      localSyncStore,
    });

    try {
      // Start syncNow in background (waiting on pushPromise)
      const syncPromise = engine.syncNow();

      // Before push resolves, user updates the decision to "mined"
      await recordingStore.wordDecisions.set({
        normalizedWord: "猫",
        status: "mined",
        updatedAt: "2026-09-17T00:00:01.000Z",
      });

      const pendingB = await localSyncStore.listOutbox(10);
      const mutationIdB = pendingB[0]!.mutationId;
      expect(mutationIdB).not.toBe(mutationIdA);

      // Now resolve the cloud push for mutation A
      resolvePush!({
        accepted: [{ mutationId: mutationIdA, eventId: 1 }],
        acceptedMutationIds: [mutationIdA],
      });

      await syncPromise;

      // Mutation B must remain in the outbox!
      const outboxAfter = await localSyncStore.listOutbox(10);
      expect(outboxAfter).toHaveLength(1);
      expect(outboxAfter[0]?.mutationId).toBe(mutationIdB);
    } finally {
      engine.dispose();
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("remote apply: applies pulled changes with recording-disabled store, keeping outbox empty", async () => {
    const dbName = `test-remote-apply-${crypto.randomUUID()}`;
    const localSyncStore = createLocalSyncStore(dbName);
    const recordingStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });
    const remoteApplyStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    const fakeCloud: CloudSyncPort = {
      async bootstrap() {
        return { eventId: 0, activeDatasetId: null, datasets: [] };
      },
      async readKnownWords() {
        return null;
      },
      async readDecisions() {
        return [];
      },
      async readPreferences() {
        return null;
      },
      async readQueues() {
        return [];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull() {
        return {
          changes: [
            {
              id: 1,
              kind: "decision.set",
              decision: {
                normalizedWord: "犬",
                status: "mined",
                updatedAt: "2026-09-17T00:00:00.000Z",
              },
            },
          ],
          nextEventId: 1,
        };
      },
      async push() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async uploadDataset() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset() {},
    };

    let remoteAppliedCalled = false;
    const engine = createSyncEngine({
      cloud: fakeCloud,
      localAppStore: recordingStore,
      remoteApplyStore,
      localSyncStore,
    });
    engine.onRemoteApplied(() => {
      remoteAppliedCalled = true;
    });

    try {
      await engine.syncNow();

      expect(remoteAppliedCalled).toBe(true);

      const decision = await recordingStore.wordDecisions.get("犬");
      expect(decision?.status).toBe("mined");

      const outbox = await localSyncStore.listOutbox(10);
      expect(outbox).toHaveLength(0);

      const meta = await localSyncStore.getMeta();
      expect(meta.serverEventId).toBe(1);
    } finally {
      engine.dispose();
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("two-device convergence: device A writes known, device B writes mined, both converge on cloud's final state", async () => {
    const dbA = `test-conv-a-${crypto.randomUUID()}`;
    const dbB = `test-conv-b-${crypto.randomUUID()}`;

    const syncA = createLocalSyncStore(dbA);
    const recordA = createIndexedDbAppStore({ databaseName: dbA, recordSyncMutations: true });
    const applyA = createIndexedDbAppStore({ databaseName: dbA, recordSyncMutations: false });

    const syncB = createLocalSyncStore(dbB);
    const recordB = createIndexedDbAppStore({ databaseName: dbB, recordSyncMutations: true });
    const applyB = createIndexedDbAppStore({ databaseName: dbB, recordSyncMutations: false });

    // Canonical cloud simulation
    let cloudEventId = 0;
    const cloudDecisions = new Map<string, WordDecision>();
    const cloudEvents: Array<{ id: number; kind: "decision.set"; decision: WordDecision }> = [];

    const makeCloud = (): CloudSyncPort => ({
      async bootstrap() {
        return { eventId: cloudEventId, activeDatasetId: null, datasets: [] };
      },
      async readKnownWords() {
        return null;
      },
      async readDecisions() {
        return [...cloudDecisions.values()];
      },
      async readPreferences() {
        return null;
      },
      async readQueues() {
        return [];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull(afterEventId) {
        const changes = cloudEvents.filter((e) => e.id > afterEventId);
        return { changes, nextEventId: cloudEventId };
      },
      async push(_deviceId, mutations) {
        const accepted: Array<{ mutationId: string; eventId: number }> = [];
        for (const m of mutations) {
          if (m.kind === "decision.set") {
            cloudDecisions.set(m.decision.normalizedWord, m.decision);
            cloudEventId++;
            cloudEvents.push({ id: cloudEventId, kind: "decision.set", decision: m.decision });
            accepted.push({ mutationId: m.mutationId, eventId: cloudEventId });
          }
        }
        return { accepted, acceptedMutationIds: accepted.map((a) => a.mutationId) };
      },
      async uploadDataset() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset() {},
    });

    const engineA = createSyncEngine({
      cloud: makeCloud(),
      localAppStore: recordA,
      remoteApplyStore: applyA,
      localSyncStore: syncA,
    });

    const engineB = createSyncEngine({
      cloud: makeCloud(),
      localAppStore: recordB,
      remoteApplyStore: applyB,
      localSyncStore: syncB,
    });

    try {
      // Device A sets "猫" to "known"
      await recordA.wordDecisions.set({
        normalizedWord: "猫",
        status: "known",
        updatedAt: "2026-09-17T00:00:00.000Z",
      });

      // Device B sets "猫" to "mined"
      await recordB.wordDecisions.set({
        normalizedWord: "猫",
        status: "mined",
        updatedAt: "2026-09-17T00:00:01.000Z",
      });

      // A syncs (pushes known)
      await engineA.syncNow();
      expect((await recordA.wordDecisions.get("猫"))?.status).toBe("known");

      // B syncs (pushes mined, which becomes the canonical state)
      await engineB.syncNow();
      expect((await recordB.wordDecisions.get("猫"))?.status).toBe("mined");

      // A syncs again (pulls mined)
      await engineA.syncNow();
      expect((await recordA.wordDecisions.get("猫"))?.status).toBe("mined");

      // Both converged on "mined"!
      expect((await recordA.wordDecisions.get("猫"))?.status).toBe(
        (await recordB.wordDecisions.get("猫"))?.status,
      );
    } finally {
      engineA.dispose();
      engineB.dispose();
      indexedDB.deleteDatabase(dbA);
      indexedDB.deleteDatabase(dbB);
    }
  });

  it("flush pushes all pending mutations and verifies outbox is empty", async () => {
    const dbName = `test-flush-${crypto.randomUUID()}`;
    const localSyncStore = createLocalSyncStore(dbName);
    const recordingStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });
    const remoteApplyStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    let pushed = false;
    const fakeCloud: CloudSyncPort = {
      async bootstrap() {
        return { eventId: 0, activeDatasetId: null, datasets: [] };
      },
      async readKnownWords() {
        return null;
      },
      async readDecisions() {
        return [];
      },
      async readPreferences() {
        return null;
      },
      async readQueues() {
        return [];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull() {
        return { changes: [], nextEventId: 0 };
      },
      async push(_deviceId, mutations) {
        pushed = true;
        return {
          accepted: mutations.map((m) => ({ mutationId: m.mutationId, eventId: 1 })),
          acceptedMutationIds: mutations.map((m) => m.mutationId),
        };
      },
      async uploadDataset() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset() {},
    };

    await recordingStore.wordDecisions.set({
      normalizedWord: "走る",
      status: "mined",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });

    const engine = createSyncEngine({
      cloud: fakeCloud,
      localAppStore: recordingStore,
      remoteApplyStore,
      localSyncStore,
    });

    try {
      await engine.flush();
      expect(pushed).toBe(true);
      const outbox = await localSyncStore.listOutbox(10);
      expect(outbox).toHaveLength(0);
    } finally {
      engine.dispose();
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("notifyOutbox debounces sync execution", async () => {
    const dbName = `test-debounce-${crypto.randomUUID()}`;
    const localSyncStore = createLocalSyncStore(dbName);
    const recordingStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });
    const remoteApplyStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    let pushCount = 0;
    const fakeCloud: CloudSyncPort = {
      async bootstrap() {
        return { eventId: 0, activeDatasetId: null, datasets: [] };
      },
      async readKnownWords() {
        return null;
      },
      async readDecisions() {
        return [];
      },
      async readPreferences() {
        return null;
      },
      async readQueues() {
        return [];
      },
      async readAnki() {
        return { config: null, snapshot: null };
      },
      async pull() {
        return { changes: [], nextEventId: 0 };
      },
      async push(_deviceId, mutations) {
        pushCount++;
        return {
          accepted: mutations.map((m) => ({ mutationId: m.mutationId, eventId: 1 })),
          acceptedMutationIds: mutations.map((m) => m.mutationId),
        };
      },
      async uploadDataset() {
        return { accepted: [], acceptedMutationIds: [] };
      },
      async *readDataset() {},
    };

    await recordingStore.wordDecisions.set({
      normalizedWord: "走る",
      status: "mined",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });

    const engine = createSyncEngine({
      cloud: fakeCloud,
      localAppStore: recordingStore,
      remoteApplyStore,
      localSyncStore,
      debounceMs: 50,
    });

    try {
      engine.notifyOutbox();
      engine.notifyOutbox();
      engine.notifyOutbox();

      expect(pushCount).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(pushCount).toBe(1);
    } finally {
      engine.dispose();
      indexedDB.deleteDatabase(dbName);
    }
  });
});

