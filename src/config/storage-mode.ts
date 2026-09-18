export type StorageModeLabel = "local-first" | "server-first fallback";

export function isLocalFirstEnabled(value?: string): boolean {
  return value !== "0";
}

export function configuredLocalFirstEnabled(): boolean {
  return isLocalFirstEnabled(process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC);
}

export function storageModeLabel(value?: string): StorageModeLabel {
  return isLocalFirstEnabled(value) ? "local-first" : "server-first fallback";
}

export function configuredStorageModeLabel(): StorageModeLabel {
  return storageModeLabel(process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC);
}

export function storageModeDiagnostic(value?: string): string {
  return `Storage mode: ${storageModeLabel(value)}`;
}

export function localBootMessage(bootstrapComplete: boolean): string {
  return bootstrapComplete ? "Loading local vocabulary…" : "Setting up local cache…";
}
