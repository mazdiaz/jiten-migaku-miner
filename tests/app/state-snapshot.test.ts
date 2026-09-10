import { describe, expect, it } from "vitest";
import { createMinerController, type MinerControllerOptions } from "../../src/app/controller";
import type { AppState, FileSource } from "../../src/app/state";
import { createInitialAppState, snapshotAppState } from "../../src/app/state";
import type {
  WorkerClient,
  WorkerCoverageInput,
  WorkerQueryInput,
} from "../../src/app/worker-client";
import type { CoverageStats, Entry, QueryResult } from "../../src/domain/types";
import type { AppStore, DatasetMetadata } from "../../src/storage/contracts";
import { createMemoryAppStore } from "../../src/storage/memory-store";
import type { ImportCompleteResponse } from "../../src/worker/protocol";

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
    furiganaRuns: [{ text: word, reading: "かん" }],
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

function metadata(id: string, name = id): DatasetMetadata {
  return {
    id,
    name,
    sourceType: "file",
    sourceName: `${name}.csv`,
    headers: ["Word"],
    entryCount: 1,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    schemaVersion: 1,
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
    knownCount: items.filter((item) => item.known).length,
    windowed: false,
  };
}

class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeWorkerClient implements WorkerClient {
  queryHandler: ((request: WorkerQueryInput) => Promise<QueryResult>) | null = null;
  coverageHandler: ((request: WorkerCoverageInput) => Promise<CoverageStats>) | null = null;

  async importJiten(name: string): Promise<Extract<ImportCompleteResponse, { kind: "jiten" }>> {
    return {
      protocolVersion: 2,
      type: "import-complete",
      requestId: "import",
      kind: "jiten",
      name,
      headers: ["Word"],
      entryCount: 1,
      skippedRows: 0,
    };
  }

  async importKnown(name: string): Promise<Extract<ImportCompleteResponse, { kind: "known" }>> {
    return {
      protocolVersion: 2,
      type: "import-complete",
      requestId: "known",
      kind: "known",
      name,
      wordCount: 0,
    };
  }

  async loadDataset(_datasetId: string, chunks: AsyncIterable<readonly Entry[]>): Promise<void> {
    for await (const chunk of chunks) void chunk;
  }

  async query(request: WorkerQueryInput): Promise<QueryResult> {
    if (this.queryHandler !== null) return this.queryHandler(request);
    return result();
  }

  async coverage(request: WorkerCoverageInput): Promise<CoverageStats> {
    if (this.coverageHandler !== null) return this.coverageHandler(request);
    return {
      totalUniqueWords: 1,
      knownUniqueWords: 0,
      unknownUniqueWords: 1,
      totalTrackedOccurrences: 3,
      knownTrackedOccurrences: 0,
      unknownTrackedOccurrences: 3,
      coveragePercent: 0,
      targets: [
        {
          targetPercent: 98,
          reached: false,
          additionalWords: 1,
          additionalTrackedOccurrences: 3,
        },
      ],
    };
  }

  dispose(): void {}
}

function _fileSource(name = "book.csv"): FileSource {
  return { name, text: async () => "Word,Occurences\n語,3,1\n" };
}

interface Setup {
  store: AppStore;
  worker: FakeWorkerClient;
  options(): MinerControllerOptions;
}

async function setup(activeDatasetId: string | null = "dataset-1"): Promise<Setup> {
  const store = createMemoryAppStore();
  if (activeDatasetId !== null) {
    await store.datasets.stage(
      metadata(activeDatasetId),
      (async function* () {
        yield [entry("one", "語")];
      })(),
    );
    await store.datasets.activate(activeDatasetId);
  }
  const worker = new FakeWorkerClient();
  return {
    store,
    worker,
    options: () => ({
      store,
      worker,
      legacyStorage: new FakeStorage(),
    }),
  };
}

function capture(controller: ReturnType<typeof createMinerController>): Readonly<AppState> {
  let captured: Readonly<AppState> | null = null;
  const unsubscribe = controller.subscribe((state) => {
    captured = state;
  });
  unsubscribe();
  if (captured === null) throw new Error("controller did not publish state");
  return captured;
}

