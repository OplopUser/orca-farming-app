import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { BotRecord, BotDefinition, GlobalPnlSummary, PositionLedgerCloseInput, PositionLedgerMarkInput, PositionLedgerOpenInput, PositionPnlRecord, BotPnlSummary } from "../domain.js";
import { OrcaClient } from "../clients/orcaClient.js";
import { PnlLedgerStore } from "../state/pnlLedgerStore.js";
import {
  computeNetPnl,
  lamportsToUsdc,
  quoteValueFromRaw,
  resolveTokenPricesUsdc,
  type TokenPricesUsdc,
  summarizeBotPnl,
  summarizeGlobalPnl
} from "./pnlMath.js";

export interface PnlDashboardSnapshot {
  summary: GlobalPnlSummary;
  botSummaries: Record<string, BotPnlSummary>;
  positions: PositionPnlRecord[];
}

type TokenPriceResolver = (
  bot: BotDefinition,
  bots: BotRecord[],
  currentPrice: number
) => Promise<TokenPricesUsdc | null>;

type OpenTransactionDebitResolver = (
  bot: BotDefinition,
  openTxId: string
) => Promise<{ tokenA: bigint; tokenB: bigint } | null>;

export class PositionPnlService {
  constructor(
    private readonly ledgerStore: PnlLedgerStore,
    private readonly logger: Logger,
    private readonly resolveTokenPrices: TokenPriceResolver = async (bot, bots, currentPrice) =>
      resolveTokenPricesUsdc(bot, currentPrice, bots),
    private readonly resolveOpenTransactionDebits?: OpenTransactionDebitResolver
  ) {}

  async recordPositionOpened(bot: BotDefinition, bots: BotRecord[], input: PositionLedgerOpenInput) {
    const prices = await this.resolveTokenPrices(bot, bots, input.centerPrice);
    if (!prices) {
      this.logger.warn({ botId: bot.id, positionMint: input.positionMint }, "skipping pnl open record because token prices could not be resolved");
      return;
    }

    const record: PositionPnlRecord = {
      id: randomUUID(),
      botId: input.botId,
      botName: input.botName,
      whirlpoolAddress: input.whirlpoolAddress,
      tokenPair: input.tokenPair,
      positionMint: input.positionMint,
      status: "open",
      openedAt: input.openedAt,
      closedAt: null,
      entryCenterPrice: input.centerPrice,
      entryLowerPrice: input.lowerPrice,
      entryUpperPrice: input.upperPrice,
      entryCapitalUsdc: input.entryCapitalQuote * prices.tokenBUsdc,
      entryTokenA: input.entryTokenA,
      entryTokenB: input.entryTokenB,
      residualTokenA: input.residualTokenA,
      residualTokenB: input.residualTokenB,
      cumulativeSwapFeesUsdc: input.cumulativeSwapFeeQuote * prices.tokenBUsdc,
      cumulativeTxFeesUsdc: lamportsToUsdc(input.cumulativeTxFeeLamports, prices.solUsdc),
      feesEarnedUsdc: 0,
      latestGrossValueUsdc: input.entryCapitalQuote * prices.tokenBUsdc,
      latestNetPnlUsdc: computeNetPnl(
        input.entryCapitalQuote * prices.tokenBUsdc,
        input.entryCapitalQuote * prices.tokenBUsdc,
        input.cumulativeSwapFeeQuote * prices.tokenBUsdc,
        lamportsToUsdc(input.cumulativeTxFeeLamports, prices.solUsdc)
      ),
      lastMarkedAt: input.openedAt,
      exitGrossValueUsdc: null,
      realizedNetPnlUsdc: null,
      openTxId: input.openTxId,
      closeTxId: null,
      bootstrapped: Boolean(input.bootstrapped)
    };

    const existingOpen = await this.ledgerStore.getOpenRecordByBotId(bot.id);
    if (existingOpen && existingOpen.positionMint !== input.positionMint) {
      existingOpen.status = "closed";
      existingOpen.closedAt = input.openedAt;
      existingOpen.exitGrossValueUsdc = existingOpen.latestGrossValueUsdc;
      existingOpen.realizedNetPnlUsdc = existingOpen.latestNetPnlUsdc;
      existingOpen.closeTxId = existingOpen.closeTxId ?? "superseded";
      await this.ledgerStore.saveRecord(existingOpen);
    }

    await this.ledgerStore.saveRecord(record);
  }

