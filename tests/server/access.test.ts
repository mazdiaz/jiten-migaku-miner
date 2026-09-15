import { describe, expect, it } from "vitest";
import { isOwner, isSameOrigin } from "../../src/server/access";

describe("owner access", () => {
  it("fails closed without a configured owner or identity", () => {
    expect(isOwner("46370875", undefined)).toBe(false);
    expect(isOwner(undefined, "46370875")).toBe(false);
    expect(isOwner("", "")).toBe(false);
  });
  it("compares immutable IDs rather than usernames", () => {
    expect(isOwner("46370875", "46370875")).toBe(true);
    expect(isOwner("999", "46370875")).toBe(false);
    expect(isOwner("mazdiaz", "46370875")).toBe(false);
  });
  it("rejects cross-origin and missing-origin mutations", () => {
    expect(isSameOrigin("https://miner.example", "https://miner.example/api/store")).toBe(true);
    expect(isSameOrigin("https://evil.example", "https://miner.example/api/store")).toBe(false);
    expect(isSameOrigin(null, "https://miner.example/api/store")).toBe(false);
    expect(isSameOrigin("null", "https://miner.example/api/store")).toBe(false);
  });
});
