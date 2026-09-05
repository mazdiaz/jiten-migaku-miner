import { describe, expect, it } from "vitest";
import {
  createSessionQueueStore,
  SESSION_QUEUE_STORAGE_KEY,
  type SessionQueueSnapshot,
} from "../../src/platform/session-queue";

function snapshot(overrides: Partial<SessionQueueSnapshot> = {}): SessionQueueSnapshot {
  return {
    version: 1,
    datasetId: "dataset-1",
    normalizedWords: ["第一", "第二", "第三"],
    ...overrides,
  };
}

class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
  failWrites = false;
  failReads = false;

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null {
    if (this.failReads) throw new Error("storage read blocked");
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("storage write blocked");
    this.values.set(key, value);
  }
}

describe("session queue store", () => {
  it("round-trips an ordered snapshot", () => {
    const storage = new FakeStorage();
    const store = createSessionQueueStore(storage);

    store.save(snapshot({ normalizedWords: ["三", "一", "二"] }));

    expect(store.load()).toEqual({
      version: 1,
      datasetId: "dataset-1",
      normalizedWords: ["三", "一", "二"],
    });
  });

  it("stores duplicates as-is: dedupe is the controller's responsibility", () => {
    const storage = new FakeStorage();
    const store = createSessionQueueStore(storage);

    store.save(snapshot({ normalizedWords: ["一", "一", "二"] }));

    expect(store.load()?.normalizedWords).toEqual(["一", "一", "二"]);
  });

  it("returns null for an unsupported version", () => {
    const storage = new FakeStorage();
    storage.setItem(SESSION_QUEUE_STORAGE_KEY, JSON.stringify({ version: 2, datasetId: "d", normalizedWords: ["一"] }));
    const store = createSessionQueueStore(storage);

    expect(store.load()).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const storage = new FakeStorage();
    storage.setItem(SESSION_QUEUE_STORAGE_KEY, "{not json");
    const store = createSessionQueueStore(storage);

    expect(store.load()).toBeNull();
  });

  it("returns null when the stored shape is invalid", () => {
    const storage = new FakeStorage();
    const store = createSessionQueueStore(storage);
    storage.setItem(SESSION_QUEUE_STORAGE_KEY, JSON.stringify({ version: 1, datasetId: "", normalizedWords: "nope" }));

    expect(store.load()).toBeNull();
  });

  it("returns null when reads throw instead of crashing the caller", () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    const store = createSessionQueueStore(storage);

    expect(store.load()).toBeNull();
  });

  it("swallows write failures", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const store = createSessionQueueStore(storage);

    expect(() => store.save(snapshot())).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it("clear removes the storage key", () => {
    const storage = new FakeStorage();
    const store = createSessionQueueStore(storage);
    store.save(snapshot());

    store.clear();

    expect(storage.getItem(SESSION_QUEUE_STORAGE_KEY)).toBeNull();
    expect(store.load()).toBeNull();
  });

  it("falls back to memory when no storage is available", () => {
    const store = createSessionQueueStore(null);

    store.save(snapshot());
    expect(store.load()).toEqual(snapshot());
    store.clear();
    expect(store.load()).toBeNull();
  });
});