  async recordPositionClosed(bot: BotDefinition, bots: BotRecord[], input: PositionLedgerCloseInput) {
    const record = await this.ledgerStore.getRecordByPositionMint(input.positionMint);
    const prices = await this.resolveTokenPrices(bot, bots, input.centerPrice);
    if (!prices) {
      this.logger.warn({ botId: bot.id, positionMint: input.positionMint }, "skipping pnl close record because token prices could not be resolved");
      return;
    }

    const exitGrossValueUsdc = input.exitGrossQuote * prices.tokenBUsdc;
    const closeTxFeesUsdc = lamportsToUsdc(input.closeTxFeeLamports, prices.solUsdc);

    if (!record) {
      const bootstrapped: PositionPnlRecord = {
        id: randomUUID(),
        botId: input.botId,
        botName: bot.name,
        whirlpoolAddress: bot.whirlpoolAddress,
        tokenPair: `${bot.tokenASymbol}/${bot.tokenBSymbol}`,
        positionMint: input.positionMint,
        status: "closed",
        openedAt: input.closedAt,
        closedAt: input.closedAt,
        entryCenterPrice: input.centerPrice,
        entryLowerPrice: null,
        entryUpperPrice: null,
        entryCapitalUsdc: exitGrossValueUsdc,
        entryTokenA: "0",
        entryTokenB: "0",
        residualTokenA: "0",
        residualTokenB: "0",
        cumulativeSwapFeesUsdc: 0,
        cumulativeTxFeesUsdc: closeTxFeesUsdc,
        feesEarnedUsdc: input.feesEarnedQuote * prices.tokenBUsdc,
        latestGrossValueUsdc: exitGrossValueUsdc,
        latestNetPnlUsdc: -closeTxFeesUsdc,
        lastMarkedAt: input.closedAt,
        exitGrossValueUsdc,
        realizedNetPnlUsdc: -closeTxFeesUsdc,
        openTxId: null,
        closeTxId: input.closeTxId,
        bootstrapped: true
      };
      await this.ledgerStore.saveRecord(bootstrapped);
      return;
    }

    this.repairQuoteNativeUsdRecord(record, input.exitGrossQuote, prices);
    this.repairCorruptedClosedBasis(record, input, exitGrossValueUsdc);

    record.status = "closed";
    record.closedAt = input.closedAt;
    record.cumulativeTxFeesUsdc += closeTxFeesUsdc;
    record.feesEarnedUsdc = input.feesEarnedQuote * prices.tokenBUsdc;
    record.latestGrossValueUsdc = exitGrossValueUsdc;
    record.latestNetPnlUsdc = computeNetPnl(
      exitGrossValueUsdc,
      record.entryCapitalUsdc,
      record.cumulativeSwapFeesUsdc,
      record.cumulativeTxFeesUsdc
    );
    record.lastMarkedAt = input.closedAt;
    record.exitGrossValueUsdc = exitGrossValueUsdc;
    record.realizedNetPnlUsdc = record.latestNetPnlUsdc;
    record.closeTxId = input.closeTxId;

    await this.ledgerStore.saveRecord(record);
  }

  private repairCorruptedClosedBasis(
    record: PositionPnlRecord,
    input: PositionLedgerCloseInput,
    exitGrossValueUsdc: number
  ) {
    const entryTokenA = this.parseBigInt(record.entryTokenA);
    const entryTokenB = this.parseBigInt(record.entryTokenB);
    const oneSidedEntry = (entryTokenA <= 0n && entryTokenB > 0n) || (entryTokenB <= 0n && entryTokenA > 0n);
    const distortedBasis =
      !Number.isFinite(record.entryCapitalUsdc) ||
      record.entryCapitalUsdc <= 0 ||
      Math.abs(record.entryCapitalUsdc - exitGrossValueUsdc) / exitGrossValueUsdc > 0.25;

    if (!oneSidedEntry || !distortedBasis) {
      return;
    }

    record.entryCapitalUsdc = exitGrossValueUsdc;
    record.entryTokenA = input.exitTokenA;
    record.entryTokenB = input.exitTokenB;
  }

