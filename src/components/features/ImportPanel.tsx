import { memo } from "react";
// Disable Firefox button-state restoration before React hydrates the page.
// The study adapter owns mutable descendants, including Migaku-parsed sentences.
export const ImportPanel = memo(function ImportPanel() {
  return (
    <section className="panel import-panel" aria-label="Import files">
      <div className="import-summary-row">
        <div id="importSummary" className="import-summary" hidden>
          <span className="import-dataset-line"></span>

          <span className="import-known-line"></span>
        </div>

        <button
          {...{ autoComplete: "off" }}
          id="changeFiles"
          type="button"
          className="clear-button"
          aria-expanded="false"
          aria-controls="importGrid"
          hidden
        >
          {"Change Files"}
        </button>
      </div>

      <div className="import-grid" id="importGrid">
        <div id="jitenDropzone" className="dropzone">
          <div className="dropzone-title">{"Jiten CSV"}</div>

          <p className="dropzone-copy">{"Drop one media vocabulary CSV here."}</p>

          <label className="file-picker" htmlFor="jitenInput">
            {"Choose CSV"}
          </label>

          <input id="jitenInput" type="file" accept=".csv,text/csv" />

          <div id="jitenStatus" className="file-status">
            {"No CSV loaded"}
          </div>
        </div>

        <div id="knownDropzone" className="dropzone">
          <div className="dropzone-title">{"Migaku Known Words"}</div>

          <p className="dropzone-copy">{"Optional plain-text export, one entry per line."}</p>

          <label className="file-picker" htmlFor="knownInput">
            {"Choose TXT"}
          </label>

          <input id="knownInput" type="file" accept=".txt,text/plain" />

          <div id="knownStatus" className="file-status optional">
            {"Optional · no list loaded"}
          </div>
        </div>
      </div>

      <section id="datasetLibrary" className="dataset-library" aria-label="Saved datasets">
        <div className="dataset-library-heading">
          <div>
            <h3>{"Dataset library"}</h3>
            <p>{"Switch between saved Jiten CSVs without uploading them again."}</p>
          </div>
          <span id="libraryStatus" className="library-status" aria-live="polite"></span>
        </div>

        <div id="libraryList" className="library-list">
          <p id="libraryEmpty" className="library-empty">
            {"Your saved CSVs will appear here."}
          </p>
        </div>
      </section>

      <section id="ankiSection" className="anki-section" aria-label="Anki Sync">
        <h3>{"Anki Sync"}</h3>

        <p id="ankiDescription">{"Automatically classify words from your Anki collection."}</p>

        <p id="ankiStatusLine" className="anki-status" hidden></p>

        <p id="ankiError" className="anki-error" role="alert" hidden></p>

        <button
          {...{ autoComplete: "off" }}
          id="ankiConnect"
          type="button"
          className="anki-primary"
        >
          {"Connect to Anki"}
        </button>

        <div id="ankiSetup" className="anki-setup" hidden>
          <label className="control">
            <span>{"Deck scope"}</span>

            <select id="ankiDeckScope"></select>
          </label>

          <label className="control">
            <span>{"Note type"}</span>

            <select id="ankiNoteType"></select>
          </label>

          <label className="control">
            <span>{"Target word field"}</span>

            <select id="ankiTargetField"></select>
          </label>

          <button
            {...{ autoComplete: "off" }}
            id="ankiCheckConfig"
            type="button"
            className="anki-primary"
          >
            {"Check configuration"}
          </button>

          <div className="anki-danger-zone">
            <p className="anki-danger-title">{"Danger zone"}</p>

            <button
              {...{ autoComplete: "off" }}
              id="ankiClear"
              type="button"
              className="anki-danger"
            >
              {"Clear Anki sync data…"}
            </button>
          </div>
        </div>

        <div id="ankiActions" className="anki-actions" hidden>
          <button
            {...{ autoComplete: "off" }}
            id="ankiSyncNow"
            type="button"
            className="anki-primary"
          >
            {"Sync from Anki"}
          </button>

          <button
            {...{ autoComplete: "off" }}
            id="ankiSettings"
            type="button"
            className="anki-secondary"
          >
            {"Settings"}
          </button>
        </div>

        <div id="ankiPreview" className="anki-preview" hidden>
          <h4>{"Anki Sync Preview"}</h4>

          <p id="ankiPreviewCounts"></p>

          <p id="ankiPreviewWarning" className="anki-warning" role="alert" hidden></p>

          <div className="anki-preview-actions">
            <button
              {...{ autoComplete: "off" }}
              id="ankiApply"
              type="button"
              className="anki-primary"
            >
              {"Apply Sync"}
            </button>

            <button
              {...{ autoComplete: "off" }}
              id="ankiCancelPreview"
              type="button"
              className="anki-secondary"
            >
              {"Cancel"}
            </button>
          </div>
        </div>
      </section>

      <fieldset className="data-area">
        <legend>{"Data"}</legend>

        <div className="clear-row">
          <button
            {...{ autoComplete: "off" }}
            id="clearData"
            type="button"
            className="clear-button"
          >
            {"Clear saved data…"}
          </button>

          <span className="clear-note">
            Removes all saved vocabulary and progress from PostgreSQL.
          </span>
        </div>

        <fieldset className="portability-row" aria-label="Data portability">
          <button
            {...{ autoComplete: "off" }}
            id="exportBackup"
            type="button"
            className="clear-button"
          >
            {"Export backup"}
          </button>

          <button
            {...{ autoComplete: "off" }}
            id="restoreBackup"
            type="button"
            className="clear-button"
          >
            {"Restore backup…"}
          </button>

          <input id="restoreBackupInput" type="file" accept=".json,application/json" hidden />

          <span id="backupStatus" className="clear-note" aria-live="polite"></span>

          <span
            id="backupFreshness"
            className="clear-note backup-freshness"
            title="Exporting does not guarantee the downloaded file was kept."
          ></span>
        </fieldset>

        <p className="data-note">
          Saved privately in PostgreSQL. Complete backups include datasets, your mining queue, known
          words, decisions, preferences, and Anki sync data. You can also restore backups from the
          old local app.
        </p>
      </fieldset>

      <div id="errorBox" className="error-box" role="alert" hidden></div>
    </section>
  );
});
