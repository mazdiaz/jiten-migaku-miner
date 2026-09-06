// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createVirtualList } from "../../src/ui/virtual-list";
import type { EntryWithKnown } from "../../src/domain/types";

function entry(index: number): EntryWithKnown {
  return {
    id: `entry-${index}`,
    originalIndex: index,
    word: `語${index}`,
    normalizedWord: `語${index}`,
    occurrences: index,
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

function entries(count: number, from = 0): EntryWithKnown[] {
  return Array.from({ length: count }, (_, offset) => entry(from + offset));
}

function itemNode(entryValue: EntryWithKnown, index: number): HTMLElement {
  const node = document.createElement("div");
  node.className = "vl-item";
  node.dataset.index = String(index);
  node.textContent = `#${index} ${entryValue.word}`;
  node.style.height = "96px";
  return node;
}

function spacerHeights(root: HTMLElement): { top: number; bottom: number } {
  const top = root.querySelector(":scope > .vl-spacer-top") as HTMLElement | null;
  const bottom = root.querySelector(":scope > .vl-spacer-bottom") as HTMLElement | null;
  return {
    top: top === null ? -1 : Number(top.style.height.replace("px", "")),
    bottom: bottom === null ? -1 : Number(bottom.style.height.replace("px", "")),
  };
}

describe("virtual list", () => {
  it("mounts a bounded window with spacers for a 100,000-row total", () => {
    const root = document.createElement("div");
    const list = createVirtualList(root, itemNode);

    list.setTotal(100_000);
    list.setWindow(0, entries(100));

    expect(root.querySelectorAll(".vl-item")).toHaveLength(100);
    expect(root.querySelectorAll<HTMLElement>(".vl-item")[0]?.dataset.index).toBe("0");
    expect(root.querySelectorAll<HTMLElement>(".vl-item")[99]?.dataset.index).toBe("99");
    const heights = spacerHeights(root);
    expect(heights.top).toBe(0);
    expect(heights.bottom).toBe((100_000 - 100) * 96);
    list.destroy();
  });

  it("caps mounted nodes at the configured maximum", () => {
    const root = document.createElement("div");
    const list = createVirtualList(root, itemNode);

    list.setTotal(1_000);
    list.setWindow(0, entries(150));

    expect(root.querySelectorAll(".vl-item").length).toBeLessThanOrEqual(120);
    list.destroy();
  });

  it("replaces the mounted window without stale entries and keeps logical numbering", () => {
    const root = document.createElement("div");
    const list = createVirtualList(root, itemNode);

    list.setTotal(10_000);
    list.setWindow(0, entries(100));
    list.setWindow(5_000, entries(100));

    const mounted = [...root.querySelectorAll<HTMLElement>(".vl-item")];
    expect(mounted).toHaveLength(100);
    expect(mounted[0]?.dataset.index).toBe("5000");
    expect(mounted.every((node) => Number(node.dataset.index) >= 5_000)).toBe(true);
    const heights = spacerHeights(root);
    expect(heights.top).toBe(5_000 * 96);
    expect(heights.bottom).toBe((10_000 - 5_100) * 96);
    list.destroy();
  });

  it("requests a new window start when scrolling moves the viewport", () => {
    const root = document.createElement("div");
    const requested: number[] = [];
    const list = createVirtualList(root, itemNode, {
      onRequestWindow: (start) => requested.push(start),
    });
    list.setTotal(100_000);
    list.setWindow(0, entries(100));

    root.getBoundingClientRect = () => ({
      top: -(2_000 * 96),
      bottom: 0,
      left: 0,
      right: 0,
      height: 100_000 * 96,
      width: 800,
      x: 0,
      y: -(2_000 * 96),
      toJSON: () => ({}),
    } as DOMRect);
    window.dispatchEvent(new Event("scroll"));

    expect(requested).toHaveLength(1);
    expect(requested[0]).toBe(2_000 - 10);
    list.destroy();
  });

  it("does not re-request the current window start", () => {
    const root = document.createElement("div");
    const requested: number[] = [];
    const list = createVirtualList(root, itemNode, {
      onRequestWindow: (start) => requested.push(start),
    });
    list.setTotal(100_000);
    list.setWindow(0, entries(100));

    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));

    expect(requested).toHaveLength(0);
    list.destroy();
  });

  it("destroy removes the scroll listener and clears the root", () => {
    const root = document.createElement("div");
    const requested: number[] = [];
    const list = createVirtualList(root, itemNode, {
      onRequestWindow: (start) => requested.push(start),
    });
    list.setTotal(100_000);
    list.setWindow(0, entries(100));
    list.destroy();

    root.getBoundingClientRect = () => ({
      top: -(5_000 * 96),
      bottom: 0,
      left: 0,
      right: 0,
      height: 100_000 * 96,
      width: 800,
      x: 0,
      y: -(5_000 * 96),
      toJSON: () => ({}),
    } as DOMRect);
    window.dispatchEvent(new Event("scroll"));

    expect(requested).toHaveLength(0);
    expect(root.children).toHaveLength(0);
  });

  it("measures the average row height from mounted items", () => {
    const root = document.createElement("div");
    const list = createVirtualList(root, (entryValue, index) => {
      const node = itemNode(entryValue, index);
      node.style.height = "120px";
      node.getBoundingClientRect = () => ({ height: 120 } as DOMRect);
      return node;
    });

    list.setTotal(10_000);
    list.setWindow(0, entries(100));

    expect(spacerHeights(root).bottom).toBe((10_000 - 100) * 120);
    list.destroy();
  });
});

