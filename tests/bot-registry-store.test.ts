import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { BotRegistryStore } from "../src/state/botRegistryStore.js";

function createConfig(root: string): AppConfig {
  return {
    SOLANA_RPC_URL: "https://rpc.example",
    SOLANA_RPC_FALLBACK_URLS: "https://api.mainnet-beta.solana.com",
    BOT_WALLET_KEYPAIR_PATH: join(root, "wallet.json"),
    ORCA_WHIRLPOOL_ADDRESS: "legacy-whirlpool",
    BOT_STATE_FILE: join(root, "state.json"),
    BOT_REGISTRY_FILE: join(root, "bots.json"),
    BOT_PNL_LEDGER_FILE: join(root, "pnl-ledger.json"),
    LOG_FILE: join(root, "rebalancer.log"),
    LOG_LEVEL: "info",
    JUPITER_API_BASE_URL: "https://lite-api.jup.ag/swap/v1",
    JUPITER_API_KEY: "",
    BOT_ALLOCATION_USDC: Number.POSITIVE_INFINITY,
    RANGE_PCT: 1,
    REBALANCE_DRIFT_PCT: 0.5,
    POLL_SECONDS: 15,
    MAX_SLIPPAGE_BPS: 100,
    CLOSE_RETRY_SLIPPAGE_BPS: 300,
    CLOSE_FINAL_RETRY_SLIPPAGE_BPS: 1000,
    OPEN_RETRY_SLIPPAGE_BPS: 300,
    OPEN_FINAL_RETRY_SLIPPAGE_BPS: 1000,
    SLIPPAGE_RETRIES_PER_TIER: 3,
    OPEN_DEPLOYMENT_BUFFER_BPS: 100,
    OPEN_RETRY_DEPLOYMENT_BUFFER_BPS: 300,
    OPEN_FINAL_DEPLOYMENT_BUFFER_BPS: 500,
    SOL_RESERVE_LAMPORTS: 50_000_000,
    MIN_SWAP_USDC: 10,
    OPEN_BALANCE_TOLERANCE_BPS: 25,
    TOKEN_A_MINT: "So11111111111111111111111111111111111111112",
    TOKEN_A_SYMBOL: "SOL",
    TOKEN_A_DECIMALS: 9,
    TOKEN_B_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    TOKEN_B_SYMBOL: "USDC",
    TOKEN_B_DECIMALS: 6,
    COMPOUND_INTERVAL_SECONDS: 0,
    COMPOUND_MIN_QUOTE_VALUE: 0.5,
    DRIFT_CONFIRM_POLLS: 2,
    REBALANCE_MIN_BENEFIT_MULTIPLE: 1.5,
    HARVEST_MIN_BENEFIT_MULTIPLE: 2.0,
    maxSlippageFraction: 0.01,
    solanaRpcUrls: ["https://rpc.example", "https://api.mainnet-beta.solana.com"],
  };
}

describe("BotRegistryStore", () => {
  it("creates, updates, and archives bot records", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-bot-registry-"));
    const config = createConfig(root);
    const store = new BotRegistryStore(config.BOT_REGISTRY_FILE, config.BOT_STATE_FILE, config);

    const created = await store.createBot(
      {
        name: "Mean Recenter",
        whirlpoolAddress: "pool-1",
        allocationUsdc: 250,
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
        harvestMinBenefitMultiple: 2.0
      },
      {
        whirlpoolAddress: "pool-1",
        tokenAMint: "mint-a",
        tokenASymbol: "SOL",
        tokenADecimals: 9,
        tokenBMint: "mint-b",
        tokenBSymbol: "USDC",
        tokenBDecimals: 6
      }
    );

    expect(created.definition.name).toBe("Mean Recenter");
    expect(created.runtime.monitoringActive).toBe(false);

    const updated = await store.updateBot(created.definition.id, {
      allocationUsdc: 400,
      monitoringActive: true,
      enabled: true
    });

    expect(updated?.definition.allocationUsdc).toBe(400);
    expect(updated?.runtime.monitoringActive).toBe(true);

    await store.archiveBot(created.definition.id);
    const bots = await store.listBots();
    expect(bots).toHaveLength(0);
  });

  it("migrates the legacy single-bot state into the registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-bot-migrate-"));
    const config = createConfig(root);
    await writeFile(
      config.BOT_STATE_FILE,
      JSON.stringify({
        activePositionMint: "legacy-position",
        lastCenterPrice: 91.5,
        latestAction: "waiting",
        paused: false
      })
    );

    const store = new BotRegistryStore(config.BOT_REGISTRY_FILE, config.BOT_STATE_FILE, config);
    const registry = await store.load();

    expect(registry.bots).toHaveLength(1);
    expect(registry.bots[0]?.runtime.activePositionMint).toBe("legacy-position");
    expect(registry.bots[0]?.definition.whirlpoolAddress).toBe("legacy-whirlpool");

    const persisted = JSON.parse(await readFile(config.BOT_REGISTRY_FILE, "utf8")) as { bots: Array<unknown> };
    expect(persisted.bots).toHaveLength(1);
  });
});
