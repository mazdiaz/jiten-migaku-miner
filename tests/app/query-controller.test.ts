import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryController, type QueryController } from "../../src/app/query-controller";
import type { VirtualList } from "../../src/ui/virtual-list";
import type { MinerController } from "../../src/app/state";
import type { AppState } from "../../src/app/state";

class FakeMinerController implements Pick<MinerController, "updateQuery" | "updateViewport"> {
  readonly queries: Array<Record<string, unknown>> = [];
  readonly viewports: number[] = [];

  updateQuery(patch: Record<string, unknown>): void {
    this.queries.push(patch);
  }

  updateViewport(start: number): void {
    this.viewports.push(start);
  }
}

class RecordingVirtualList implements Pick<VirtualList, "setTotal" | "setWindow"> {
  readonly totals: number[] = [];
  readonly windows: Array<{ start: number; items: number }> = [];

  setTotal(total: number): void {
    this.totals.push(total);
  }

  setWindow(start: number, items: readonly unknown[]): void {
    this.windows.push({ start, items: items.length });
  }
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    dataset: null,
    knownWords: new Set<string>(),
    knownWordsName: null,
    wordDecisions: new Map(),
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
    view: { showFurigana: false, pillHighlight: false, showHighlight: false, showDefinitions: true },
    page: 1,
    result: null,
    status: "empty",
    errorMessage: null,
    persistence: "memory",
    review: {
      active: false,
      initialTotal: 0,
      processed: 0,
      remaining: 0,
      current: null,
      status: "idle",
      errorMessage: null,
    },
    ...overrides,
  };
}

describe("query controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces search input and forwards only the latest value", () => {
    const miner = new FakeMinerController();
    const controller: QueryController = createQueryController({
      controller: miner as unknown as MinerController,
    });

    controller.search("気");
    controller.search("気に");
    expect(miner.queries).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(miner.queries).toEqual([{ search: "気に" }]);
    controller.dispose();
  });

  it("keeps a later search pending when an earlier one is superseded", () => {
    const miner = new FakeMinerController();
    const controller: QueryController = createQueryController({
      controller: miner as unknown as MinerController,
    });

    controller.search("一つ");
    vi.advanceTimersByTime(100);
    controller.search("二つ");
    vi.advanceTimersByTime(50);
    expect(miner.queries).toEqual([{ search: "一つ" }]);

    vi.advanceTimersByTime(50);
    expect(miner.queries).toEqual([{ search: "一つ" }, { search: "二つ" }]);
    controller.dispose();
  });

  it("forwards viewport start changes immediately", () => {
    const miner = new FakeMinerController();
    const controller: QueryController = createQueryController({
      controller: miner as unknown as MinerController,
    });

    controller.setViewportStart(4_200);
    controller.setViewportStart(8_600);

    expect(miner.viewports).toEqual([4_200, 8_600]);
    controller.dispose();
  });

  it("applies windowed results to the virtual list", () => {
    const miner = new FakeMinerController();
    const list = new RecordingVirtualList();
    const controller: QueryController = createQueryController({
      controller: miner as unknown as MinerController,
      virtualList: list as unknown as VirtualList,
    });

    controller.applyResult({
      items: [],
      page: 1,
      totalPages: 1,
      totalEntries: 100_000,
      startIndex: 4_001,
      endIndex: 4_100,
      pageSize: "all",
      knownCount: 0,
      windowed: true,
    });

    expect(list.totals).toEqual([100_000]);
    expect(list.windows).toEqual([{ start: 4_000, items: 0 }]);
    controller.dispose();
  });

  it("ignores non-windowed results for the virtual list", () => {
    const list = new RecordingVirtualList();
    const controller: QueryController = createQueryController({
      controller: new FakeMinerController() as unknown as MinerController,
      virtualList: list as unknown as VirtualList,
    });

    controller.applyResult({
      items: [],
      page: 1,
      totalPages: 1,
      totalEntries: 0,
      startIndex: 0,
      endIndex: 0,
      pageSize: 50,
      knownCount: 0,
      windowed: false,
    });

    expect(list.totals).toHaveLength(0);
    controller.dispose();
  });

  it("cancel pending search on dispose", () => {
    const miner = new FakeMinerController();
    const controller: QueryController = createQueryController({
      controller: miner as unknown as MinerController,
    });

    controller.search("保留");
    controller.dispose();
    vi.advanceTimersByTime(500);

    expect(miner.queries).toHaveLength(0);
  });
});
