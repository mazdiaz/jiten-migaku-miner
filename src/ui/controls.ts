import { canonicalWord } from "../domain/text";
import type { QueryState, ViewState, WordDecisionStatus } from "../domain/types";
import type { AppState, FileSource, MinerController } from "../app/state";
import { createFileSource } from "../platform/file-source";
import type { DomMap } from "./dom";

export interface ControlsOptions {
  confirmClear?: (message: string) => boolean;
  confirmQueueClear?: (message: string) => boolean;
  confirmRestore?: (message: string) => boolean;
  downloadBackup?: (filename: string, contents: string) => void;
  onSearch?: (value: string) => void;
  onToggleImports?: () => void;
  onToggleAdvanced?: () => void;
}

export const RESTORE_CONFIRM_MESSAGE = [
  "Restore this backup?",
  "",
  "This will replace your current Migaku-known list, word decisions, and preferences.",
  "Your imported Jiten dataset will not be deleted.",
].join("\n");

function defaultDownloadBackup(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
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

interface PendingFocus {
  word: string;
  action: string;
  after: string[];
}

const normalizeWord = (value: string): string => value.trim().toLocaleLowerCase();

export function bindControls(
  dom: DomMap,
  controller: MinerController,
  options: ControlsOptions = {},
): ControlBindings {
  const recorder = new EventRecorder();
  const confirmClear = options.confirmClear ?? ((message: string) => globalThis.confirm(message));
  const confirmQueueClear = options.confirmQueueClear ?? ((message: string) => globalThis.confirm(message));
  const onSearch = options.onSearch;
  const onToggleImports = options.onToggleImports;
  const onToggleAdvanced = options.onToggleAdvanced;
  let latest: Readonly<AppState> | null = null;
  let reviewWasActive = false;
  let pendingFocus: PendingFocus | null = null;
  let focusIntent: PendingFocus | null = null;

  const captureFollowingWords = (clicked: HTMLButtonElement): string[] => {
    const article = clicked.closest("article");
    if (article === null) return [];
    const following: string[] = [];
    let sibling = article.nextElementSibling;
    while (sibling !== null) {
      if (sibling instanceof HTMLElement) {
        const word = sibling.querySelector<HTMLButtonElement>("button[data-word]")?.dataset.word;
        if (word !== undefined && word !== "") following.push(word);
      }
      sibling = sibling.nextElementSibling;
    }
    return following;
  };

  // Focus restoration tiers after a results-list action rerenders the list:
  // (a) same word still rendered -> its same-action button (queue toggles map
  //     to action "queue" -> [data-queue-action="toggle"]); data-word keeps the
  //     entry's raw case while queue words are lowercase, so compare normalized.
  // (a') same word entry, same-action button disabled (Reset after reset) ->
  //     the entry's first enabled decision button.
  // (b) row removed -> first decision button of the next still-rendered entry.
  // (c) nothing left to focus -> the results heading.
  // A decision action rerenders the list twice (decision publish, then the
  // async query result); the second rebuild destroys the node the first pass
  // focused, so the applied intent is remembered and re-applied on later
  // renders while focus has fallen back to <body>.
  const applyPendingFocus = (): void => {
    const focusLost = document.activeElement === document.body || document.activeElement === null;
    const pending = pendingFocus ?? (focusLost ? focusIntent : null);
    if (pending === null) return;
    if (pendingFocus !== null) {
      focusIntent = pending;
      pendingFocus = null;
    }
    const wanted = normalizeWord(pending.word);
    const buttons = dom.resultsList.querySelectorAll<HTMLButtonElement>("button[data-word]");
    const matchesWord = (button: HTMLButtonElement): boolean =>
      normalizeWord(button.dataset.word ?? "") === wanted;

    for (const button of buttons) {
      if (!matchesWord(button)) continue;
      const sameAction = pending.action === "queue"
        ? button.dataset.queueAction === "toggle"
        : button.dataset.decisionAction === pending.action;
      if (sameAction && !button.disabled) {
        button.focus();
        return;
      }
    }
    for (const button of buttons) {
      if (matchesWord(button) && button.dataset.decisionAction !== undefined && !button.disabled) {
        button.focus();
        return;
      }
    }
    const afterWords = new Set(pending.after.map(normalizeWord));
    if (afterWords.size > 0) {
      for (const article of dom.resultsList.querySelectorAll("article")) {
        const button = article.querySelector<HTMLButtonElement>("button[data-decision-action]");
        if (button !== null && !button.disabled && afterWords.has(normalizeWord(button.dataset.word ?? ""))) {
          button.focus();
          return;
        }
      }
    }
    dom.resultsHeading.focus();
  };

  const unsubscribe = controller.subscribe((state) => {
    if (reviewWasActive && !state.review.active) dom.reviewButton.focus();
    else if (!reviewWasActive && state.review.active) dom.reviewPanel.focus();
    reviewWasActive = state.review.active;
    latest = state;
    if (!state.review.active) applyPendingFocus();
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

  // Moving focus to the results heading after a page change gives keyboard
  // users a stable anchor just above the refreshed list. scroll-margin-top on
  // the heading clears the sticky toolbar; focus uses preventScroll so it does
  // not fight the scroll-margin-aware scrollIntoView.
  const focusResultsHeading = (): void => {
    dom.resultsHeading.scrollIntoView({ block: "start" });
    dom.resultsHeading.focus({ preventScroll: true });
  };

  const bindPagerButton = (button: HTMLButtonElement, delta: number): void => {
    recorder.add(button, "click", () => {
      controller.changePage(delta);
      focusResultsHeading();
    });
  };

  bindDropzone(dom.jitenDropzone, dom.jitenInput, importJiten);
  bindDropzone(dom.knownDropzone, dom.knownInput, importKnown);

  recorder.add(dom.changeFiles, "click", () => {
    onToggleImports?.();
  });

  recorder.add(dom.advancedToggle, "click", () => {
    onToggleAdvanced?.();
  });

  bindSearch(dom.stickySearch);

  bindQueryCheckbox(dom.hideKnown, (checked) => ({ hideKnown: checked }));
  bindQueryCheckbox(dom.hideKanaOnly, (checked) => ({ hideKanaOnly: checked }));

  bindSelect(dom.sortSelect, (value) => ({ sort: value as QueryState["sort"] }));
  bindSelect(dom.sentenceFilter, (value) => ({ sentence: value as QueryState["sentence"] }));
  bindSelect(dom.decisionFilter, (value) => ({ decision: value as QueryState["decision"] }));
  bindSelect(dom.pageSize, parsePageSize);

  bindMinOccurrences(dom.minOccurrences);

  bindViewCheckbox(dom.showFurigana, (checked) => ({ showFurigana: checked }));
  bindViewCheckbox(dom.pillHighlight, (checked) => ({ pillHighlight: checked }));
  bindViewCheckbox(dom.showHighlight, (checked) => ({ showHighlight: checked }));
  bindViewCheckbox(dom.showDefinitions, (checked) => ({ showDefinitions: checked }));

  bindPagerButton(dom.bottomPrev, -1);
  bindPagerButton(dom.stickyPrev, -1);
  bindPagerButton(dom.bottomNext, 1);
  bindPagerButton(dom.stickyNext, 1);

  recorder.add(dom.queueToggle, "click", () => {
    if (latest?.queue.mode === "queue") controller.stopQueueMode();
    else void controller.startQueueMode();
  });
  recorder.add(dom.exitQueue, "click", () => controller.stopQueueMode());
  recorder.add(dom.clearQueue, "click", () => {
    const count = latest?.queue.normalizedWords.length ?? 0;
    if (count === 0) return;
    if (confirmQueueClear(`Clear all ${count} words from this mining queue?`)) {
      controller.clearQueue();
    }
  });

  recorder.add(dom.resultsList, "click", (event) => {
    const target = event.target;
    if (target === null || !(target instanceof Element)) return;
    const queueButton = target.closest<HTMLButtonElement>("[data-queue-action]");
    if (queueButton !== null && !queueButton.disabled) {
      const word = queueButton.dataset.word ?? "";
      pendingFocus = { word, action: "queue", after: captureFollowingWords(queueButton) };
      if (queueButton.dataset.queueAction === "remove") {
        controller.removeQueued(word);
      } else if (latest?.queue.normalizedWords.includes(canonicalWord(word)) === true) {
        controller.removeQueued(word);
      } else {
        controller.toggleQueued(word);
      }
      return;
    }

    const button = target.closest<HTMLButtonElement>("[data-decision-action]");
    if (button === null || button.disabled) return;
    const word = button.dataset.word ?? "";
    const action = button.dataset.decisionAction;
    if (action !== "known" && action !== "mined" && action !== "skip" && action !== "later" && action !== "unreviewed") return;
    pendingFocus = { word, action, after: captureFollowingWords(button) };
    void controller.setWordDecision(word, action satisfies WordDecisionStatus | "unreviewed");
  });

  recorder.add(dom.clearData, "click", () => {
    if (confirmClear("Clear all saved data from this browser? Imported datasets, known words, and preferences will be removed.")) {
      void controller.clearSavedData();
    }
  });

  const confirmRestore = options.confirmRestore ?? ((message: string) => globalThis.confirm(message));
  const downloadBackup = options.downloadBackup ?? defaultDownloadBackup;

  recorder.add(dom.exportBackup, "click", () => {
    void (async () => {
      try {
        const json = await controller.exportBackup();
        const date = new Date().toISOString().slice(0, 10);
        downloadBackup(`jiten-migaku-miner-backup-${date}.json`, json);
        dom.backupStatus.textContent = "Backup exported.";
      } catch (error) {
        dom.backupStatus.textContent = `Backup could not be exported: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  });

  recorder.add(dom.restoreBackup, "click", () => {
    dom.restoreBackupInput.click();
  });

  recorder.add(dom.restoreBackupInput, "change", () => {
    const file = dom.restoreBackupInput.files?.[0] ?? null;
    dom.restoreBackupInput.value = "";
    if (file === null) return;
    void (async () => {
      try {
        const text = await file.text();
        if (!confirmRestore(RESTORE_CONFIRM_MESSAGE)) {
          dom.backupStatus.textContent = "Restore cancelled.";
          return;
        }
        await controller.restoreBackup(text);
        if (latest === null || latest.errorMessage !== null) return;
        dom.backupStatus.textContent =
          `Backup restored: ${latest.knownWords.size.toLocaleString()} Migaku-known words · ${latest.wordDecisions.size.toLocaleString()} decisions.`;
      } catch {
        dom.backupStatus.textContent = "";
      }
    })();
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

  const reviewFocusables = (): HTMLElement[] => {
    const nodes = dom.reviewPanel.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]",
    );
    const isRendered = (node: HTMLElement): boolean => {
      let current: HTMLElement | null = node;
      while (current !== null && current !== document.body) {
        if (current.hidden) return false;
        current = current.parentElement;
      }
      return true;
    };
    return [...nodes].filter((node) =>
      isRendered(node)
      && node.getAttribute("tabindex") !== "-1"
      && !(node instanceof HTMLButtonElement && node.disabled)
      && !(node instanceof HTMLInputElement && node.disabled)
      && !(node instanceof HTMLSelectElement && node.disabled)
      && !(node instanceof HTMLTextAreaElement && node.disabled),
    );
  };

  // Focus trap for the review overlay: Tab/Shift+Tab wrap within the panel's
  // focusables instead of escaping into the inert background shell. Runs before
  // the modifier guard so Shift+Tab (shiftKey=true) is still trapped.
  const trapReviewTab = (keyboard: KeyboardEvent): void => {
    const focusables = reviewFocusables();
    if (focusables.length === 0) {
      keyboard.preventDefault();
      return;
    }
    const active = document.activeElement;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) return;
    const inCycle = active instanceof HTMLElement && focusables.includes(active);
    const wrapsBackward = !inCycle || active === first;
    const wrapsForward = !inCycle || active === last;
    if (keyboard.shiftKey && wrapsBackward) {
      keyboard.preventDefault();
      last.focus();
    } else if (!keyboard.shiftKey && wrapsForward) {
      keyboard.preventDefault();
      first.focus();
    }
  };

  const handleKeydown = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    if (latest === null || keyboard.defaultPrevented) return;
    if (latest.review.active && keyboard.key === "Tab") {
      trapReviewTab(keyboard);
      return;
    }
    if (keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey || keyboard.shiftKey) return;
    if (
      isTypingTarget(keyboard.target)
      || (keyboard.target instanceof Element && keyboard.target.closest("#stickyToolbar") !== null)
    ) return;

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

    if (latest.queue.mode === "queue") {
      // Queue Mode has no paging; ignore list shortcuts until exited.
      return;
    }

    if (latest.dataset === null) return;
    if (keyboard.key === "ArrowRight" || keyboard.key === "n") {
      keyboard.preventDefault();
      controller.changePage(1);
      focusResultsHeading();
    } else if (keyboard.key === "ArrowLeft" || keyboard.key === "p") {
      keyboard.preventDefault();
      controller.changePage(-1);
      focusResultsHeading();
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
