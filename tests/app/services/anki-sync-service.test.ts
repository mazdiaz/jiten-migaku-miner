import { describe, expect, it, vi } from "vitest";
import { AnkiSyncService } from "../../../src/app/services/anki-sync-service";
import type { ControllerCore } from "../../../src/app/services/context";
import type { AppState } from "../../../src/app/state";
import { createInitialAppState } from "../../../src/app/state";
import { AnkiConnectError, type AnkiConnectPort } from "../../../src/platform/anki-connect";
import type { AppStore } from "../../../src/storage/contracts";
import { createMemoryAppStore } from "../../../src/storage/memory-store";

const config = {
  deckScope: { kind: "deck" as const, name: "MAIN::Mining" },
  noteType: "Diaz Custom Mine",
  targetField: "Target Word (no syntax)",
};

const snapshot = {
  syncedAt: "2026-09-10T10:00:00.000Z",
  statuses: [
    ["word", "known"],
    ["other", "mined"],
  ] as Array<[string, "known" | "mined"]>,
};

function fakePort(): AnkiConnectPort {
  return {
    requestPermission: vi.fn(async () => {}),
    deckNames: vi.fn(async () => ["MAIN::Mining"]),
    modelNames: vi.fn(async () => ["Diaz Custom Mine"]),
    modelFieldNames: vi.fn(async () => ["Target Word (no syntax)"]),
    findCards: vi.fn(async () => []),
    cardsInfo: vi.fn(async () => []),
  };
}

function dataset(id = "dataset-1"): NonNullable<AppState["dataset"]> {
  return {
    id,
    name: "dataset",
    sourceType: "file",
    sourceName: "dataset.csv",
    headers: ["Word"],
    entryCount: 1,
    createdAt: "2026-09-10T09:00:00.000Z",
    updatedAt: "2026-09-10T09:00:00.000Z",
    schemaVersion: 1,
  };
}

interface Harness {
  core: ControllerCore;
  state: AppState;
  port: AnkiConnectPort;
  decisionSpy: { clearUndo: () => void };
  coverageSpy: { request: () => Promise<void> };
  previewSpy: ReturnType<typeof vi.fn>;
}

function coreFor(store: AppStore, port = fakePort()): Harness {
  const state = createInitialAppState("memory");
  let epoch = 0;
  let queryGeneration = 0;
  const decisionSpy = { clearUndo: vi.fn() as () => void };
  const coverageSpy = { request: vi.fn(async () => undefined) };
  const previewSpy = vi.fn(async () => ({
    matchedWords: 2,
    knownCount: 1,
    minedCount: 1,
    manualProtected: 0,
  }));
  const core: ControllerCore = {
    worker: { previewAnkiMatch: previewSpy } as unknown as ControllerCore["worker"],
    sessionQueue: { save: vi.fn(), load: vi.fn(() => null), clear: vi.fn() },
    now: () => "2026-09-10T11:00:00.000Z",
    createId: (kind) => `${kind}-id`,
    get state() {
      return state;
    },
    publish: vi.fn(),
    setState: (patch) => Object.assign(state, patch),
    storageOperation: (operation) => operation(store),
    withUserStateLock: (action) => action(),
    withImportLock: (action) => action(),
    getUserStateEpoch: () => epoch,
    bumpUserStateEpoch: () => {
      epoch += 1;
    },
    bumpQueryGeneration: () => ++queryGeneration,
    getQueryGeneration: () => queryGeneration,
    invalidateQueries: () => {
      queryGeneration += 1;
    },
    getWarningMessage: () => null,
    getViewportStart: () => 0,
    setViewportStart: () => {},
    persistPreferencesUnlocked: async () => {},
    runQuery: async () => {},
    loadAndQuery: async () => {},
    decisionTuples: () => [],
    ankiStatusTuples: () => [],
    countChangeSinceExport: () => {
      state.changesSinceExport += 1;
    },
  };
  return { core, state, port, decisionSpy, coverageSpy, previewSpy };
}

function serviceFor(harness: Harness): AnkiSyncService {
  return new AnkiSyncService(
    harness.core,
    () => harness.port,
    harness.decisionSpy,
    harness.coverageSpy,
  );
}