describe("snapshotAppState structural isolation", () => {
  it("clones lightweight Anki state without exposing a full status map", () => {
    const state = createInitialAppState("memory");
    state.anki = {
      ...state.anki,
      configured: true,
      wordCount: 2,
      knownCount: 1,
      minedCount: 1,
    };
    state.ankiPreview = {
      scannedCards: 2,
      uniqueWords: 2,
      matchedWords: 2,
      knownCount: 1,
      minedCount: 1,
      manualProtected: 0,
      emptyTargetFields: 0,
      queueRemovals: 0,
      zeroCards: false,
      datasetAvailable: true,
    };

    const snapshot = snapshotAppState(state);

    snapshot.anki.wordCount = 99;
    snapshot.ankiPreview!.matchedWords = 99;
    expect(state.anki.wordCount).toBe(2);
    expect(state.ankiPreview?.matchedWords).toBe(2);
    expect((snapshot as { ankiStatuses?: unknown }).ankiStatuses).toBeUndefined();
  });

  it("clones decision objects so subscriber mutation cannot alter the source", () => {
    const state = createInitialAppState("memory");
    state.wordDecisions.set("ねこ", {
      normalizedWord: "ねこ",
      status: "mined",
      updatedAt: "t1",
    });
    const snapshot = snapshotAppState(state);

    const decision = snapshot.wordDecisions.get("ねこ");
    expect(decision).toBeDefined();
    decision!.status = "known";

    expect(state.wordDecisions.get("ねこ")?.status).toBe("mined");
  });

  it("clones result items and nested furigana runs", () => {
    const state = createInitialAppState("memory");
    state.result = result([withKnown(entry("a", "語"))]);
    const snapshot = snapshotAppState(state);

    const item = snapshot.result!.items[0]!;
    item.occurrences = 999;
    item.furiganaRuns[0]!.reading = "changed";

    expect(state.result?.items[0]?.occurrences).toBe(3);
    expect(state.result?.items[0]?.furiganaRuns[0]?.reading).toBe("かん");
  });

  it("clones review.current deeply", () => {
    const state = createInitialAppState("memory");
    state.review = {
      ...state.review,
      active: true,
      current: withKnown(entry("a", "語")),
    };
    const snapshot = snapshotAppState(state);

    snapshot.review.current!.furiganaRuns[0]!.text = "changed";
    snapshot.review.current!.word = "changed";

    expect(state.review.current?.furiganaRuns[0]?.text).toBe("語");
    expect(state.review.current?.word).toBe("語");
  });

  it("clones coverage targets deeply", () => {
    const state = createInitialAppState("memory");
    state.coverage = {
      totalUniqueWords: 1,
      knownUniqueWords: 0,
      unknownUniqueWords: 1,
      totalTrackedOccurrences: 3,
      knownTrackedOccurrences: 0,
      unknownTrackedOccurrences: 3,
      coveragePercent: 0,
      targets: [
        {
          targetPercent: 98,
          reached: false,
          additionalWords: 1,
          additionalTrackedOccurrences: 3,
        },
      ],
    };
    const snapshot = snapshotAppState(state);

    snapshot.coverage!.targets[0]!.reached = true;
    snapshot.coverage!.targets[0]!.additionalWords = 42;

    expect(state.coverage?.targets[0]?.reached).toBe(false);
    expect(state.coverage?.targets[0]?.additionalWords).toBe(1);
  });

  it("clones queue words, dataset headers, and known words", () => {
    const state = createInitialAppState("memory");
    state.queue = { datasetId: "d1", normalizedWords: ["a"], mode: "normal" };
    state.dataset = metadata("d1");
    state.knownWords = new Set(["a"]);
    const snapshot = snapshotAppState(state);

    snapshot.queue.normalizedWords.push("b");
    snapshot.dataset?.headers.push("Extra");
    snapshot.knownWords.add("c");

    expect(state.queue.normalizedWords).toEqual(["a"]);
    expect(state.dataset?.headers).toEqual(["Word"]);
    expect(state.knownWords.has("c")).toBe(false);
  });
});

describe("controller snapshot isolation", () => {
  it("keeps controller decisions intact when a subscriber mutates a snapshot decision", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    await controller.init();
    await controller.setWordDecision("ねこ", "mined");

    const snapshot = capture(controller);
    const decision = snapshot.wordDecisions.get("ねこ");
    expect(decision?.status).toBe("mined");
    decision!.status = "skip";
    decision!.normalizedWord = "mutated";

    const fresh = capture(controller);
    expect(fresh.wordDecisions.get("ねこ")?.status).toBe("mined");
    expect(fresh.wordDecisions.has("mutated")).toBe(false);
  });

  it("keeps controller result items intact when a subscriber mutates a snapshot item", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    env.worker.queryHandler = async () => result([withKnown(entry("a", "語"))]);
    await controller.init();

    const snapshot = capture(controller);
    const item = snapshot.result!.items[0]!;
    item.decision = "known";
    item.furiganaRuns[0]!.reading = "mutated";

    controller.updateView({});
    const fresh = capture(controller);
    expect(fresh.result?.items[0]?.decision).toBe("unreviewed");
    expect(fresh.result?.items[0]?.furiganaRuns[0]?.reading).toBe("かん");
  });

  it("keeps review current intact when a subscriber mutates a snapshot review card", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    env.worker.queryHandler = async () => result([withKnown(entry("a", "語"))]);
    await controller.init();
    await controller.startReview();

    const snapshot = capture(controller);
    snapshot.review.current!.word = "mutated";
    snapshot.review.current!.furiganaRuns[0]!.text = "mutated";

    const fresh = capture(controller);
    expect(fresh.review.current?.word).toBe("語");
    expect(fresh.review.current?.furiganaRuns[0]?.text).toBe("語");
  });

  it("keeps coverage stats intact when a subscriber mutates a snapshot target", async () => {
    const env = await setup();
    const controller = createMinerController(env.options());
    env.worker.coverageHandler = async () => ({
      totalUniqueWords: 1,
      knownUniqueWords: 0,
      unknownUniqueWords: 1,
      totalTrackedOccurrences: 3,
      knownTrackedOccurrences: 0,
      unknownTrackedOccurrences: 3,
      coveragePercent: 0,
      targets: [
        {
          targetPercent: 98,
          reached: false,
          additionalWords: 1,
          additionalTrackedOccurrences: 3,
        },
      ],
    });
    await controller.init();

    const snapshot = capture(controller);
    snapshot.coverage!.targets[0]!.reached = true;
    snapshot.coverage!.targets[0]!.additionalWords = 42;

    const fresh = capture(controller);
    expect(fresh.coverage?.targets[0]?.reached).toBe(false);
    expect(fresh.coverage?.targets[0]?.additionalWords).toBe(1);
  });
});
