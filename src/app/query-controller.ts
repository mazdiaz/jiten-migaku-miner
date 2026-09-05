import type { QueryResult } from "../domain/types";
import type { MinerController } from "./state";
import type { VirtualList } from "../ui/virtual-list";

export interface QueryControllerOptions {
  controller: MinerController;
  virtualList?: VirtualList;
  debounceMs?: number;
}

export interface QueryController {
  search(value: string): void;
  setViewportStart(start: number): void;
  applyResult(result: QueryResult | null): void;
  dispose(): void;
}

export function createQueryController(options: QueryControllerOptions): QueryController {
  const debounceMs = options.debounceMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingSearch: string | null = null;

  return {
    search(value: string): void {
      pendingSearch = value;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const latest = pendingSearch;
        pendingSearch = null;
        if (latest !== null) options.controller.updateQuery({ search: latest });
      }, debounceMs);
    },

    setViewportStart(start: number): void {
      options.controller.updateViewport(start);
    },

    applyResult(result: QueryResult | null): void {
      const virtualList = options.virtualList;
      if (virtualList === undefined || result === null || !result.windowed) return;
      virtualList.setTotal(result.totalEntries);
      virtualList.setWindow(Math.max(0, result.startIndex - 1), result.items);
    },

    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingSearch = null;
    },
  };
}
