export interface SessionQueueSnapshot {
  version: 1;
  datasetId: string;
  normalizedWords: string[];
}

export interface SessionQueueStore {
  load(): SessionQueueSnapshot | null;
  save(snapshot: SessionQueueSnapshot): void;
  clear(): void;
}

export const SESSION_QUEUE_STORAGE_KEY = "jitenMiner.sessionQueue.v1";
const SESSION_QUEUE_VERSION = 1;

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createMemoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function defaultSessionStorage(): Storage | MemoryStorage | null {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined || storage === null) return null;
    const probe = `${SESSION_QUEUE_STORAGE_KEY}.probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function parseSnapshot(raw: string | null): SessionQueueSnapshot | null {
  if (raw === null || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== SESSION_QUEUE_VERSION) return null;
  if (typeof record.datasetId !== "string" || record.datasetId.length === 0) return null;
  if (!Array.isArray(record.normalizedWords)) return null;
  if (record.normalizedWords.some((word) => typeof word !== "string")) return null;
  return {
    version: SESSION_QUEUE_VERSION,
    datasetId: record.datasetId,
    normalizedWords: [...record.normalizedWords],
  };
}

export function createSessionQueueStore(
  storage: Storage | MemoryStorage | null = defaultSessionStorage(),
): SessionQueueStore {
  const backing = storage ?? createMemoryStorage();
  return {
    load(): SessionQueueSnapshot | null {
      try {
        return parseSnapshot(backing.getItem(SESSION_QUEUE_STORAGE_KEY));
      } catch {
        return null;
      }
    },

    save(snapshot: SessionQueueSnapshot): void {
      try {
        backing.setItem(SESSION_QUEUE_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Queue persistence is best-effort session state; ignore storage failures.
      }
    },

    clear(): void {
      try {
        backing.removeItem(SESSION_QUEUE_STORAGE_KEY);
      } catch {
        // Best-effort removal; the controller treats a failed clear as a lost queue.
      }
    },
  };
}
