import { describe, expect, it } from "vitest";

import { evaluateDriftTrigger } from "../src/strategy/bands.js";

describe("drift trigger", () => {
  it("calculates a +/- 0.5 percent trigger window from the anchor", () => {
    const trigger = evaluateDriftTrigger(100, 100, 0.5);

    expect(trigger.lowerTrigger).toBeCloseTo(100 / 1.005, 8);
    expect(trigger.upperTrigger).toBeCloseTo(100 * 1.005, 8);
    expect(trigger.shouldRebalance).toBe(false);
  });

  it("allows the anchor to reset after each rebalance", () => {
    const firstAnchor = evaluateDriftTrigger(100, 100.51, 0.5);
    const secondAnchor = evaluateDriftTrigger(100.51, 101.01, 0.5);

    expect(firstAnchor.shouldRebalance).toBe(true);
    expect(secondAnchor.shouldRebalance).toBe(false);
  });

  it("triggers immediately on the first out-of-band observation", () => {
    const immediate = evaluateDriftTrigger(100, 99.49, 0.5);

    expect(immediate.direction).toBe("below");
    expect(immediate.shouldRebalance).toBe(true);
  });
});
