import { memo } from "react";
// Disable Firefox button-state restoration before React hydrates the page.
// The study adapter owns mutable descendants, including Migaku-parsed sentences.
export const ReviewPanel = memo(function ReviewPanel() {
  return (
    <div
      id="reviewOverlay"
      className="review-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reviewHeading"
      hidden
    >
      <div id="reviewPanel" className="review-panel" tabIndex={-1}>
        <div className="review-header">
          <h2 id="reviewHeading">{"Review"}</h2>

          <span id="reviewProgress" className="review-progress" aria-live="polite"></span>

          <button
            {...{ autoComplete: "off" }}
            id="reviewExit"
            type="button"
            className="review-exit"
          >
            {"Exit review"}
          </button>
        </div>

        <div id="reviewContent" className="review-content"></div>

        <div id="reviewComplete" className="review-complete" hidden>
          <p>{"No unreviewed candidates remain for the current filters."}</p>

          <button
            {...{ autoComplete: "off" }}
            id="reviewReturn"
            type="button"
            className="review-action"
          >
            {"Return to list"}
          </button>
        </div>

        <fieldset className="review-actions" aria-label="Review decision">
          <button
            {...{ autoComplete: "off" }}
            id="reviewKnown"
            type="button"
            className="review-action"
          >
            {"Known (K)"}
          </button>

          <button
            {...{ autoComplete: "off" }}
            id="reviewMined"
            type="button"
            className="review-action"
          >
            {"Mined (M)"}
          </button>

          <button
            {...{ autoComplete: "off" }}
            id="reviewSkip"
            type="button"
            className="review-action"
          >
            {"Skip (S)"}
          </button>

          <button
            {...{ autoComplete: "off" }}
            id="reviewLater"
            type="button"
            className="review-action"
          >
            {"Later (L)"}
          </button>

          <button
            {...{ autoComplete: "off" }}
            id="reviewUndo"
            type="button"
            className="review-action review-undo"
            disabled
          >
            {"Undo last (Z)"}
          </button>
        </fieldset>

        <p className="review-shortcut-note">
          {"Shortcuts: K known · M mined · S skip · L later · Z undo · Esc exit."}
        </p>
      </div>
    </div>
  );
});
