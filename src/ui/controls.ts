import type { QueryState, ViewState, WordDecisionStatus } from "../domain/types";
import type { AppState, FileSource, MinerController } from "../app/state";
import { createFileSource } from "../platform/file-source";
import type { DomMap } from "./dom";

export interface ControlsOptions {
  confirmClear?: (message: string) => boolean;
  onSearch?: (value: string) => void;
}

export interface ControlBindings {
  dispose(): void;
}

class EventRecorder {
  private readonly entries: Array<[HTMLElement | Document | Window, string, EventListener]> = [];

  add(target: HTMLElement | Document | Window, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.entries.push([target, type, listener]);
  }

  dispose(): void {
    for (const [target, type, listener] of this.entries) target.removeEventListener(type, listener);
    this.entries.length = 0;
  }
}

function parseMinOccurrences(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parsePageSize(value: string): Partial<QueryState> {
  return { pageSize: value === "all" ? "all" : Number(value) };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
}

export function bindControls(
  dom: DomMap,
  controller: MinerController,
  options: ControlsOptions = {},
): ControlBindings {
  const recorder = new EventRecorder();
  const confirmClear = options.confirmClear ?? ((message: string) => globalThis.confirm(message));
  const onSearch = options.onSearch;
  let latest: Readonly<AppState> | null = null;
  let reviewWasActive = false;
  const unsubscribe = controller.subscribe((state) => {
    if (reviewWasActive && !state.review.active) dom.reviewButton.focus();
    else if (!reviewWasActive && state.review.active) dom.reviewPanel.focus();
    reviewWasActive = state.review.active;
    latest = state;
  });

  const importJiten = (file: Pick<File, "name" | "text">): void => {
    void controller.importJiten(createFileSource(file as File));
  };
  const importKnown = (file: Pick<File, "name" | "text">): void => {
    void controller.importKnown(createFileSource(file as File));
  };

  const bindDropzone = (
    dropzone: HTMLElement,
    input: HTMLInputElement,
    loader: (file: Pick<File, "name" | "text">) => void,
  ): void => {
    recorder.add(dropzone, "dragover", (event) => {
      event.preventDefault();
      dropzone.dataset.dragging = "true";
    });
    recorder.add(dropzone, "dragleave", () => {
      delete dropzone.dataset.dragging;
    });
    recorder.add(dropzone, "drop", (event) => {
      event.preventDefault();
      delete dropzone.dataset.dragging;
      const dragEvent = event as DragEvent;
      const file = dragEvent.dataTransfer?.files[0];
      if (file) loader(file);
      input.value = "";
    });
    recorder.add(dropzone, "keydown", (event) => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === "Enter" || keyboard.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
    recorder.add(input, "change", () => {
      const file = input.files?.[0];
      if (file) loader(file);
      input.value = "";
    });
  };

  const bindSearch = (input: HTMLInputElement): void => {
    recorder.add(input, "input", () => {
      if (onSearch !== undefined) onSearch(input.value);
      else controller.updateQuery({ search: input.value });
    });
  };

  const bindQueryCheckbox = (
    input: HTMLInputElement,
    patch: (checked: boolean) => Partial<QueryState>,
  ): void => {
    recorder.add(input, "change", () => controller.updateQuery(patch(input.checked)));
  };

  const bindViewCheckbox = (
    input: HTMLInputElement,
    patch: (checked: boolean) => Partial<ViewState>,
  ): void => {
    recorder.add(input, "change", () => controller.updateView(patch(input.checked)));
  };

  const bindSelect = <T extends HTMLSelectElement>(
    select: T,
    patch: (value: string) => Partial<QueryState>,
  ): void => {
    recorder.add(select, "change", () => controller.updateQuery(patch(select.value)));
  };

  const bindMinOccurrences = (input: HTMLInputElement): void => {
    recorder.add(input, "input", () => {
      controller.updateQuery({ minOccurrences: parseMinOccurrences(input.value) });
    });
  };

  const bindPagerButton = (button: HTMLButtonElement, delta: number): void => {
    recorder.add(button, "click", () => {
      controller.changePage(delta);
      dom.resultsHeading.scrollIntoView({ block: "start" });
    });
  };

  bindDropzone(dom.jitenDropzone, dom.jitenInput, importJiten);
  bindDropzone(dom.knownDropzone, dom.knownInput, importKnown);

  bindSearch(dom.searchInput);
  bindSearch(dom.stickySearch);

  bindQueryCheckbox(dom.hideKnown, (checked) => ({ hideKnown: checked }));
  bindQueryCheckbox(dom.stickyHideKnown, (checked) => ({ hideKnown: checked }));
  bindQueryCheckbox(dom.hideKanaOnly, (checked) => ({ hideKanaOnly: checked }));
  bindQueryCheckbox(dom.stickyHideKana, (checked) => ({ hideKanaOnly: checked }));

  bindSelect(dom.sortSelect, (value) => ({ sort: value as QueryState["sort"] }));
  bindSelect(dom.stickySort, (value) => ({ sort: value as QueryState["sort"] }));
  bindSelect(dom.sentenceFilter, (value) => ({ sentence: value as QueryState["sentence"] }));
  bindSelect(dom.stickySentence, (value) => ({ sentence: value as QueryState["sentence"] }));
  bindSelect(dom.decisionFilter, (value) => ({ decision: value as QueryState["decision"] }));
  bindSelect(dom.stickyDecision, (value) => ({ decision: value as QueryState["decision"] }));
  bindSelect(dom.pageSize, parsePageSize);
  bindSelect(dom.stickyPageSize, parsePageSize);

  bindMinOccurrences(dom.minOccurrences);
  bindMinOccurrences(dom.stickyMin);

  bindViewCheckbox(dom.showFurigana, (checked) => ({ showFurigana: checked }));
  bindViewCheckbox(dom.stickyFurigana, (checked) => ({ showFurigana: checked }));
  bindViewCheckbox(dom.pillHighlight, (checked) => ({ pillHighlight: checked }));
  bindViewCheckbox(dom.stickyPill, (checked) => ({ pillHighlight: checked }));
  bindViewCheckbox(dom.showHighlight, (checked) => ({ showHighlight: checked }));
  bindViewCheckbox(dom.stickyHl, (checked) => ({ showHighlight: checked }));
  bindViewCheckbox(dom.showDefinitions, (checked) => ({ showDefinitions: checked }));
  bindViewCheckbox(dom.stickyDefs, (checked) => ({ showDefinitions: checked }));

  bindPagerButton(dom.topPrev, -1);
  bindPagerButton(dom.bottomPrev, -1);
  bindPagerButton(dom.stickyPrev, -1);
  bindPagerButton(dom.topNext, 1);
  bindPagerButton(dom.bottomNext, 1);
  bindPagerButton(dom.stickyNext, 1);

  recorder.add(dom.resultsList, "click", (event) => {
    const target = event.target;
    if (target === null || !(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-decision-action]");
    if (button === null || button.disabled) return;
    const word = button.dataset.word ?? "";
    const action = button.dataset.decisionAction;
    if (action !== "known" && action !== "mined" && action !== "skip" && action !== "later" && action !== "unreviewed") return;
    void controller.setWordDecision(word, action satisfies WordDecisionStatus | "unreviewed");
  });

  recorder.add(dom.clearData, "click", () => {
    if (confirmClear("Clear all saved data from this browser? Imported datasets, known words, and preferences will be removed.")) {
      void controller.clearSavedData();
    }
  });

  const REVIEW_ACTION_KEYS: Record<string, WordDecisionStatus> = {
    k: "known",
    m: "mined",
    s: "skip",
    l: "later",
  };

  const submitReviewDecision = (status: WordDecisionStatus): void => {
    if (latest === null || latest.review.status !== "ready") return;
    void controller.reviewDecision(status);
  };

  recorder.add(dom.reviewButton, "click", () => {
    void controller.startReview();
  });
  recorder.add(dom.reviewExit, "click", () => controller.stopReview());
  recorder.add(dom.reviewReturn, "click", () => controller.stopReview());
  for (const [button, status] of [
    [dom.reviewKnown, "known"],
    [dom.reviewMined, "mined"],
    [dom.reviewSkip, "skip"],
    [dom.reviewLater, "later"],
  ] as const) {
    recorder.add(button, "click", () => submitReviewDecision(status));
  }

  const handleKeydown = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    if (latest === null || keyboard.defaultPrevented) return;
    if (keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey || keyboard.shiftKey) return;
    if (isTypingTarget(keyboard.target)) return;

    if (latest.review.active) {
      const action = REVIEW_ACTION_KEYS[keyboard.key.toLowerCase()];
      if (action !== undefined) {
        keyboard.preventDefault();
        submitReviewDecision(action);
      } else if (keyboard.key === "Escape") {
        keyboard.preventDefault();
        controller.stopReview();
      }
      return;
    }

    if (latest.dataset === null) return;
    if (keyboard.key === "ArrowRight" || keyboard.key === "n") {
      keyboard.preventDefault();
      controller.changePage(1);
      dom.resultsHeading.scrollIntoView({ block: "start" });
    } else if (keyboard.key === "ArrowLeft" || keyboard.key === "p") {
      keyboard.preventDefault();
      controller.changePage(-1);
      dom.resultsHeading.scrollIntoView({ block: "start" });
    } else if (keyboard.key === "Home") {
      keyboard.preventDefault();
      dom.resultsHeading.scrollIntoView({ block: "start" });
    } else if (keyboard.key === "End") {
      keyboard.preventDefault();
      dom.bottomPage.scrollIntoView({ block: "end" });
    }
  };
  recorder.add(document, "keydown", handleKeydown);

  return {
    dispose(): void {
      recorder.dispose();
      unsubscribe();
    },
  };
}