  async markOpenPosition(bot: BotDefinition, bots: BotRecord[], client: OrcaClient, input: PositionLedgerMarkInput) {
    let record = await this.ledgerStore.getRecordByPositionMint(input.positionMint);
    const prices = await this.resolveTokenPrices(bot, bots, input.centerPrice);
    if (!prices) {
      this.logger.warn({ botId: bot.id, positionMint: input.positionMint }, "skipping pnl mark because token prices could not be resolved");
      return;
    }

    if (!record) {
      const closeResult = await client.closePosition(input.positionMint, false);
      const { grossValueQuote } = describeCloseQuote(
        input.centerPrice,
        closeResult.quote,
        bot.tokenADecimals,
        bot.tokenBDecimals
      );

      record = {
        id: randomUUID(),
        botId: bot.id,
        botName: bot.name,
        whirlpoolAddress: bot.whirlpoolAddress,
        tokenPair: `${bot.tokenASymbol}/${bot.tokenBSymbol}`,
        positionMint: input.positionMint,
        status: "open",
        openedAt: input.markedAt,
        closedAt: null,
        entryCenterPrice: input.centerPrice,
        entryLowerPrice: null,
        entryUpperPrice: null,
        entryCapitalUsdc: grossValueQuote * prices.tokenBUsdc,
        entryTokenA: "0",
        entryTokenB: "0",
        residualTokenA: "0",
        residualTokenB: "0",
        cumulativeSwapFeesUsdc: 0,
        cumulativeTxFeesUsdc: 0,
        feesEarnedUsdc: input.feesEarnedQuote * prices.tokenBUsdc,
        latestGrossValueUsdc: grossValueQuote * prices.tokenBUsdc,
        latestNetPnlUsdc: 0,
        lastMarkedAt: input.markedAt,
        exitGrossValueUsdc: null,
        realizedNetPnlUsdc: null,
        openTxId: null,
        closeTxId: null,
        bootstrapped: true
      };
    }

    this.repairQuoteNativeUsdRecord(record, input.grossValueQuote, prices);
    await this.repairOpenTransactionBasis(record, bot, prices);
    this.repairInconsistentOpenBasis(record, bot, prices);

    const latestGrossValueUsdc = input.grossValueQuote * prices.tokenBUsdc;
    this.repairCorruptedOpenBasis(record, input, latestGrossValueUsdc);
    if (
      record.bootstrapped &&
      !record.openTxId &&
      latestGrossValueUsdc > 0 &&
      (!Number.isFinite(record.entryCapitalUsdc) ||
        record.entryCapitalUsdc <= 0 ||
        Math.abs(record.entryCapitalUsdc - latestGrossValueUsdc) / latestGrossValueUsdc > 0.25)
    ) {
      // Recovered positions can be adopted after an open timeout without a trustworthy entry basis.
      // Snap the entry basis to the first reliable close quote so dashboard PnL reflects the live LP.
      record.entryCapitalUsdc = latestGrossValueUsdc;
    }

    record.feesEarnedUsdc = input.feesEarnedQuote * prices.tokenBUsdc;
    record.latestGrossValueUsdc = latestGrossValueUsdc;
    record.latestNetPnlUsdc = computeNetPnl(
      latestGrossValueUsdc,
      record.entryCapitalUsdc,
      record.cumulativeSwapFeesUsdc,
      record.cumulativeTxFeesUsdc
    );
    record.lastMarkedAt = input.markedAt;

    await this.ledgerStore.saveRecord(record);
  }

