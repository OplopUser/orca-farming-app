import type { AppConfig } from "./config.js";
import type { BotDefinition } from "./domain.js";

export function buildBotConfig(baseConfig: AppConfig, bot: BotDefinition): AppConfig {
  return {
    ...baseConfig,
    ORCA_WHIRLPOOL_ADDRESS: bot.whirlpoolAddress,
    BOT_ALLOCATION_USDC: bot.allocationUsdc,
    RANGE_PCT: bot.rangePct,
    REBALANCE_DRIFT_PCT: bot.rebalanceDriftPct,
    POLL_SECONDS: bot.pollSeconds,
    MAX_SLIPPAGE_BPS: bot.maxSlippageBps,
    CLOSE_RETRY_SLIPPAGE_BPS: bot.closeRetrySlippageBps,
    CLOSE_FINAL_RETRY_SLIPPAGE_BPS: bot.closeFinalRetrySlippageBps,
    OPEN_RETRY_SLIPPAGE_BPS: bot.openRetrySlippageBps,
    OPEN_FINAL_RETRY_SLIPPAGE_BPS: bot.openFinalRetrySlippageBps,
    SLIPPAGE_RETRIES_PER_TIER: bot.slippageRetriesPerTier,
    OPEN_DEPLOYMENT_BUFFER_BPS: bot.openDeploymentBufferBps,
    OPEN_RETRY_DEPLOYMENT_BUFFER_BPS: bot.openRetryDeploymentBufferBps,
    OPEN_FINAL_DEPLOYMENT_BUFFER_BPS: bot.openFinalDeploymentBufferBps,
    MIN_SWAP_USDC: bot.minSwapQuoteValue,
    OPEN_BALANCE_TOLERANCE_BPS: bot.openBalanceToleranceBps,
    TOKEN_A_MINT: bot.tokenAMint,
    TOKEN_A_SYMBOL: bot.tokenASymbol,
    TOKEN_A_DECIMALS: bot.tokenADecimals,
    TOKEN_B_MINT: bot.tokenBMint,
    TOKEN_B_SYMBOL: bot.tokenBSymbol,
    TOKEN_B_DECIMALS: bot.tokenBDecimals,
    COMPOUND_INTERVAL_SECONDS: bot.compoundIntervalSeconds,
    COMPOUND_MIN_QUOTE_VALUE: bot.compoundMinQuoteValue,
    DRIFT_CONFIRM_POLLS: bot.driftConfirmPolls,
    REBALANCE_MIN_BENEFIT_MULTIPLE: bot.rebalanceMinBenefitMultiple,
    HARVEST_MIN_BENEFIT_MULTIPLE: bot.harvestMinBenefitMultiple
  };
}
