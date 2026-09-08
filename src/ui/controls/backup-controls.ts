import type { AppState, MinerController } from "../../app/state";
import type { DomMap } from "../dom";

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

export interface BackupControlsOptions {
  confirmRestore?: ((message: string) => boolean) | undefined;
  downloadBackup?: ((filename: string, contents: string) => void) | undefined;
  /** Latest published snapshot, for the post-restore status line. */
  getLatestState(): Readonly<AppState> | null;
}

type EventRegister = (
  target: HTMLElement | Document | Window,
  type: string,
  listener: EventListener,
) => void;

/**
 * Owns the Data-area backup controls: export download, restore file picker
 * with confirmation, and the status line under them.
 */
export function bindBackupControls(
  dom: DomMap,
  controller: MinerController,
  register: EventRegister,
  options: BackupControlsOptions,
): void {
  const confirmRestore =
    options.confirmRestore ?? ((message: string) => globalThis.confirm(message));
  const downloadBackup = options.downloadBackup ?? defaultDownloadBackup;

  register(dom.exportBackup, "click", () => {
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

  register(dom.restoreBackup, "click", () => {
    dom.restoreBackupInput.click();
  });

  register(dom.restoreBackupInput, "change", () => {
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
        const latest = options.getLatestState();
        if (latest === null || latest.errorMessage !== null) return;
        dom.backupStatus.textContent = `Backup restored: ${latest.knownWords.size.toLocaleString()} Migaku-known words · ${latest.wordDecisions.size.toLocaleString()} decisions.`;
      } catch {
        dom.backupStatus.textContent = "";
      }
    })();
  });
}