  private repairCorruptedOpenBasis(
    record: PositionPnlRecord,
    input: PositionLedgerMarkInput,
    latestGrossValueUsdc: number
  ) {
    if (record.status !== "open" || !Number.isFinite(latestGrossValueUsdc) || latestGrossValueUsdc <= 0) {
      return;
    }

    const entryTokenA = this.parseBigInt(record.entryTokenA);
    const entryTokenB = this.parseBigInt(record.entryTokenB);
    const oneSidedEntry = (entryTokenA <= 0n && entryTokenB > 0n) || (entryTokenB <= 0n && entryTokenA > 0n);
    const distortedBasis =
      !Number.isFinite(record.entryCapitalUsdc) ||
      record.entryCapitalUsdc <= 0 ||
      Math.abs(record.entryCapitalUsdc - latestGrossValueUsdc) / latestGrossValueUsdc > 0.25;

    if (!oneSidedEntry || !distortedBasis) {
      return;
    }

    record.entryCapitalUsdc = latestGrossValueUsdc;
    record.entryTokenA = input.grossTokenA;
    record.entryTokenB = input.grossTokenB;
  }

  private async repairOpenTransactionBasis(
    record: PositionPnlRecord,
    bot: BotDefinition,
    prices: TokenPricesUsdc
  ) {
    if (record.status !== "open" || !record.openTxId || !this.resolveOpenTransactionDebits) {
      return;
    }

    try {
      const debits = await this.resolveOpenTransactionDebits(bot, record.openTxId);
      if (!debits || debits.tokenA <= 0n || debits.tokenB <= 0n) {
        return;
      }

      const expectedEntryCapitalUsdc = quoteValueFromRaw(
        record.entryCenterPrice,
        debits.tokenA,
        debits.tokenB,
        bot.tokenADecimals,
        bot.tokenBDecimals
      ) * prices.tokenBUsdc;

      if (!Number.isFinite(expectedEntryCapitalUsdc) || expectedEntryCapitalUsdc <= 0) {
        return;
      }

      const recordedTokenA = this.parseBigInt(record.entryTokenA);
      const recordedTokenB = this.parseBigInt(record.entryTokenB);
      const tokenMismatch =
        recordedTokenA !== debits.tokenA ||
        recordedTokenB !== debits.tokenB;
      const basisDelta = Math.abs(record.entryCapitalUsdc - expectedEntryCapitalUsdc) / expectedEntryCapitalUsdc;

      if (!tokenMismatch && basisDelta <= 0.01) {
        return;
      }

      record.entryTokenA = debits.tokenA.toString();
      record.entryTokenB = debits.tokenB.toString();
      record.entryCapitalUsdc = expectedEntryCapitalUsdc;
    } catch (error) {
      this.logger.warn(
        {
          botId: bot.id,
          positionMint: record.positionMint,
          openTxId: record.openTxId,
          error: (error as Error).message
        },
        "open transaction basis repair failed"
      );
    }
  }

  private repairQuoteNativeUsdRecord(
    record: PositionPnlRecord,
    latestGrossValueQuote: number,
    prices: TokenPricesUsdc
  ) {
    if (record.status !== "open") {
      return;
    }

    if (
      !Number.isFinite(prices.tokenBUsdc) ||
      prices.tokenBUsdc <= 1.25 ||
      !Number.isFinite(latestGrossValueQuote) ||
      latestGrossValueQuote <= 0
    ) {
      return;
    }

    const storedGrossValue = record.latestGrossValueUsdc ?? record.entryCapitalUsdc;
    if (!Number.isFinite(storedGrossValue) || storedGrossValue <= 0) {
      return;
    }

    const quoteNativeDelta = Math.abs(storedGrossValue - latestGrossValueQuote) / latestGrossValueQuote;
    const expectedUsdValue = latestGrossValueQuote * prices.tokenBUsdc;
    const usdDelta = Math.abs(storedGrossValue - expectedUsdValue) / expectedUsdValue;

    if (quoteNativeDelta > 0.1 || usdDelta < 0.5) {
      return;
    }

    record.entryCapitalUsdc *= prices.tokenBUsdc;
    record.cumulativeSwapFeesUsdc *= prices.tokenBUsdc;
    record.feesEarnedUsdc *= prices.tokenBUsdc;
    if (record.latestGrossValueUsdc != null) {
      record.latestGrossValueUsdc *= prices.tokenBUsdc;
    }
    if (record.exitGrossValueUsdc != null) {
      record.exitGrossValueUsdc *= prices.tokenBUsdc;
    }
    if (record.realizedNetPnlUsdc != null) {
      record.realizedNetPnlUsdc = computeNetPnl(
        record.exitGrossValueUsdc ?? record.latestGrossValueUsdc ?? record.entryCapitalUsdc,
        record.entryCapitalUsdc,
        record.cumulativeSwapFeesUsdc,
        record.cumulativeTxFeesUsdc
      );
    }
  }