describe("AnkiSyncService", () => {
  it("loads saved config and snapshot into lightweight UI state without publishing the map", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    const service = serviceFor(harness);

    await service.initialize();

    expect(harness.state.anki).toMatchObject({
      configured: true,
      status: "idle",
      lastSyncedAt: snapshot.syncedAt,
      wordCount: 2,
      knownCount: 1,
      minedCount: 1,
      deckScopeLabel: "MAIN::Mining",
      noteType: config.noteType,
      targetField: config.targetField,
      errorMessage: null,
    });
    expect((harness.state as { ankiStatuses?: unknown }).ankiStatuses).toBeUndefined();
    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
  });

  it("discovers decks and models only after permission is granted", async () => {
    const harness = coreFor(createMemoryAppStore());
    const service = serviceFor(harness);

    await expect(service.connect()).resolves.toEqual({
      decks: ["MAIN::Mining"],
      models: ["Diaz Custom Mine"],
    });

    expect(harness.port.requestPermission).toHaveBeenCalledTimes(1);
    expect(harness.port.deckNames).toHaveBeenCalledTimes(1);
    expect(harness.port.modelNames).toHaveBeenCalledTimes(1);
    expect(harness.state.anki.status).toBe("idle");
  });

  it("loads fields for a selected note type", async () => {
    const harness = coreFor(createMemoryAppStore());
    const service = serviceFor(harness);

    await expect(service.loadModelFields(config.noteType)).resolves.toEqual([
      "Target Word (no syntax)",
    ]);
    expect(harness.port.modelFieldNames).toHaveBeenCalledWith(config.noteType);
  });

  it("does not save config when permission is denied", async () => {
    const store = createMemoryAppStore();
    const harness = coreFor(store);
    const error = new AnkiConnectError("permission-denied", "permission denied");
    vi.mocked(harness.port.requestPermission).mockRejectedValue(error);
    const service = serviceFor(harness);

    await expect(service.validateAndSaveConfig(config)).rejects.toBe(error);

    expect(await store.ankiSync.loadConfig()).toBeNull();
    expect(harness.state.anki).toMatchObject({ configured: false, status: "error" });
    expect(harness.state.changesSinceExport).toBe(0);
  });

  it("saves only a collection-validated config and counts changed config once", async () => {
    const store = createMemoryAppStore();
    const harness = coreFor(store);
    const service = serviceFor(harness);

    await service.validateAndSaveConfig(config);
    await service.validateAndSaveConfig(config);

    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(harness.state.anki).toMatchObject({
      configured: true,
      status: "idle",
      deckScopeLabel: "MAIN::Mining",
    });
    expect(harness.state.changesSinceExport).toBe(1);
  });

  it("builds a candidate with canonical duplicate merging without mutating the saved snapshot", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    vi.mocked(harness.port.findCards).mockImplementation(async (search) =>
      search.includes("is:new") ? [1] : [1, 2, 3],
    );
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: " Word " } },
      { cardId: 2, fields: { [config.targetField]: "word" } },
      { cardId: 3, fields: { [config.targetField]: "other" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();

    await service.previewSync();

    expect(harness.state.ankiPreview).toMatchObject({
      scannedCards: 3,
      uniqueWords: 2,
      emptyTargetFields: 0,
      datasetAvailable: true,
    });
    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
    expect(harness.previewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: "dataset-1",
        ankiStatuses: [
          ["word", "known"],
          ["other", "known"],
        ],
      }),
    );
  });

  it("reports a valid zero-card preview without changing the saved snapshot", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    vi.mocked(harness.port.findCards).mockResolvedValue([]);
    const service = serviceFor(harness);
    await service.initialize();

    await service.previewSync();

    expect(harness.state.ankiPreview).toMatchObject({
      scannedCards: 0,
      uniqueWords: 0,
      emptyTargetFields: 0,
      zeroCards: true,
      datasetAvailable: false,
      matchedWords: null,
    });
    expect(harness.state.anki.status).toBe("preview");
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
  });

  it("skips empty target fields while retaining non-empty card candidates", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    vi.mocked(harness.port.findCards).mockImplementation(async (search) =>
      search.includes("is:new") ? [1] : [1, 2],
    );
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "" } },
      { cardId: 2, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();

    await service.previewSync();

    expect(harness.state.ankiPreview).toMatchObject({
      scannedCards: 2,
      uniqueWords: 1,
      emptyTargetFields: 1,
      zeroCards: false,
    });
  });

  it("keeps the previous snapshot when a cardsInfo batch fails", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    vi.mocked(harness.port.findCards).mockResolvedValue(Array.from({ length: 501 }, (_, i) => i));
    vi.mocked(harness.port.cardsInfo).mockRejectedValue(
      new AnkiConnectError("anki-error", "batch failed"),
    );
    const service = serviceFor(harness);
    await service.initialize();

    await expect(service.previewSync()).rejects.toThrow("batch failed");

    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
    expect(harness.state.ankiPreview).toBeNull();
    expect(harness.state.anki.status).toBe("error");
  });
});
