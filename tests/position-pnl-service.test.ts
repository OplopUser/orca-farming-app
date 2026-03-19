import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../src/domain.js";
import { PositionPnlService } from "../src/services/positionPnlService.js";
import { PnlLedgerStore } from "../src/state/pnlLedgerStore.js";
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

describe("PositionPnlService", () => {
  it("creates an open record, marks it, and closes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-pnl-service-"));
    const store = new PnlLedgerStore(join(root, "pnl-ledger.json"));
    const service = new PositionPnlService(store, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never);
    const bot = createBotRecord();
    const bots = [bot];

    await service.recordPositionOpened(bot.definition, bots, {
      botId: bot.definition.id,
      botName: bot.definition.name,
      whirlpoolAddress: bot.definition.whirlpoolAddress,
      tokenPair: "SOL/USDC",
      positionMint: "position-1",
      openedAt: "2026-03-14T00:00:00.000Z",
      centerPrice: 90,
      lowerPrice: 89,
      upperPrice: 91,
      entryCapitalQuote: 100,
      entryTokenA: "1000000000",
      entryTokenB: "1000000",
      residualTokenA: "50000000",
      residualTokenB: "0",
      cumulativeSwapFeeQuote: 1,
      cumulativeTxFeeLamports: 5000,
      openTxId: "open-tx"
    });

    await service.markOpenPosition(
      bot.definition,
      bots,
      {
        closePosition: vi.fn(async () => ({
          quote: {
            quote: {
              tokenMinA: "1000000000",
              tokenMinB: "1000000"
            },
            feesQuote: {
              feeOwedA: "10000000",
              feeOwedB: "5000"
            }
          }
        }))
      } as never,
      {
        botId: bot.definition.id,
        positionMint: "position-1",
        markedAt: "2026-03-14T00:10:00.000Z",
        centerPrice: 95,
        grossValueQuote: 96,
        feesEarnedQuote: 1
      }
    );

    await service.recordPositionClosed(bot.definition, bots, {
      botId: bot.definition.id,
      positionMint: "position-1",
      closedAt: "2026-03-14T00:20:00.000Z",
      centerPrice: 97,
      exitGrossQuote: 105,
      feesEarnedQuote: 3,
      closeTxId: "close-tx",
      closeTxFeeLamports: 7000
    });

    const records = await store.listRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("closed");
    expect(records[0]?.latestNetPnlUsdc).not.toBeNull();
    expect(records[0]?.realizedNetPnlUsdc).not.toBeNull();

    const dashboard = await service.getDashboardSnapshot(bots, ["orphaned-position"]);
    expect(dashboard.summary.closedPositionCount).toBe(1);
    expect(dashboard.summary.orphanedPositionCount).toBe(1);
    expect(dashboard.botSummaries[bot.definition.id]?.realizedNetPnlUsdc).toBe(records[0]?.realizedNetPnlUsdc);
  });

  it("uses the async token price resolver fallback when direct pricing is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-pnl-service-"));
    const store = new PnlLedgerStore(join(root, "pnl-ledger.json"));
    const warn = vi.fn();
    const logger = {
      info: vi.fn(),
      warn,
      error: vi.fn()
    };
    const service = new PositionPnlService(
      store,
      logger as never,
      async () => ({
        tokenAUsdc: 90,
        tokenBUsdc: 2000,
        solUsdc: 90
      })
    );
    const bot = createBotRecord({
      definition: {
        ...createBotRecord().definition,
        tokenBMint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
        tokenBSymbol: "whETH",
        tokenBDecimals: 8
      }
    });

    await service.recordPositionOpened(bot.definition, [bot], {
      botId: bot.definition.id,
      botName: bot.definition.name,
      whirlpoolAddress: bot.definition.whirlpoolAddress,
      tokenPair: "SOL/whETH",
      positionMint: "position-eth-sol",
      openedAt: "2026-03-14T00:00:00.000Z",
      centerPrice: 0.045,
      lowerPrice: 0.044,
      upperPrice: 0.046,
      entryCapitalQuote: 10,
      entryTokenA: "1",
      entryTokenB: "2",
      residualTokenA: "0",
      residualTokenB: "0",
      cumulativeSwapFeeQuote: 0.1,
      cumulativeTxFeeLamports: 5000,
      openTxId: "open-tx"
    });

    const records = await store.listRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.entryCapitalUsdc).toBe(20_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("repairs open records that were previously stored in quote-token units instead of USD", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-pnl-service-"));
    const store = new PnlLedgerStore(join(root, "pnl-ledger.json"));
    const service = new PositionPnlService(
      store,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never,
      async () => ({
        tokenAUsdc: 90,
        tokenBUsdc: 2_000,
        solUsdc: 90
      })
    );
    const bot = createBotRecord({
      definition: {
        ...createBotRecord().definition,
        tokenBMint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
        tokenBSymbol: "whETH",
        tokenBDecimals: 8
      }
    });

    await store.saveRecord({
      id: "record-1",
      botId: bot.definition.id,
      botName: bot.definition.name,
      whirlpoolAddress: bot.definition.whirlpoolAddress,
      tokenPair: "SOL/whETH",
      positionMint: "position-eth-sol",
      status: "open",
      openedAt: "2026-03-14T00:00:00.000Z",
      closedAt: null,
      entryCenterPrice: 0.045,
      entryLowerPrice: 0.044,
      entryUpperPrice: 0.046,
      entryCapitalUsdc: 10,
      entryTokenA: "1",
      entryTokenB: "2",
      residualTokenA: "0",
      residualTokenB: "0",
      cumulativeSwapFeesUsdc: 0.1,
      cumulativeTxFeesUsdc: 0.01,
      feesEarnedUsdc: 0.02,
      latestGrossValueUsdc: 10.1,
      latestNetPnlUsdc: 0,
      lastMarkedAt: "2026-03-14T00:00:00.000Z",
      exitGrossValueUsdc: null,
      realizedNetPnlUsdc: null,
      openTxId: "open-tx",
      closeTxId: null,
      bootstrapped: false
    });

    await service.markOpenPosition(
      bot.definition,
      [bot],
      {
        closePosition: vi.fn(async () => ({
          quote: {
            quote: {
              tokenMinA: "0",
              tokenMinB: "0"
            },
            feesQuote: {
              feeOwedA: "0",
              feeOwedB: "0"
            }
          }
        }))
      } as never,
      {
        botId: bot.definition.id,
        positionMint: "position-eth-sol",
        markedAt: "2026-03-14T00:10:00.000Z",
        centerPrice: 0.045,
        grossValueQuote: 10.1,
        feesEarnedQuote: 0.03
      }
    );

    const records = await store.listRecords();
    expect(records[0]?.entryCapitalUsdc).toBe(20_000);
    expect(records[0]?.cumulativeSwapFeesUsdc).toBe(200);
    expect(records[0]?.latestGrossValueUsdc).toBe(20_200);
    expect(records[0]?.feesEarnedUsdc).toBe(60);
  });
});
