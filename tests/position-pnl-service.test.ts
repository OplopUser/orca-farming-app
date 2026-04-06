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
      slippageRetriesPerTier: 3,
      openDeploymentBufferBps: 100,
      openRetryDeploymentBufferBps: 300,
      openFinalDeploymentBufferBps: 500,
      minSwapQuoteValue: 10,
      openBalanceToleranceBps: 25,
      compoundIntervalSeconds: 0,
      compoundMinQuoteValue: 0.5,
      driftConfirmPolls: 2,
      rebalanceMinBenefitMultiple: 1.5,
      harvestMinBenefitMultiple: 2.0,
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
      initialGrossValueQuote: 99,
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
    // PnL = exitGrossValue - costBasis (Orca-style: currentValue vs initial LP value)
    // costBasis = initialGrossValueQuote (99), not entryCapitalQuote (100)
    expect(records[0]?.entryCapitalUsdc).toBe(99);
    expect(records[0]?.latestNetPnlUsdc).toBe(105 - 99);
    expect(records[0]?.realizedNetPnlUsdc).toBe(105 - 99);

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
      bootstrapped: false,
      cumulativeCompoundedFeesUsdc: 0,
      compoundCount: 0
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

  it("preserves entry capital on mark without rebasing", async () => {
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
      bootstrapped: false,
      cumulativeCompoundedFeesUsdc: 0,
      compoundCount: 0
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
    // Entry capital is frozen at deposit time — no rebasing
    expect(records[0]?.entryCapitalUsdc).toBe(320_000);
    expect(records[0]?.latestGrossValueUsdc).toBeCloseTo(153.75, 6);
    // PnL = grossValue - costBasis (Orca-style)
    expect(records[0]?.latestNetPnlUsdc).toBeCloseTo(153.75 - 320_000, 0);
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
      bootstrapped: true,
      cumulativeCompoundedFeesUsdc: 0,
      compoundCount: 0
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

  it("repairs an open record from a one-sided open transaction debit using target weights", async () => {
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
        tokenBUsdc: 2_140,
        solUsdc: 90
      }),
      async () => ({
        tokenA: 0n,
        tokenB: 3_880_626n
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
      id: "record-5",
      botId: bot.definition.id,
      botName: bot.definition.name,
      whirlpoolAddress: bot.definition.whirlpoolAddress,
      tokenPair: "SOL/whETH",
      positionMint: "position-eth-sol-partial-open-tx",
      status: "open",
      openedAt: "2026-03-24T01:06:47.246Z",
      closedAt: null,
      entryCenterPrice: 0.042445184788114626,
      entryLowerPrice: 0.04194188220169429,
      entryUpperPrice: 0.042954527005572,
      entryCapitalUsdc: 153.9902486221383,
      entryTokenA: "850526192",
      entryTokenB: "3588928",
      residualTokenA: "122976740",
      residualTokenB: "437111",
      cumulativeSwapFeesUsdc: 0,
      cumulativeTxFeesUsdc: 0.003099833049254773,
      feesEarnedUsdc: 0.004217550664515891,
      latestGrossValueUsdc: 165.76282126551564,
      latestNetPnlUsdc: 11.76947281032809,
      lastMarkedAt: "2026-03-24T01:23:35.079Z",
      exitGrossValueUsdc: null,
      realizedNetPnlUsdc: null,
      openTxId: "open-tx",
      closeTxId: null,
      bootstrapped: true,
      cumulativeCompoundedFeesUsdc: 0,
      compoundCount: 0
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
        positionMint: "position-eth-sol-partial-open-tx",
        markedAt: "2026-03-24T01:23:35.079Z",
        centerPrice: 0.042373092873998736,
        grossValueQuote: 0.0772526458584296,
        feesEarnedQuote: 0.0000033056496983026057,
        grossTokenA: "1034542982",
        grossTokenB: "3341586"
      }
    );

    const records = await store.listRecords();
    expect(records[0]?.entryCapitalUsdc).toBeCloseTo(166.09, 2);
    expect(records[0]?.entryTokenB).toBe("3880626");
    expect(records[0]?.latestNetPnlUsdc).toBeLessThan(0);
    expect(records[0]?.latestNetPnlUsdc).toBeGreaterThan(-1);
  });

  it("preserves entry capital without rebasing for non-bootstrapped positions", async () => {
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
      positionMint: "position-frozen-entry",
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
      bootstrapped: false,
      cumulativeCompoundedFeesUsdc: 0,
      compoundCount: 0
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
        positionMint: "position-frozen-entry",
        markedAt: "2026-03-14T00:10:00.000Z",
        centerPrice: 0.0416,
        grossValueQuote: 0.068,
        feesEarnedQuote: 0.0001,
        grossTokenA: "830000000",
        grossTokenB: "3400000"
      }
    );

    const records = await store.listRecords();
    // Entry capital frozen at deposit-time value — no rebasing (Orca-style)
    expect(records[0]?.entryCapitalUsdc).toBe(73);
    // PnL = grossValue - costBasis (Orca-style)
    const expectedGross = 0.068 * 2_160;
    expect(records[0]?.latestGrossValueUsdc).toBeCloseTo(expectedGross, 1);
    expect(records[0]?.latestNetPnlUsdc).toBeCloseTo(expectedGross - 73, 1);
  });

  it("reconciles stale open records that are no longer live on-chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-pnl-service-"));
    const store = new PnlLedgerStore(join(root, "pnl-ledger.json"));
    const service = new PositionPnlService(
      store,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    );
    const activeBot = createBotRecord();
    const archivedBot = createBotRecord({
      definition: {
        ...createBotRecord().definition,
        id: "bot-archived",
        enabled: false,
        archived: true
      },
      runtime: {
        ...createEmptyBotRuntimeState(),
        monitoringActive: false
      }
    });

    await store.saveRecord({
      id: "record-live",
      botId: activeBot.definition.id,
      botName: activeBot.definition.name,
      whirlpoolAddress: activeBot.definition.whirlpoolAddress,
      tokenPair: "SOL/USDC",
      positionMint: "live-position",
      status: "open",
      openedAt: "2026-03-14T00:00:00.000Z",
      closedAt: null,
      entryCenterPrice: 90,
      entryLowerPrice: 89,
      entryUpperPrice: 91,
      entryCapitalUsdc: 100,
      entryTokenA: "1",
      entryTokenB: "1",
      residualTokenA: "0",
      residualTokenB: "0",
      cumulativeSwapFeesUsdc: 0,
      cumulativeTxFeesUsdc: 0,
      feesEarnedUsdc: 1,
      latestGrossValueUsdc: 101,
      latestNetPnlUsdc: 1,
      lastMarkedAt: "2026-03-14T00:10:00.000Z",
      exitGrossValueUsdc: null,
      realizedNetPnlUsdc: null,
      openTxId: "open-live",
      closeTxId: null,
      bootstrapped: false,
      cumulativeCompoundedFeesUsdc: 0,
      compoundCount: 0
    });
    await store.saveRecord({
      id: "record-stale",
      botId: archivedBot.definition.id,
      botName: archivedBot.definition.name,
      whirlpoolAddress: archivedBot.definition.whirlpoolAddress,
      tokenPair: "SOL/USDC",
      positionMint: "stale-position",
      status: "open",
      openedAt: "2026-03-14T00:00:00.000Z",
      closedAt: null,
      entryCenterPrice: 90,
      entryLowerPrice: 89,
      entryUpperPrice: 91,
      entryCapitalUsdc: 100,
      entryTokenA: "1",
      entryTokenB: "1",
      residualTokenA: "0",
      residualTokenB: "0",
      cumulativeSwapFeesUsdc: 0,
      cumulativeTxFeesUsdc: 0,
      feesEarnedUsdc: 2,
      latestGrossValueUsdc: 98,
      latestNetPnlUsdc: -2,
      lastMarkedAt: "2026-03-14T00:10:00.000Z",
      exitGrossValueUsdc: null,
      realizedNetPnlUsdc: null,
      openTxId: "open-stale",
      closeTxId: null,
      bootstrapped: false,
      cumulativeCompoundedFeesUsdc: 0,
      compoundCount: 0
    });

    const dashboard = await service.getDashboardSnapshot(
      [
        {
          ...activeBot,
          runtime: {
            ...activeBot.runtime,
            activePositionMint: "live-position"
          }
        },
        archivedBot
      ],
      ["live-position"]
    );

    const staleRecord = dashboard.positions.find((record) => record.positionMint === "stale-position");
    expect(staleRecord?.status).toBe("closed");
    expect(staleRecord?.closeTxId).toBe("reconciled-missing-on-chain");
    expect(dashboard.summary.openPositionCount).toBe(1);
    expect(dashboard.summary.closedPositionCount).toBe(1);
  });
});