describe("virtual list scroll anchoring", () => {
  interface ScrollStub {
    calls: Array<[number, number]>;
  }

  function stubWindowScroll(initialY: number): ScrollStub {
    const calls: Array<[number, number]> = [];
    Object.defineProperty(window, "scrollY", {
      value: initialY,
      configurable: true,
      writable: true,
    });
    window.scrollTo = ((x: number, y: number) => {
      calls.push([x, y]);
      Object.defineProperty(window, "scrollY", {
        value: y,
        configurable: true,
        writable: true,
      });
    }) as typeof window.scrollTo;
    return { calls };
  }

  function measuredItems(height: number) {
    return (entryValue: EntryWithKnown, index: number): HTMLElement => {
      const node = itemNode(entryValue, index);
      node.getBoundingClientRect = () => ({ height } as DOMRect);
      return node;
    };
  }

  it("compensates scroll when the estimate grows at a deep start", () => {
    const root = document.createElement("div");
    const requested: number[] = [];
    const { calls } = stubWindowScroll(5_000 * 96);
    const list = createVirtualList(root, measuredItems(200), {
      onRequestWindow: (start) => requested.push(start),
    });

    list.setTotal(100_000);
    list.setWindow(5_000, entries(100));

    expect(spacerHeights(root).top).toBe(5_000 * 200);
    expect(calls).toEqual([[0, 5_000 * 200]]);
    expect(window.scrollY).toBe(5_000 * 200);
    expect(requested).toEqual([]);
    list.destroy();
  });

  it("compensates scroll when the estimate shrinks at a deep start", () => {
    const root = document.createElement("div");
    const requested: number[] = [];
    const { calls } = stubWindowScroll(5_000 * 96);
    const list = createVirtualList(root, measuredItems(40), {
      onRequestWindow: (start) => requested.push(start),
    });

    list.setTotal(100_000);
    list.setWindow(5_000, entries(100));

    expect(spacerHeights(root).top).toBe(5_000 * 40);
    expect(calls).toEqual([[0, 5_000 * 40]]);
    expect(window.scrollY).toBe(5_000 * 40);
    expect(requested).toEqual([]);
    list.destroy();
  });

  it("keeps the estimate when measured average is within 5% hysteresis", () => {
    const root = document.createElement("div");
    const requested: number[] = [];
    const { calls } = stubWindowScroll(5_000 * 96);
    const list = createVirtualList(root, measuredItems(100), {
      onRequestWindow: (start) => requested.push(start),
    });

    list.setTotal(100_000);
    list.setWindow(5_000, entries(100));

    expect(spacerHeights(root).top).toBe(5_000 * 96);
    expect(calls).toEqual([]);
    expect(window.scrollY).toBe(5_000 * 96);
    expect(requested).toEqual([]);
    list.destroy();
  });
});

describe("virtual list viewport resize", () => {
  function viewportRect(top: number, height: number): DOMRect {
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 0,
      height,
      width: 800,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  // GUARD test (audit phase 6 "resize" box): the scroll handler derives the
  // desired window start from the content offset (rect.top) only, so a taller
  // viewport at an unchanged offset must not churn onRequestWindow or grow the
  // mounted set. The invariant already holds in the offset-based math; this
  // pins it against regressions (e.g. a rewrite that folds rect.height into
  // the desired-start computation).
  it("keeps the window start and node cap when the viewport grows at the same content offset", () => {
    const root = document.createElement("div");
    const requested: number[] = [];
    const list = createVirtualList(root, itemNode, {
      onRequestWindow: (start) => requested.push(start),
    });

    list.setTotal(100_000);
    list.setWindow(5_000, entries(100));
    const mountedBefore = root.querySelectorAll(".vl-item").length;

    // Pre-resize baseline: 800px viewport whose content offset keeps the
    // desired start exactly at the mounted window start (5_000).
    root.getBoundingClientRect = () => viewportRect(-(5_010 * 96), 800);
    window.dispatchEvent(new Event("scroll"));
    expect(requested).toEqual([]);

    // Resize: viewport doubles in height at the identical content offset.
    root.getBoundingClientRect = () => viewportRect(-(5_010 * 96), 1_600);
    window.dispatchEvent(new Event("scroll"));

    expect(requested).toEqual([]);
    const mounted = root.querySelectorAll(".vl-item");
    expect(mounted.length).toBe(mountedBefore);
    expect(mounted.length).toBeLessThanOrEqual(120);
    list.destroy();
  });
});
