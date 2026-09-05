import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearLegacyData,
  hasMigrationMarker,
  readLegacyState,
  writeMigrationMarker,
} from "../../src/storage/legacy";

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("readLegacyState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads legacy files and page without deleting either key", () => {
    const storage = new TestStorage();
    storage.setItem(
      "jitenMiner.v1",
      JSON.stringify({
        mediaFileName: "media.csv",
        mediaText: "Word\nalpha",
        knownFileName: "known.txt",
        knownText: "alpha\nbeta",
      }),
    );
    storage.setItem("jitenMiner.page", "7");

    expect(readLegacyState(storage)).toEqual({
      mediaFileName: "media.csv",
      mediaText: "Word\nalpha",
      knownFileName: "known.txt",
      knownText: "alpha\nbeta",
      page: 7,
    });
    expect(storage.getItem("jitenMiner.v1")).toContain("media.csv");
    expect(storage.getItem("jitenMiner.page")).toBe("7");
  });

  it("returns null when no legacy keys exist", () => {
    expect(readLegacyState(new TestStorage())).toBeNull();
  });

  it("warns on malformed JSON while preserving legacy values", () => {
    const storage = new TestStorage();
    storage.setItem("jitenMiner.v1", "{not-json");
    storage.setItem("jitenMiner.page", "0");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(readLegacyState(storage)).toEqual({
      mediaFileName: null,
      mediaText: null,
      knownFileName: null,
      knownText: null,
      page: 1,
    });
    expect(warning).toHaveBeenCalledOnce();
    expect(storage.getItem("jitenMiner.v1")).toBe("{not-json");
    expect(storage.getItem("jitenMiner.page")).toBe("0");
  });

  it("surfaces wrong legacy field types instead of silently treating them as absent", () => {
    const storage = new TestStorage();
    storage.setItem("jitenMiner.v1", JSON.stringify({ mediaText: 42, knownText: { words: [] } }));

    expect(readLegacyState(storage)).toMatchObject({
      mediaText: null,
      knownText: null,
      warning: expect.stringContaining("mediaText"),
    });
  });
});

describe("migration markers", () => {
  it("writes and checks exact migration versions", () => {
    const storage = new TestStorage();

    expect(hasMigrationMarker(storage, 1)).toBe(false);
    writeMigrationMarker(storage, 1);

    expect(hasMigrationMarker(storage, 1)).toBe(true);
    expect(hasMigrationMarker(storage, 2)).toBe(false);
    expect(storage.getItem("jitenMiner.v1")).toBeNull();
  });
});

describe("clearLegacyData", () => {
  it("removes legacy state, page, and migration marker keys", () => {
    const storage = new TestStorage();
    storage.setItem("jitenMiner.v1", JSON.stringify({ mediaText: "Word\n猫" }));
    storage.setItem("jitenMiner.page", "3");
    writeMigrationMarker(storage, 1);

    clearLegacyData(storage);

    expect(storage.getItem("jitenMiner.v1")).toBeNull();
    expect(storage.getItem("jitenMiner.page")).toBeNull();
    expect(hasMigrationMarker(storage, 1)).toBe(false);
    expect(storage.length).toBe(0);
  });
});
