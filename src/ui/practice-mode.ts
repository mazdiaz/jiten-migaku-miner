import type { AppState, MinerController } from "../app/state";
import type { EntryWithKnown } from "../domain/types";
import { renderReviewEntryNode } from "./views/entry-view";

export function shuffleIndexes(length: number, random: () => number = Math.random): number[] {
  const size = Math.max(0, Math.trunc(length));
  const order = Array.from({ length: size }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const draw = Math.min(Math.max(random(), 0), 0.9999999999999999);
    const swapIndex = Math.floor(draw * (index + 1));
    [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  }
  return order;
}

export interface PracticeMode {
  isActive(): boolean;
  sync(state: Readonly<AppState>): void;
}

interface PracticeModeOptions {
  controller: MinerController;
  resultsList: HTMLElement;
  random?: () => number;
  onContentChanged?: () => void;
  onExit?: (state: Readonly<AppState>) => void;
}

interface PracticeElements {
  button: HTMLButtonElement;
  overlay: HTMLElement;
  panel: HTMLElement;
  progress: HTMLElement;
  exit: HTMLButtonElement;
  content: HTMLElement;
  complete: HTMLElement;
  returnButton: HTMLButtonElement;
  actions: HTMLElement;
  reveal: HTMLButtonElement;
}

function createPracticeElements(resultsList: HTMLElement): PracticeElements {
  const document = resultsList.ownerDocument;
  const reviewButton = document.getElementById("reviewButton");
  if (!(reviewButton instanceof HTMLButtonElement)) {
    throw new Error("Practice mode requires #reviewButton.");
  }

  const button = document.createElement("button");
  button.id = "practiceButton";
  button.type = "button";
  button.className = "review-button practice-button";
  button.textContent = "Practice";
  button.disabled = true;
  reviewButton.after(button);

  const overlay = document.createElement("div");
  overlay.id = "practiceOverlay";
  overlay.className = "review-overlay practice-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "practiceHeading");
  overlay.hidden = true;

  const panel = document.createElement("div");
  panel.id = "practicePanel";
  panel.className = "review-panel practice-panel";
  panel.tabIndex = -1;

  const header = document.createElement("div");
  header.className = "review-header";
  const heading = document.createElement("h2");
  heading.id = "practiceHeading";
  heading.textContent = "Practice";
  const progress = document.createElement("span");
  progress.id = "practiceProgress";
  progress.className = "review-progress";
  progress.setAttribute("aria-live", "polite");
  const exit = document.createElement("button");
  exit.id = "practiceExit";
  exit.type = "button";
  exit.className = "review-exit";
  exit.textContent = "Exit practice";
  header.append(heading, progress, exit);

  const content = document.createElement("div");
  content.id = "practiceContent";
  content.className = "review-content practice-content";

  const complete = document.createElement("div");
  complete.id = "practiceComplete";
  complete.className = "review-complete";
  complete.hidden = true;
  const completeText = document.createElement("p");
  completeText.textContent = "Practice complete. You saw every word in this shuffled session.";
  const returnButton = document.createElement("button");
  returnButton.id = "practiceReturn";
  returnButton.type = "button";
  returnButton.className = "review-action";
  returnButton.textContent = "Return to list";
  complete.append(completeText, returnButton);

  const actions = document.createElement("div");
  actions.className = "review-actions practice-actions";
  const reveal = document.createElement("button");
  reveal.id = "practiceReveal";
  reveal.type = "button";
  reveal.className = "review-action practice-reveal";
  reveal.textContent = "Reveal";
  actions.appendChild(reveal);

  const shortcutNote = document.createElement("p");
  shortcutNote.className = "review-shortcut-note";
  shortcutNote.textContent = "Space reveal / next · → next after reveal · Esc exit.";

  panel.append(header, content, complete, actions, shortcutNote);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  return {
    button,
    overlay,
    panel,
    progress,
    exit,
    content,
    complete,
    returnButton,
    actions,
    reveal,
  };
}

function entryAtAbsoluteIndex(
  state: Readonly<AppState>,
  absoluteIndex: number,
): EntryWithKnown | null {
  const result = state.result;
  if (result === null || result.items.length === 0 || result.startIndex <= 0) return null;
  const offset = absoluteIndex - (result.startIndex - 1);
  return offset >= 0 && offset < result.items.length ? (result.items[offset] ?? null) : null;
}

export function createPracticeMode(options: PracticeModeOptions): PracticeMode {
  const { controller, resultsList } = options;
  const random = options.random ?? Math.random;
  const elements = createPracticeElements(resultsList);
  const document = resultsList.ownerDocument;
  const resultsHome = resultsList.parentNode;
  const resultsHomeNextSibling = resultsList.nextSibling;

  let latest: Readonly<AppState> | null = null;
  let active = false;
  let revealed = false;
  let order: number[] = [];
  let cursor = 0;
  let sessionDatasetId: string | null = null;
  let originalPage = 1;
  let originalWindowStart = 0;
  let renderedAbsoluteIndex: number | null = null;

  const setBackgroundInert = (value: boolean): void => {
    document.querySelector("main.app-shell")?.toggleAttribute("inert", value);
    document.body.classList.toggle("practice-open", value);
  };

  const updateStartButton = (state: Readonly<AppState>): void => {
    elements.button.disabled =
      active ||
      state.review.active ||
      state.queue.mode === "queue" ||
      state.dataset === null ||
      state.status !== "ready" ||
      state.result === null ||
      state.result.totalEntries === 0;
  };

  const showComplete = (): void => {
    elements.content.hidden = true;
    elements.complete.hidden = false;
    elements.actions.hidden = true;
    elements.progress.textContent = `${order.length} / ${order.length}`;
    elements.returnButton.focus();
  };

  const renderCard = (
    state: Readonly<AppState>,
    entry: EntryWithKnown,
    absoluteIndex: number,
  ): void => {
    if (
      renderedAbsoluteIndex === absoluteIndex &&
      resultsList.querySelector(".practice-entry") !== null
    ) {
      return;
    }
    const practiceView = { ...state.view, showDefinitions: true, showFurigana: true };
    const card = renderReviewEntryNode(entry, practiceView);
    card.classList.add("practice-entry", "practice-concealed");
    resultsList.textContent = "";
    resultsList.appendChild(card);
    renderedAbsoluteIndex = absoluteIndex;
    revealed = false;
    elements.content.hidden = false;
    elements.complete.hidden = true;
    elements.actions.hidden = false;
    elements.reveal.disabled = false;
    elements.reveal.textContent = "Reveal";
    options.onContentChanged?.();
  };

  const requestCurrentCard = (state: Readonly<AppState>): void => {
    if (!active) return;
    if (cursor >= order.length) {
      showComplete();
      return;
    }

    const absoluteIndex = order[cursor];
    if (absoluteIndex === undefined) {
      showComplete();
      return;
    }
    elements.progress.textContent = `${cursor + 1} / ${order.length}`;

    const entry = entryAtAbsoluteIndex(state, absoluteIndex);
    if (entry !== null) {
      renderCard(state, entry, absoluteIndex);
      return;
    }

    renderedAbsoluteIndex = null;
    elements.reveal.disabled = true;
    resultsList.textContent = "";
    const loading = document.createElement("div");
    loading.className = "empty-state practice-loading";
    loading.textContent = "Loading practice card…";
    resultsList.appendChild(loading);

    if (state.status === "loading") return;
    if (state.query.pageSize === "all") {
      controller.updateViewport(absoluteIndex);
      return;
    }
    const pageSize = state.query.pageSize;
    const targetPage = Math.floor(absoluteIndex / pageSize) + 1;
    if (targetPage !== state.query.page) controller.changePage(targetPage - state.query.page);
  };

  const advance = (): void => {
    if (!active || !revealed || latest === null) return;
    cursor += 1;
    renderedAbsoluteIndex = null;
    if (cursor >= order.length) {
      resultsList.textContent = "";
      showComplete();
      return;
    }
    revealed = false;
    elements.reveal.textContent = "Reveal";
    requestCurrentCard(latest);
  };

  const revealOrAdvance = (): void => {
    if (!active || elements.reveal.disabled) return;
    if (revealed) {
      advance();
      return;
    }
    const card = resultsList.querySelector<HTMLElement>(".practice-entry");
    if (card === null) return;
    card.classList.remove("practice-concealed");
    revealed = true;
    elements.reveal.textContent = "Next";
    options.onContentChanged?.();
  };

  const restoreResultsHome = (): void => {
    if (resultsHome === null || resultsList.parentNode === resultsHome) return;
    resultsHome.insertBefore(resultsList, resultsHomeNextSibling);
  };

  const stop = (restorePosition = true): void => {
    if (!active) return;
    const state = latest;
    active = false;
    revealed = false;
    renderedAbsoluteIndex = null;
    order = [];
    cursor = 0;
    sessionDatasetId = null;
    elements.overlay.hidden = true;
    elements.content.hidden = false;
    elements.complete.hidden = true;
    elements.actions.hidden = false;
    elements.reveal.textContent = "Reveal";
    resultsList.textContent = "";
    restoreResultsHome();
    setBackgroundInert(false);

    if (state !== null) {
      options.onExit?.(state);
      updateStartButton(state);
      if (restorePosition && state.dataset !== null) {
        if (state.query.pageSize === "all") {
          controller.updateViewport(originalWindowStart);
        } else if (state.query.page !== originalPage) {
          controller.changePage(originalPage - state.query.page);
        }
      }
    }
    elements.button.focus();
  };

  const start = (): void => {
    const state = latest;
    if (
      active ||
      state === null ||
      state.review.active ||
      state.queue.mode === "queue" ||
      state.dataset === null ||
      state.status !== "ready" ||
      state.result === null ||
      state.result.totalEntries === 0
    ) {
      return;
    }

    order = shuffleIndexes(state.result.totalEntries, random);
    cursor = 0;
    originalPage = state.query.page;
    originalWindowStart = Math.max(0, state.result.startIndex - 1);
    sessionDatasetId = state.dataset.id;
    renderedAbsoluteIndex = null;
    revealed = false;
    active = true;

    if (resultsList.parentNode !== elements.content) elements.content.prepend(resultsList);
    resultsList.textContent = "";
    elements.overlay.hidden = false;
    elements.complete.hidden = true;
    elements.content.hidden = false;
    elements.actions.hidden = false;
    setBackgroundInert(true);
    updateStartButton(state);
    requestCurrentCard(state);
    elements.panel.focus();
  };

  elements.button.addEventListener("click", start);
  elements.exit.addEventListener("click", () => stop());
  elements.returnButton.addEventListener("click", () => stop());
  elements.reveal.addEventListener("click", revealOrAdvance);

  document.addEventListener(
    "keydown",
    (event) => {
      if (!active || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        event.stopImmediatePropagation();
        revealOrAdvance();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        stop();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (revealed) advance();
        return;
      }

      const key = event.key.toLowerCase();
      if (["arrowleft", "n", "p", "z", "home", "end"].includes(key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  return {
    isActive: () => active,
    sync(state: Readonly<AppState>): void {
      latest = state;
      updateStartButton(state);
      if (!active) return;
      if (state.dataset === null || state.dataset.id !== sessionDatasetId || state.review.active) {
        stop(false);
        return;
      }
      requestCurrentCard(state);
    },
  };
}
