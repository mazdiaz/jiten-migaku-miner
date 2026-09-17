import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/domain/types";
import { DatasetNotCachedError, type DatasetMetadata } from "../../src/storage/contracts";
import { createIndexedDbAppStore } from "../../src/storage/indexed-db";
import { openDatabase } from "../../src/storage/indexed-db-core";
import { createLocalSyncStore } from "../../src/storage/local-sync";

describe("LocalSyncStore and IndexedDB local-first substrate", () => {
  it("creates fresh database with all required stores and key paths", async () => {
    const dbName = `test-schema-${crypto.randomUUID()}`;
    const database = await openDatabase(dbName);
    try {
      const storeNames = [...database.objectStoreNames].sort();
      expect(storeNames).toEqual(
        [
          "ankiSync",
          "datasets",
          "entryChunks",
          "knownWordSets",
          "meta",
          "preferences",
          "queues",
          "syncMeta",
          "syncOutbox",
          "wordDecisions",
          "workspace",
        ].sort(),
      );

      const tx = database.transaction(
        ["syncOutbox", "queues", "syncMeta", "workspace"],
        "readonly",
      );
      expect(tx.objectStore("syncOutbox").keyPath).toBe("dedupeKey");
      expect(tx.objectStore("queues").keyPath).toBe("datasetId");
      expect(tx.objectStore("syncMeta").keyPath).toBe("id");
      expect(tx.objectStore("workspace").keyPath).toBe("id");
    } finally {
      database.close();
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("initializes LocalSyncMeta with stable deviceId on first getMeta", async () => {
    const dbName = `test-meta-${crypto.randomUUID()}`;
    const store = createLocalSyncStore(dbName);
    try {
      const meta1 = await store.getMeta();
      expect(meta1).toMatchObject({
        id: "current",
        bootstrapComplete: false,
        serverEventId: 0,
        lastSyncAt: null,
      });
      expect(meta1.deviceId).toBeDefined();
      expect(meta1.deviceId.length).toBeGreaterThan(10);

      const meta2 = await store.getMeta();
      expect(meta2.deviceId).toBe(meta1.deviceId);
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("saves and loads workspace resume state", async () => {
    const dbName = `test-ws-${crypto.randomUUID()}`;
    const store = createLocalSyncStore(dbName);
    try {
      expect(await store.loadWorkspace()).toBeNull();
      const ws = {
        id: "current" as const,
        activeDatasetId: "ds-1",
        viewportStart: 3500,
        queueMode: "normal" as const,
        updatedAt: "2026-09-17T00:00:00.000Z",
      };
      await store.saveWorkspace(ws);
      expect(await store.loadWorkspace()).toEqual(ws);
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("persists queues per dataset and lists them", async () => {
    const dbName = `test-queue-${crypto.randomUUID()}`;
    const store = createLocalSyncStore(dbName);
    try {
      expect(await store.loadQueue("ds-1")).toBeNull();
      const q = {
        version: 1 as const,
        datasetId: "ds-1",
        normalizedWords: ["猫", "犬"],
      };
      await store.saveQueue(q, "ds-1", false);
      expect(await store.loadQueue("ds-1")).toEqual(q);

      const queues = await store.listQueues();
      expect(queues).toEqual([q]);

      await store.saveQueue(null, "ds-1", false);
      expect(await store.loadQueue("ds-1")).toBeNull();
      expect(await store.listQueues()).toEqual([]);
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("handles outbox acknowledgement and prevents race with newer mutations", async () => {
    const dbName = `test-outbox-${crypto.randomUUID()}`;
    const store = createLocalSyncStore(dbName);
    try {
      // 1. Save queue with mutation recording
      await store.saveQueue(
        { version: 1, datasetId: "ds-1", normalizedWords: ["猫"] },
        "ds-1",
        true,
      );

      const pending1 = await store.listOutbox(10);
      expect(pending1).toHaveLength(1);
      const oldMutationId = pending1[0]!.mutationId;
      expect(pending1[0]!.dedupeKey).toBe("queue:ds-1");

      // 2. A newer mutation overwrites the same dedupeKey before old one is acknowledged
      await store.saveQueue(
        { version: 1, datasetId: "ds-1", normalizedWords: ["犬"] },
        "ds-1",
        true,
      );

      const pending2 = await store.listOutbox(10);
      expect(pending2).toHaveLength(1);
      const newMutationId = pending2[0]!.mutationId;
      expect(newMutationId).not.toBe(oldMutationId);

      // 3. Acknowledge old mutation ID -> new mutation must remain
      await store.acknowledge("queue:ds-1", oldMutationId);
      const afterOldAck = await store.listOutbox(10);
      expect(afterOldAck).toHaveLength(1);
      expect(afterOldAck[0]!.mutationId).toBe(newMutationId);

      // 4. Acknowledge new mutation ID -> outbox is now empty
      await store.acknowledge("queue:ds-1", newMutationId);
      const afterNewAck = await store.listOutbox(10);
      expect(afterNewAck).toHaveLength(0);
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });
});

describe("Local mutation recording and sync outbox integration", () => {
  const datasetMeta = (id: string): DatasetMetadata => ({
    id,
    name: `${id} dataset`,
    sourceType: "file",
    sourceName: `${id}.csv`,
    headers: ["Word", "Occurrences"],
    entryCount: 1,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    schemaVersion: 1,
  });

  const testEntry = (id: string): Entry => ({
    id,
    originalIndex: 0,
    word: "猫",
    normalizedWord: "猫",
    occurrences: 1,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
  });

  async function* makeChunks(entries: Entry[]) {
    yield entries;
  }

  it("records outbox events for all local mutating operations when enabled", async () => {
    const dbName = `test-matrix-${crypto.randomUUID()}`;
    const syncStore = createLocalSyncStore(dbName);
    const appStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });

    try {
      // 1. Stage dataset -> dataset:<id>, dataset.upload
      await appStore.datasets.stage(datasetMeta("ds-1"), makeChunks([testEntry("e-1")]));
      let outbox = await syncStore.listOutbox(100);
      const stageRecord = outbox.find((r) => r.dedupeKey === "dataset:ds-1");
      expect(stageRecord).toBeDefined();
      expect(stageRecord?.kind).toBe("dataset.upload");
      expect(stageRecord?.resourceId).toBe("ds-1");

      // 2. Activate dataset -> activeDataset, dataset.activate
      await appStore.datasets.activate("ds-1");
      outbox = await syncStore.listOutbox(100);
      const activateRecord = outbox.find((r) => r.dedupeKey === "activeDataset");
      expect(activateRecord).toBeDefined();
      expect(activateRecord?.kind).toBe("dataset.activate");
      expect(activateRecord?.resourceId).toBe("ds-1");

      // 3. Known save -> known, known.replace
      await appStore.knownWords.save("kw-1", "Known", ["猫"]);
      outbox = await syncStore.listOutbox(100);
      const knownRecord = outbox.find((r) => r.dedupeKey === "known");
      expect(knownRecord).toBeDefined();
      expect(knownRecord?.kind).toBe("known.replace");

      // 4. Decision set -> decision:<word>, decision.set
      await appStore.wordDecisions.set({
        normalizedWord: "猫",
        status: "known",
        updatedAt: "2026-09-17T00:00:00.000Z",
      });
      outbox = await syncStore.listOutbox(100);
      const decisionSetRecord = outbox.find((r) => r.dedupeKey === "decision:猫");
      expect(decisionSetRecord).toBeDefined();
      expect(decisionSetRecord?.kind).toBe("decision.set");
      expect(decisionSetRecord?.resourceId).toBe("猫");

      // 5. Decision remove -> decision:<word>, decision.remove
      await appStore.wordDecisions.remove("猫");
      outbox = await syncStore.listOutbox(100);
      const decisionRemoveRecord = outbox.find((r) => r.dedupeKey === "decision:猫");
      expect(decisionRemoveRecord).toBeDefined();
      expect(decisionRemoveRecord?.kind).toBe("decision.remove");
      expect(decisionRemoveRecord?.resourceId).toBe("猫");

      // 6. Preferences save -> preferences, preferences.replace
      await appStore.preferences.save({
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
          showFurigana: true,
          pillHighlight: false,
          showHighlight: true,
          showDefinitions: false,
          sentenceSize: "large",
          density: "compact",
        },
        page: 1,
      });
      outbox = await syncStore.listOutbox(100);
      const prefRecord = outbox.find((r) => r.dedupeKey === "preferences");
      expect(prefRecord).toBeDefined();
      expect(prefRecord?.kind).toBe("preferences.replace");

      // 7. Anki saveConfig -> anki, anki.replace
      await appStore.ankiSync.saveConfig({
        deckScope: { kind: "all-decks" },
        noteType: "Basic",
        targetField: "Front",
      });
      outbox = await syncStore.listOutbox(100);
      const ankiRecord = outbox.find((r) => r.dedupeKey === "anki");
      expect(ankiRecord).toBeDefined();
      expect(ankiRecord?.kind).toBe("anki.replace");

      // 8. Dataset remove -> dataset:<id>, dataset.remove
      await appStore.datasets.remove("ds-1");
      outbox = await syncStore.listOutbox(100);
      const removeRecord = outbox.find((r) => r.dedupeKey === "dataset:ds-1");
      expect(removeRecord).toBeDefined();
      expect(removeRecord?.kind).toBe("dataset.remove");
      expect(removeRecord?.resourceId).toBe("ds-1");
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("does not commit application data or outbox when a transaction fails", async () => {
    const dbName = `test-abort-${crypto.randomUUID()}`;
    const syncStore = createLocalSyncStore(dbName);
    const appStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });

    try {
      // Trying to activate non-existent dataset fails
      await expect(appStore.datasets.activate("non-existent")).rejects.toThrow();

      // Assert outbox has no activeDataset record
      const outbox = await syncStore.listOutbox(10);
      expect(outbox.find((r) => r.dedupeKey === "activeDataset")).toBeUndefined();
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("supports metadata-only datasets and DatasetNotCachedError", async () => {
    const dbName = `test-meta-only-${crypto.randomUUID()}`;
    const syncStore = createLocalSyncStore(dbName);
    const silentAppStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    try {
      const meta = datasetMeta("meta-1");
      await silentAppStore.datasets.upsertMetadata!(meta);

      // Upsert metadata should NOT record any outbox item
      const outbox = await syncStore.listOutbox(10);
      expect(outbox).toHaveLength(0);

      // List returns it
      const list = await silentAppStore.datasets.list();
      expect(list).toEqual([meta]);

      // Cache state is metadata-only
      const state = await silentAppStore.datasets.cacheState!("meta-1");
      expect(state).toBe("metadata-only");

      // readChunks throws DatasetNotCachedError
      const readIter = silentAppStore.datasets.readChunks("meta-1", 10);
      await expect(async () => {
        for await (const _ of readIter) {
          // should throw before returning chunks
        }
      }).rejects.toThrowError(DatasetNotCachedError);
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("produces individual sync outbox mutations on atomic restoreUserState", async () => {
    const dbName = `test-restore-sync-${crypto.randomUUID()}`;
    const syncStore = createLocalSyncStore(dbName);
    const appStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: true,
    });

    try {
      // Pre-seed some decisions
      await appStore.wordDecisions.set({
        normalizedWord: "old-1",
        status: "known",
        updatedAt: "2026-09-17T00:00:00.000Z",
      });
      await appStore.wordDecisions.set({
        normalizedWord: "keep-1",
        status: "known",
        updatedAt: "2026-09-17T00:00:00.000Z",
      });

      // Clear outbox from pre-seeding
      const initialOutbox = await syncStore.listOutbox(10);
      for (const item of initialOutbox) {
        await syncStore.acknowledge(item.dedupeKey, item.mutationId);
      }
      expect(await syncStore.listOutbox(10)).toHaveLength(0);

      // Perform restoreUserState
      await appStore.restoreUserState!({
        knownWords: { id: "kw-restored", name: "Restored", words: ["猫"] },
        decisions: [
          { normalizedWord: "keep-1", status: "mined", updatedAt: "2026-09-17T01:00:00.000Z" },
          { normalizedWord: "new-1", status: "known", updatedAt: "2026-09-17T01:00:00.000Z" },
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
            showFurigana: true,
            pillHighlight: false,
            showHighlight: true,
            showDefinitions: false,
            sentenceSize: "large",
            density: "compact",
          },
          page: 1,
        },
        ankiSync: {
          config: null,
          snapshot: null,
        },
      });

      const outbox = await syncStore.listOutbox(100);
      const keys = outbox.map((r) => r.dedupeKey).sort();
      expect(keys).toContain("decision:old-1");
      expect(keys).toContain("decision:keep-1");
      expect(keys).toContain("decision:new-1");
      expect(keys).toContain("known");
      expect(keys).toContain("preferences");
      expect(keys).toContain("anki");

      const removedRecord = outbox.find((r) => r.dedupeKey === "decision:old-1");
      expect(removedRecord?.kind).toBe("decision.remove");

      const keepRecord = outbox.find((r) => r.dedupeKey === "decision:keep-1");
      expect(keepRecord?.kind).toBe("decision.set");

      const newRecord = outbox.find((r) => r.dedupeKey === "decision:new-1");
      expect(newRecord?.kind).toBe("decision.set");
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });

  it("keeps outbox empty when recordSyncMutations is false (silent remote/bootstrap writes)", async () => {
    const dbName = `test-silent-${crypto.randomUUID()}`;
    const syncStore = createLocalSyncStore(dbName);
    const silentStore = createIndexedDbAppStore({
      databaseName: dbName,
      recordSyncMutations: false,
    });

    try {
      await silentStore.wordDecisions.set({
        normalizedWord: "silent-word",
        status: "known",
        updatedAt: "2026-09-17T00:00:00.000Z",
      });
      await silentStore.knownWords.save("silent-kw", "Silent", ["silent-word"]);
      await silentStore.datasets.upsertMetadata!(datasetMeta("silent-ds"));

      const outbox = await syncStore.listOutbox(10);
      expect(outbox).toHaveLength(0);
    } finally {
      indexedDB.deleteDatabase(dbName);
    }
  });
});

