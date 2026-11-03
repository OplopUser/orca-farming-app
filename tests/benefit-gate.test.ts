import { describe, expect, it } from "vitest";

import { passesRebalanceBenefitGate } from "../src/strategy/bands.js";

describe("passesRebalanceBenefitGate", () => {
  it("always passes when the multiple is 0 (no minimum)", () => {
    expect(passesRebalanceBenefitGate(0, 1, 0)).toBe(true);
    expect(passesRebalanceBenefitGate(0.01, 1_000, 0)).toBe(true);
  });

  it("passes when expected fees times the multiple cover the cost", () => {
    expect(passesRebalanceBenefitGate(1, 1.5, 1.5)).toBe(true);
    expect(passesRebalanceBenefitGate(2, 1.5, 1)).toBe(true);
  });

  it("blocks when expected fees times the multiple fall short of the cost", () => {
    expect(passesRebalanceBenefitGate(0.3, 1.005, 1.5)).toBe(false);
    expect(passesRebalanceBenefitGate(0, 0.005, 1)).toBe(false);
  });
});
