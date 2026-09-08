import type { AppState } from "../../app/state";
import type { DomMap } from "../dom";
import { renderReviewEntryNode } from "./entry-view";

const REVIEW_COMPLETE_MESSAGE = "No unreviewed candidates remain for the current filters.";
const REVIEW_UNDO_BASE_LABEL = "Undo last";

export function renderReviewSurface(dom: DomMap, state: Readonly<AppState>): void {
  const review = state.review;
  dom.reviewOverlay.hidden = !review.active;
  document.body.classList.toggle("review-open", review.active);
  // Inert the background shell so background controls are unfocusable while
  // the modal review overlay is open; the overlay lives outside main.app-shell.
  document.querySelector("main.app-shell")?.toggleAttribute("inert", review.active);
  dom.reviewButton.disabled = state.dataset === null || state.status === "loading" || review.active;

  const triageButtons = [dom.reviewKnown, dom.reviewMined, dom.reviewSkip, dom.reviewLater];
  for (const button of triageButtons) button.disabled = review.status !== "ready";

  // The review undo button shares state.undo with the results-head button:
  // enabled whenever a decision record is available, labeled with it.
  dom.reviewUndo.disabled = !state.undo.available;
  dom.reviewUndo.textContent =
    state.undo.available && state.undo.label !== null ? state.undo.label : REVIEW_UNDO_BASE_LABEL;

  const complete = review.active && review.status === "complete";
  dom.reviewComplete.hidden = !complete;
  dom.reviewContent.hidden = !review.active || complete;

  if (!review.active) {
    dom.reviewContent.textContent = "";
    dom.reviewProgress.textContent = "";
    return;
  }

  dom.reviewProgress.textContent = `${review.processed} processed · ${review.remaining} remaining`;

  // The error renders whenever it is set, regardless of status: a failed
  // decision returns to "ready" with the card kept, so retry stays possible.
  const appendReviewError = (message: string): void => {
    const error = document.createElement("div");
    error.className = "review-error";
    error.setAttribute("role", "alert");
    error.textContent = message;
    dom.reviewContent.appendChild(error);
  };

  if (review.current === null) {
    if (review.errorMessage !== null) {
      dom.reviewContent.textContent = "";
      appendReviewError(review.errorMessage);
      return;
    }
    dom.reviewContent.textContent =
      review.status === "loading" ? "Loading review queue…" : REVIEW_COMPLETE_MESSAGE;
    return;
  }
  dom.reviewContent.textContent = "";
  dom.reviewContent.appendChild(renderReviewEntryNode(review.current, state.view));
  if (review.errorMessage !== null) appendReviewError(review.errorMessage);
}
