import type { AppState } from "../../app/state";
import type { DomMap } from "../dom";

export const QUEUE_COMPLETE_MESSAGE = "Mining queue complete.";

// Queue Mode header: word count plus the working instructions, visible only
// while the queue is active.
export function renderQueueHeader(dom: DomMap, state: Readonly<AppState>): void {
  const queueMode = state.queue.mode === "queue";
  dom.queueHeader.hidden = !queueMode;
  if (queueMode) {
    dom.queueHeading.textContent = `Mining Queue — ${state.queue.normalizedWords.length} words`;
    dom.queueStats.textContent =
      state.queue.normalizedWords.length === 0
        ? QUEUE_COMPLETE_MESSAGE
        : "Work through each queued word, then exit to return to the full list.";
  }
}
