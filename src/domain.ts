export type DriftDirection = "below" | "above";
export type DriftStatus = "waiting" | "triggered";
export type RebalancePhase = "closing" | "swapping" | "opening";
export type BotId = string;
export type PositionPnlStatus = "open" | "closed";
export type BotPlatform = "orca" | "meteora";
export type MeteoraStrategyType = "Spot" | "Curve" | "BidAsk";

export interface PendingRebalance {
  phase: RebalancePhase;
  startedAt: string;
  nextRetryAt: string | null;
  anchorPrice: number;
  targetCenterPrice: number;
  previousPositionMint: string | null;
  plannedPositionMint: string | null;
  lastKnownCloseTxId: string | null;
  lastKnownSwapTxId: string | null;
  lastKnownOpenTxId: string | null;
  recoveryReason: string | null;
  retryCount: number;
  openFailureCount: number;
  entryCapitalQuote: number | null;
  entryTokenA: string | null;
  entryTokenB: string | null;
  cumulativeSwapFeeQuote: number;
  cumulativeTxFeeLamports: number;
}

export interface BotState {
  activePositionMint: string | null;
  lastRebalanceAt: string | null;
  lastCenterPrice: number | null;
  latestAction: string | null;
  lastPnlMarkAt: string | null;
  paused: boolean;
  pauseReason: string | null;
  inFlightRebalance: boolean;
  lastObservedPrice: number | null;
  lastOraclePrice: number | null;
  lastOracleAt: string | null;
  driftTriggerLower: number | null;
  driftTriggerUpper: number | null;
  driftDirection: DriftDirection | null;
  driftStatus: DriftStatus | null;
  pendingRebalance: PendingRebalance | null;
  positionLowerPrice: number | null;
  positionUpperPrice: number | null;
}

export interface BotRuntimeState extends BotState {
  monitoringActive: boolean;
  lastCycleAt: string | null;
}

export interface BotDefinition {
  id: BotId;
  name: string;
  enabled: boolean;
  archived: boolean;
  platform: BotPlatform;
  whirlpoolAddress: string;
  allocationUsdc: number;
  /** Symmetric ±% range for Orca bots */
  rangePct: number;
  /** % below current price for Meteora bots (asymmetric lower bound) */
  rangePctBelow?: number;
  /** % above current price for Meteora bots (asymmetric upper bound) */
  rangePctAbove?: number;
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
  tokenAMint: string;
  tokenASymbol: string;
  tokenADecimals: number;
  tokenBMint: string;
  tokenBSymbol: string;
  tokenBDecimals: number;
  /** Meteora only: liquidity distribution strategy */
  meteoraStrategyType?: MeteoraStrategyType;
  /** Meteora only: pool bin step in bps (discovered, informational) */
  meteoraBinStep?: number;
  createdAt: string;
  updatedAt: string;
}

export interface BotRecord {
  definition: BotDefinition;
  runtime: BotRuntimeState;
}

export interface BotRegistry {
  version: 1;
  bots: BotRecord[];
}

export interface WalletAllocationSummary {
  walletAddress: string | null;
  enabledBots: number;
  monitoringBots: number;
  totalAllocatedUsdc: number;
  availableTokenA: string | null;
  availableTokenB: string | null;
  queueDepth: number;
  overAllocated: boolean;
}

export interface ExecutionQueueJob {
  id: string;
  botId: BotId;
  reason: "trigger" | "manual" | "recovery";
  enqueuedAt: string;
}

export interface PoolMetadata {
  whirlpoolAddress: string;
  tokenAMint: string;
  tokenASymbol: string;
  tokenADecimals: number;
  tokenBMint: string;
  tokenBSymbol: string;
  tokenBDecimals: number;
  platform: BotPlatform;
  /** Meteora only: pool bin step in bps */
  binStep?: number;
}

export interface PoolSnapshot {
  whirlpoolAddress: string;
  currentPrice: number;
  tokenAMint: string;
  tokenBMint: string;
  tokenADecimals: number;
  tokenBDecimals: number;
  raw: unknown;
  platform: BotPlatform;
  /** Meteora only: current active bin ID */
  activeBinId?: number;
}

