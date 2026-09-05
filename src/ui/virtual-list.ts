import type { EntryWithKnown } from "../domain/types";

export interface VirtualList {
  setTotal(total: number): void;
  setWindow(start: number, items: readonly EntryWithKnown[]): void;
  destroy(): void;
}

export interface VirtualListOptions {
  onRequestWindow?: (start: number) => void;
  overscan?: number;
  minRowHeight?: number;
  maxNodes?: number;
}

interface ScrollTarget {
  addEventListener(type: "scroll", listener: () => void, options?: { passive?: boolean }): void;
  removeEventListener(type: "scroll", listener: () => void): void;
}

export function createVirtualList(
  root: HTMLElement,
  renderItem: (entry: EntryWithKnown, index: number) => HTMLElement,
  options: VirtualListOptions = {},
): VirtualList {
  const overscan = options.overscan ?? 10;
  const minRowHeight = options.minRowHeight ?? 96;
  const maxNodes = options.maxNodes ?? 120;
  const scrollTarget: ScrollTarget = typeof window === "object" && window !== null
    ? window as unknown as ScrollTarget
    : { addEventListener: () => undefined, removeEventListener: () => undefined };

  let total = 0;
  let currentStart = -1;
  let rowHeight = minRowHeight;
  let disposed = false;

  const spacerHeight = (rows: number): string => `${Math.max(0, rows) * rowHeight}px`;

  const handleScroll = (): void => {
    if (disposed || total === 0 || currentStart < 0) return;
    const rect = root.getBoundingClientRect();
    const visibleTop = Math.max(0, -rect.top);
    const desired = Math.max(0, Math.floor(visibleTop / rowHeight) - overscan);
    if (desired !== currentStart) options.onRequestWindow?.(desired);
  };

  scrollTarget.addEventListener("scroll", handleScroll, { passive: true });

  return {
    setTotal(nextTotal: number): void {
      if (disposed) return;
      total = Math.max(0, Math.trunc(nextTotal));
    },

    setWindow(start: number, items: readonly EntryWithKnown[]): void {
      if (disposed) return;
      const safeStart = Math.max(0, Math.trunc(start));
      const mounted = items.slice(0, maxNodes);
      if (mounted.length === 0) {
        if (total > 0) root.textContent = "";
        currentStart = total === 0 ? -1 : safeStart;
        return;
      }
      currentStart = safeStart;

      const spacerTop = document.createElement("div");
      spacerTop.className = "vl-spacer-top";
      spacerTop.style.height = spacerHeight(safeStart);

      const container = document.createElement("div");
      container.className = "vl-container";
      const fragment = document.createDocumentFragment();
      mounted.forEach((entry, offset) => fragment.appendChild(renderItem(entry, safeStart + offset)));
      container.appendChild(fragment);

      const spacerBottom = document.createElement("div");
      spacerBottom.className = "vl-spacer-bottom";
      spacerBottom.style.height = spacerHeight(total - safeStart - mounted.length);

      root.textContent = "";
      root.append(spacerTop, container, spacerBottom);

      let measured = 0;
      for (const child of [...container.children]) {
        const height = (child as HTMLElement).getBoundingClientRect().height;
        if (Number.isFinite(height) && height > 0) measured += height;
      }
      if (measured > 0) {
        const average = measured / container.children.length;
        if (average > rowHeight) {
          rowHeight = average;
          spacerTop.style.height = spacerHeight(safeStart);
          spacerBottom.style.height = spacerHeight(total - safeStart - mounted.length);
        }
      }
    },

    destroy(): void {
      if (disposed) return;
      disposed = true;
      scrollTarget.removeEventListener("scroll", handleScroll);
      root.textContent = "";
      total = 0;
      currentStart = -1;
    },
  };
}