  private repairInconsistentOpenBasis(
    record: PositionPnlRecord,
    bot: BotDefinition,
    prices: TokenPricesUsdc
  ) {
    if (record.status !== "open" || !Number.isFinite(record.entryCenterPrice) || record.entryCenterPrice <= 0) {
      return;
    }

    let entryTokenA: bigint;
    let entryTokenB: bigint;
    try {
      entryTokenA = BigInt(record.entryTokenA);
      entryTokenB = BigInt(record.entryTokenB);
    } catch {
      return;
    }

    if (entryTokenA <= 0n && entryTokenB <= 0n) {
      return;
    }

    const expectedEntryCapitalUsdc = quoteValueFromRaw(
      record.entryCenterPrice,
      entryTokenA,
      entryTokenB,
      bot.tokenADecimals,
      bot.tokenBDecimals
    ) * prices.tokenBUsdc;

    if (!Number.isFinite(expectedEntryCapitalUsdc) || expectedEntryCapitalUsdc <= 0) {
      return;
    }

    const basisDelta = Math.abs(record.entryCapitalUsdc - expectedEntryCapitalUsdc) / expectedEntryCapitalUsdc;
    if (basisDelta <= 0.5) {
      return;
    }

    record.entryCapitalUsdc = expectedEntryCapitalUsdc;
  }

  private parseBigInt(value: string) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }

  async getDashboardSnapshot(bots: BotRecord[], livePositionMints: string[]): Promise<PnlDashboardSnapshot> {
    const positions = await this.ledgerStore.listRecords();
    // Build the set of position mints actively managed by enabled, non-archived bots
    const activePositionMints = new Set<string>(
      bots
        .filter((bot) => bot.definition.enabled && !bot.definition.archived && bot.runtime.activePositionMint)
        .map((bot) => bot.runtime.activePositionMint!)
    );
    const botSummaries = Object.fromEntries(
      bots.map((bot) => [bot.definition.id, summarizeBotPnl(positions, bot.definition.id, activePositionMints)])
    );
    const orphanedPositionCount = livePositionMints.filter(
      (positionMint) => !positions.some((record) => record.status === "open" && record.positionMint === positionMint)
    ).length;

    return {
      summary: summarizeGlobalPnl(positions, orphanedPositionCount, activePositionMints),
      botSummaries,
      positions
    };
  }
}

export function describeCloseQuote(
  currentPrice: number,
  quote: any,
  tokenADecimals: number,
  tokenBDecimals: number
) {
  const tokenEstA = BigInt(quote?.quote?.tokenEstA ?? quote?.quote?.tokenMinA ?? 0);
  const tokenEstB = BigInt(quote?.quote?.tokenEstB ?? quote?.quote?.tokenMinB ?? 0);
  const feeOwedA = BigInt(quote?.feesQuote?.feeOwedA ?? 0);
  const feeOwedB = BigInt(quote?.feesQuote?.feeOwedB ?? 0);
  const grossTokenA = tokenEstA + feeOwedA;
  const grossTokenB = tokenEstB + feeOwedB;

  return {
    grossValueQuote: quoteValueFromRaw(
      currentPrice,
      grossTokenA,
      grossTokenB,
      tokenADecimals,
      tokenBDecimals
    ),
    feesEarnedQuote: quoteValueFromRaw(currentPrice, feeOwedA, feeOwedB, tokenADecimals, tokenBDecimals),
    grossTokenA,
    grossTokenB
  };
}
