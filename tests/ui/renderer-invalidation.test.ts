// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { getDomMap } from "../../src/ui/dom";
import type { DomMap } from "../../src/ui/dom";
import { createRenderer, renderEntryNode } from "../../src/ui/renderer";
import { createVirtualList } from "../../src/ui/virtual-list";
import { createInitialAppState } from "../../src/app/state";
import { DEFAULT_VIEW } from "../../src/app/state";
import type { AppState } from "../../src/app/state";
import type { EntryWithKnown, QueryResult } from "../../src/domain/types";

function seedDom(): DomMap {
  const add = (id: string, tag: string): HTMLElement => {
    const existing = document.getElementById(id);
    if (existing !== null) existing.remove();
    const element = document.createElement(tag);
    element.id = id;
    document.body.appendChild(element);
    return element;
  };

  add("jitenInput", "input").setAttribute("type", "file");
  add("knownInput", "input").setAttribute("type", "file");
  add("jitenDropzone", "div");
  add("knownDropzone", "div");
  add("jitenStatus", "div");
  add("knownStatus", "div");
  const importSummary = add("importSummary", "div");
  for (const className of ["import-dataset-line", "import-known-line"]) {
    const line = document.createElement("span");
    line.className = className;
    importSummary.appendChild(line);
  }
  const changeFiles = add("changeFiles", "button");
  changeFiles.setAttribute("aria-expanded", "false");
  changeFiles.setAttribute("aria-controls", "importGrid");
  add("importGrid", "div");
  add("clearData", "button");
  add("exportBackup", "button");
  add("restoreBackup", "button");
  add("restoreBackupInput", "input").setAttribute("type", "file");
  add("backupStatus", "span");
  add("errorBox", "div");
  const advancedToggle = add("advancedToggle", "button");
  advancedToggle.setAttribute("aria-expanded", "false");
  advancedToggle.setAttribute("aria-controls", "advancedPanel");
  const advancedPanel = add("advancedPanel", "div");
  advancedPanel.hidden = true;
  add("stickySearch", "input").setAttribute("type", "search");
  for (const id of ["hideKnown", "hideKanaOnly", "showFurigana", "pillHighlight", "showHighlight", "showDefinitions"]) {
    add(id, "input").setAttribute("type", "checkbox");
  }
  add("minOccurrences", "input").setAttribute("type", "number");

  const withOptions = (id: string, options: Array<[string, string]>): HTMLSelectElement => {
    const select = add(id, "select") as HTMLSelectElement;
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    return select;
  };

  withOptions("sentenceFilter", [["any", "any"], ["has", "has"], ["none", "none"]]);
  withOptions("sortSelect", [["occ-desc", "occ-desc"], ["occ-asc", "occ-asc"], ["original", "original"]]);
  withOptions("pageSize", [["25", "25"], ["50", "50"], ["100", "100"], ["all", "all"]]);
  withOptions("decisionFilter", [["all", "All decisions"]]);

  add("results", "section");
  add("resultsHeading", "h2");
  add("resultStats", "p");
  add("resultsList", "div");
  add("reviewButton", "button");
  const reviewOverlay = add("reviewOverlay", "div");
  reviewOverlay.setAttribute("role", "dialog");
  const reviewPanel = add("reviewPanel", "div");
  reviewPanel.setAttribute("tabindex", "-1");
  reviewOverlay.appendChild(reviewPanel);
  for (const id of ["reviewHeading", "reviewProgress", "reviewContent", "reviewComplete", "reviewReturn", "reviewExit", "reviewKnown", "reviewMined", "reviewSkip", "reviewLater"]) {
    const element = add(id, "div");
    reviewPanel.appendChild(element);
  }
  add("queueToggle", "button");
  add("queueHeader", "div");
  add("queueHeading", "h2");
  add("queueStats", "p");
  add("exitQueue", "button");
  add("clearQueue", "button");
  add("stickyToolbar", "div");
  add("stickyTitle", "div");
  add("stickyPrev", "button");
  add("stickyNext", "button");
  add("stickyPage", "span");
  add("bottomPrev", "button");
  add("bottomNext", "button");
  add("bottomPage", "span");

  const coveragePanel = add("coveragePanel", "section");
  const coverageToggle = add("coverageToggle", "button");
  const coverageLabel = document.createElement("span");
  coverageLabel.textContent = "Tracked vocabulary coverage:";
  const coverageSummary = add("coverageSummary", "span");
  coverageToggle.append(coverageLabel, coverageSummary);
  coveragePanel.appendChild(coverageToggle);
  const coverageBody = add("coverageBody", "div");
  coverageBody.hidden = true;
  coveragePanel.appendChild(coverageBody);
  for (const id of ["coverageUniqueWords", "coverageKnownOccurrences", "coveragePercent", "coverageTargets"]) {
    coverageBody.appendChild(add(id, "div"));
  }
  const coverageError = add("coverageError", "p");
  coverageError.hidden = true;
  coverageBody.appendChild(coverageError);
  coverageBody.appendChild(add("coverageFocus", "button"));

  return getDomMap();
}

function dataset(id: string): NonNullable<AppState["dataset"]> {
  return {
    id, name: "book.csv", sourceType: "file", sourceName: "book.csv",
    headers: ["Word"], entryCount: 3, createdAt: "x", updatedAt: "x", schemaVersion: 1,
  };
}

interface TestEntrySpec {
  id: string;
  word: string;
  sentence: string;
}

