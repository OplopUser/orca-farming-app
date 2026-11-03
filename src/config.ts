import dotenv from "dotenv";
import { z } from "zod";

import { normalizeRpcUrls } from "./infra/rpcFailover.js";

dotenv.config({ override: true });

export const envSchema = z.object({
  SOLANA_RPC_URL: z.url(),
  SOLANA_RPC_FALLBACK_URLS: z.string().default(""),
  BOT_WALLET_KEYPAIR_PATH: z.string().min(1),
  ORCA_WHIRLPOOL_ADDRESS: z.string().min(1),
  BOT_STATE_FILE: z.string().default("./data/state.json"),
  BOT_REGISTRY_FILE: z.string().default("./data/bots.json"),
  BOT_PNL_LEDGER_FILE: z.string().default("./data/pnl-ledger.json"),
  LOG_FILE: z.string().default("./data/logs/rebalancer.log"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  JUPITER_API_BASE_URL: z.url().default("https://lite-api.jup.ag/swap/v1"),
  JUPITER_API_KEY: z.string().default(""),
  RANGE_PCT: z.coerce.number().positive().default(1),
  BOT_ALLOCATION_USDC: z.coerce.number().nonnegative().default(0),
  REBALANCE_DRIFT_PCT: z.coerce.number().positive().default(0.5),
  POLL_SECONDS: z.coerce.number().int().positive().default(15),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(25),
  CLOSE_RETRY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(50),
  CLOSE_FINAL_RETRY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(100),
  OPEN_RETRY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(50),
  OPEN_FINAL_RETRY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(100),
  SLIPPAGE_RETRIES_PER_TIER: z.coerce.number().int().positive().default(3),
  OPEN_DEPLOYMENT_BUFFER_BPS: z.coerce.number().int().min(0).max(9_999).default(50),
  OPEN_RETRY_DEPLOYMENT_BUFFER_BPS: z.coerce.number().int().min(0).max(9_999).default(150),
  OPEN_FINAL_DEPLOYMENT_BUFFER_BPS: z.coerce.number().int().min(0).max(9_999).default(300),
  SOL_RESERVE_LAMPORTS: z.coerce.number().int().nonnegative().default(50_000_000),
  MIN_SWAP_USDC: z.coerce.number().nonnegative().default(10),
  OPEN_BALANCE_TOLERANCE_BPS: z.coerce.number().int().min(0).max(10_000).default(25),
  TOKEN_A_MINT: z.string().min(1).default("So11111111111111111111111111111111111111112"),
  TOKEN_A_SYMBOL: z.string().min(1).default("SOL"),
  TOKEN_A_DECIMALS: z.coerce.number().int().nonnegative().default(9),
  TOKEN_B_MINT: z.string().min(1).default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  TOKEN_B_SYMBOL: z.string().min(1).default("USDC"),
  TOKEN_B_DECIMALS: z.coerce.number().int().nonnegative().default(6),
  COMPOUND_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(0),
  COMPOUND_MIN_QUOTE_VALUE: z.coerce.number().nonnegative().default(0.5),
  DRIFT_CONFIRM_POLLS: z.coerce.number().int().nonnegative().default(2),
  REBALANCE_MIN_BENEFIT_MULTIPLE: z.coerce.number().nonnegative().default(1.5),
  HARVEST_MIN_BENEFIT_MULTIPLE: z.coerce.number().nonnegative().default(2.0)
});

export type AppConfig = z.infer<typeof envSchema> & {
  maxSlippageFraction: number;
  solanaRpcUrls: string[];
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  return {
    ...parsed,
    maxSlippageFraction: parsed.MAX_SLIPPAGE_BPS / 10_000,
    solanaRpcUrls: normalizeRpcUrls(
      parsed.SOLANA_RPC_URL,
      parsed.SOLANA_RPC_FALLBACK_URLS
    )
  };
}
