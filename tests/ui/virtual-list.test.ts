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
