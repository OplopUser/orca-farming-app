import { describe, expect, it } from "vitest";

import {
  classifyCloseTimeout,
  classifyOpenTimeout,
  classifySwapTimeout,
  shouldRecoverPausedTimeout
} from "../src/services/recovery.js";

describe("timeout recovery helpers", () => {
  it("retries close when the old position is still present", () => {
    expect(classifyCloseTimeout("old-position", "old-position")).toBe("retry");
  });

  it("continues close recovery when the old position is gone", () => {
    expect(classifyCloseTimeout("old-position", null)).toBe("continue");
  });

  it("completes open recovery when a new position is already live", () => {
    expect(
      classifyOpenTimeout({
        livePositionMint: "new-position",
        previousPositionMint: "old-position",
        plannedPositionMint: null
      })
    ).toBe("complete");
  });

  it("continues swap recovery when balances are already within tolerance", () => {
    expect(classifySwapTimeout(false)).toBe("continue");
    expect(classifySwapTimeout(true)).toBe("retry");
  });

  it("only auto-recovers paused timeout states that are not already ambiguous", () => {
    expect(shouldRecoverPausedTimeout("Transaction confirmation timeout", null)).toBe(true);
    expect(shouldRecoverPausedTimeout("Failed to send transaction: SolanaError: HTTP error (429): Too Many Requests", null)).toBe(true);
    expect(shouldRecoverPausedTimeout("Connection not initialized. Call setRpc() first", null)).toBe(true);
    expect(
      shouldRecoverPausedTimeout("Transaction confirmation timeout", {
        phase: "opening",
        startedAt: "2026-03-13T00:00:00.000Z",
        nextRetryAt: null,
        anchorPrice: 100,
        targetCenterPrice: 99.4,
        previousPositionMint: "old",
        plannedPositionMint: null,
        lastKnownCloseTxId: null,
        lastKnownSwapTxId: null,
        lastKnownOpenTxId: null,
        recoveryReason: "Ambiguous opening timeout",
        retryCount: 1,
        openFailureCount: 0,
        entryCapitalQuote: null,
        entryTokenA: null,
        entryTokenB: null,
        cumulativeSwapFeeQuote: 0,
        cumulativeTxFeeLamports: 0
      })
    ).toBe(false);
    expect(
      shouldRecoverPausedTimeout("Failed to send transaction: SolanaError: HTTP error (429): Too Many Requests", {
        phase: "closing",
        startedAt: "2026-03-13T00:00:00.000Z",
        nextRetryAt: null,
        anchorPrice: 100,
        targetCenterPrice: 99.4,
        previousPositionMint: "old",
        plannedPositionMint: null,
        lastKnownCloseTxId: null,
        lastKnownSwapTxId: null,
        lastKnownOpenTxId: null,
        recoveryReason: "Ambiguous closing timeout",
        retryCount: 1,
        openFailureCount: 0,
        entryCapitalQuote: null,
        entryTokenA: null,
        entryTokenB: null,
        cumulativeSwapFeeQuote: 0,
        cumulativeTxFeeLamports: 0
      })
    ).toBe(false);
  });
});
