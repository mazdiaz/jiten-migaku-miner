import { describe, expect, it } from "vitest";
import {
  configuredLocalFirstEnabled,
  isLocalFirstEnabled,
  localBootMessage,
  storageModeDiagnostic,
  storageModeLabel,
} from "../../src/config/storage-mode";

describe("storage mode", () => {
  it.each([
    [undefined, true],
    ["1", true],
    ["0", false],
  ])("interprets %s as local-first=%s", (value, expected) => {
    expect(isLocalFirstEnabled(value)).toBe(expected);
  });

  it("labels the active architecture without exposing configuration values", () => {
    expect(storageModeLabel(undefined)).toBe("local-first");
    expect(storageModeLabel("1")).toBe("local-first");
    expect(storageModeLabel("0")).toBe("server-first fallback");
    expect(storageModeDiagnostic(storageModeLabel(undefined))).toBe("Storage mode: local-first");
    expect(storageModeDiagnostic(storageModeLabel("0"))).toBe(
      "Storage mode: server-first fallback",
    );
  });

  it("distinguishes cold bootstrap from warm local loading", () => {
    expect(localBootMessage(false)).toBe("Setting up local cache…");
    expect(localBootMessage(true)).toBe("Loading local vocabulary…");
  });

  it("defaults configured builds to local-first when flag is absent", () => {
    const previous = process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC;
    delete process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC;
    try {
      expect(configuredLocalFirstEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC;
      else process.env.NEXT_PUBLIC_LOCAL_FIRST_SYNC = previous;
    }
  });
});
