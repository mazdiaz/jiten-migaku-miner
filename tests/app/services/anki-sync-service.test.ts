import { describe, expect, it, vi } from "vitest";
import { AnkiSyncService } from "../../../src/app/services/anki-sync-service";
import type { ControllerCore } from "../../../src/app/services/context";
import type { AppState } from "../../../src/app/state";
import { createInitialAppState } from "../../../src/app/state";
import type { AnkiSyncSnapshot } from "../../../src/domain/anki";
import type { WordDecisionStatus } from "../../../src/domain/types";
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

interface Harness {
  core: ControllerCore;
  state: AppState;
  port: AnkiConnectPort;
  decisionSpy: { clearUndo: () => void };
  coverageSpy: { request: () => Promise<void> };
  previewSpy: ReturnType<typeof vi.fn>;
  runQuerySpy: ReturnType<typeof vi.fn>;
}

function coreFor(store: AppStore, port = fakePort()): Harness {
  const state = createInitialAppState("memory");
  let epoch = 0;
  let queryGeneration = 0;
  let userStateLock: Promise<unknown> = Promise.resolve();
  const decisionSpy = { clearUndo: vi.fn() as () => void };
  const coverageSpy = { request: vi.fn(async () => undefined) };
  const previewSpy = vi.fn(async () => ({
    matchedWords: 2,
    knownCount: 1,
    minedCount: 1,
    manualProtected: 0,
  }));
  const runQuerySpy = vi.fn(async () => {});
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
    withUserStateLock: <T>(action: () => Promise<T>) => {
      const result = userStateLock.then(action, action);
      userStateLock = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
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
    runQuery: runQuerySpy,
    loadAndQuery: async () => {},
    decisionTuples: (): Array<[string, WordDecisionStatus]> =>
      [...state.wordDecisions.values()].map((decision) => [
        decision.normalizedWord,
        decision.status,
      ]),
    ankiStatusTuples: () => [],
    countChangeSinceExport: () => {
      state.changesSinceExport += 1;
    },
  };
  return { core, state, port, decisionSpy, coverageSpy, previewSpy, runQuerySpy };
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

  it("preserves prior service state when staged initialization cannot map snapshot", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();

    store.ankiSync.loadConfig = vi.fn(async () => ({ ...config, noteType: "Other model" }));
    store.ankiSync.loadSnapshot = vi.fn(
      async () =>
        ({ syncedAt: "2026-09-11T10:00:00.000Z", statuses: null }) as unknown as AnkiSyncSnapshot,
    );

    await expect(service.initialize()).rejects.toThrow();

    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
    expect(harness.state.anki).toMatchObject({
      configured: true,
      noteType: config.noteType,
      wordCount: 2,
      status: "error",
    });
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

  it("counts one change when identical config saves overlap", async () => {
    const store = createMemoryAppStore();
    const harness = coreFor(store);
    const service = serviceFor(harness);
    const saveConfig = vi.spyOn(store.ankiSync, "saveConfig");

    await Promise.all([
      service.validateAndSaveConfig(config),
      service.validateAndSaveConfig(config),
    ]);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(harness.state.changesSinceExport).toBe(1);
    expect(await store.ankiSync.loadConfig()).toEqual(config);
  });

  it("preserves saved state when selected deck is no longer available", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();
    vi.mocked(harness.port.deckNames).mockResolvedValue([]);

    await expect(service.validateAndSaveConfig(config)).rejects.toMatchObject({
      code: "invalid-config",
    });

    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
    expect(harness.state.anki).toMatchObject({ configured: true, noteType: config.noteType });
  });

  it("preserves saved state when selected note type is no longer available", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();
    vi.mocked(harness.port.modelNames).mockResolvedValue([]);

    await expect(service.validateAndSaveConfig(config)).rejects.toMatchObject({
      code: "invalid-config",
    });

    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
    expect(harness.state.anki).toMatchObject({ configured: true, targetField: config.targetField });
  });

  it("preserves saved state when selected target field is no longer available", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();
    vi.mocked(harness.port.modelFieldNames).mockResolvedValue([]);

    await expect(service.validateAndSaveConfig(config)).rejects.toMatchObject({
      code: "invalid-config",
    });

    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
    expect(harness.state.anki).toMatchObject({
      configured: true,
      deckScopeLabel: config.deckScope.name,
    });
  });

  it("invalidates a pending preview when config validation completes", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    const service = serviceFor(harness);
    await service.initialize();

    await service.previewSync();
    expect(harness.state.ankiPreview).not.toBeNull();

    await service.validateAndSaveConfig(config);

    expect(harness.state.ankiPreview).toBeNull();
    await expect(service.applySync()).rejects.toMatchObject({ code: "stale-preview" });
  });

  it("rejects sync when saved configuration no longer exists", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    vi.mocked(harness.port.deckNames).mockResolvedValue([]);
    const service = serviceFor(harness);
    await service.initialize();

    await expect(service.previewSync()).rejects.toMatchObject({ code: "invalid-config" });

    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
    expect(harness.state.ankiPreview).toBeNull();
  });

  it("clears the previous preview when a new sync begins", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();
    expect(harness.state.ankiPreview).not.toBeNull();

    let releasePermission!: () => void;
    const permission = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    vi.mocked(harness.port.requestPermission).mockImplementationOnce(() => permission);
    const nextSync = service.previewSync();

    expect(harness.state.anki.status).toBe("syncing");
    expect(harness.state.ankiPreview).toBeNull();

    releasePermission();
    await nextSync;
  });

  it("returns to idle when an in-flight sync is cancelled", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();

    let releasePermission!: () => void;
    const permission = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    vi.mocked(harness.port.requestPermission).mockImplementationOnce(() => permission);
    const nextSync = service.previewSync();

    service.cancelPreview();
    expect(harness.state.anki.status).toBe("idle");
    expect(harness.state.ankiPreview).toBeNull();

    releasePermission();
    await expect(nextSync).rejects.toMatchObject({ code: "stale-preview" });
    expect(harness.state.anki.status).toBe("idle");
  });

  it("rejects missing cardsInfo IDs instead of publishing a partial candidate", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    vi.mocked(harness.port.findCards).mockImplementation(async (search) =>
      search.includes("is:new") ? [] : [1, 2],
    );
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();

    await expect(service.previewSync()).rejects.toMatchObject({
      name: "AnkiConnectError",
      code: "protocol-error",
    });

    expect(harness.state.ankiPreview).toBeNull();
    expect(harness.state.anki.status).toBe("error");
  });

  it("rejects duplicate cardsInfo IDs instead of double-counting a card", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    vi.mocked(harness.port.findCards).mockImplementation(async (search) =>
      search.includes("is:new") ? [] : [1, 2],
    );
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
      { cardId: 1, fields: { [config.targetField]: "word" } },
      { cardId: 2, fields: { [config.targetField]: "other" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();

    await expect(service.previewSync()).rejects.toMatchObject({
      name: "AnkiConnectError",
      code: "protocol-error",
    });

    expect(harness.state.ankiPreview).toBeNull();
    expect(harness.state.anki.status).toBe("error");
  });

  it("uses exact base and mined searches and bypasses dataset matching when absent", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    vi.mocked(harness.port.findCards).mockImplementation(async (search) =>
      search.includes("is:new") ? [] : [1],
    );
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();

    await service.previewSync();

    expect(harness.port.findCards).toHaveBeenNthCalledWith(
      1,
      'note:"Diaz Custom Mine" deck:"MAIN::Mining"',
    );
    expect(harness.port.findCards).toHaveBeenNthCalledWith(
      2,
      'note:"Diaz Custom Mine" deck:"MAIN::Mining" is:new -is:suspended',
    );
    expect(harness.previewSpy).not.toHaveBeenCalled();
    expect(harness.state.ankiPreview).toMatchObject({
      datasetAvailable: false,
      matchedWords: null,
      knownCount: null,
      minedCount: null,
      manualProtected: null,
    });
  });

  it("counts and removes only unprotected queued candidate words", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    harness.state.queue = {
      datasetId: "dataset-1",
      normalizedWords: ["word", "manual-word", "untouched"],
      mode: "normal",
    };
    harness.state.wordDecisions.set("manual-word", {
      normalizedWord: "manual-word",
      status: "later",
      updatedAt: "2026-09-10T09:00:00.000Z",
    });
    vi.mocked(harness.port.findCards).mockImplementation(async (search) =>
      search.includes("is:new") ? [] : [1, 2],
    );
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
      { cardId: 2, fields: { [config.targetField]: "manual-word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();

    await service.previewSync();
    expect(harness.state.ankiPreview?.queueRemovals).toBe(1);

    await service.applySync();

    expect(harness.state.queue.normalizedWords).toEqual(["manual-word", "untouched"]);
  });

  it("rejects a canceled dataset match promptly and leaves worker work cleanable", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const workerMatch = deferred<{
      matchedWords: number;
      knownCount: number;
      minedCount: number;
      manualProtected: number;
    }>();
    vi.mocked(harness.previewSpy).mockImplementationOnce(() => workerMatch.promise);
    const service = serviceFor(harness);
    await service.initialize();

    const pending = service.previewSync();
    for (let attempt = 0; attempt < 20 && harness.previewSpy.mock.calls.length === 0; attempt += 1)
      await Promise.resolve();
    service.cancelPreview();
    const outcome = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 50),
      ),
    ]);
    workerMatch.resolve({ matchedWords: 1, knownCount: 0, minedCount: 1, manualProtected: 0 });
    await pending.catch(() => undefined);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.error).toMatchObject({ code: "stale-preview" });
    expect(harness.state.anki.status).toBe("idle");
    expect(harness.state.ankiPreview).toBeNull();
  });

  it("does not let an older scan failure clear a newer preview", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const firstMatch = deferred<{
      matchedWords: number;
      knownCount: number;
      minedCount: number;
      manualProtected: number;
    }>();
    const secondMatch = deferred<{
      matchedWords: number;
      knownCount: number;
      minedCount: number;
      manualProtected: number;
    }>();
    let matchNumber = 0;
    vi.mocked(harness.previewSpy).mockImplementation(() => {
      matchNumber += 1;
      return matchNumber === 1 ? firstMatch.promise : secondMatch.promise;
    });
    const service = serviceFor(harness);
    await service.initialize();

    const first = service.previewSync();
    for (let attempt = 0; attempt < 20 && harness.previewSpy.mock.calls.length < 1; attempt += 1)
      await Promise.resolve();
    const second = service.previewSync();
    for (let attempt = 0; attempt < 20 && harness.previewSpy.mock.calls.length < 2; attempt += 1)
      await Promise.resolve();
    secondMatch.resolve({ matchedWords: 1, knownCount: 1, minedCount: 0, manualProtected: 0 });
    await second;
    firstMatch.reject(new Error("old scan failed"));

    await expect(first).rejects.toMatchObject({ code: "stale-preview" });
    expect(harness.state.anki.status).toBe("preview");
    expect(harness.state.ankiPreview).not.toBeNull();
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

  it("applies one snapshot, removes only Anki-owned queue entries, and refreshes once", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const previous = {
      syncedAt: "2026-09-09T10:00:00.000Z",
      statuses: [["old", "known"]] as Array<[string, "known" | "mined"]>,
    };
    await store.ankiSync.replaceSnapshot(previous);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    harness.state.queue = {
      datasetId: "dataset-1",
      normalizedWords: ["word", "manual-word"],
      mode: "normal",
    };
    harness.state.wordDecisions.set("manual-word", {
      normalizedWord: "manual-word",
      status: "later",
      updatedAt: "2026-09-10T09:00:00.000Z",
    });
    vi.mocked(harness.port.findCards).mockImplementation(async (search) =>
      search.includes("is:new") ? [1] : [1, 2],
    );
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
      { cardId: 2, fields: { [config.targetField]: "other" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();
    const publishCountBeforeApply = vi.mocked(harness.core.publish).mock.calls.length;

    await service.applySync();

    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T11:00:00.000Z",
      statuses: [
        ["word", "mined"],
        ["other", "known"],
      ],
    });
    expect(service.ankiStatusTuples()).toEqual([
      ["word", "mined"],
      ["other", "known"],
    ]);
    expect(harness.state.queue.normalizedWords).toEqual(["manual-word"]);
    expect(harness.state.ankiPreview).toBeNull();
    expect(harness.state.anki.status).toBe("idle");
    expect(harness.runQuerySpy).toHaveBeenCalledTimes(1);
    expect(harness.coverageSpy.request).toHaveBeenCalledTimes(1);
    expect(harness.decisionSpy.clearUndo).toHaveBeenCalledTimes(1);
    expect(harness.state.changesSinceExport).toBe(1);
    expect(vi.mocked(harness.core.publish)).toHaveBeenCalledTimes(publishCountBeforeApply + 2);
  });

  it("ignores cancellation during replacement and applies one atomic snapshot", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const previous = {
      syncedAt: "2026-09-09T10:00:00.000Z",
      statuses: [["old", "known"]] as Array<[string, "known" | "mined"]>,
    };
    await store.ankiSync.replaceSnapshot(previous);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    harness.state.queue = { datasetId: "dataset-1", normalizedWords: ["word"], mode: "normal" };
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();

    const originalReplaceSnapshot = store.ankiSync.replaceSnapshot.bind(store.ankiSync);
    const replacementStarted = deferred<void>();
    const releaseReplacement = deferred<void>();
    let replacementCalls = 0;
    store.ankiSync.replaceSnapshot = vi.fn(async (nextSnapshot) => {
      replacementCalls += 1;
      if (replacementCalls === 1) {
        replacementStarted.resolve(undefined);
        await releaseReplacement.promise;
      }
      await originalReplaceSnapshot(nextSnapshot);
    });

    const applying = service.applySync();
    await replacementStarted.promise;
    service.cancelPreview();
    expect(harness.state.anki.status).toBe("syncing");
    expect(harness.state.ankiPreview).not.toBeNull();
    releaseReplacement.resolve(undefined);

    await expect(applying).resolves.toBeUndefined();

    expect(replacementCalls).toBe(1);
    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T11:00:00.000Z",
      statuses: [["word", "mined"]],
    });
    expect(service.ankiStatusTuples()).toEqual([["word", "mined"]]);
    expect(harness.state.queue.normalizedWords).toEqual([]);
    expect(harness.state.changesSinceExport).toBe(1);
    expect(harness.state.ankiPreview).toBeNull();
    expect(harness.state.anki.status).toBe("idle");
    expect(harness.runQuerySpy).toHaveBeenCalledTimes(1);
    expect(harness.coverageSpy.request).toHaveBeenCalledTimes(1);
  });

  it("keeps failed Apply retryable after cancellation attempt", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const previous = {
      syncedAt: "2026-09-09T10:00:00.000Z",
      statuses: [["old", "known"]] as Array<[string, "known" | "mined"]>,
    };
    await store.ankiSync.replaceSnapshot(previous);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    harness.state.queue = { datasetId: "dataset-1", normalizedWords: ["word"], mode: "normal" };
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();

    const originalReplaceSnapshot = store.ankiSync.replaceSnapshot.bind(store.ankiSync);
    const replacementStarted = deferred<void>();
    const releaseReplacement = deferred<void>();
    const storageError = new Error("storage failed");
    store.ankiSync.replaceSnapshot = vi.fn(async () => {
      replacementStarted.resolve(undefined);
      await releaseReplacement.promise;
      throw storageError;
    });

    const applying = service.applySync();
    await replacementStarted.promise;
    service.cancelPreview();
    expect(harness.state.anki.status).toBe("syncing");
    expect(harness.state.ankiPreview).not.toBeNull();
    releaseReplacement.resolve(undefined);

    await expect(applying).rejects.toBe(storageError);

    expect(await store.ankiSync.loadSnapshot()).toEqual(previous);
    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(service.ankiStatusTuples()).toEqual(previous.statuses);
    expect(harness.state.queue.normalizedWords).toEqual(["word"]);
    expect(harness.state.anki.status).toBe("error");
    expect(harness.state.ankiPreview).not.toBeNull();
    expect(harness.state.changesSinceExport).toBe(0);
    expect(harness.runQuerySpy).not.toHaveBeenCalled();

    store.ankiSync.replaceSnapshot = originalReplaceSnapshot;
    await service.applySync();

    expect(await store.ankiSync.loadSnapshot()).toEqual({
      syncedAt: "2026-09-10T11:00:00.000Z",
      statuses: [["word", "mined"]],
    });
    expect(service.ankiStatusTuples()).toEqual([["word", "mined"]]);
    expect(harness.state.queue.normalizedWords).toEqual([]);
    expect(harness.state.changesSinceExport).toBe(1);
    expect(harness.runQuerySpy).toHaveBeenCalledTimes(1);
    expect(harness.coverageSpy.request).toHaveBeenCalledTimes(1);
  });

  it("does not let an old Apply error overwrite a newer preview", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();

    const originalReplaceSnapshot = store.ankiSync.replaceSnapshot.bind(store.ankiSync);
    const replacementStarted = deferred<void>();
    const releaseReplacement = deferred<void>();
    const storageError = new Error("storage failed");
    store.ankiSync.replaceSnapshot = vi.fn(async () => {
      replacementStarted.resolve(undefined);
      await releaseReplacement.promise;
      throw storageError;
    });

    const applying = service.applySync();
    await replacementStarted.promise;
    await service.previewSync();
    expect(harness.state.anki.status).toBe("preview");
    expect(harness.state.ankiPreview).not.toBeNull();
    releaseReplacement.resolve(undefined);

    await expect(applying).rejects.toBe(storageError);

    expect(harness.state.anki.status).toBe("preview");
    expect(harness.state.anki.errorMessage).toBeNull();
    expect(harness.state.ankiPreview).not.toBeNull();
    expect(await store.ankiSync.loadSnapshot()).toBeNull();

    store.ankiSync.replaceSnapshot = originalReplaceSnapshot;
  });

  it("refreshes query and coverage after committed apply even if epoch changes after lock", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();
    const lock = harness.core.withUserStateLock;
    harness.core.withUserStateLock = <T>(action: () => Promise<T>) =>
      lock(action).then((value) => {
        harness.core.bumpUserStateEpoch();
        return value;
      });

    await service.applySync();

    expect(harness.runQuerySpy).toHaveBeenCalledTimes(1);
    expect(harness.coverageSpy.request).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale preview after the user-state epoch changes", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();
    harness.core.bumpUserStateEpoch();

    await expect(service.applySync()).rejects.toMatchObject({ code: "stale-preview" });

    expect(await store.ankiSync.loadSnapshot()).toBeNull();
    expect(harness.state.ankiPreview).toBeNull();
    expect(harness.state.anki.status).toBe("error");
    expect(harness.runQuerySpy).not.toHaveBeenCalled();
  });

  it("preserves the prior snapshot and queue when storage replacement fails", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const previous = {
      syncedAt: "2026-09-09T10:00:00.000Z",
      statuses: [["old", "known"]] as Array<[string, "known" | "mined"]>,
    };
    await store.ankiSync.replaceSnapshot(previous);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    harness.state.queue = { datasetId: "dataset-1", normalizedWords: ["word"], mode: "normal" };
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();
    const originalReplaceSnapshot = store.ankiSync.replaceSnapshot.bind(store.ankiSync);
    store.ankiSync.replaceSnapshot = vi.fn().mockRejectedValue(new Error("storage failed"));

    await expect(service.applySync()).rejects.toThrow("storage failed");

    expect(service.ankiStatusTuples()).toEqual(previous.statuses);
    expect(await store.ankiSync.loadSnapshot()).toEqual(previous);
    expect(harness.state.queue.normalizedWords).toEqual(["word"]);
    expect(harness.state.anki.status).toBe("error");
    expect(harness.runQuerySpy).not.toHaveBeenCalled();

    store.ankiSync.replaceSnapshot = originalReplaceSnapshot;
    await service.applySync();

    expect(service.ankiStatusTuples()).toEqual([["word", "mined"]]);
    expect(harness.runQuerySpy).toHaveBeenCalledTimes(1);
    expect(harness.coverageSpy.request).toHaveBeenCalledTimes(1);
    expect(harness.state.changesSinceExport).toBe(1);
  });

  it("refuses apply after active dataset identity changes", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    harness.state.dataset = dataset("dataset-1");
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();
    harness.state.dataset = dataset("dataset-2");

    await expect(service.applySync()).rejects.toMatchObject({ code: "stale-preview" });

    expect(await store.ankiSync.loadSnapshot()).toBeNull();
    expect(service.ankiStatusTuples()).toEqual([]);
    expect(harness.runQuerySpy).not.toHaveBeenCalled();
  });

  it("preserves service and storage state when clear fails", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();
    store.ankiSync.clear = vi.fn().mockRejectedValue(new Error("clear failed"));

    await expect(service.clearSyncData()).rejects.toThrow("clear failed");

    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
    expect(harness.state.anki).toMatchObject({ configured: true, status: "error" });
    expect(harness.state.changesSinceExport).toBe(0);
    expect(harness.runQuerySpy).not.toHaveBeenCalled();
    expect(harness.coverageSpy.request).not.toHaveBeenCalled();
  });

  it("clears Anki config and snapshot as one refreshable state mutation", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();
    const publishCountBeforeClear = vi.mocked(harness.core.publish).mock.calls.length;

    await service.clearSyncData();

    expect(await store.ankiSync.loadConfig()).toBeNull();
    expect(await store.ankiSync.loadSnapshot()).toBeNull();
    expect(service.ankiStatusTuples()).toEqual([]);
    expect(harness.state.anki).toMatchObject({ configured: false, wordCount: 0, status: "idle" });
    expect(harness.state.changesSinceExport).toBe(1);
    expect(harness.runQuerySpy).toHaveBeenCalledTimes(1);
    expect(harness.coverageSpy.request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.core.publish)).toHaveBeenCalledTimes(publishCountBeforeClear + 1);
  });

  it("hydrates service memory from restored backup state without counting another change", async () => {
    const harness = coreFor(createMemoryAppStore());
    const service = serviceFor(harness);

    service.restoreFromBackup({ config, snapshot });

    expect(service.ankiStatusTuples()).toEqual(snapshot.statuses);
    expect(harness.state.anki).toMatchObject({
      configured: true,
      wordCount: 2,
      knownCount: 1,
      minedCount: 1,
    });
    expect(harness.state.changesSinceExport).toBe(0);
  });

  it("canonicalizes restored snapshot and clears service memory for null restore", async () => {
    const store = createMemoryAppStore();
    const harness = coreFor(store);
    const service = serviceFor(harness);
    const restoredSnapshot = {
      syncedAt: "2026-09-10T10:00:00.000Z",
      statuses: [
        [" Word ", "mined"],
        ["word", "known"],
        ["Other", "mined"],
        ["other", "mined"],
      ] as Array<[string, "known" | "mined"]>,
    };

    service.restoreFromBackup({ config, snapshot: restoredSnapshot });

    expect(service.ankiStatusTuples()).toEqual([
      ["word", "known"],
      ["other", "mined"],
    ]);
    expect(harness.state.anki).toMatchObject({
      configured: true,
      wordCount: 2,
      knownCount: 1,
      minedCount: 1,
      lastSyncedAt: restoredSnapshot.syncedAt,
    });

    service.restoreFromBackup(null);

    expect(service.ankiStatusTuples()).toEqual([]);
    expect(harness.state.anki).toMatchObject({
      configured: false,
      wordCount: 0,
      knownCount: 0,
      minedCount: 0,
      lastSyncedAt: null,
      status: "idle",
    });
    expect(harness.state.ankiPreview).toBeNull();
  });

  it("resets only service memory without clearing durable Anki state", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    await store.ankiSync.replaceSnapshot(snapshot);
    const harness = coreFor(store);
    const service = serviceFor(harness);
    await service.initialize();

    service.resetLocal();

    expect(service.ankiStatusTuples()).toEqual([]);
    expect(harness.state.anki).toMatchObject({ configured: false, wordCount: 0, status: "idle" });
    expect(await store.ankiSync.loadConfig()).toEqual(config);
    expect(await store.ankiSync.loadSnapshot()).toEqual(snapshot);
  });

  it("clears private candidate as well as visible preview on same-config validation", async () => {
    const store = createMemoryAppStore();
    await store.ankiSync.saveConfig(config);
    const harness = coreFor(store);
    harness.state.dataset = dataset();
    vi.mocked(harness.port.findCards).mockResolvedValue([1]);
    vi.mocked(harness.port.cardsInfo).mockResolvedValue([
      { cardId: 1, fields: { [config.targetField]: "word" } },
    ]);
    const service = serviceFor(harness);
    await service.initialize();
    await service.previewSync();

    await service.validateAndSaveConfig(config);

    expect(harness.state.ankiPreview).toBeNull();
    await expect(service.applySync()).rejects.toMatchObject({ code: "stale-preview" });
  });
});
