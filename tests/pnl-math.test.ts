import { describe, expect, it } from "vitest";

import {
  computeNetPnl,
  resolveTokenPricesUsdc,
  resolveTokenPricesUsdcStrict,
  summarizeGlobalPnl
} from "../src/services/pnlMath.js";
import type { BotRecord, PositionPnlRecord } from "../src/domain.js";
import { createEmptyBotRuntimeState } from "../src/state/store.js";

function createBotRecord(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    definition: {
      id: "bot-1",
      name: "SOL/USDC",
      enabled: true,
      archived: false,
      whirlpoolAddress: "pool-1",
      allocationUsdc: 10,
      rangePct: 1,
      rebalanceDriftPct: 0.5,
      pollSeconds: 15,
      maxSlippageBps: 100,
      closeRetrySlippageBps: 300,
      closeFinalRetrySlippageBps: 1000,
      openRetrySlippageBps: 300,
      openFinalRetrySlippageBps: 1000,
      openDeploymentBufferBps: 100,
      openRetryDeploymentBufferBps: 300,
      openFinalDeploymentBufferBps: 500,
      minSwapQuoteValue: 10,
      openBalanceToleranceBps: 25,
      tokenAMint: "So11111111111111111111111111111111111111112",
      tokenASymbol: "SOL",
      tokenADecimals: 9,
      tokenBMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      tokenBSymbol: "USDC",
      tokenBDecimals: 6,
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z"
    },
    runtime: {
      ...createEmptyBotRuntimeState(),
      monitoringActive: true,
      lastObservedPrice: 90
    },
    ...overrides
  };
}

describe("pnl math", () => {
  it("computes open net pnl after swap and tx fees", () => {
    expect(computeNetPnl(110, 100, 3, 2)).toBe(5);
  });

  it("resolves token prices through a SOL/USDC reference bot", () => {
    const solUsdcBot = createBotRecord();
    const ethSolBot = createBotRecord({
      definition: {
        ...createBotRecord().definition,
        id: "bot-2",
        name: "whETH/SOL",
        whirlpoolAddress: "pool-2",
        tokenBMint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
        tokenBSymbol: "whETH",
        tokenBDecimals: 8
      },
      runtime: {
        ...createEmptyBotRuntimeState(),
        lastObservedPrice: 0.045
      }
    });

    const prices = resolveTokenPricesUsdc(ethSolBot.definition, 0.045, [solUsdcBot, ethSolBot]);
    expect(prices?.tokenAUsdc).toBe(90);
    expect(prices?.tokenBUsdc).toBeCloseTo(2000, 5);
  });

  it("returns null from strict pricing when no USD reference is available for a non-USDC quote token", () => {
    const ethSolBot = createBotRecord({
      definition: {
        ...createBotRecord().definition,
        id: "bot-2",
        name: "whETH/SOL",
        whirlpoolAddress: "pool-2",
        tokenBMint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
        tokenBSymbol: "whETH",
        tokenBDecimals: 8
      },
      runtime: {
        ...createEmptyBotRuntimeState(),
        lastObservedPrice: 0.045
      }
    });

    expect(resolveTokenPricesUsdcStrict(ethSolBot.definition, 0.045, [ethSolBot])).toBeNull();
    expect(resolveTokenPricesUsdc(ethSolBot.definition, 0.045, [ethSolBot])).toEqual({
      tokenAUsdc: 0.045,
      tokenBUsdc: 1,
      solUsdc: 0.045
    });
  });

  it("sums open and realized pnl into a global total", () => {
    const records: PositionPnlRecord[] = [
      {
        id: "one",
        botId: "bot-1",
        botName: "SOL/USDC",
        whirlpoolAddress: "pool-1",
        tokenPair: "SOL/USDC",
        positionMint: "mint-1",
        status: "open",
        openedAt: "2026-03-14T00:00:00.000Z",
        closedAt: null,
        entryCenterPrice: 90,
        entryLowerPrice: 89,
        entryUpperPrice: 91,
        entryCapitalUsdc: 100,
        entryTokenA: "1",
        entryTokenB: "2",
        residualTokenA: "0",
        residualTokenB: "0",
        cumulativeSwapFeesUsdc: 1,
        cumulativeTxFeesUsdc: 1,
        feesEarnedUsdc: 3,
        latestGrossValueUsdc: 110,
        latestNetPnlUsdc: 8,
        lastMarkedAt: "2026-03-14T00:00:00.000Z",
        exitGrossValueUsdc: null,
        realizedNetPnlUsdc: null,
        openTxId: null,
        closeTxId: null,
        bootstrapped: false
      },
      {
        id: "two",
        botId: "bot-1",
        botName: "SOL/USDC",
        whirlpoolAddress: "pool-1",
        tokenPair: "SOL/USDC",
        positionMint: "mint-2",
        status: "closed",
        openedAt: "2026-03-13T00:00:00.000Z",
        closedAt: "2026-03-14T00:00:00.000Z",
        entryCenterPrice: 85,
        entryLowerPrice: 84,
        entryUpperPrice: 86,
        entryCapitalUsdc: 100,
        entryTokenA: "1",
        entryTokenB: "2",
        residualTokenA: "0",
        residualTokenB: "0",
        cumulativeSwapFeesUsdc: 1,
        cumulativeTxFeesUsdc: 2,
        feesEarnedUsdc: 4,
        latestGrossValueUsdc: 115,
        latestNetPnlUsdc: 12,
        lastMarkedAt: "2026-03-14T00:00:00.000Z",
        exitGrossValueUsdc: 115,
        realizedNetPnlUsdc: 12,
        openTxId: null,
        closeTxId: null,
        bootstrapped: false
      }
    ];

    const summary = summarizeGlobalPnl(records, 1);
    expect(summary.totalNetPnlUsdc).toBe(20);
    expect(summary.realizedNetPnlUsdc).toBe(12);
    expect(summary.openNetPnlUsdc).toBe(8);
    expect(summary.orphanedPositionCount).toBe(1);
  });
});
