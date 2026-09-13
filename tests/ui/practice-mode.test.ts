import { describe, expect, it } from "vitest";
import { shuffleIndexes } from "../../src/ui/practice-mode";

describe("practice shuffle", () => {
  it("creates one shuffled permutation without duplicates", () => {
    const order = shuffleIndexes(4, () => 0);
    expect(order).toEqual([1, 2, 3, 0]);
    expect(new Set(order).size).toBe(4);
  });
});
