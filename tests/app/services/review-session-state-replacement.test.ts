import { describe, expect, it } from "vitest";
import type { ControllerCore } from "../../../src/app/services/context";
import { CoverageService } from "../../../src/app/services/coverage-service";
import { DecisionService } from "../../../src/app/services/decision-service";
import { MiningQueueService } from "../../../src/app/services/mining-queue-service";
import { ReviewSession } from "../../../src/app/services/review-session";
import { createInitialAppState, EMPTY_REVIEW } from "../../../src/app/state";
import type {
  WorkerAnkiPreviewInput,
  WorkerClient,
  WorkerCoverageInput,
  WorkerQueryInput,
} from "../../../src/app/worker-client";
import type { Entry, QueryResult } from "../../../src/domain/types";

function item(word: string): QueryResult["items"][number] {
  return {
    id: word,
    originalIndex: 0,
    word,
    normalizedWord: word,
    occurrences: 1,
    sentenceRaw: "",
    hasSentence: false,
    definitions: "",
    furiganaRuns: [],
    known: false,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed",
  };
}

function result(word: string): QueryResult {
  return {
    items: [item(word)],
    page: 1,
    totalPages: 1,
    totalEntries: 1,
    startIndex: 1,
    endIndex: 1,
    pageSize: 1,
    knownCount: 0,
    windowed: false,
  };
}

class DeferredWorker implements WorkerClient {
  resolveQuery: ((value: QueryResult) => void) | null = null;

  async importJiten(name: string) {
    return {
      protocolVersion: 3 as const,
      type: "import-complete" as const,
      requestId: "jiten",
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
      requestId: "known",
      kind: "known" as const,
      name,
      wordCount: 0,
    };
  }

  async loadDataset(_datasetId: string, _chunks: AsyncIterable<readonly Entry[]>): Promise<void> {}

  query(_request: WorkerQueryInput): Promise<QueryResult> {
    return new Promise((resolve) => {
      this.resolveQuery = resolve;
    });
  }

  async coverage(_request: WorkerCoverageInput) {
    return {
      totalUniqueWords: 0,
      knownUniqueWords: 0,
      unknownUniqueWords: 0,
      totalTrackedOccurrences: 0,
      knownTrackedOccurrences: 0,
      unknownTrackedOccurrences: 0,
      coveragePercent: 0,
      targets: [],
    };
  }

  async previewAnkiMatch(_request: WorkerAnkiPreviewInput) {
    return { matchedWords: 0, knownCount: 0, minedCount: 0, manualProtected: 0 };
  }

  dispose(): void {}
}

describe("ReviewSession state replacement", () => {
  it("applies an in-flight review query to the current AppState object", async () => {
    const worker = new DeferredWorker();
    let state = createInitialAppState("memory");
    state.dataset = {
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

    let queryGeneration = 0;
    let userStateEpoch = 0;
    const core: ControllerCore = {
      worker,
      sessionQueue: { save: () => {}, load: () => null, clear: () => {} },
      now: () => "2026-09-08T00:00:00.000Z",
      createId: (kind) => `${kind}-id`,
      get state() {
        return state;
      },
      publish: () => {},
      setState: (patch) => Object.assign(state, patch),
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
          knownWords: { getActive: async () => null, save: async () => {}, remove: async () => {} },
          wordDecisions: {
            get: async () => null,
            list: async () => [],
            set: async () => {},
            remove: async () => {},
            replaceAll: async () => {},
          },
          preferences: { load: async () => null, save: async () => {}, clear: async () => {} },
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
      runQuery: async () => {},
      loadAndQuery: async () => {},
      decisionTuples: () => [],
      ankiStatusTuples: () => [],
      countChangeSinceExport: () => {},
    };

    const queue = new MiningQueueService(core);
    const decisions = new DecisionService(core, queue, new CoverageService(core));
    const review = new ReviewSession(core, decisions);

    const start = review.start();
    await Promise.resolve();
    expect(worker.resolveQuery).not.toBeNull();

    const replacement = createInitialAppState("memory");
    replacement.dataset = state.dataset;
    replacement.review = { ...EMPTY_REVIEW, active: true, status: "loading" };
    state = replacement;

    worker.resolveQuery!(result("ねこ"));
    await start;

    expect(core.state).toBe(replacement);
    expect(core.state.review.status).toBe("ready");
    expect(core.state.review.current?.normalizedWord).toBe("ねこ");
    expect(core.state.review.remaining).toBe(1);
  });
});
