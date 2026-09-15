import { memo } from "react";
// Disable Firefox button-state restoration before React hydrates the page.
// The study adapter owns mutable descendants, including Migaku-parsed sentences.
export const ResultsPanel = memo(function ResultsPanel() {
  return (
    <section id="results" className="results-section" aria-label="Mining results">
      <div id="stickyToolbar" className="sticky-toolbar" hidden>
        <div className="sticky-row-1">
          <div id="stickyTitle" className="sticky-title">
            {"Jiten media"}
          </div>

          <input
            id="stickySearch"
            className="sticky-search queue-hidden"
            type="search"
            placeholder="Search target…"
            autoComplete="off"
            aria-label="Search mining results"
          />

          <button
            {...{ autoComplete: "off" }}
            id="queueToggle"
            type="button"
            className="queue-button"
            aria-pressed="false"
            disabled
          >
            {"Queue (0)"}
          </button>

          <nav className="pager queue-hidden" aria-label="Sticky page navigation">
            <button
              {...{ autoComplete: "off" }}
              id="stickyPrev"
              type="button"
              aria-label="Previous page"
            >
              {"←"}
            </button>

            <span id="stickyPage" className="page-label">
              {"Page 0 / 0"}
            </span>

            <button
              {...{ autoComplete: "off" }}
              id="stickyNext"
              type="button"
              aria-label="Next page"
            >
              {"→"}
            </button>
          </nav>

          <button
            {...{ autoComplete: "off" }}
            id="advancedToggle"
            type="button"
            className="advanced-toggle"
            aria-expanded="false"
            aria-controls="advancedPanel"
            disabled
          >
            {"Filters"}
          </button>
        </div>

        <div id="advancedPanel" hidden>
          <fieldset className="adv-group">
            <legend>{"Filters"}</legend>

            <div className="adv-controls">
              <label className="control queue-hidden">
                <span>{"Sort"}</span>

                <select id="sortSelect" defaultValue="occ-desc">
                  <option value="occ-desc">{"Media occurrences ↓"}</option>

                  <option value="occ-asc">{"Media occurrences ↑"}</option>

                  <option value="original">{"Original Jiten CSV order"}</option>
                </select>
              </label>

              <label className="control queue-hidden">
                <span>{"Example sentence"}</span>

                <select id="sentenceFilter" defaultValue="any">
                  <option value="any">{"Any"}</option>

                  <option value="has">{"Has sentence"}</option>

                  <option value="none">{"No sentence"}</option>
                </select>
              </label>

              <label className="control queue-hidden">
                <span>{"Decision"}</span>

                <select id="decisionFilter" defaultValue="all">
                  <option value="all">{"All decisions"}</option>

                  <option value="unreviewed">{"Unreviewed"}</option>

                  <option value="known">{"Known"}</option>

                  <option value="mined">{"Mined"}</option>

                  <option value="skip">{"Skipped"}</option>

                  <option value="later">{"Later"}</option>
                </select>
              </label>

              <label className="control queue-hidden">
                <span>{"Min occurrences"}</span>

                <input
                  id="minOccurrences"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue="1"
                  inputMode="numeric"
                />
              </label>

              <label
                className="check-control queue-hidden"
                title="Hides words on your Migaku known list AND words you marked Known here"
              >
                <input id="hideKnown" type="checkbox" disabled />
                {" Hide Known"}
              </label>

              <label className="check-control queue-hidden">
                <input id="hideKanaOnly" type="checkbox" />
                {" Hide kana-only words"}
              </label>
            </div>
          </fieldset>

          <fieldset className="adv-group">
            <legend>{"Display"}</legend>

            <div className="adv-controls">
              <label
                className="check-control"
                title="Turn off when Migaku's own furigana is enabled to avoid double readings"
              >
                <input id="showFurigana" type="checkbox" />
                {" Furigana on target"}
              </label>

              <label className="check-control">
                <input id="pillHighlight" type="checkbox" />
                {" Pill highlight"}
              </label>

              <label
                className="check-control"
                title="Off = sentences left completely untouched for Migaku"
              >
                <input id="showHighlight" type="checkbox" />
                {" Highlight target"}
              </label>

              <label className="check-control">
                <input id="showDefinitions" type="checkbox" defaultChecked />
                {" Definitions"}
              </label>

              <label className="control queue-hidden">
                <span>{"Per page"}</span>

                <select id="pageSize" defaultValue="50">
                  <option value="25">{"25"}</option>

                  <option value="50">{"50"}</option>

                  <option value="100">{"100"}</option>

                  <option value="all">{"All"}</option>
                </select>
              </label>

              <label className="control">
                <span>{"Sentence size"}</span>

                <select id="sentenceSize" defaultValue="medium">
                  <option value="medium">{"Medium"}</option>

                  <option value="large">{"Large"}</option>
                </select>
              </label>

              <label className="control">
                <span>{"Density"}</span>

                <select id="density" defaultValue="comfortable">
                  <option value="comfortable">{"Comfortable"}</option>

                  <option value="compact">{"Compact"}</option>
                </select>
              </label>
            </div>

            <p className="adv-note">
              {
                "Highlight marks the mining target inside example sentences; Pill restyles it as a soft outline."
              }
            </p>
          </fieldset>
        </div>
      </div>

      <div id="queueHeader" className="queue-header" hidden>
        <div>
          <h2 id="queueHeading">{"Mining Queue"}</h2>

          <p id="queueStats" className="result-stats" aria-live="polite"></p>
        </div>

        <div className="queue-actions">
          <button
            {...{ autoComplete: "off" }}
            id="exitQueue"
            type="button"
            className="queue-action"
          >
            {"Exit Queue"}
          </button>

          <button
            {...{ autoComplete: "off" }}
            id="clearQueue"
            type="button"
            className="queue-action queue-clear"
          >
            {"Clear Queue…"}
          </button>
        </div>
      </div>

      <div className="results-head queue-hidden">
        <div>
          <h2 id="resultsHeading" tabIndex={-1}>
            {"Mining entries"}
          </h2>

          <p id="resultStats" className="result-stats" aria-live="polite">
            {"Load a Jiten CSV to begin."}
          </p>

          <p id="decisionSummary" className="decision-summary" hidden></p>
        </div>

        <div id="filterChips" className="filter-chips queue-hidden" hidden></div>

        <div className="results-head-actions">
          <button
            {...{ autoComplete: "off" }}
            id="undoButton"
            type="button"
            className="review-button undo-button"
            disabled
          >
            {"Undo"}
          </button>

          <button
            {...{ autoComplete: "off" }}
            id="reviewButton"
            type="button"
            className="review-button"
            disabled
          >
            {"Review unreviewed"}
          </button>
        </div>
      </div>

      <section
        id="coveragePanel"
        className="coverage-panel queue-hidden"
        aria-label="Tracked vocabulary coverage"
        hidden
      >
        <button
          {...{ autoComplete: "off" }}
          id="coverageToggle"
          type="button"
          className="coverage-toggle"
          aria-expanded="false"
          aria-controls="coverageBody"
        >
          <span className="coverage-toggle-label">{"Tracked vocabulary coverage:"}</span>

          <span id="coverageSummary" className="coverage-summary">
            {"N/A"}
          </span>
        </button>

        <div id="coverageBody" className="coverage-body" hidden>
          <h3 className="coverage-title">{"Tracked vocabulary occurrence coverage"}</h3>

          <dl className="coverage-stats">
            <div className="coverage-stat">
              <dt>{"Known unique words"}</dt>

              <dd id="coverageUniqueWords"></dd>
            </div>

            <div className="coverage-stat">
              <dt>{"Known occurrences"}</dt>

              <dd id="coverageKnownOccurrences"></dd>
            </div>

            <div className="coverage-stat">
              <dt>{"Coverage"}</dt>

              <dd id="coveragePercent"></dd>
            </div>
          </dl>

          <h4 className="coverage-targets-heading">{"Priority path"}</h4>

          <ul id="coverageTargets" className="coverage-targets"></ul>

          <p className="coverage-note">
            {
              "Based on occurrence counts in this Jiten export. This is not guaranteed raw-text comprehension coverage."
            }
          </p>

          <p id="coverageError" className="coverage-error" role="alert" hidden></p>

          <button
            {...{ autoComplete: "off" }}
            id="coverageFocus"
            type="button"
            className="coverage-focus"
          >
            {"Focus highest-value unknowns"}
          </button>
        </div>
      </section>

      <div id="resultsList" className="results-list">
        <div className="empty-state">{"Load a Jiten CSV above."}</div>
      </div>

      <nav className="pager bottom-pager queue-hidden" aria-label="Bottom page navigation">
        <button
          {...{ autoComplete: "off" }}
          id="bottomPrev"
          type="button"
          aria-label="Previous page"
          disabled
        >
          {"←"}
        </button>

        <span id="bottomPage" className="page-label">
          {"Page 0 / 0"}
        </span>

        <button
          {...{ autoComplete: "off" }}
          id="bottomNext"
          type="button"
          aria-label="Next page"
          disabled
        >
          {"→"}
        </button>
      </nav>

      <p className="shortcut-note">
        {
          "Shortcuts: → / N next · ← / P previous · Z undo last decision · Home top · End bottom. Work when focus is outside the toolbar; disabled while typing."
        }
      </p>
    </section>
  );
});
