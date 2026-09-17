import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createLocalSyncStore } from "../../src/storage/local-sync";
import { openDatabase } from "../../src/storage/indexed-db-core";

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
