// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createInitialAppState } from "../../src/miner/state";
import type { DatasetMetadata } from "../../src/storage/contracts";
import { getDomMap } from "../../src/ui/dom";
import { createRenderer } from "../../src/ui/renderer";
import { renderMinerShell } from "../support/shell";

function dataset(id: string, name: string, entryCount: number): DatasetMetadata {
  return {
    id,
    name,
    sourceType: "file",
    sourceName: name,
    headers: ["Word"],
    entryCount,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    schemaVersion: 1,
  };
}

describe("dataset library", () => {
  beforeEach(() => {
    document.body.innerHTML = renderMinerShell();
  });

  it("renders saved datasets with an active marker and open buttons", () => {
    const dom = getDomMap();
    const renderer = createRenderer(dom);
    const state = createInitialAppState("memory");
    const first = dataset("first", "anime.csv", 1200);
    const second = dataset("second", "novel.csv", 42);
    state.dataset = first;
    state.datasetLibrary = [first, second];
    state.status = "ready";

    renderer.render(state);

    const items = dom.libraryList.querySelectorAll<HTMLElement>(".library-item");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("anime");
    expect(items[0]?.textContent).toContain("1,200 entries");
    const buttons = dom.libraryList.querySelectorAll<HTMLButtonElement>(".library-open");
    expect(buttons[0]?.textContent).toBe("Active");
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[0]?.getAttribute("aria-current")).toBe("true");
    expect(buttons[1]?.textContent).toBe("Open");
    expect(buttons[1]?.dataset.libraryDatasetId).toBe("second");
  });

  it("shows an empty state before any CSV has been imported", () => {
    const dom = getDomMap();
    const renderer = createRenderer(dom);
    const state = createInitialAppState("memory");

    renderer.render(state);

    expect(dom.libraryEmpty.hidden).toBe(false);
    expect(dom.libraryEmpty.textContent).toContain("saved CSVs");
  });
});
