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
        feesEarnedQuote: 1,
        grossTokenA: "1010000000",
        grossTokenB: "1005000"
      }
    );

    await service.recordPositionClosed(bot.definition, bots, {
      botId: bot.definition.id,
      positionMint: "position-1",
      closedAt: "2026-03-14T00:20:00.000Z",
      centerPrice: 97,
      exitGrossQuote: 105,
      feesEarnedQuote: 3,
      exitTokenA: "1050000000",
      exitTokenB: "3000000",
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
      entryTokenA: "0",
      entryTokenB: "0",
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
      entryTokenA: "0",
      entryTokenB: "0",
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
        feesEarnedQuote: 0.03,
        grossTokenA: "0",
        grossTokenB: "0"
      }
    );

    const records = await store.listRecords();
    expect(records[0]?.entryCapitalUsdc).toBe(20_000);
    expect(records[0]?.cumulativeSwapFeesUsdc).toBe(200);
    expect(records[0]?.latestGrossValueUsdc).toBe(20_200);
    expect(records[0]?.feesEarnedUsdc).toBe(60);
  });

  it("repairs an inconsistent open entry basis from the recorded opening token amounts", async () => {
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
        tokenAUsdc: 150,
        tokenBUsdc: 3_600,
        solUsdc: 150
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
      id: "record-2",
      botId: bot.definition.id,
      botName: bot.definition.name,
      whirlpoolAddress: bot.definition.whirlpoolAddress,
      tokenPair: "SOL/whETH",
      positionMint: "position-eth-sol-basis",
      status: "open",
      openedAt: "2026-03-14T00:00:00.000Z",
      closedAt: null,
      entryCenterPrice: 0.0416666667,
      entryLowerPrice: 0.041,
      entryUpperPrice: 0.042,
      entryCapitalUsdc: 320_000,
      entryTokenA: "840000000",
      entryTokenB: "700000",
      residualTokenA: "0",
      residualTokenB: "0",
      cumulativeSwapFeesUsdc: 0.01,
      cumulativeTxFeesUsdc: 0.01,
      feesEarnedUsdc: 0.01,
      latestGrossValueUsdc: 151,
      latestNetPnlUsdc: -319_849,
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
        positionMint: "position-eth-sol-basis",
        markedAt: "2026-03-14T00:10:00.000Z",
        centerPrice: 0.0416666667,
        grossValueQuote: 0.0427083334,
        feesEarnedQuote: 0.00001,
        grossTokenA: "0",
        grossTokenB: "0"
      }
    );

    const records = await store.listRecords();
    expect(records[0]?.entryCapitalUsdc).toBeCloseTo(151.2, 6);
    expect(records[0]?.latestGrossValueUsdc).toBeCloseTo(153.75, 6);
    expect(records[0]?.latestNetPnlUsdc).toBeCloseTo(2.53, 2);
  });

  it("repairs an open record from the actual token debits in the open transaction", async () => {
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
        tokenAUsdc: 150,
        tokenBUsdc: 3_600,
        solUsdc: 150
      }),
      async () => ({
        tokenA: 500_500_000n,
        tokenB: 1_993_000n
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
      id: "record-3",
      botId: bot.definition.id,
      botName: bot.definition.name,
      whirlpoolAddress: bot.definition.whirlpoolAddress,
      tokenPair: "SOL/whETH",
      positionMint: "position-eth-sol-open-tx",
      status: "open",
      openedAt: "2026-03-14T00:00:00.000Z",
      closedAt: null,
      entryCenterPrice: 0.0415756437,
      entryLowerPrice: 0.0411,
      entryUpperPrice: 0.042,
      entryCapitalUsdc: 150.93811678041808,
      entryTokenA: "840115435",
      entryTokenB: "3477225",
      residualTokenA: "0",
      residualTokenB: "0",
      cumulativeSwapFeesUsdc: 0.0048,
      cumulativeTxFeesUsdc: 0.000001,
      feesEarnedUsdc: 0.52,
      latestGrossValueUsdc: 151.14513360293333,
      latestNetPnlUsdc: 0.20,
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
        positionMint: "position-eth-sol-open-tx",
        markedAt: "2026-03-14T00:10:00.000Z",
        centerPrice: 0.0414718396,
        grossValueQuote: 0.0420375371,
        feesEarnedQuote: 0.0001338,
        grossTokenA: "500500000",
        grossTokenB: "1993000"
      }
    );

    const records = await store.listRecords();
    expect(records[0]?.entryTokenA).toBe("500500000");
    expect(records[0]?.entryTokenB).toBe("1993000");
    expect(records[0]?.entryCapitalUsdc).toBeCloseTo(146.66, 2);
    expect(records[0]?.latestNetPnlUsdc).toBeGreaterThan(4);
  });

  it("adopts the first reliable live mark when startup saved a one-sided entry basis", async () => {
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
        tokenBUsdc: 2_160,
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
      id: "record-4",
      botId: bot.definition.id,
      botName: bot.definition.name,
      whirlpoolAddress: bot.definition.whirlpoolAddress,
      tokenPair: "SOL/whETH",
      positionMint: "position-corrupted-open",
      status: "open",
      openedAt: "2026-03-14T00:00:00.000Z",
      closedAt: null,
      entryCenterPrice: 0.0415,
      entryLowerPrice: 0.041,
      entryUpperPrice: 0.042,
      entryCapitalUsdc: 73,
      entryTokenA: "0",
      entryTokenB: "3400000",
      residualTokenA: "880000000",
      residualTokenB: "50000",
      cumulativeSwapFeesUsdc: 0,
      cumulativeTxFeesUsdc: 0.001,
      feesEarnedUsdc: 0,
      latestGrossValueUsdc: 147,
      latestNetPnlUsdc: 74,
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
        positionMint: "position-corrupted-open",
        markedAt: "2026-03-14T00:10:00.000Z",
        centerPrice: 0.0416,
        grossValueQuote: 0.068,
        feesEarnedQuote: 0.0001,
        grossTokenA: "830000000",
        grossTokenB: "3400000"
      }
    );

    const records = await store.listRecords();
    expect(records[0]?.entryCapitalUsdc).toBeCloseTo(146.88, 2);
    expect(records[0]?.entryTokenA).toBe("830000000");
    expect(records[0]?.entryTokenB).toBe("3400000");
    expect(records[0]?.latestNetPnlUsdc).toBeCloseTo(-0.001, 2);
  });
});
