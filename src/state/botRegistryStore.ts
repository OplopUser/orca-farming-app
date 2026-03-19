import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type {
  BotDefinition,
  BotId,
  BotRecord,
  BotRegistry,
  BotRuntimeState,
  PoolMetadata
} from "../domain.js";
import { createEmptyBotRuntimeState } from "./store.js";

const REGISTRY_VERSION = 1 as const;

export interface CreateBotInput {
  name: string;
  whirlpoolAddress: string;
  allocationUsdc: number;
  rangePct: number;
  rebalanceDriftPct: number;
  pollSeconds: number;
  maxSlippageBps: number;
  closeRetrySlippageBps: number;
  closeFinalRetrySlippageBps: number;
  openRetrySlippageBps: number;
  openFinalRetrySlippageBps: number;
  openDeploymentBufferBps: number;
  openRetryDeploymentBufferBps: number;
  openFinalDeploymentBufferBps: number;
  minSwapQuoteValue: number;
  openBalanceToleranceBps: number;
}

export interface UpdateBotInput extends Partial<CreateBotInput> {
  enabled?: boolean;
  archived?: boolean;
  monitoringActive?: boolean;
  paused?: boolean;
  pauseReason?: string | null;
  resetPause?: boolean;
}

function createDefaultRegistry(): BotRegistry {
  return {
    version: REGISTRY_VERSION,
    bots: []
  };
}

function createDefinitionFromConfig(config: AppConfig, botId: string, now: string): BotDefinition {
  return {
    id: botId,
    name: `${config.TOKEN_A_SYMBOL}/${config.TOKEN_B_SYMBOL} Legacy Bot`,
    enabled: true,
    archived: false,
    whirlpoolAddress: config.ORCA_WHIRLPOOL_ADDRESS,
    allocationUsdc: Number.isFinite(config.BOT_ALLOCATION_USDC) ? config.BOT_ALLOCATION_USDC : 0,
    rangePct: config.RANGE_PCT,
    rebalanceDriftPct: config.REBALANCE_DRIFT_PCT,
    pollSeconds: config.POLL_SECONDS,
    maxSlippageBps: config.MAX_SLIPPAGE_BPS,
    closeRetrySlippageBps: config.CLOSE_RETRY_SLIPPAGE_BPS,
    closeFinalRetrySlippageBps: config.CLOSE_FINAL_RETRY_SLIPPAGE_BPS,
    openRetrySlippageBps: config.OPEN_RETRY_SLIPPAGE_BPS,
    openFinalRetrySlippageBps: config.OPEN_FINAL_RETRY_SLIPPAGE_BPS,
    openDeploymentBufferBps: config.OPEN_DEPLOYMENT_BUFFER_BPS,
    openRetryDeploymentBufferBps: config.OPEN_RETRY_DEPLOYMENT_BUFFER_BPS,
    openFinalDeploymentBufferBps: config.OPEN_FINAL_DEPLOYMENT_BUFFER_BPS,
    minSwapQuoteValue: config.MIN_SWAP_USDC,
    openBalanceToleranceBps: config.OPEN_BALANCE_TOLERANCE_BPS,
    tokenAMint: config.TOKEN_A_MINT,
    tokenASymbol: config.TOKEN_A_SYMBOL,
    tokenADecimals: config.TOKEN_A_DECIMALS,
    tokenBMint: config.TOKEN_B_MINT,
    tokenBSymbol: config.TOKEN_B_SYMBOL,
    tokenBDecimals: config.TOKEN_B_DECIMALS,
    createdAt: now,
    updatedAt: now
  };
}

