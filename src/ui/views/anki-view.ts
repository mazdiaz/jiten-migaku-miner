import type { AnkiPreviewState, AppState } from "../../app/state";
import type { DomMap } from "../dom";

export type AnkiDom = Pick<
  DomMap,
  | "ankiSection"
  | "ankiDescription"
  | "ankiStatusLine"
  | "ankiError"
  | "ankiConnect"
  | "ankiSetup"
  | "ankiDeckScope"
  | "ankiNoteType"
  | "ankiTargetField"
  | "ankiCheckConfig"
  | "ankiActions"
  | "ankiSyncNow"
  | "ankiSettings"
  | "ankiClear"
  | "ankiPreview"
  | "ankiPreviewCounts"
  | "ankiPreviewWarning"
  | "ankiApply"
  | "ankiCancelPreview"
>;

const ANKI_DESCRIPTION = "Automatically classify words from your Anki collection.";

function formatAnkiSummary(state: Readonly<AppState>): string {
  const { anki } = state;
  const details = [
    `${anki.wordCount.toLocaleString()} words`,
    `${anki.knownCount.toLocaleString()} Known`,
    `${anki.minedCount.toLocaleString()} Mined`,
  ];
  if (anki.deckScopeLabel !== null) details.push(`Scope: ${anki.deckScopeLabel}`);
  if (anki.noteType !== null) details.push(`Note type: ${anki.noteType}`);
  if (anki.targetField !== null) details.push(`Target field: ${anki.targetField}`);
  if (anki.lastSyncedAt !== null) details.push(`Last synced: ${anki.lastSyncedAt}`);
  return details.join(" · ");
}

function formatPreviewCounts(preview: AnkiPreviewState): string {
  const counts = [
    `${preview.scannedCards.toLocaleString()} cards scanned`,
    `${preview.uniqueWords.toLocaleString()} unique words`,
  ];
  if (preview.matchedWords !== null) {
    counts.push(`${preview.matchedWords.toLocaleString()} matched`);
  }
  if (preview.knownCount !== null) counts.push(`${preview.knownCount.toLocaleString()} Known`);
  if (preview.minedCount !== null) counts.push(`${preview.minedCount.toLocaleString()} Mined`);
  if (preview.manualProtected !== null && preview.manualProtected > 0) {
    counts.push(`${preview.manualProtected.toLocaleString()} manual decisions protected`);
  }
  if (preview.queueRemovals > 0) {
    counts.push(`${preview.queueRemovals.toLocaleString()} queue removals`);
  }
  return counts.join(" · ");
}

function formatPreviewWarnings(preview: AnkiPreviewState): string[] {
  const warnings: string[] = [];
  if (preview.zeroCards) warnings.push("No cards matched selected Anki scope.");
  if (preview.datasetAvailable && preview.uniqueWords > 0 && preview.matchedWords === 0) {
    warnings.push(
      "No Anki target words matched the current Jiten dataset; Apply will save the snapshot for future datasets.",
    );
  }
  if (preview.emptyTargetFields > 0) {
    warnings.push(
      `${preview.emptyTargetFields.toLocaleString()} cards skipped because target field was empty.`,
    );
  }
  if (!preview.datasetAvailable) {
    warnings.push("No Jiten dataset loaded; Apply will save Anki snapshot only.");
  }
  return warnings;
}

export function renderAnkiSection(dom: AnkiDom, state: Readonly<AppState>): void {
  const { anki, ankiPreview } = state;
  const busy = anki.status === "connecting" || anki.status === "syncing";

  dom.ankiDescription.textContent = ANKI_DESCRIPTION;
  dom.ankiConnect.hidden = anki.configured;
  dom.ankiConnect.disabled = busy;
  dom.ankiActions.hidden = !anki.configured;
  // Setup visibility is controlled by connect/settings actions. Once config is
  // saved, renderer owns the transition back to the compact configured view.
  if (anki.configured && dom.ankiSetup.dataset.editing !== "true") dom.ankiSetup.hidden = true;
  if (!anki.configured && anki.status === "idle" && dom.ankiSetup.dataset.editing !== "true") {
    delete dom.ankiSetup.dataset.editing;
    dom.ankiSetup.hidden = true;
  }
  dom.ankiCheckConfig.disabled = busy;
  dom.ankiSyncNow.disabled = busy || anki.status === "preview" || !anki.configured;
  dom.ankiSettings.disabled = busy || !anki.configured;
  dom.ankiClear.disabled = busy || !anki.configured;

  const hasStatus = anki.configured || anki.status !== "idle";
  dom.ankiStatusLine.hidden = !hasStatus;
  if (hasStatus) {
    const prefix =
      anki.status === "connecting"
        ? "Connecting to Anki"
        : anki.status === "syncing"
          ? "Syncing from Anki"
          : anki.status === "preview"
            ? "Preview ready"
            : "Anki sync ready";
    dom.ankiStatusLine.textContent = anki.configured
      ? `${prefix} · ${formatAnkiSummary(state)}`
      : `${prefix}…`;
  } else {
    dom.ankiStatusLine.textContent = "";
  }

  dom.ankiError.hidden = anki.errorMessage === null;
  dom.ankiError.textContent =
    anki.errorMessage === null ? "" : `Anki unavailable: ${anki.errorMessage}`;

  dom.ankiPreview.hidden = ankiPreview === null;
  dom.ankiApply.disabled = ankiPreview === null || anki.status !== "preview";
  dom.ankiCancelPreview.disabled = ankiPreview === null || anki.status === "syncing";
  if (ankiPreview === null) {
    dom.ankiPreviewCounts.textContent = "";
    dom.ankiPreviewWarning.textContent = "";
    dom.ankiPreviewWarning.hidden = true;
    return;
  }

  dom.ankiPreviewCounts.textContent = formatPreviewCounts(ankiPreview);
  const warnings = formatPreviewWarnings(ankiPreview);
  dom.ankiPreviewWarning.hidden = warnings.length === 0;
  dom.ankiPreviewWarning.textContent = warnings.join(" ");
}
