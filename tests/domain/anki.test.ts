import { describe, expect, it } from "vitest";
import {
  aggregateAnkiStatuses,
  ankiCardStatus,
  resolveEffectiveDecision,
} from "../../src/domain/anki";

describe("Anki decision rules", () => {
  it("maps unsuspended New cards to Mined and every other card to Known", () => {
    expect(ankiCardStatus(true)).toBe("mined");
    expect(ankiCardStatus(false)).toBe("known");
  });

  it("gives Known precedence when duplicate cards share a word", () => {
    expect(aggregateAnkiStatuses(["mined", "known", "mined"])).toBe("known");
    expect(aggregateAnkiStatuses(["mined", "mined"])).toBe("mined");
    expect(aggregateAnkiStatuses([])).toBeNull();
  });

  it("gives manual decisions precedence and reveals Anki after removal", () => {
    expect(resolveEffectiveDecision("mined", "known")).toEqual({
      decision: "mined",
      source: "manual",
    });
    expect(resolveEffectiveDecision(null, "known")).toEqual({
      decision: "known",
      source: "anki",
    });
    expect(resolveEffectiveDecision(null, null)).toEqual({
      decision: "unreviewed",
      source: null,
    });
  });
});
