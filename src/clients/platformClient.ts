/**
 * PlatformClient — common interface implemented by OrcaClient.
 * The rebalancer and supervisor only ever reference this interface, keeping them
 * platform-agnostic.
 */

import type {
  ManagedPosition,
  PoolMetadata,
  PoolSnapshot,
  WalletBalances
} from "../domain.js";

/** Minimal open-plan fields that the rebalancer reads from assessSwapToOpenTarget */
export interface OpenPlan {
  rawTargetTokenA: bigint;
  rawTargetTokenB: bigint;
}

export interface ClosePositionResult {
  dryRun: boolean;
  quote: unknown;
  txId: string | null;
}

export interface OpenPositionResult {
  dryRun: boolean;
  positionMint: string | null;
  lowerPrice: number;
  upperPrice: number;
  quote: unknown;
  txId: string | null;
  deployableTokenA: bigint;
  deployableTokenB: bigint;
}

export interface SwapAssessment {
  direction: "buy-token-a" | "sell-token-a" | "none";
  inputAmount: bigint;
  targetWeights: { tokenA: number; tokenB: number };
  valueDelta: number;
  valueDeltaBps: number;
}

export interface SwapResult {
  dryRun: boolean;
  direction: "buy-token-a" | "sell-token-a" | "none";
  inputAmount: bigint;
  quote: unknown;
  txId: string | null;
  targetWeights: { tokenA: number; tokenB: number };
  assessment: SwapAssessment;
}

export interface SwapOptions {
  minSwapUsdc?: number;
  valueToleranceBps?: number;
}

/** A funding source that was skipped because no quote/route could be obtained (nothing was sent). */
export interface FundingFailure {
  sourceMint: string;
  error: string;
}

export interface FundResult {
  fundedQuoteAmount: bigint;
  txIds: string[];
  route: unknown;
  /** Sources skipped because quoting failed; callers should log these. Swap (send) failures throw instead. */
  failures: FundingFailure[];
}

export interface PlatformClient {
  init(): Promise<void>;

  fetchPoolSnapshot(): Promise<PoolSnapshot>;

  discoverPoolMetadata(poolAddress: string): Promise<PoolMetadata>;

  findManagedPosition(expectedPositionMint?: string | null): Promise<ManagedPosition | null>;

  listManagedPositions(poolAddress?: string): Promise<ManagedPosition[]>;

  listAllOwnerPositions(): Promise<ManagedPosition[]>;

  getWalletBalances(): Promise<WalletBalances>;

  getOwnerAddress(): string;

  clearPositionCache(): void;

  getSolUsdcPrice(): Promise<number>;

  closePosition(
    positionMint: string,
    execute: boolean,
    slippageBps?: number
  ): Promise<ClosePositionResult>;

  openCenteredPosition(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    previousPositionMint?: string | null,
    slippageBps?: number,
    deploymentBufferBps?: number,
    allocationQuoteOverride?: number
  ): Promise<OpenPositionResult>;

  swapToTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    options?: SwapOptions
  ): Promise<SwapResult>;

  swapToOpenTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    deploymentBufferBps?: number,
    allocationQuoteOverride?: number,
    options?: SwapOptions
  ): Promise<SwapResult>;

  assessSwapToTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    options?: SwapOptions
  ): SwapAssessment;

  assessSwapToOpenTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    deploymentBufferBps?: number,
    allocationQuoteOverride?: number,
    options?: SwapOptions
  ): SwapAssessment & { plan: OpenPlan };

  fundQuoteTokenFromWallet(targetQuoteAmount: bigint, execute: boolean): Promise<FundResult>;
}
