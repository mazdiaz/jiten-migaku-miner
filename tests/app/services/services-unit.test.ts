import { describe, expect, it } from "vitest";
import { BackupService, MAX_BACKUP_BYTES } from "../../../src/app/services/backup-service";
import type { ControllerCore } from "../../../src/app/services/context";
import { CoverageService } from "../../../src/app/services/coverage-service";
import { DecisionService } from "../../../src/app/services/decision-service";
import { MiningQueueService } from "../../../src/app/services/mining-queue-service";
import { ReviewSession } from "../../../src/app/services/review-session";
import {
  type AppState,
  createInitialAppState,
  DEFAULT_QUERY,
  DEFAULT_VIEW,
  EMPTY_REVIEW,
} from "../../../src/app/state";
import type {
  WorkerAnkiPreviewInput,
  WorkerClient,
  WorkerCoverageInput,
  WorkerQueryInput,
} from "../../../src/app/worker-client";
import type { CoverageStats, Entry, QueryResult } from "../../../src/domain/types";

function entry(id: string, word: string, originalIndex = 0): Entry {
  return {
    id,
    originalIndex,
    word,
    normalizedWord: word,
    occurrences: 3,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
  };
}

function withKnown(value: Entry): Entry & {
  known: boolean;
  knownByMigaku: boolean;
  knownByDecision: boolean;
  decision: "unreviewed";
} {
  return {
    ...value,
    known: false,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed",
  };
}

function result(items: QueryResult["items"] = []): QueryResult {
  return {
    items,
    page: 1,
    totalPages: 1,
    totalEntries: items.length,
    startIndex: items.length ? 1 : 0,
    endIndex: items.length,
    pageSize: 50,
    knownCount: 0,
    windowed: false,
  };
}

class FakeWorker implements WorkerClient {
  queryGate: Promise<void> = Promise.resolve();
  coverageGate: Promise<void> = Promise.resolve();
  coverageResults: CoverageStats[] = [];

  async importJiten(name: string) {
    return {
      protocolVersion: 3 as const,
      type: "import-complete" as const,
      requestId: "i",
      kind: "jiten" as const,
      name,
      headers: [],
      entryCount: 0,
      skippedRows: 0,
    };
  }

  async importKnown(name: string) {
    return {
      protocolVersion: 3 as const,
      type: "import-complete" as const,
      requestId: "i",
      kind: "known" as const,
      name,
      wordCount: 0,
    };
  }

  async loadDataset(_datasetId: string, _chunks: AsyncIterable<readonly Entry[]>): Promise<void> {}

  async query(request: WorkerQueryInput): Promise<QueryResult> {
    await this.queryGate;
    return result(
      (request.includeNormalizedWords ?? []).map((word, index) =>
        withKnown(entry(word, word, index)),
      ),
    );
  }

  async coverage(_request: WorkerCoverageInput): Promise<CoverageStats> {
    await this.coverageGate;
    const next = this.coverageResults.shift();
    if (next === undefined) throw new Error("no staged coverage result");
    return next;
  }

  async previewAnkiMatch(_request: WorkerAnkiPreviewInput) {
    return { matchedWords: 0, knownCount: 0, minedCount: 0, manualProtected: 0 };
  }

  dispose(): void {}
}

function coverageStats(percent: number): CoverageStats {
  return {
    totalUniqueWords: 2,
    knownUniqueWords: 0,
    unknownUniqueWords: 2,
    totalTrackedOccurrences: 6,
    knownTrackedOccurrences: 0,
    unknownTrackedOccurrences: 6,
    coveragePercent: percent,
    targets: [],
  };
}

interface Harness {
  state: AppState;
  core: ControllerCore;
  worker: FakeWorker;
  events: string[];
  queryGeneration(): number;
}