export class BotRegistryStore {
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly legacyStatePath: string,
    private readonly config: AppConfig
  ) {}

  async load(): Promise<BotRegistry> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BotRegistry>;
      return this.normalizeRegistry(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      const migrated = await this.migrateLegacyState();
      if (migrated) {
        await this.save(migrated);
        return migrated;
      }

      return createDefaultRegistry();
    }
  }

  async save(registry: BotRegistry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(registry, null, 2));
    await rename(tempPath, this.filePath);
  }

  async listBots(): Promise<BotRecord[]> {
    const registry = await this.load();
    return registry.bots.filter((bot) => !bot.definition.archived);
  }

  async listAllBots(): Promise<BotRecord[]> {
    const registry = await this.load();
    return registry.bots;
  }

  async getBot(botId: BotId): Promise<BotRecord | null> {
    const bots = await this.listBots();
    return bots.find((bot) => bot.definition.id === botId) ?? null;
  }

  async createBot(input: CreateBotInput, metadata: PoolMetadata): Promise<BotRecord> {
    return this.withExclusive(async () => {
      const registry = await this.load();
      const now = new Date().toISOString();
      const record: BotRecord = {
        definition: {
          id: randomUUID(),
          name: input.name.trim() || `${metadata.tokenASymbol}/${metadata.tokenBSymbol} Bot`,
          enabled: true,
          archived: false,
          whirlpoolAddress: metadata.whirlpoolAddress,
          allocationUsdc: input.allocationUsdc,
          rangePct: input.rangePct,
          rebalanceDriftPct: input.rebalanceDriftPct,
          pollSeconds: input.pollSeconds,
          maxSlippageBps: input.maxSlippageBps,
          closeRetrySlippageBps: input.closeRetrySlippageBps,
          closeFinalRetrySlippageBps: input.closeFinalRetrySlippageBps,
          openRetrySlippageBps: input.openRetrySlippageBps,
          openFinalRetrySlippageBps: input.openFinalRetrySlippageBps,
          openDeploymentBufferBps: input.openDeploymentBufferBps,
          openRetryDeploymentBufferBps: input.openRetryDeploymentBufferBps,
          openFinalDeploymentBufferBps: input.openFinalDeploymentBufferBps,
          minSwapQuoteValue: input.minSwapQuoteValue,
          openBalanceToleranceBps: input.openBalanceToleranceBps,
          tokenAMint: metadata.tokenAMint,
          tokenASymbol: metadata.tokenASymbol,
          tokenADecimals: metadata.tokenADecimals,
          tokenBMint: metadata.tokenBMint,
          tokenBSymbol: metadata.tokenBSymbol,
          tokenBDecimals: metadata.tokenBDecimals,
          createdAt: now,
          updatedAt: now
        },
        runtime: {
          ...createEmptyBotRuntimeState(),
          monitoringActive: false
        }
      };

      registry.bots.push(record);
      await this.save(registry);
      return record;
    });
  }

  async updateBot(botId: BotId, input: UpdateBotInput): Promise<BotRecord | null> {
    return this.withExclusive(async () => {
      const registry = await this.load();
      const record = registry.bots.find((bot) => bot.definition.id === botId);
      if (!record) {
        return null;
      }

      const now = new Date().toISOString();
      const nextDefinition = record.definition;
      if (typeof input.name === "string") {
        nextDefinition.name = input.name.trim() || nextDefinition.name;
      }
      if (typeof input.enabled === "boolean") {
        nextDefinition.enabled = input.enabled;
      }
      if (typeof input.archived === "boolean") {
        nextDefinition.archived = input.archived;
      }
      if (typeof input.allocationUsdc === "number") {
        nextDefinition.allocationUsdc = input.allocationUsdc;
      }
      if (typeof input.rangePct === "number") {
        nextDefinition.rangePct = input.rangePct;
      }
      if (typeof input.rebalanceDriftPct === "number") {
        nextDefinition.rebalanceDriftPct = input.rebalanceDriftPct;
      }
      if (typeof input.pollSeconds === "number") {
        nextDefinition.pollSeconds = input.pollSeconds;
      }
      if (typeof input.maxSlippageBps === "number") {
        nextDefinition.maxSlippageBps = input.maxSlippageBps;
      }
      if (typeof input.closeRetrySlippageBps === "number") {
        nextDefinition.closeRetrySlippageBps = input.closeRetrySlippageBps;
      }
      if (typeof input.closeFinalRetrySlippageBps === "number") {
        nextDefinition.closeFinalRetrySlippageBps = input.closeFinalRetrySlippageBps;
      }
      if (typeof input.openRetrySlippageBps === "number") {
        nextDefinition.openRetrySlippageBps = input.openRetrySlippageBps;
      }
      if (typeof input.openFinalRetrySlippageBps === "number") {
        nextDefinition.openFinalRetrySlippageBps = input.openFinalRetrySlippageBps;
      }
      if (typeof input.openDeploymentBufferBps === "number") {
        nextDefinition.openDeploymentBufferBps = input.openDeploymentBufferBps;
      }
      if (typeof input.openRetryDeploymentBufferBps === "number") {
        nextDefinition.openRetryDeploymentBufferBps = input.openRetryDeploymentBufferBps;
      }
      if (typeof input.openFinalDeploymentBufferBps === "number") {
        nextDefinition.openFinalDeploymentBufferBps = input.openFinalDeploymentBufferBps;
      }
      if (typeof input.minSwapQuoteValue === "number") {
        nextDefinition.minSwapQuoteValue = input.minSwapQuoteValue;
      }
      if (typeof input.openBalanceToleranceBps === "number") {
        nextDefinition.openBalanceToleranceBps = input.openBalanceToleranceBps;
      }
      nextDefinition.updatedAt = now;

      if (typeof input.monitoringActive === "boolean") {
        record.runtime.monitoringActive = input.monitoringActive;
      }
      if (typeof input.paused === "boolean") {
        record.runtime.paused = input.paused;
      }
      if (typeof input.pauseReason === "string" || input.pauseReason === null) {
        record.runtime.pauseReason = input.pauseReason;
      }
      if (input.resetPause) {
        record.runtime.paused = false;
        record.runtime.pauseReason = null;
      }

      await this.save(registry);
      return record;
    });
  }

  async saveRuntime(botId: BotId, runtime: BotRuntimeState): Promise<void> {
    await this.withExclusive(async () => {
      const registry = await this.load();
      const record = registry.bots.find((bot) => bot.definition.id === botId);
      if (!record) {
        throw new Error(`Bot ${botId} not found`);
      }

      record.runtime = {
        ...createEmptyBotRuntimeState(),
        ...runtime
      };
      record.definition.updatedAt = new Date().toISOString();
      await this.save(registry);
    });
  }

  async archiveBot(botId: BotId): Promise<BotRecord | null> {
    return this.updateBot(botId, {
      archived: true,
      enabled: false,
      monitoringActive: false
    });
  }

  private normalizeRegistry(registry: Partial<BotRegistry>): BotRegistry {
    const bots = Array.isArray(registry.bots) ? registry.bots : [];

    return {
      version: REGISTRY_VERSION,
      bots: bots.map((bot) => {
        const definition = {
          ...createDefinitionFromConfig(this.config, bot.definition?.id ?? randomUUID(), new Date().toISOString()),
          ...bot.definition
        };

        definition.allocationUsdc =
          typeof definition.allocationUsdc === "number" && Number.isFinite(definition.allocationUsdc)
            ? definition.allocationUsdc
            : 0;

        return {
          definition,
          runtime: {
            ...createEmptyBotRuntimeState(),
            ...bot.runtime
          }
        };
      })
    };
  }

  private async migrateLegacyState(): Promise<BotRegistry | null> {
    try {
      const raw = await readFile(this.legacyStatePath, "utf8");
      const runtime = {
        ...createEmptyBotRuntimeState(),
        ...(JSON.parse(raw) as Partial<BotRuntimeState>)
      };
      const now = new Date().toISOString();
      const botId = randomUUID();

      return {
        version: REGISTRY_VERSION,
        bots: [
          {
            definition: createDefinitionFromConfig(this.config, botId, now),
            runtime
          }
        ]
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prior;

    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class BotRuntimeStore {
  constructor(
    private readonly registryStore: BotRegistryStore,
    private readonly botId: BotId
  ) {}

  async load(): Promise<BotRuntimeState> {
    const record = await this.registryStore.getBot(this.botId);
    return record?.runtime ?? createEmptyBotRuntimeState();
  }

  async save(state: BotRuntimeState): Promise<void> {
    await this.registryStore.saveRuntime(this.botId, state);
  }
}
