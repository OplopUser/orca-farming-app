import type {
  BotDefinition,
  BotPnlSummary,
  GlobalPnlSummary,
  PositionPnlRecord
} from "../domain.js";
import { fromBaseUnits } from "../strategy/bands.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface TokenPricesUsdc {
  tokenAUsdc: number;
  tokenBUsdc: number;
  solUsdc: number;
}

export function quoteValueFromRaw(
  currentPrice: number,
  tokenA: bigint,
  tokenB: bigint,
  tokenADecimals: number,
  tokenBDecimals: number
) {
  return fromBaseUnits(tokenA, tokenADecimals) * currentPrice + fromBaseUnits(tokenB, tokenBDecimals);
}

export function lamportsToUsdc(lamports: number, solUsdc: number) {
  return lamports / 1_000_000_000 * solUsdc;
}

export function computeNetPnl(
  grossValueUsdc: number,
  entryCapitalUsdc: number,
  cumulativeSwapFeesUsdc: number,
  cumulativeTxFeesUsdc: number
) {
  return grossValueUsdc - entryCapitalUsdc - cumulativeSwapFeesUsdc - cumulativeTxFeesUsdc;
}

export function summarizeBotPnl(
  records: PositionPnlRecord[],
  botId: string,
  activePositionMints?: Set<string>
): BotPnlSummary {
  const botRecords = records.filter((record) => record.botId === botId);
  const openNetPnlUsdc = botRecords
    .filter((record) => record.status === "open" && (!activePositionMints || activePositionMints.has(record.positionMint)))
    .reduce((sum, record) => sum + (record.latestNetPnlUsdc ?? 0), 0);
  // Realized = explicitly closed + stale open positions no longer actively managed
  const realizedNetPnlUsdc = botRecords
    .filter((record) =>
      record.status === "closed" ||
      (record.status === "open" && activePositionMints && !activePositionMints.has(record.positionMint))
    )
    .reduce((sum, record) => sum + (record.status === "closed" ? (record.realizedNetPnlUsdc ?? 0) : (record.latestNetPnlUsdc ?? 0)), 0);
  const feesEarnedUsdc = botRecords.reduce((sum, record) => sum + (record.feesEarnedUsdc ?? 0), 0);

  return {
    botId,
    openNetPnlUsdc,
    realizedNetPnlUsdc,
    totalNetPnlUsdc: openNetPnlUsdc + realizedNetPnlUsdc,
    feesEarnedUsdc,
    openPositionCount: botRecords.filter((record) => record.status === "open" && (!activePositionMints || activePositionMints.has(record.positionMint))).length,
    closedPositionCount: botRecords.filter((record) =>
      record.status === "closed" ||
      (record.status === "open" && activePositionMints && !activePositionMints.has(record.positionMint))
    ).length
  };
}

export function summarizeGlobalPnl(
  records: PositionPnlRecord[],
  orphanedPositionCount: number,
  activePositionMints?: Set<string>
): GlobalPnlSummary {
  const openNetPnlUsdc = records
    .filter((record) => record.status === "open" && (!activePositionMints || activePositionMints.has(record.positionMint)))
    .reduce((sum, record) => sum + (record.latestNetPnlUsdc ?? 0), 0);
  // Realized = explicitly closed + stale open positions no longer actively managed
  const realizedNetPnlUsdc = records
    .filter((record) =>
      record.status === "closed" ||
      (record.status === "open" && activePositionMints && !activePositionMints.has(record.positionMint))
    )
    .reduce((sum, record) => sum + (record.status === "closed" ? (record.realizedNetPnlUsdc ?? 0) : (record.latestNetPnlUsdc ?? 0)), 0);
  const feesEarnedUsdc = records.reduce((sum, record) => sum + (record.feesEarnedUsdc ?? 0), 0);

  return {
    totalNetPnlUsdc: openNetPnlUsdc + realizedNetPnlUsdc,
    realizedNetPnlUsdc,
    openNetPnlUsdc,
    feesEarnedUsdc,
    openPositionCount: records.filter((record) => record.status === "open" && (!activePositionMints || activePositionMints.has(record.positionMint))).length,
    closedPositionCount: records.filter((record) =>
      record.status === "closed" ||
      (record.status === "open" && activePositionMints && !activePositionMints.has(record.positionMint))
    ).length,
    orphanedPositionCount
  };
}

export function resolveTokenPricesUsdc(
  bot: BotDefinition,
  currentPrice: number,
  bots: Array<{ definition: BotDefinition; runtime: { lastObservedPrice: number | null; lastCenterPrice: number | null } }>
): TokenPricesUsdc | null {
  const resolved = resolveTokenPricesUsdcStrict(bot, currentPrice, bots);
  if (resolved) {
    return resolved;
  }

  // Fallback: use quote-token-native values (tokenBUsdc = 1) so PnL marks
  // are never skipped. Values are internally consistent within the pool's
  // quote token, and PnL (fees, IL) remains meaningful even without USD conversion.
  return {
    tokenAUsdc: currentPrice,
    tokenBUsdc: 1,
    solUsdc: bot.tokenAMint === SOL_MINT ? currentPrice : (bot.tokenBMint === SOL_MINT ? 1 : 0)
  };
}

export function resolveTokenPricesUsdcStrict(
  bot: BotDefinition,
  currentPrice: number,
  bots: Array<{ definition: BotDefinition; runtime: { lastObservedPrice: number | null; lastCenterPrice: number | null } }>
): TokenPricesUsdc | null {
  const direct = resolveDirectTokenPrices(bot, currentPrice);
  if (direct) {
    return direct;
  }

  const solUsdc = resolveSolUsdcPrice(bots);
  if (solUsdc) {
    if (bot.tokenAMint === SOL_MINT) {
      return {
        tokenAUsdc: solUsdc,
        tokenBUsdc: solUsdc / currentPrice,
        solUsdc
      };
    }

    if (bot.tokenBMint === SOL_MINT) {
      return {
        tokenAUsdc: currentPrice * solUsdc,
        tokenBUsdc: solUsdc,
        solUsdc
      };
    }
  }

  return null;
}

function resolveDirectTokenPrices(bot: BotDefinition, currentPrice: number): TokenPricesUsdc | null {
  if (bot.tokenBMint === USDC_MINT) {
    const solUsdc = bot.tokenAMint === SOL_MINT ? currentPrice : 0;
    return {
      tokenAUsdc: currentPrice,
      tokenBUsdc: 1,
      solUsdc
    };
  }

  if (bot.tokenAMint === USDC_MINT) {
    const tokenBUsdc = 1 / currentPrice;
    const solUsdc = bot.tokenBMint === SOL_MINT ? tokenBUsdc : 0;
    return {
      tokenAUsdc: 1,
      tokenBUsdc,
      solUsdc
    };
  }

  return null;
}

function resolveSolUsdcPrice(
  bots: Array<{ definition: BotDefinition; runtime: { lastObservedPrice: number | null; lastCenterPrice: number | null } }>
) {
  for (const bot of bots) {
    const observedPrice = bot.runtime.lastObservedPrice ?? bot.runtime.lastCenterPrice;
    if (!observedPrice) {
      continue;
    }

    if (bot.definition.tokenAMint === SOL_MINT && bot.definition.tokenBMint === USDC_MINT) {
      return observedPrice;
    }

    if (bot.definition.tokenAMint === USDC_MINT && bot.definition.tokenBMint === SOL_MINT) {
      return 1 / observedPrice;
    }
  }

  return null;
}