function entry(spec: TestEntrySpec, index: number): EntryWithKnown {
  return {
    id: spec.id,
    originalIndex: index,
    word: spec.word,
    normalizedWord: spec.word,
    occurrences: 1,
    sentenceRaw: spec.sentence,
    hasSentence: true,
    definitions: "",
    furiganaRuns: [],
    known: false,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed",
  };
}

function pagedResult(specs: TestEntrySpec[]): QueryResult {
  return {
    items: specs.map((spec, index) => entry(spec, index)),
    page: 1,
    totalPages: 1,
    totalEntries: specs.length,
    startIndex: 1,
    endIndex: specs.length,
    pageSize: 50,
    knownCount: 0,
    windowed: false,
  };
}

function windowedResult(specs: TestEntrySpec[]): QueryResult {
  return {
    items: specs.map((spec, index) => entry(spec, index)),
    page: 1,
    totalPages: 1,
    totalEntries: specs.length,
    startIndex: 1,
    endIndex: specs.length,
    pageSize: "all",
    knownCount: 0,
    windowed: true,
  };
}

function freshResult(result: QueryResult): QueryResult {
  return {
    ...result,
    items: result.items.map((item) => ({ ...item })),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderer render-skip invalidation (audit phase 6, task 5 fixes)", () => {
  it("clears mounted virtual-list DOM when a windowed render is followed by an identical paged signature", () => {
    const dom = seedDom();
    const renderer = createRenderer(dom);
    const specs: TestEntrySpec[] = [
      { id: "e0", word: "言葉", sentence: "古い文A。" },
      { id: "e1", word: "犬", sentence: "古い文B。" },
    ];
    const paged = pagedResult(specs);

    // Paged render mounts entry rows.
    renderer.render({ ...createInitialAppState("memory"), dataset: dataset("d1"), status: "ready", result: paged });
    expect(dom.resultsList.querySelectorAll(".mining-entry")).toHaveLength(2);

    // Windowed result: renderer must not touch the list; main.ts mounts the
    // virtual list into resultsList (spacers + container), as in production.
    renderer.render({ ...createInitialAppState("memory"), dataset: dataset("d1"), status: "ready", result: windowedResult(specs) });
    const virtualList = createVirtualList(
      dom.resultsList,
      (item, index) => renderEntryNode(item, index + 1, DEFAULT_VIEW, {}),
    );
    virtualList.setTotal(specs.length);
    virtualList.setWindow(0, windowedResult(specs).items);
    expect(dom.resultsList.querySelectorAll(".vl-spacer-top, .vl-container, .vl-spacer-bottom")).toHaveLength(3);

    // Back to paged with the SAME pre-windowed signature (fresh result clone,
    // identical content). The skip cache must not short-circuit: stale
    // vl-spacer/vl-container DOM would otherwise persist in paged mode.
    renderer.render({ ...createInitialAppState("memory"), dataset: dataset("d1"), status: "ready", result: freshResult(paged) });

    expect(dom.resultsList.querySelectorAll(".vl-spacer-top, .vl-spacer-bottom, .vl-container, .vl-spacer")).toHaveLength(0);
    expect(dom.resultsList.querySelectorAll(".mining-entry")).toHaveLength(2);
    virtualList.destroy();
  });

  it("rebuilds rows when a same-shape dataset re-import changes entry text", () => {
    const dom = seedDom();
    const renderer = createRenderer(dom);

    const shapeA: TestEntrySpec[] = [
      { id: "e0", word: "言葉", sentence: "Aさんの古い文。" },
      { id: "e1", word: "犬", sentence: "Bさんの古い文。" },
    ];
    renderer.render({
      ...createInitialAppState("memory"),
      dataset: dataset("d1"),
      status: "ready",
      result: pagedResult(shapeA),
    });
    expect(dom.resultsList.textContent).toContain("Aさんの古い文。");

    // Re-import: dataset id changes, ids/counts/shape identical, entry text
    // edited. Signature must invalidate so dataset B's text reaches the DOM.
    const shapeB: TestEntrySpec[] = [
      { id: "e0", word: "言葉", sentence: "Aさんの新しい文。" },
      { id: "e1", word: "犬", sentence: "Bさんの新しい文。" },
    ];
    renderer.render({
      ...createInitialAppState("memory"),
      dataset: dataset("d2"),
      status: "ready",
      result: pagedResult(shapeB),
    });

    expect(dom.resultsList.textContent).toContain("Aさんの新しい文。");
    expect(dom.resultsList.textContent).not.toContain("Aさんの古い文。");
  });

  it("rebuilds rows when entry words change with an identical dataset id and shape", () => {
    const dom = seedDom();
    const renderer = createRenderer(dom);

    const wordsA: TestEntrySpec[] = [{ id: "e0", word: "言葉", sentence: "同じ文。" }];
    renderer.render({
      ...createInitialAppState("memory"),
      dataset: dataset("d1"),
      status: "ready",
      result: pagedResult(wordsA),
    });
    expect(dom.resultsList.textContent).toContain("言葉");

    // Same ids/counts, different word text: per-item word participates in
    // the signature so the target word column cannot go stale.
    const wordsB: TestEntrySpec[] = [{ id: "e0", word: "機械", sentence: "同じ文。" }];
    renderer.render({
      ...createInitialAppState("memory"),
      dataset: dataset("d1"),
      status: "ready",
      result: pagedResult(wordsB),
    });

    expect(dom.resultsList.textContent).toContain("機械");
    expect(dom.resultsList.textContent).not.toContain("言葉");
  });
});