function setup(): Harness {
  const state = createInitialAppState("memory");
  state.query = { ...DEFAULT_QUERY };
  state.view = { ...DEFAULT_VIEW };
  const worker = new FakeWorker();
  const events: string[] = [];
  let queryGeneration = 0;
  let userStateEpoch = 0;

  const core: ControllerCore = {
    worker,
    sessionQueue: {
      save: () => events.push("sessionQueue.save"),
      load: () => null,
      clear: () => events.push("sessionQueue.clear"),
    },
    now: () => "2026-09-08T00:00:00.000Z",
    createId: (kind) => `${kind}-id`,
    get state() {
      return state;
    },
    publish: () => events.push("publish"),
    setState: (patch) => {
      Object.assign(state, patch);
      events.push("publish");
    },
    storageOperation: async (operation) =>
      operation({
        datasets: {
          list: async () => [],
          getActive: async () => null,
          stage: async () => {},
          activate: async () => {},
          remove: async () => {},
          readChunks: async function* () {},
        },
        knownWords: {
          getActive: async () => null,
          save: async () => {},
          remove: async () => {},
        },
        wordDecisions: {
          get: async () => null,
          list: async () => [],
          set: async () => {},
          remove: async () => {},
          replaceAll: async () => {},
        },
        preferences: {
          load: async () => null,
          save: async () => {},
          clear: async () => {},
        },
        ankiSync: {
          loadConfig: async () => null,
          saveConfig: async () => {},
          loadSnapshot: async () => null,
          replaceSnapshot: async () => {},
          clear: async () => {},
        },
        clearAll: async () => {},
        restoreUserState: async () => {},
      }),
    withUserStateLock: async (action) => action(),
    withImportLock: async (action) => action(),
    getUserStateEpoch: () => userStateEpoch,
    bumpUserStateEpoch: () => {
      userStateEpoch += 1;
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
    runQuery: async () => {
      events.push("runQuery");
    },
    loadAndQuery: async () => {
      events.push("loadAndQuery");
    },
    decisionTuples: () =>
      [...state.wordDecisions.values()].map((d) => [d.normalizedWord, d.status]),
    ankiStatusTuples: () => [],
    countChangeSinceExport: () => {
      state.changesSinceExport += 1;
    },
  };
  return { state, core, worker, events, queryGeneration: () => queryGeneration };
}

describe("CoverageService", () => {
  it("drops a stale coverage response after invalidate()", async () => {
    const env = setup();
    env.state.dataset = {
      id: "d1",
      name: "d1",
      sourceType: "file",
      sourceName: "d1.csv",
      headers: [],
      entryCount: 1,
      createdAt: "",
      updatedAt: "",
      schemaVersion: 1,
    };
    env.worker.coverageResults = [coverageStats(10), coverageStats(20)];
    const service = new CoverageService(env.core);

    let resolveFirst: (() => void) | null = null;
    env.worker.coverageGate = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const first = service.request();
    await Promise.resolve();
    resolveFirst!();
    await first;
    expect(env.state.coverage?.coveragePercent).toBe(10);

    // Invalidate while a second response is in flight: its result is dropped.
    env.worker.coverageGate = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = service.request();
    await Promise.resolve();
    service.invalidate();
    resolveFirst!();
    await second;
    expect(env.state.coverage?.coveragePercent).toBe(10);
    expect(env.state.coverageStatus).toBe("loading");
  });

  it("clears stats when no dataset is active", async () => {
    const env = setup();
    const service = new CoverageService(env.core);
    service.reset();
    expect(env.state.coverage).toBeNull();
    await service.request();
    expect(env.state.coverage).toBeNull();
    expect(env.state.coverageStatus).toBe("idle");
  });
});

describe("MiningQueueService", () => {
  it("sends a neutral query constrained by the include list", async () => {
    const env = setup();
    env.state.dataset = {
      id: "d1",
      name: "d1",
      sourceType: "file",
      sourceName: "d1.csv",
      headers: [],
      entryCount: 3,
      createdAt: "",
      updatedAt: "",
      schemaVersion: 1,
    };
    env.state.query = { ...DEFAULT_QUERY, search: "猫", hideKnown: true, decision: "later" };
    const service = new MiningQueueService(env.core);
    service.setQueueWords("d1", ["b", "a"]);
    await service.startQueueMode();

    const state = env.core.state;
    expect(state.queue.mode).toBe("queue");
    expect(state.result?.items.map((item) => item.normalizedWord)).toEqual(["b", "a"]);
    expect(state.status).toBe("ready");
  });

  it("stopQueueMode returns to normal and triggers a normal requery", async () => {
    const env = setup();
    env.state.dataset = {
      id: "d1",
      name: "d1",
      sourceType: "file",
      sourceName: "d1.csv",
      headers: [],
      entryCount: 3,
      createdAt: "",
      updatedAt: "",
      schemaVersion: 1,
    };
    const service = new MiningQueueService(env.core);
    service.setQueueWords("d1", ["a"]);
    await service.startQueueMode();
    env.events.length = 0;
    service.stopQueueMode();
    await Promise.resolve();
    expect(env.core.state.queue.mode).toBe("normal");
    expect(env.events).toContain("runQuery");
  });
});

describe("DecisionService", () => {
  it("persists a decision, removes it from the queue, and enables undo", async () => {
    const env = setup();
    env.state.dataset = {
      id: "d1",
      name: "d1",
      sourceType: "file",
      sourceName: "d1.csv",
      headers: [],
      entryCount: 1,
      createdAt: "",
      updatedAt: "",
      schemaVersion: 1,
    };
    const queue = new MiningQueueService(env.core);
    const coverage = new CoverageService(env.core);
    const decisions = new DecisionService(env.core, queue, coverage);
    queue.setQueueWords("d1", ["ねこ"]);

    await decisions.setWordDecision("ねこ", "known");

    expect(env.core.state.wordDecisions.get("ねこ")?.status).toBe("known");
    expect(env.core.state.queue.normalizedWords).toEqual([]);
    expect(env.core.state.undo.available).toBe(true);
    expect(env.core.state.changesSinceExport).toBe(1);
    expect(env.events).toContain("runQuery");

    await decisions.undoLastDecision();
    expect(env.core.state.wordDecisions.has("ねこ")).toBe(false);
    // Undo restored the queue membership the decision removed.
    expect(env.core.state.queue.normalizedWords).toEqual(["ねこ"]);
    expect(env.core.state.undo.available).toBe(false);
  });

  it("rejects an empty decision word", async () => {
    const env = setup();
    const decisions = new DecisionService(
      env.core,
      new MiningQueueService(env.core),
      new CoverageService(env.core),
    );
    await expect(decisions.setWordDecision("  ", "known")).rejects.toThrow(
      "non-empty normalized word",
    );
  });
});

describe("ReviewSession", () => {
  it("ignores a stale decision continuation after invalidate()", async () => {
    const env = setup();
    env.state.dataset = {
      id: "d1",
      name: "d1",
      sourceType: "file",
      sourceName: "d1.csv",
      headers: [],
      entryCount: 1,
      createdAt: "",
      updatedAt: "",
      schemaVersion: 1,
    };
    const queue = new MiningQueueService(env.core);
    const coverage = new CoverageService(env.core);
    const decisions = new DecisionService(env.core, queue, coverage);
    const review = new ReviewSession(env.core, decisions);

    env.core.state.review = {
      ...EMPTY_REVIEW,
      active: true,
      status: "ready",
      remaining: 1,
      current: withKnown(entry("a", "ねこ")),
    };

    let resolveGate: (() => void) | null = null;
    env.worker.queryGate = new Promise((resolve) => {
      resolveGate = resolve;
    });
    const inFlight = review.reviewDecision("known");
    await Promise.resolve();
    // Session ends while the decision write is in flight.
    review.invalidate();
    env.core.state.review = { ...EMPTY_REVIEW };
    resolveGate!();
    await inFlight;

    // The stale continuation must not resurrect the review state.
    expect(env.core.state.review).toEqual(EMPTY_REVIEW);
    expect(env.core.state.review.active).toBe(false);
  });

  it("start refuses without a dataset and stop resets review state", async () => {
    const env = setup();
    const queue = new MiningQueueService(env.core);
    const review = new ReviewSession(
      env.core,
      new DecisionService(env.core, queue, new CoverageService(env.core)),
    );
    await review.start();
    expect(env.core.state.review.active).toBe(false);

    env.core.state.review = { ...EMPTY_REVIEW, active: true, status: "ready" };
    review.stop();
    expect(env.core.state.review).toEqual(EMPTY_REVIEW);
  });
});

describe("BackupService", () => {
  it("rejects oversized backups without mutating user state", async () => {
    const env = setup();
    const queue = new MiningQueueService(env.core);
    const coverage = new CoverageService(env.core);
    const decisions = new DecisionService(env.core, queue, coverage);
    const review = new ReviewSession(env.core, decisions);
    const backup = new BackupService(env.core, review, coverage, decisions, queue, {
      restoreFromBackup: () => {},
    });

    env.state.wordDecisions.set("ねこ", {
      normalizedWord: "ねこ",
      status: "mined",
      updatedAt: "t",
    });

    await expect(backup.restoreBackup("x".repeat(MAX_BACKUP_BYTES + 1))).rejects.toThrow(
      "Backup is too large",
    );
    expect(env.state.wordDecisions.size).toBe(1);
    expect(env.state.errorMessage).toContain("Backup could not be restored");
  });

  it("rejects malformed backups and reports via errorMessage", async () => {
    const env = setup();
    const queue = new MiningQueueService(env.core);
    const coverage = new CoverageService(env.core);
    const decisions = new DecisionService(env.core, queue, coverage);
    const review = new ReviewSession(env.core, decisions);
    const backup = new BackupService(env.core, review, coverage, decisions, queue, {
      restoreFromBackup: () => {},
    });

    await expect(backup.restoreBackup("not-json")).rejects.toThrow();
    expect(env.state.errorMessage).toContain("Backup could not be restored");
  });

  it("exports through the user-state lock and resets the freshness counter", async () => {
    const env = setup();
    const queue = new MiningQueueService(env.core);
    const coverage = new CoverageService(env.core);
    const decisions = new DecisionService(env.core, queue, coverage);
    const review = new ReviewSession(env.core, decisions);
    const backup = new BackupService(env.core, review, coverage, decisions, queue, {
      restoreFromBackup: () => {},
    });

    env.state.changesSinceExport = 5;
    const json = await backup.exportBackup();

    expect(JSON.parse(json).version).toBe(2);
    expect(JSON.parse(json).ankiSync).toEqual({ config: null, snapshot: null });
    expect(env.state.changesSinceExport).toBe(0);
    expect(env.state.lastExportAt).toBe("2026-09-08T00:00:00.000Z");
  });
});
