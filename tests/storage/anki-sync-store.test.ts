import { describe, expect, it } from "vitest";
import type { AnkiSyncConfig, AnkiSyncSnapshot } from "../../src/domain/anki";
import { createMemoryAppStore } from "../../src/storage/memory-store";

describe("MemoryAppStore Anki sync", () => {
  it("round-trips and replaces Anki config/snapshot independently", async () => {
    const store = createMemoryAppStore();
    const config = {
      deckScope: { kind: "all-decks" as const },
      noteType: "Mine",
      targetField: "Word",
    };
    const first = {
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [["word", "mined"] as [string, "mined"]],
    };
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(first);
    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toEqual(first);
    await store.ankiSync.replaceSnapshot({ syncedAt: "2026-09-10T11:00:00.000Z", statuses: [] });
    expect((await store.ankiSync.loadSnapshot())?.statuses).toEqual([]);
    expect(await store.ankiSync.loadConfig()).toEqual(config);
    await store.ankiSync.replaceSnapshot(null);
    expect(await store.ankiSync.loadSnapshot()).toBeNull();
    expect(await store.ankiSync.loadConfig()).toEqual(config);
    await store.ankiSync.clear();
    expect(await store.ankiSync.loadConfig()).toBeNull();
    expect(await store.ankiSync.loadSnapshot()).toBeNull();
  });

  it("isolates nested config scopes and snapshot tuples on read and write", async () => {
    const store = createMemoryAppStore();
    const config: AnkiSyncConfig = {
      deckScope: { kind: "deck", name: "MAIN::Mining" },
      noteType: "Mine",
      targetField: "Word",
    };
    const snapshot: AnkiSyncSnapshot = {
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [
        ["word", "mined"],
        ["known-word", "known"],
      ],
    };

    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);

    if (config.deckScope.kind === "deck") {
      config.deckScope.name = "MUTATED";
    }
    config.noteType = "Changed";
    snapshot.statuses[0]![0] = "changed-word";
    snapshot.statuses.push(["added-word", "known"]);

    expect(await store.ankiSync.loadConfig()).toEqual({
      deckScope: { kind: "deck", name: "MAIN::Mining" },
      noteType: "Mine",
      targetField: "Word",
    });
    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [
        ["word", "mined"],
        ["known-word", "known"],
      ],
    });

    const loadedConfig = await store.ankiSync.loadConfig();
    const loadedSnapshot = await store.ankiSync.loadSnapshot();
    if (loadedConfig?.deckScope.kind === "deck") {
      loadedConfig.deckScope.name = "READ-MUTATED";
    }
    if (loadedSnapshot !== null) {
      loadedSnapshot.statuses[0]![1] = "known";
    }

    expect(await store.ankiSync.loadConfig()).toEqual({
      deckScope: { kind: "deck", name: "MAIN::Mining" },
      noteType: "Mine",
      targetField: "Word",
    });
    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [
        ["word", "mined"],
        ["known-word", "known"],
      ],
    });
  });
});
