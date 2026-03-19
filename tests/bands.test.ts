import { describe, expect, it } from "vitest";

import { computeBand, computeTargetValueWeights, evaluateDriftTrigger } from "../src/strategy/bands.js";

describe("band math", () => {
  it("creates a 1 percent band around the center, symmetric in tick space", () => {
    const band = computeBand(100, 1);

    expect(band.lower).toBeCloseTo(100 / 1.01, 8);
    expect(band.upper).toBeCloseTo(100 * 1.01, 8);
    expect(Math.sqrt(band.lower * band.upper)).toBeCloseTo(100, 8);
  });

  it("triggers once price drifts beyond 0.5 percent from the anchor", () => {
    // lower trigger = 100 / 1.005 ≈ 99.5025, upper trigger = 100 * 1.005 = 100.5
    const nearUpper = evaluateDriftTrigger(100, 100.49, 0.5);
    const aboveUpper = evaluateDriftTrigger(100, 100.51, 0.5);
    const belowLower = evaluateDriftTrigger(100, 99.49, 0.5);

    expect(nearUpper.shouldRebalance).toBe(false);
    expect(nearUpper.direction).toBeNull();
    expect(aboveUpper.shouldRebalance).toBe(true);
    expect(aboveUpper.direction).toBe("above");
    expect(belowLower.shouldRebalance).toBe(true);
    expect(belowLower.direction).toBe("below");
  });

  it("computes balanced target value weights inside the centered range", () => {
    const band = computeBand(100, 1);
    const weights = computeTargetValueWeights(band.lower, 100, band.upper);

    expect(weights.tokenA).toBeGreaterThan(0);
    expect(weights.tokenB).toBeGreaterThan(0);
    expect(weights.tokenA + weights.tokenB).toBeCloseTo(1, 8);
  });
});
