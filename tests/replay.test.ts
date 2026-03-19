import { describe, expect, it } from "vitest";

import { evaluateDriftTrigger } from "../src/strategy/bands.js";

describe("price replay", () => {
  it("produces immediate triggers as soon as 0.5 percent drift is crossed", () => {
    const points = [
      { t: "2026-03-13T00:00:00.000Z", price: 100.2 },
      { t: "2026-03-13T00:00:15.000Z", price: 100.49 },
      { t: "2026-03-13T00:00:30.000Z", price: 100.51 },
      { t: "2026-03-13T00:00:45.000Z", price: 100.3 }
    ];

    const triggerMoments: string[] = [];

    for (const point of points) {
      const trigger = evaluateDriftTrigger(100, point.price, 0.5);
      if (trigger.shouldRebalance) {
        triggerMoments.push(point.t);
      }
    }

    expect(triggerMoments).toEqual(["2026-03-13T00:00:30.000Z"]);
  });
});
