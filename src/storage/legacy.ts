export interface LegacyState {
  mediaFileName: string | null;
  mediaText: string | null;
  knownFileName: string | null;
  knownText: string | null;
  page: number;
  warning?: string;
}

const LEGACY_STATE_KEY = "jitenMiner.v1";
const LEGACY_PAGE_KEY = "jitenMiner.page";
const MIGRATION_MARKER_KEY = "jitenMiner.migration";

interface LegacyRecord {
  mediaFileName?: unknown;
  mediaText?: unknown;
  knownFileName?: unknown;
  knownText?: unknown;
}

function emptyLegacyState(page: number): LegacyState {
  return {
    mediaFileName: null,
    mediaText: null,
    knownFileName: null,
    knownText: null,
    page,
  };
}

function readPage(storage: Storage): number {
  const rawPage = storage.getItem(LEGACY_PAGE_KEY);
  if (rawPage === null) {
    return 1;
  }

  const page = Number.parseInt(rawPage, 10);
  return Number.isFinite(page) && page >= 1 ? page : 1;
}

function isLegacyRecord(value: unknown): value is LegacyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readLegacyState(storage: Storage): LegacyState | null {
  const rawState = storage.getItem(LEGACY_STATE_KEY);
  const rawPage = storage.getItem(LEGACY_PAGE_KEY);
  if (rawState === null && rawPage === null) {
    return null;
  }

  const page = readPage(storage);
  if (rawState === null) {
    return emptyLegacyState(page);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawState) as unknown;
  } catch (error) {
    console.warn("Could not parse legacy Jiten Miner storage; values were preserved.", error);
    return emptyLegacyState(page);
  }

  if (!isLegacyRecord(parsed)) {
    console.warn("Legacy Jiten Miner storage has unexpected shape; values were preserved.");
    return emptyLegacyState(page);
  }

  const invalidFields: string[] = [];
  const optionalString = (field: keyof LegacyRecord): string | null => {
    const value = parsed[field];
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    invalidFields.push(field);
    return null;
  };
  const state: LegacyState = {
    mediaFileName: optionalString("mediaFileName"),
    mediaText: optionalString("mediaText"),
    knownFileName: optionalString("knownFileName"),
    knownText: optionalString("knownText"),
    page,
  };
  if (invalidFields.length > 0) {
    state.warning = `Legacy Jiten Miner storage has invalid field types: ${invalidFields.join(", ")}.`;
  }
  return state;
}

export function writeMigrationMarker(storage: Storage, version: number): void {
  storage.setItem(MIGRATION_MARKER_KEY, String(version));
}

export function hasMigrationMarker(storage: Storage, version: number): boolean {
  return storage.getItem(MIGRATION_MARKER_KEY) === String(version);
}

export function clearLegacyData(storage: Storage): void {
  storage.removeItem(LEGACY_STATE_KEY);
  storage.removeItem(LEGACY_PAGE_KEY);
  storage.removeItem(MIGRATION_MARKER_KEY);
}