export interface WalletBalances {
  tokenA: bigint;
  tokenB: bigint;
}

export interface ManagedPosition {
  positionAddress: string;
  positionMint: string;
  whirlpoolAddress: string;
  liquidity: bigint;
  tickLowerIndex?: number;
  tickUpperIndex?: number;
  raw: unknown;
}

export interface OracleQuote {
  source: string;
  price: number;
  observedAt: string;
}

export interface RebalancePlan {
  lowerPrice: number;
  upperPrice: number;
  targetTokenAValueWeight: number;
  targetTokenBValueWeight: number;
  desiredSwapDirection: "buy-token-a" | "sell-token-a" | "none";
  desiredSwapAmountIn: bigint;
  deployableTokenA: bigint;
  deployableTokenB: bigint;
}

export interface RebalanceResult {
  previousPositionMint: string | null;
  newPositionMint: string | null;
  closeTxId: string | null;
  swapTxId: string | null;
  openTxId: string | null;
  newCenterPrice: number;
}

export interface PositionLedgerOpenInput {
  botId: BotId;
  botName: string;
  whirlpoolAddress: string;
  tokenPair: string;
  positionMint: string;
  openedAt: string;
  centerPrice: number;
  lowerPrice: number | null;
  upperPrice: number | null;
  entryCapitalQuote: number;
  entryTokenA: string;
  entryTokenB: string;
  residualTokenA: string;
  residualTokenB: string;
  cumulativeSwapFeeQuote: number;
  cumulativeTxFeeLamports: number;
  openTxId: string | null;
  bootstrapped?: boolean;
}

export interface PositionLedgerCloseInput {
  botId: BotId;
  positionMint: string;
  closedAt: string;
  centerPrice: number;
  exitGrossQuote: number;
  feesEarnedQuote: number;
  exitTokenA: string;
  exitTokenB: string;
  closeTxId: string | null;
  closeTxFeeLamports: number;
}

export interface PositionLedgerMarkInput {
  botId: BotId;
  positionMint: string;
  markedAt: string;
  centerPrice: number;
  grossValueQuote: number;
  feesEarnedQuote: number;
  grossTokenA: string;
  grossTokenB: string;
}

export interface PositionPnlRecord {
  id: string;
  botId: BotId;
  botName: string;
  whirlpoolAddress: string;
  tokenPair: string;
  positionMint: string;
  status: PositionPnlStatus;
  openedAt: string;
  closedAt: string | null;
  entryCenterPrice: number;
  entryLowerPrice: number | null;
  entryUpperPrice: number | null;
  entryCapitalUsdc: number;
  entryTokenA: string;
  entryTokenB: string;
  residualTokenA: string;
  residualTokenB: string;
  cumulativeSwapFeesUsdc: number;
  cumulativeTxFeesUsdc: number;
  feesEarnedUsdc: number;
  latestGrossValueUsdc: number | null;
  latestNetPnlUsdc: number | null;
  lastMarkedAt: string | null;
  exitGrossValueUsdc: number | null;
  realizedNetPnlUsdc: number | null;
  openTxId: string | null;
  closeTxId: string | null;
  bootstrapped: boolean;
}

export interface PositionPnlLedger {
  version: 1;
  positions: PositionPnlRecord[];
}

export interface BotPnlSummary {
  botId: BotId;
  openNetPnlUsdc: number;
  realizedNetPnlUsdc: number;
  totalNetPnlUsdc: number;
  feesEarnedUsdc: number;
  openPositionCount: number;
  closedPositionCount: number;
}

export interface GlobalPnlSummary {
  totalNetPnlUsdc: number;
  realizedNetPnlUsdc: number;
  openNetPnlUsdc: number;
  feesEarnedUsdc: number;
  openPositionCount: number;
  closedPositionCount: number;
  orphanedPositionCount: number;
}

export class TransactionTimeoutError extends Error {
  constructor(
    public readonly phase: RebalancePhase,
    public readonly details: Record<string, string | null> = {}
  ) {
    super(`Transaction confirmation timeout during ${phase}`);
    this.name = "TransactionTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
