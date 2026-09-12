import type { AppState } from "../../app/state";
import type { DomMap } from "../dom";

const REVIEW_UNDO_BASE_LABEL = "Undo last";

export function renderReviewSurface(dom: DomMap, state: Readonly<AppState>): void {
  const review = state.review;
  dom.reviewOverlay.hidden = !review.active;
  document.body.classList.toggle("review-open", review.active);
  // Inert the background shell so background controls are unfocusable while
  // the modal review overlay is open; the shared results surface is moved
  // into the overlay before this runs, so the Japanese text stays interactive.
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

  // Review content owns the shared #resultsList while active. Only remove
  // error nodes that this view created; clearing reviewContent would detach
  // the Migaku-facing results surface and throw away extension parsing.
  for (const child of [...dom.reviewContent.children]) {
    if (child.classList.contains("review-error")) child.remove();
  }

  if (!review.active) {
    dom.reviewProgress.textContent = "";
    return;
  }

  dom.reviewProgress.textContent = `${review.processed} processed · ${review.remaining} remaining`;

  // The error renders whenever it is set, regardless of status: a failed
  // decision returns to "ready" with the card kept, so retry stays possible.
  if (review.errorMessage !== null) {
    const error = document.createElement("div");
    error.className = "review-error";
    error.setAttribute("role", "alert");
    error.textContent = review.errorMessage;
    dom.reviewContent.appendChild(error);
  }
}
