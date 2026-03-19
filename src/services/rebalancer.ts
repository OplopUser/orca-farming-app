import type { Logger } from "pino";

import type {
  AppConfig
} from "../config.js";
import {
  TransactionTimeoutError,
  type ManagedPosition,
  type BotRuntimeState,
  type PendingRebalance,
  type PositionLedgerCloseInput,
  type PositionLedgerMarkInput,
  type PositionLedgerOpenInput,
  type RebalancePhase,
  type RebalanceResult,
  type WalletBalances
} from "../domain.js";
import { RpcAccountReader } from "../infra/rpcAccountReader.js";
import { isRecoverableRpcError } from "../infra/rpcFailover.js";
import { TransactionInspector } from "../infra/transactionInspector.js";
import {
  classifyCloseTimeout,
  classifyOpenTimeout,
  classifySwapTimeout,
  shouldRecoverPausedTimeout
} from "./recovery.js";
import { computeBand, computeTargetValueWeights, evaluateDriftTrigger, fromBaseUnits, toBaseUnits } from "../strategy/bands.js";
import { describeCloseQuote } from "./positionPnlService.js";
import { InsufficientAllocationError, OrcaClient } from "../clients/orcaClient.js";

export type RunMode = "run" | "dry-run" | "rebalance-now";

interface RuntimeStateStore {
  load(): Promise<BotRuntimeState>;
  save(state: BotRuntimeState): Promise<void>;
}

interface RebalancerOptions {
  botId?: string;
  botName?: string;
  runExclusive?: <T>(reason: "trigger" | "manual" | "recovery", task: () => Promise<T>) => Promise<T>;
  listClaimedPositionMints?: () => Promise<string[]>;
  resolveAllocationQuoteBudget?: (currentPrice: number) => Promise<number | null>;
  onPositionOpened?: (input: PositionLedgerOpenInput) => Promise<void>;
  onPositionClosed?: (input: PositionLedgerCloseInput) => Promise<void>;
  onPositionMarked?: (input: PositionLedgerMarkInput) => Promise<void>;
}

class AllocationQuoteBudgetUnavailableError extends Error {
  constructor() {
    super("Allocation quote budget is unavailable for this pool");
    this.name = "AllocationQuoteBudgetUnavailableError";
  }
}

export class RebalancerService {
  private static readonly USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  private readonly accountReader: RpcAccountReader;
  private readonly transactionInspector: TransactionInspector;
  private static readonly POST_CLOSE_BALANCE_WAIT_MS = 20_000;
  private static readonly POST_CLOSE_BALANCE_POLL_MS = 1_500;
  private static readonly PNL_MARK_INTERVAL_MS = 60_000;
  private static readonly TOKEN_MIN_SUBCEEDED_CODE = "6018";
  private static readonly OPEN_SLIPPAGE_ERROR_CODE = "6012";
  private static readonly MAX_TIMEOUT_RETRIES = 1;
  private static readonly MAX_STRICT_PREOPEN_SWAPS = 4;
  private static readonly MAX_OPEN_FAILURE_PREOPEN_SWAPS = 8;
  private static readonly MIN_STRICT_PREOPEN_SWAP_QUOTE = 0.01;
  private static readonly OPEN_RETRY_BALANCE_TOLERANCE_BPS = 5;
  private static readonly CLOSE_RETRY_BACKOFF_MS = 5_000;
  private static readonly MAX_CLOSE_RETRY_BACKOFF_MS = 60_000;
  private static readonly OPEN_RETRY_BACKOFF_MS = 5_000;
  private static readonly MAX_OPEN_RETRY_BACKOFF_MS = 60_000;
  private static readonly RPC_RETRY_BACKOFF_MS = 5_000;
  private static readonly MAX_RPC_RETRY_BACKOFF_MS = 60_000;
  private static readonly MAX_RECOVERABLE_RPC_RETRIES = 12;
  private static readonly TIMEOUT_TEXT = "Transaction confirmation timeout";

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly stateStore: RuntimeStateStore,
    private readonly orcaClient: OrcaClient,
    private readonly options: RebalancerOptions = {}
  ) {
    this.accountReader = new RpcAccountReader(config.solanaRpcUrls);
    this.transactionInspector = new TransactionInspector(config.solanaRpcUrls);
  }

  async run(mode: RunMode): Promise<void> {
    if (mode === "run") {
      for (;;) {
        await this.runCycle(mode);
        await this.sleep(this.config.POLL_SECONDS * 1000);
      }
    }

    await this.runCycle(mode);
  }

  async runCycle(mode: RunMode): Promise<void> {
    this.orcaClient.clearPositionCache();
    const state = await this.stateStore.load();
    if (state.pendingRebalance) {
      this.normalizePendingRebalance(state.pendingRebalance);
    }
    state.lastCycleAt = new Date().toISOString();
    const wasTriggered = state.driftStatus === "triggered";

    if (!state.pendingRebalance && state.inFlightRebalance) {
      state.inFlightRebalance = false;
      await this.stateStore.save(state);
    }

    if (!state.pendingRebalance && state.paused && this.isTimeoutMessage(state.pauseReason)) {
      await this.seedLegacyTimeoutRecovery(state);
    }

    if (state.pendingRebalance) {
      if (state.paused && !this.shouldRecoverPausedPendingRebalance(state)) {
        this.logger.warn({ pauseReason: state.pauseReason }, "bot is paused");
        return;
      }

      await this.runExclusive("recovery", () => this.reconcilePendingRebalance(state));
      return;
    }

    if (state.paused) {
      this.logger.warn({ pauseReason: state.pauseReason }, "bot is paused");
      return;
    }

    const pool = await this.orcaClient.fetchPoolSnapshot();
    state.lastObservedPrice = pool.currentPrice;
    state.lastOraclePrice = null;
    state.lastOracleAt = null;

    if (state.activePositionMint) {
      const livePosition = await this.orcaClient.findManagedPosition(state.activePositionMint);
      if (!livePosition) {
        this.logger.warn(
          {
            positionMint: state.activePositionMint
          },
          "tracked position missing on-chain; clearing stale position state"
        );
        state.activePositionMint = null;
        state.lastPnlMarkAt = null;
        state.latestAction = "tracked position missing on-chain";
        await this.stateStore.save(state);
        return;
      }
    }

    const baselineCenter = state.lastCenterPrice ?? pool.currentPrice;
    const drift = evaluateDriftTrigger(
      baselineCenter,
      pool.currentPrice,
      this.config.REBALANCE_DRIFT_PCT
    );
    // Also trigger if current price has left the actual on-chain LP range (tick-snapped bounds
    // may be narrower than the theoretical rangePct, so price can exit range before driftPct fires)
    const isOutOfActualRange =
      (state.positionLowerPrice !== null && pool.currentPrice < state.positionLowerPrice) ||
      (state.positionUpperPrice !== null && pool.currentPrice > state.positionUpperPrice);
    const shouldRebalance = mode === "rebalance-now" ? true : drift.shouldRebalance || wasTriggered || isOutOfActualRange;
    state.driftTriggerLower = drift.lowerTrigger;
    state.driftTriggerUpper = drift.upperTrigger;
    state.driftDirection = shouldRebalance
      ? (isOutOfActualRange && !drift.direction ? (pool.currentPrice < baselineCenter ? "below" : "above") : drift.direction ?? state.driftDirection)
      : drift.direction;
    state.driftStatus = shouldRebalance ? "triggered" : "waiting";

    const band = computeBand(baselineCenter, this.config.RANGE_PCT);
    this.logger.info(
      {
        mode,
        anchorPrice: baselineCenter,
        currentPrice: pool.currentPrice,
        band,
        driftTriggerLower: drift.lowerTrigger,
        driftTriggerUpper: drift.upperTrigger,
        positionLowerPrice: state.positionLowerPrice,
        positionUpperPrice: state.positionUpperPrice,
        isOutOfActualRange,
        driftDirection: state.driftDirection,
        driftStatus: state.driftStatus,
        shouldRebalance
      },
      "cycle evaluated"
    );

    if (
      state.activePositionMint &&
      this.options.onPositionMarked &&
      (!state.lastPnlMarkAt || Date.now() - Date.parse(state.lastPnlMarkAt) >= RebalancerService.PNL_MARK_INTERVAL_MS)
    ) {
      try {
        const markQuote = await this.orcaClient.closePosition(state.activePositionMint, false, 0);
        const { grossValueQuote, feesEarnedQuote } = describeCloseQuote(
          pool.currentPrice,
          markQuote.quote,
          this.config.TOKEN_A_DECIMALS,
          this.config.TOKEN_B_DECIMALS
        );
        await this.options.onPositionMarked({
          botId: this.options.botId ?? "legacy",
          positionMint: state.activePositionMint,
          markedAt: state.lastCycleAt,
          centerPrice: pool.currentPrice,
          grossValueQuote,
          feesEarnedQuote
        });
        state.lastPnlMarkAt = state.lastCycleAt;
      } catch (error) {
        this.logger.warn(
          {
            positionMint: state.activePositionMint,
            error: (error as Error).message
          },
          "pnl mark refresh failed"
        );
      }
    }

    if (!state.activePositionMint) {
      state.latestAction = "bootstrapping initial LP position";
      await this.stateStore.save(state);
      await this.runRebalanceWithRecoverableTriggerRetry(
        state,
        mode,
        pool.currentPrice,
        "bootstrapping initial LP position"
      );
      return;
    }

    if (shouldRebalance) {
      await this.runRebalanceWithRecoverableTriggerRetry(
        state,
        mode,
        pool.currentPrice,
        mode === "rebalance-now" ? "manual rebalance retry after rpc error" : "trigger latched; retrying after rpc error"
      );
      return;
    }

    state.latestAction = "waiting for 0.5% drift trigger";
    await this.stateStore.save(state);
  }

  private async executeRebalance(mode: RunMode, state: BotRuntimeState, currentPrice: number): Promise<void> {
    if (state.pendingRebalance) {
      await this.reconcilePendingRebalance(state);
      return;
    }

    if (state.inFlightRebalance) {
      this.logger.warn("rebalance skipped because one is already in flight");
      return;
    }

    if (mode === "dry-run") {
      await this.executeDryRunRebalance(state, currentPrice);
      return;
    }

    const existingPosition = state.activePositionMint
      ? await this.orcaClient.findManagedPosition(state.activePositionMint)
      : null;

    state.pendingRebalance = {
      phase: existingPosition?.positionMint ? "closing" : "swapping",
      startedAt: new Date().toISOString(),
      nextRetryAt: null,
      anchorPrice: state.lastCenterPrice ?? currentPrice,
      targetCenterPrice: currentPrice,
      previousPositionMint: existingPosition?.positionMint ?? null,
      plannedPositionMint: null,
      lastKnownCloseTxId: null,
      lastKnownSwapTxId: null,
      lastKnownOpenTxId: null,
      recoveryReason: null,
      retryCount: 0,
      openFailureCount: 0,
      entryCapitalQuote: null,
      entryTokenA: null,
      entryTokenB: null,
      cumulativeSwapFeeQuote: 0,
      cumulativeTxFeeLamports: 0
    };
    state.inFlightRebalance = true;
    state.paused = false;
    state.pauseReason = null;
    state.latestAction = "rebalance started";
    await this.stateStore.save(state);

    await this.reconcilePendingRebalance(state);
  }

  private async runRebalanceWithRecoverableTriggerRetry(
    state: BotRuntimeState,
    mode: RunMode,
    currentPrice: number,
    latestActionOnRecoverableError: string
  ) {
    try {
      await this.runExclusive(mode === "rebalance-now" ? "manual" : "trigger", () =>
        this.executeRebalance(mode, state, currentPrice)
      );
    } catch (error) {
      if (!isRecoverableRpcError(error)) {
        throw error;
      }

      state.driftStatus = "triggered";
      state.latestAction = latestActionOnRecoverableError;
      await this.stateStore.save(state);

      this.logger.warn(
        {
          error: (error as Error).message,
          currentPrice,
          mode
        },
        "recoverable rpc error while starting rebalance; trigger retained"
      );
    }
  }

  private async executeDryRunRebalance(state: BotRuntimeState, currentPrice: number) {
    const existingPosition = state.activePositionMint
      ? await this.orcaClient.findManagedPosition(state.activePositionMint)
      : null;
    let balances = await this.orcaClient.getWalletBalances();
    let closeTxId: string | null = null;
    let swapTxId: string | null = null;
    let openTxId: string | null = null;
    let newPositionMint: string | null = null;

    if (existingPosition?.positionMint) {
      const closeResult = await this.closeManagedPosition(existingPosition.positionMint, false);
      closeTxId = closeResult.txId;
      this.logger.info(
        {
          closeTxId,
          closeQuote: closeResult.quote ?? null,
          closeSummary: null,
          positionAddress: existingPosition.positionAddress,
          positionMint: existingPosition.positionMint,
          execute: false
        },
        "position close evaluated"
      );

      balances = {
        tokenA: balances.tokenA + BigInt(closeResult.quote?.quote?.tokenMinA ?? 0),
        tokenB: balances.tokenB + BigInt(closeResult.quote?.quote?.tokenMinB ?? 0)
      };
    }

    balances = await this.capBalancesToAllocation(currentPrice, balances);

    const swapResult = await this.orcaClient.swapToTarget(
      currentPrice,
      balances.tokenA,
      balances.tokenB,
      false
    );
    swapTxId = swapResult.txId;
    this.logger.info(
      {
        execute: false,
        direction: swapResult.direction,
        inputAmount: swapResult.inputAmount.toString(),
        swapTxId,
        swapQuote: swapResult.quote ?? null,
        swapSummary: null
      },
      "swap plan evaluated"
    );

    const openResult = await this.orcaClient.openCenteredPosition(
      currentPrice,
      balances.tokenA,
      balances.tokenB,
      false,
      existingPosition?.positionMint ?? null
    );
    newPositionMint = openResult.positionMint;
    openTxId = openResult.txId;

    const nextBand = computeBand(currentPrice, this.config.RANGE_PCT);
    const weights = computeTargetValueWeights(nextBand.lower, currentPrice, nextBand.upper);
    const result: RebalanceResult = {
      previousPositionMint: existingPosition?.positionMint ?? null,
      newPositionMint,
      closeTxId,
      swapTxId,
      openTxId,
      newCenterPrice: currentPrice
    };

    state.latestAction = "dry-run rebalance complete";
    await this.stateStore.save(state);

    this.logger.info(
      {
        execute: false,
        result,
        openQuote: openResult.quote ?? null,
        openSummary: null,
        lowerPrice: nextBand.lower,
        upperPrice: nextBand.upper,
        targetWeights: weights
      },
      "rebalance finished"
    );
  }

  private async seedLegacyTimeoutRecovery(state: BotRuntimeState) {
    const targetCenterPrice = state.lastObservedPrice ?? state.lastCenterPrice;
    if (!targetCenterPrice) {
      return;
    }

    const livePosition = state.activePositionMint
      ? await this.orcaClient.findManagedPosition(state.activePositionMint)
      : null;
    let phase: RebalancePhase = "closing";
    let plannedPositionMint: string | null = null;

    if (!livePosition) {
      phase = "swapping";
    } else if (state.activePositionMint && livePosition.positionMint !== state.activePositionMint) {
      phase = "opening";
      plannedPositionMint = livePosition.positionMint;
    }

    state.pendingRebalance = {
      phase,
      startedAt: new Date().toISOString(),
      nextRetryAt: null,
      anchorPrice: state.lastCenterPrice ?? targetCenterPrice,
      targetCenterPrice,
      previousPositionMint: state.activePositionMint,
      plannedPositionMint,
      lastKnownCloseTxId: null,
      lastKnownSwapTxId: null,
      lastKnownOpenTxId: null,
      recoveryReason: state.pauseReason,
      retryCount: 0,
      openFailureCount: 0,
      entryCapitalQuote: null,
      entryTokenA: null,
      entryTokenB: null,
      cumulativeSwapFeeQuote: 0,
      cumulativeTxFeeLamports: 0
    };
    state.inFlightRebalance = true;
    state.latestAction = `reconciling timed-out ${phase} phase`;
    await this.stateStore.save(state);

    this.logger.warn(
      {
        phase,
        previousPositionMint: state.activePositionMint,
        targetCenterPrice
      },
      "legacy timeout state migrated into pending rebalance"
    );
  }

  private async reconcilePendingRebalance(state: BotRuntimeState) {
    if (!state.pendingRebalance) {
      return;
    }

    if (state.paused) {
      state.paused = false;
      state.pauseReason = null;
      state.latestAction = `reconciling timeout (${state.pendingRebalance.phase})`;
      await this.stateStore.save(state);
    }

    state.inFlightRebalance = true;

    while (state.pendingRebalance && !state.paused) {
      if (state.pendingRebalance.nextRetryAt) {
        const retryAtMs = Date.parse(state.pendingRebalance.nextRetryAt);
        if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
          return;
        }

        state.pendingRebalance.nextRetryAt = null;
        await this.stateStore.save(state);
      }

      switch (state.pendingRebalance.phase) {
        case "closing":
          await this.executeClosePhase(state);
          break;
        case "swapping":
          await this.executeSwapPhase(state);
          break;
        case "opening":
          await this.executeOpenPhase(state);
          break;
      }
    }
  }

  private async executeClosePhase(state: BotRuntimeState) {
    const pending = state.pendingRebalance;
    if (!pending) {
      return;
    }

    if (!pending.previousPositionMint) {
      await this.advancePendingPhase(state, "swapping", "no position to close");
      return;
    }

    const livePosition = await this.orcaClient.findManagedPosition(pending.previousPositionMint);
    if (!livePosition) {
      await this.advancePendingPhase(state, "swapping", "position already closed on-chain");
      return;
    }

    try {
      const closeResult = await this.closeManagedPosition(pending.previousPositionMint, true);
      pending.lastKnownCloseTxId = closeResult.txId;
      const closeSummary = await this.inspectTransaction(closeResult.txId);
      const { grossValueQuote, feesEarnedQuote } = describeCloseQuote(
        pending.targetCenterPrice,
        closeResult.quote,
        this.config.TOKEN_A_DECIMALS,
        this.config.TOKEN_B_DECIMALS
      );

      this.logger.info(
        {
          closeTxId: closeResult.txId,
          closeQuote: closeResult.quote ?? null,
          closeSummary,
          positionMint: pending.previousPositionMint,
          execute: true
        },
        "position close evaluated"
      );

      if (this.options.onPositionClosed) {
        try {
          await this.options.onPositionClosed({
            botId: this.options.botId ?? "legacy",
            positionMint: pending.previousPositionMint,
            closedAt: new Date().toISOString(),
            centerPrice: pending.targetCenterPrice,
            exitGrossQuote: grossValueQuote,
            feesEarnedQuote,
            closeTxId: closeResult.txId,
            closeTxFeeLamports: closeSummary?.feeLamports ?? 0
          });
        } catch (error) {
          this.logger.warn({ error: (error as Error).message }, "position close pnl update failed");
        }
      }

      await this.advancePendingPhase(state, "swapping", "position close confirmed");
    } catch (error) {
      if (await this.handleCloseTimeout(state, error)) {
        return;
      }

      if (await this.handleMissingClosePosition(state, error)) {
        return;
      }

      if (await this.handleRecoverableRpcFailure(state, error)) {
        return;
      }

      if (await this.handleRetryableCloseFailure(state, error)) {
        return;
      }

      await this.pauseAfterFailure(state, error);
    }
  }

  private async executeSwapPhase(state: BotRuntimeState) {
    const pending = state.pendingRebalance;
    if (!pending) {
      return;
    }

    const owner = this.orcaClient.getOwnerAddress();
    let balancesBeforeSwap = pending.previousPositionMint
      ? await this.waitForPostCloseBalances(owner, pending.previousPositionMint, 0n, 0n)
      : await this.accountReader.getWalletBalances(owner, this.config.TOKEN_A_MINT, this.config.TOKEN_B_MINT);
    balancesBeforeSwap = await this.capBalancesToAllocation(pending.targetCenterPrice, balancesBeforeSwap);

    if (pending.entryCapitalQuote == null) {
      pending.entryCapitalQuote = this.quoteValue(pending.targetCenterPrice, balancesBeforeSwap.tokenA, balancesBeforeSwap.tokenB);
      pending.entryTokenA = balancesBeforeSwap.tokenA.toString();
      pending.entryTokenB = balancesBeforeSwap.tokenB.toString();
    }

    try {
      if (this.requiresAdditionalPreOpenRebalance(pending)) {
        balancesBeforeSwap = await this.fundWalletForAllocationIfNeeded(state, pending, balancesBeforeSwap, "swapping");
        const strictResult = await this.performPreOpenRebalance(
          state,
          pending,
          balancesBeforeSwap,
          "pre-open retry rebalance"
        );
        await this.advancePendingPhase(
          state,
          "opening",
          strictResult.swapsExecuted > 0 ? "swap confirmed" : "swap skipped"
        );
        return;
      }

      const swapResult = await this.orcaClient.swapToTarget(
        pending.targetCenterPrice,
        balancesBeforeSwap.tokenA,
        balancesBeforeSwap.tokenB,
        true
      );
      pending.lastKnownSwapTxId = swapResult.txId;
      const swapSummary = await this.inspectTransaction(swapResult.txId);
      pending.cumulativeTxFeeLamports += swapSummary?.feeLamports ?? 0;

      this.logger.info(
        {
          execute: true,
          direction: swapResult.direction,
          inputAmount: swapResult.inputAmount.toString(),
          swapTxId: swapResult.txId,
          swapQuote: swapResult.quote ?? null,
          swapSummary
        },
        "swap plan evaluated"
      );

      await this.advancePendingPhase(state, "opening", swapResult.direction === "none" ? "swap skipped" : "swap confirmed");
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          phase: "swapping",
          targetCenterPrice: pending.targetCenterPrice,
          tokenA: balancesBeforeSwap.tokenA.toString(),
          tokenB: balancesBeforeSwap.tokenB.toString(),
          entryCapitalQuote: pending.entryCapitalQuote,
          swapAssessment: this.orcaClient.assessSwapToTarget(
            pending.targetCenterPrice,
            balancesBeforeSwap.tokenA,
            balancesBeforeSwap.tokenB
          )
        },
        "swap phase failed"
      );
      if (await this.handleInsufficientAllocation(state, error)) {
        return;
      }

      if (await this.handleUnavailableAllocationQuoteBudget(state, error)) {
        return;
      }

      if (await this.handleSwapTimeout(state, error)) {
        return;
      }

      if (await this.handleRecoverableRpcFailure(state, error)) {
        return;
      }

      if (await this.handleRetryableSwapFailure(state, error)) {
        return;
      }

      await this.pauseAfterFailure(state, error);
    }
  }

  private async executeOpenPhase(state: BotRuntimeState) {
    const pending = state.pendingRebalance;
    if (!pending) {
      return;
    }

    try {
      let balances = await this.orcaClient.getWalletBalances();
      balances = await this.fundWalletForAllocationIfNeeded(state, pending, balances, "opening");

      balances = await this.capBalancesToAllocation(
        pending.targetCenterPrice,
        balances
      );

      balances = (await this.performPreOpenRebalance(
        state,
        pending,
        balances,
        "strict pre-open rebalance"
      )).balances;

      // Measure deployed value after all swaps. The difference from pre-swap entry capital
      // is the true swap cost (slippage + fees). Re-baseline entry capital to post-swap so
      // value change in PnL reflects only IL, not swap cost.
      const deployedValue = this.quoteValue(pending.targetCenterPrice, balances.tokenA, balances.tokenB);
      if (pending.entryCapitalQuote != null) {
        pending.cumulativeSwapFeeQuote = Math.max(0, pending.entryCapitalQuote - deployedValue);
      }
      pending.entryCapitalQuote = deployedValue;
      pending.entryTokenA = balances.tokenA.toString();
      pending.entryTokenB = balances.tokenB.toString();

      const openResult = await this.openManagedPosition(
        pending.targetCenterPrice,
        balances.tokenA,
        balances.tokenB,
        true,
        pending.previousPositionMint,
        pending.openFailureCount
      );
      pending.plannedPositionMint = openResult.positionMint;
      pending.lastKnownOpenTxId = openResult.txId;
      const openSummary = await this.inspectTransaction(openResult.txId);
      let openedGrossValueQuote = this.quoteValue(
        pending.targetCenterPrice,
        openResult.deployableTokenA,
        openResult.deployableTokenB
      );
      let openedGrossTokenA = openResult.deployableTokenA;
      let openedGrossTokenB = openResult.deployableTokenB;

      if (openResult.positionMint) {
        try {
          const openMarkQuote = await this.orcaClient.closePosition(openResult.positionMint, false, 0);
          const openMarkSummary = describeCloseQuote(
            pending.targetCenterPrice,
            openMarkQuote.quote,
            this.config.TOKEN_A_DECIMALS,
            this.config.TOKEN_B_DECIMALS
          );
          openedGrossValueQuote = openMarkSummary.grossValueQuote;
          openedGrossTokenA = openMarkSummary.grossTokenA;
          openedGrossTokenB = openMarkSummary.grossTokenB;
        } catch (error) {
          this.logger.warn(
            {
              positionMint: openResult.positionMint,
              error: (error as Error).message
            },
            "open basis quote failed; falling back to deployable token max values"
          );
        }
      }

      if (this.options.onPositionOpened && openResult.positionMint) {
        try {
          await this.options.onPositionOpened({
            botId: this.options.botId ?? "legacy",
            botName: this.options.botName ?? "Legacy Bot",
            whirlpoolAddress: this.config.ORCA_WHIRLPOOL_ADDRESS,
            tokenPair: `${this.config.TOKEN_A_SYMBOL}/${this.config.TOKEN_B_SYMBOL}`,
            positionMint: openResult.positionMint,
            openedAt: new Date().toISOString(),
            centerPrice: pending.targetCenterPrice,
            lowerPrice: openResult.lowerPrice,
            upperPrice: openResult.upperPrice,
            entryCapitalQuote: openedGrossValueQuote,
            entryTokenA: openedGrossTokenA.toString(),
            entryTokenB: openedGrossTokenB.toString(),
            residualTokenA: this.nonNegativeBigInt(balances.tokenA - openResult.deployableTokenA).toString(),
            residualTokenB: this.nonNegativeBigInt(balances.tokenB - openResult.deployableTokenB).toString(),
            cumulativeSwapFeeQuote: pending.cumulativeSwapFeeQuote,
            cumulativeTxFeeLamports: pending.cumulativeTxFeeLamports + (openSummary?.feeLamports ?? 0),
            openTxId: openResult.txId
          });
        } catch (error) {
          this.logger.warn({ error: (error as Error).message }, "position open pnl update failed");
        }
      }

      await this.finalizeRebalance(
        state,
        openResult.positionMint,
        openResult.quote ?? null,
        openSummary,
        openResult.lowerPrice ?? null,
        openResult.upperPrice ?? null
      );
    } catch (error) {
      if (await this.handleInsufficientAllocation(state, error)) {
        return;
      }

      if (await this.handleUnavailableAllocationQuoteBudget(state, error)) {
        return;
      }

      if (await this.handleSwapTimeout(state, error)) {
        return;
      }

      if (await this.handleOpenTimeout(state, error)) {
        return;
      }

      if (await this.handleRetryableOpenFailure(state, error)) {
        return;
      }

      if (await this.handleRecoverableRpcFailure(state, error)) {
        return;
      }

      await this.pauseAfterFailure(state, error);
    }
  }

  private async handleCloseTimeout(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !this.isTimeoutError(error, "closing")) {
      return false;
    }

    pending.recoveryReason = (error as Error).message;
    await this.stateStore.save(state);
    this.logTimeoutDetected("closing", error, pending);

    const livePosition = await this.orcaClient.findManagedPosition(pending.previousPositionMint);
    const outcome = classifyCloseTimeout(
      pending.previousPositionMint,
      livePosition?.positionMint ?? null
    );

    this.logger.info(
      {
        phase: "closing",
        outcome,
        previousPositionMint: pending.previousPositionMint,
        livePositionMint: livePosition?.positionMint ?? null
      },
      "timeout reconciliation evaluated"
    );

    if (outcome === "continue") {
      await this.advancePendingPhase(state, "swapping", "recovered from close timeout");
      this.logger.info({ phase: "closing", outcome }, "recovery success");
      return true;
    }

    if (pending.retryCount < RebalancerService.MAX_TIMEOUT_RETRIES) {
      pending.retryCount += 1;
      state.latestAction = "retrying close after timeout";
      await this.stateStore.save(state);
      this.logger.warn({ phase: "closing", attempt: pending.retryCount }, "retry attempt");
      await this.executeClosePhase(state);
      return true;
    }

    await this.pauseForAmbiguousPhase(state, "closing", (error as Error).message);
    return true;
  }

  private async handleMissingClosePosition(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message ?? "";
    if (!pending || pending.phase !== "closing" || !pending.previousPositionMint || !this.isMissingAccountError(message)) {
      return false;
    }

    const livePosition = await this.orcaClient.findManagedPosition(pending.previousPositionMint);
    if (livePosition) {
      return false;
    }

    this.logger.warn(
      {
        phase: "closing",
        previousPositionMint: pending.previousPositionMint,
        error: message
      },
      "close account missing and position is already gone on-chain; continuing automatically"
    );

    await this.advancePendingPhase(state, "swapping", "position inferred closed after missing account");
    return true;
  }

  private async handleRecoverableRpcFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !isRecoverableRpcError(error)) {
      return false;
    }

    pending.retryCount += 1;
    pending.recoveryReason = (error as Error).message;
    if (
      pending.retryCount >= RebalancerService.MAX_RECOVERABLE_RPC_RETRIES &&
      pending.phase !== "closing"
    ) {
      this.logger.warn(
        {
          phase: pending.phase,
          attempt: pending.retryCount,
          error: (error as Error).message
        },
        "recoverable rpc retry budget exhausted; releasing stale pending rebalance"
      );
      state.pendingRebalance = null;
      state.inFlightRebalance = false;
      state.latestAction = "recoverable rpc retries exhausted; retrying from a fresh cycle";
      state.driftStatus = "triggered";
      state.driftDirection = null;
      await this.stateStore.save(state);
      return true;
    }

    pending.nextRetryAt = new Date(
      Date.now() +
      Math.min(
        RebalancerService.MAX_RPC_RETRY_BACKOFF_MS,
        RebalancerService.RPC_RETRY_BACKOFF_MS * Math.max(1, pending.retryCount)
      )
    ).toISOString();
    state.latestAction = `retrying ${pending.phase} after recoverable rpc failure`;
    await this.stateStore.save(state);

    this.logger.warn(
      {
        phase: pending.phase,
        attempt: pending.retryCount,
        error: (error as Error).message,
        nextRetryAt: pending.nextRetryAt
      },
      "recoverable rpc failure; retrying automatically"
    );
    return true;
  }

  private async handleRetryableCloseFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message ?? "";
    if (!pending || pending.phase !== "closing" || !this.isRetryableCloseSimulationFailure(message)) {
      return false;
    }

    const livePosition = pending.previousPositionMint
      ? await this.orcaClient.findManagedPosition(pending.previousPositionMint)
      : null;

    if (!livePosition) {
      this.logger.warn(
        {
          phase: "closing",
          previousPositionMint: pending.previousPositionMint,
          error: message
        },
        "close simulation failed but the position is already gone on-chain; continuing automatically"
      );
      await this.advancePendingPhase(state, "swapping", "position inferred closed after close simulation failure");
      return true;
    }

    pending.retryCount += 1;
    pending.recoveryReason = message;
    pending.nextRetryAt = new Date(
      Date.now() +
        Math.min(
          RebalancerService.MAX_CLOSE_RETRY_BACKOFF_MS,
          RebalancerService.CLOSE_RETRY_BACKOFF_MS * Math.max(1, pending.retryCount)
        )
    ).toISOString();
    state.latestAction = "retrying close after simulation failure";
    await this.stateStore.save(state);

    this.logger.warn(
      {
        phase: "closing",
        attempt: pending.retryCount,
        nextRetryAt: pending.nextRetryAt,
        previousPositionMint: pending.previousPositionMint,
        error: message
      },
      "close simulation failed; scheduled automatic retry"
    );
    return true;
  }

  private async handleRetryableOpenFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message ?? "";
    if (!pending || pending.phase !== "opening" || !this.isRetryableOpenFailure(message)) {
      return false;
    }

    pending.retryCount += 1;
    pending.openFailureCount += 1;
    pending.phase = "swapping";
    pending.recoveryReason = message;
    pending.entryCapitalQuote = null;
    pending.entryTokenA = null;
    pending.entryTokenB = null;
    pending.nextRetryAt = new Date(
      Date.now() +
        Math.min(
          RebalancerService.MAX_OPEN_RETRY_BACKOFF_MS,
          RebalancerService.OPEN_RETRY_BACKOFF_MS * Math.max(1, pending.retryCount)
        )
    ).toISOString();
    state.latestAction = "retrying rebalance before open after simulation failure";
    await this.stateStore.save(state);

    this.logger.warn(
      {
        phase: "opening",
        nextPhase: pending.phase,
        attempt: pending.retryCount,
        openFailureCount: pending.openFailureCount,
        nextRetryAt: pending.nextRetryAt,
        error: message
      },
      "open simulation failed; scheduled rebalance retry before next open"
    );
    return true;
  }

  private async handleRetryableSwapFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message ?? "";
    if (!pending || pending.phase !== "swapping" || !message.includes("Transaction simulation failed:")) {
      return false;
    }

    pending.retryCount += 1;
    pending.recoveryReason = message;
    pending.nextRetryAt = new Date(
      Date.now() +
        Math.min(
          RebalancerService.MAX_OPEN_RETRY_BACKOFF_MS,
          RebalancerService.OPEN_RETRY_BACKOFF_MS * Math.max(1, pending.retryCount)
        )
    ).toISOString();
    state.latestAction = "retrying swap after simulation failure";
    await this.stateStore.save(state);

    this.logger.warn(
      {
        phase: "swapping",
        attempt: pending.retryCount,
        nextRetryAt: pending.nextRetryAt,
        error: message
      },
      "swap simulation failed; scheduled automatic retry"
    );
    return true;
  }

  private async handleSwapTimeout(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !this.isTimeoutError(error, "swapping")) {
      return false;
    }

    pending.recoveryReason = (error as Error).message;
    await this.stateStore.save(state);
    this.logTimeoutDetected("swapping", error, pending);

    const balances = await this.capBalancesToAllocation(
      pending.targetCenterPrice,
      await this.orcaClient.getWalletBalances()
    );
    const needsSwap =
      this.orcaClient.assessSwapToTarget(
        pending.targetCenterPrice,
        balances.tokenA,
        balances.tokenB
      ).direction !== "none";
    const outcome = classifySwapTimeout(needsSwap);

    this.logger.info(
      {
        phase: "swapping",
        outcome,
        needsSwap
      },
      "timeout reconciliation evaluated"
    );

    if (outcome === "continue") {
      await this.advancePendingPhase(state, "opening", "recovered from swap timeout");
      this.logger.info({ phase: "swapping", outcome }, "recovery success");
      return true;
    }

    if (pending.retryCount < RebalancerService.MAX_TIMEOUT_RETRIES) {
      pending.retryCount += 1;
      state.latestAction = "retrying swap after timeout";
      await this.stateStore.save(state);
      this.logger.warn({ phase: "swapping", attempt: pending.retryCount }, "retry attempt");
      await this.executeSwapPhase(state);
      return true;
    }

    await this.pauseForAmbiguousPhase(state, "swapping", (error as Error).message);
    return true;
  }

  private async handleOpenTimeout(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !this.isTimeoutError(error, "opening")) {
      return false;
    }

    if (error instanceof TransactionTimeoutError) {
      pending.plannedPositionMint = error.details.plannedPositionMint ?? pending.plannedPositionMint;
      pending.lastKnownOpenTxId = error.details.openTxId ?? pending.lastKnownOpenTxId;
    }

    pending.recoveryReason = (error as Error).message;
    await this.stateStore.save(state);
    this.logTimeoutDetected("opening", error, pending);

    const livePosition = pending.plannedPositionMint
      ? await this.orcaClient.findManagedPosition(pending.plannedPositionMint)
      : null;

    const adoptablePosition = livePosition ?? await this.findAdoptableOpenTimeoutPosition(pending);
    if (adoptablePosition === "ambiguous") {
      await this.pauseForAmbiguousPhase(
        state,
        "opening",
        "Multiple unclaimed positions were found in the target pool after an opening timeout"
      );
      return true;
    }

    const outcome = classifyOpenTimeout({
      livePositionMint: adoptablePosition?.positionMint ?? null,
      previousPositionMint: pending.previousPositionMint,
      plannedPositionMint: pending.plannedPositionMint
    });

    this.logger.info(
      {
        phase: "opening",
        outcome,
        previousPositionMint: pending.previousPositionMint,
        plannedPositionMint: pending.plannedPositionMint,
        livePositionMint: adoptablePosition?.positionMint ?? null
      },
      "timeout reconciliation evaluated"
    );

    if (outcome === "complete" && adoptablePosition) {
      this.logger.info({ phase: "opening", outcome }, "recovery success");
      if (this.options.onPositionOpened) {
        const band = computeBand(pending.targetCenterPrice, this.config.RANGE_PCT);
        let recoveredEntryCapitalQuote = pending.entryCapitalQuote ?? 0;
        let recoveredEntryTokenA = pending.entryTokenA ?? "0";
        let recoveredEntryTokenB = pending.entryTokenB ?? "0";

        try {
          const recoveredOpenQuote = await this.orcaClient.closePosition(adoptablePosition.positionMint, false, 0);
          const recoveredOpenSummary = describeCloseQuote(
            pending.targetCenterPrice,
            recoveredOpenQuote.quote,
            this.config.TOKEN_A_DECIMALS,
            this.config.TOKEN_B_DECIMALS
          );
          recoveredEntryCapitalQuote = recoveredOpenSummary.grossValueQuote;
          recoveredEntryTokenA = recoveredOpenSummary.grossTokenA.toString();
          recoveredEntryTokenB = recoveredOpenSummary.grossTokenB.toString();
        } catch (error) {
          this.logger.warn(
            {
              phase: "opening",
              positionMint: adoptablePosition.positionMint,
              error: (error as Error).message
            },
            "recovered position basis quote failed; falling back to pending entry estimate"
          );
        }

        try {
          await this.options.onPositionOpened({
            botId: this.options.botId ?? "legacy",
            botName: this.options.botName ?? "Legacy Bot",
            whirlpoolAddress: this.config.ORCA_WHIRLPOOL_ADDRESS,
            tokenPair: `${this.config.TOKEN_A_SYMBOL}/${this.config.TOKEN_B_SYMBOL}`,
            positionMint: adoptablePosition.positionMint,
            openedAt: new Date().toISOString(),
            centerPrice: pending.targetCenterPrice,
            lowerPrice: band.lower,
            upperPrice: band.upper,
            entryCapitalQuote: recoveredEntryCapitalQuote,
            entryTokenA: recoveredEntryTokenA,
            entryTokenB: recoveredEntryTokenB,
            residualTokenA: "0",
            residualTokenB: "0",
            cumulativeSwapFeeQuote: pending.cumulativeSwapFeeQuote,
            cumulativeTxFeeLamports: pending.cumulativeTxFeeLamports,
            openTxId: pending.lastKnownOpenTxId,
            bootstrapped: true
          });
        } catch (error) {
          this.logger.warn({ error: (error as Error).message }, "position open pnl recovery update failed");
        }
      }
      await this.finalizeRebalance(
        state,
        adoptablePosition.positionMint,
        null,
        await this.inspectTransaction(pending.lastKnownOpenTxId)
      );
      return true;
    }

    if (outcome === "retry" && !adoptablePosition) {
      const previousStillLive = pending.previousPositionMint
        ? await this.orcaClient.findManagedPosition(pending.previousPositionMint)
        : null;

      if (!previousStillLive) {
        pending.plannedPositionMint = null;
        pending.recoveryReason = "Opening timeout with no live position found; retrying fresh open";
        pending.retryCount = 0;
        state.latestAction = "retrying open after timeout reconciliation";
        await this.stateStore.save(state);
        this.logger.warn(
          {
            phase: "opening",
            previousPositionMint: pending.previousPositionMint,
            plannedPositionMint: null
          },
          "opening timeout left no live position; retrying fresh open automatically"
        );
        await this.sleep(2_000);
        return true;
      }
    }

    if (pending.retryCount < RebalancerService.MAX_TIMEOUT_RETRIES) {
      pending.retryCount += 1;
      state.latestAction = "retrying open after timeout";
      await this.stateStore.save(state);
      this.logger.warn({ phase: "opening", attempt: pending.retryCount }, "retry attempt");
      await this.executeOpenPhase(state);
      return true;
    }

    await this.pauseForAmbiguousPhase(state, "opening", (error as Error).message);
    return true;
  }

  private async handleInsufficientAllocation(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !(error instanceof InsufficientAllocationError)) {
      return false;
    }

    state.activePositionMint = null;
    state.lastPnlMarkAt = null;
    state.inFlightRebalance = false;
    state.paused = false;
    state.pauseReason = null;
    state.pendingRebalance = null;
    state.driftStatus = "triggered";
    state.latestAction = "waiting for enough free balance to meet configured allocation";
    await this.stateStore.save(state);

    this.logger.warn(
      {
        phase: pending.phase,
        targetCenterPrice: pending.targetCenterPrice,
        configuredAllocationQuote: error.configuredAllocationQuote,
        availableAllocationQuote: error.availableAllocationQuote,
        minimumRequiredAllocationQuote: error.minimumRequiredAllocationQuote
      },
      "open deferred because free wallet balance is below the configured allocation target"
    );
    return true;
  }

  private async handleUnavailableAllocationQuoteBudget(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !(error instanceof AllocationQuoteBudgetUnavailableError)) {
      return false;
    }

    state.inFlightRebalance = false;
    state.paused = false;
    state.pauseReason = null;
    state.pendingRebalance = null;
    state.driftStatus = "triggered";
    state.latestAction = "waiting for quote-token pricing to size configured allocation";
    await this.stateStore.save(state);

    this.logger.warn(
      {
        phase: pending.phase,
        targetCenterPrice: pending.targetCenterPrice
      },
      "open deferred because quote-token USD pricing was unavailable for allocation sizing"
    );
    return true;
  }

  private async findAdoptableOpenTimeoutPosition(
    pending: PendingRebalance
  ): Promise<ManagedPosition | null | "ambiguous"> {
    const claimedPositionMints = new Set(await this.options.listClaimedPositionMints?.() ?? []);
    if (pending.previousPositionMint) {
      claimedPositionMints.delete(pending.previousPositionMint);
    }

    const poolPositions = await this.orcaClient.listManagedPositions(this.config.ORCA_WHIRLPOOL_ADDRESS);
    const candidates = poolPositions.filter((position) => {
      if (!position.positionMint || position.positionMint === pending.previousPositionMint) {
        return false;
      }

      return !claimedPositionMints.has(position.positionMint);
    });

    if (pending.plannedPositionMint) {
      const exactPlannedPosition = candidates.find((position) => position.positionMint === pending.plannedPositionMint);
      if (exactPlannedPosition) {
        return exactPlannedPosition;
      }
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    return candidates.length > 1 ? "ambiguous" : null;
  }

  private async advancePendingPhase(state: BotRuntimeState, nextPhase: RebalancePhase, latestAction: string) {
    if (!state.pendingRebalance) {
      return;
    }

    state.pendingRebalance.phase = nextPhase;
    state.pendingRebalance.nextRetryAt = null;
    state.pendingRebalance.retryCount = 0;
    state.pendingRebalance.recoveryReason = null;
    state.latestAction = latestAction;
    await this.stateStore.save(state);
  }

  private async finalizeRebalance(
    state: BotRuntimeState,
    newPositionMint: string | null,
    openQuote: unknown,
    openSummary: unknown,
    positionLowerPrice: number | null = null,
    positionUpperPrice: number | null = null
  ) {
    const pending = state.pendingRebalance;
    if (!pending) {
      return;
    }

    const currentPrice = pending.targetCenterPrice;
    const nextBand = computeBand(currentPrice, this.config.RANGE_PCT);
    const weights = computeTargetValueWeights(nextBand.lower, currentPrice, nextBand.upper);

    const result: RebalanceResult = {
      previousPositionMint: pending.previousPositionMint,
      newPositionMint,
      closeTxId: pending.lastKnownCloseTxId,
      swapTxId: pending.lastKnownSwapTxId,
      openTxId: pending.lastKnownOpenTxId,
      newCenterPrice: currentPrice
    };

    const driftFactor = 1 + this.config.REBALANCE_DRIFT_PCT / 100;
    state.activePositionMint = newPositionMint;
    state.lastCenterPrice = currentPrice;
    state.lastRebalanceAt = new Date().toISOString();
    state.driftDirection = null;
    state.driftStatus = "waiting";
    state.driftTriggerLower = currentPrice / driftFactor;
    state.driftTriggerUpper = currentPrice * driftFactor;
    state.positionLowerPrice = positionLowerPrice;
    state.positionUpperPrice = positionUpperPrice;
    state.inFlightRebalance = false;
    state.latestAction = "rebalance complete";
    state.paused = false;
    state.pauseReason = null;
    state.pendingRebalance = null;
    await this.stateStore.save(state);

    this.logger.info(
      {
        execute: true,
        result,
        openQuote,
        openSummary,
        lowerPrice: nextBand.lower,
        upperPrice: nextBand.upper,
        targetWeights: weights
      },
      "rebalance finished"
    );
  }

  private async pauseAfterFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message;
    const phaseLabel = pending?.phase ? `${pending.phase} phase` : "rebalance";

    state.inFlightRebalance = false;
    state.paused = true;
    state.pauseReason =
      pending
        ? `Rebalance failed during ${phaseLabel}. Manual reconciliation required: ${message}`
        : message;
    state.latestAction = "paused after rebalance failure";

    if (pending) {
      pending.recoveryReason = message;
    }

    await this.stateStore.save(state);

    this.logger.error(
      {
        error: message,
        closeTxId: pending?.lastKnownCloseTxId ?? null,
        swapTxId: pending?.lastKnownSwapTxId ?? null,
        openTxId: pending?.lastKnownOpenTxId ?? null
      },
      "rebalance failed"
    );
  }

  private async pauseForAmbiguousPhase(state: BotRuntimeState, phase: RebalancePhase, reason: string) {
    if (state.pendingRebalance) {
      state.pendingRebalance.recoveryReason = `Ambiguous ${phase} timeout`;
    }

    state.inFlightRebalance = false;
    state.paused = true;
    state.pauseReason = `Ambiguous ${phase} state after timeout. Manual reconciliation required: ${reason}`;
    state.latestAction = "paused after timeout reconciliation failure";
    await this.stateStore.save(state);

    this.logger.error(
      {
        phase,
        pauseReason: state.pauseReason
      },
      "ambiguous-state pause"
    );
  }

  private logTimeoutDetected(phase: RebalancePhase, error: unknown, pending: PendingRebalance) {
    this.logger.warn(
      {
        phase,
        error: (error as Error).message,
        retryCount: pending.retryCount,
        recoveryReason: pending.recoveryReason,
        previousPositionMint: pending.previousPositionMint,
        plannedPositionMint: pending.plannedPositionMint
      },
      "timeout detected"
    );
  }

  private async closeManagedPosition(positionMint: string, execute: boolean) {
    const slippageAttempts = [
      this.config.MAX_SLIPPAGE_BPS,
      this.config.CLOSE_RETRY_SLIPPAGE_BPS,
      this.config.CLOSE_FINAL_RETRY_SLIPPAGE_BPS
    ];

    let lastError: unknown;

    for (let attemptIndex = 0; attemptIndex < slippageAttempts.length; attemptIndex += 1) {
      const slippageBps = slippageAttempts[attemptIndex];

      try {
        return await this.orcaClient.closePosition(positionMint, execute, slippageBps);
      } catch (error) {
        lastError = error;
        if (!this.isTokenMinSubceeded(error) || attemptIndex === slippageAttempts.length - 1) {
          throw error;
        }

        const nextSlippageBps = slippageAttempts[attemptIndex + 1];
        this.logger.warn(
          {
            positionMint,
            attemptedSlippageBps: slippageBps,
            retrySlippageBps: nextSlippageBps,
            error: (error as Error).message
          },
          "close quote was too tight, retrying with wider slippage"
        );

        await this.sleep(1_000);
      }
    }

    throw lastError;
  }

  private async openManagedPosition(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    previousPositionMint: string | null,
    openFailureCount = 0
  ) {
    const attempts = this.getOpenAttemptsForFailureCount(openFailureCount);

    let lastError: unknown;
    const allocationQuoteBudget = await this.options.resolveAllocationQuoteBudget?.(currentPrice) ?? null;

    if (
      !this.isUsdcQuoteToken() &&
      !(typeof allocationQuoteBudget === "number" && Number.isFinite(allocationQuoteBudget) && allocationQuoteBudget > 0)
    ) {
      throw new AllocationQuoteBudgetUnavailableError();
    }

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const { slippageBps, deploymentBufferBps } = attempts[attemptIndex];

      try {
        return await this.orcaClient.openCenteredPosition(
          currentPrice,
          tokenA,
          tokenB,
          execute,
          previousPositionMint,
          slippageBps,
          deploymentBufferBps,
          allocationQuoteBudget ?? undefined
        );
      } catch (error) {
        lastError = error;
        const message = (error as Error).message ?? "";
        if (
          (!this.isOpenSlippageError(error) && !this.isRetryableOpenSimulationFailure(message)) ||
          attemptIndex === attempts.length - 1
        ) {
          throw error;
        }

        const nextAttempt = attempts[attemptIndex + 1];
        this.logger.warn(
          {
            previousPositionMint,
            openFailureCount,
            attemptedSlippageBps: slippageBps,
            attemptedDeploymentBufferBps: deploymentBufferBps,
            retrySlippageBps: nextAttempt.slippageBps,
            retryDeploymentBufferBps: nextAttempt.deploymentBufferBps,
            error: message
          },
          "open quote was too tight, retrying with wider slippage and more deployment buffer"
        );

        await this.sleep(1_000);
      }
    }

    throw lastError;
  }

  private isTokenMinSubceeded(error: unknown) {
    return (error as Error).message.includes(RebalancerService.TOKEN_MIN_SUBCEEDED_CODE);
  }

  private isOpenSlippageError(error: unknown) {
    return (error as Error).message.includes(RebalancerService.OPEN_SLIPPAGE_ERROR_CODE);
  }

  private isTimeoutError(error: unknown, phase?: RebalancePhase): error is TransactionTimeoutError {
    if (error instanceof TransactionTimeoutError) {
      return phase ? error.phase === phase : true;
    }

    const message = (error as Error).message ?? "";
    return message.includes(RebalancerService.TIMEOUT_TEXT);
  }

  private isTimeoutMessage(value: string | null) {
    return Boolean(value?.includes(RebalancerService.TIMEOUT_TEXT));
  }

  private isMissingAccountError(message: string) {
    return message.includes("Account not found at address:");
  }

  private isRetryableCloseSimulationFailure(message: string) {
    return message.includes("Transaction simulation failed:");
  }

  private isInsufficientOpenBalanceFailure(message: string) {
    return message.includes("Insufficient deployable balance to open a position");
  }

  private isRetryableOpenSimulationFailure(message: string) {
    return message.includes("Transaction simulation failed:");
  }

  private isRetryableOpenFailure(message: string) {
    return this.isRetryableOpenSimulationFailure(message) || this.isInsufficientOpenBalanceFailure(message);
  }

  private requiresAdditionalPreOpenRebalance(pending: PendingRebalance) {
    return pending.openFailureCount > 0 || this.isRetryableOpenFailure(pending.recoveryReason ?? "");
  }

  private shouldRecoverPausedPendingRebalance(state: BotRuntimeState) {
    if (!state.pendingRebalance) {
      return false;
    }

    if (shouldRecoverPausedTimeout(state.pauseReason, state.pendingRebalance)) {
      return true;
    }

    return (
      state.pendingRebalance.phase === "closing" &&
      this.isRetryableCloseSimulationFailure(state.pauseReason ?? "")
    ) || (
      state.pendingRebalance.phase === "swapping" &&
      (state.pauseReason ?? "").includes("Transaction simulation failed:")
    ) || (
      state.pendingRebalance.phase === "opening" &&
      this.isRetryableOpenFailure(state.pauseReason ?? "")
    ) || this.isRecoverableAllocationPause(state) ||
      this.isUnsupportedFundingRouteDiscoveryPause(state);
  }

  private isRecoverableAllocationPause(state: BotRuntimeState) {
    const message = state.pauseReason ?? "";
    return state.pendingRebalance != null &&
      (
        message.includes("Insufficient free wallet balance to fund the requested allocation") ||
        message.includes("Allocation quote budget is unavailable for this pool")
      );
  }

  private isUnsupportedFundingRouteDiscoveryPause(state: BotRuntimeState) {
    return state.pendingRebalance?.phase === "opening" &&
      (
        (state.pauseReason ?? "").includes("excluded from account secondary indexes") ||
        (state.pauseReason ?? "").includes("duplicate instruction")
      );
  }

  private async inspectTransaction(signature: string | null) {
    if (!signature) {
      return null;
    }

    try {
      return await this.transactionInspector.inspect(signature);
    } catch (error) {
      this.logger.warn(
        {
          signature,
          error: (error as Error).message
        },
        "failed to inspect transaction"
      );
      return null;
    }
  }

  private async waitForPostCloseBalances(
    owner: string,
    closedPositionMint: string,
    minimumTokenA: bigint,
    minimumTokenB: bigint
  ) {
    this.orcaClient.clearPositionCache();
    await this.sleep(2_000);

    const [balances, livePosition] = await Promise.all([
      this.accountReader.getWalletBalances(owner, this.config.TOKEN_A_MINT, this.config.TOKEN_B_MINT),
      this.orcaClient.findManagedPosition(closedPositionMint)
    ]);

    const positionGone = !livePosition || livePosition.positionMint !== closedPositionMint;
    const balancesReady = balances.tokenA >= minimumTokenA && balances.tokenB >= minimumTokenB;

    if (positionGone && balancesReady) {
      return balances;
    }

    this.orcaClient.clearPositionCache();
    await this.sleep(3_000);

    return this.accountReader.getWalletBalances(owner, this.config.TOKEN_A_MINT, this.config.TOKEN_B_MINT);
  }

  private quoteValue(currentPrice: number, tokenA: bigint, tokenB: bigint) {
    return fromBaseUnits(tokenA, this.config.TOKEN_A_DECIMALS) * currentPrice +
      fromBaseUnits(tokenB, this.config.TOKEN_B_DECIMALS);
  }

  private swapFeeQuoteValue(currentPrice: number, direction: string, quote: any) {
    const tradeFee = BigInt(quote?.quote?.tradeFee ?? 0);
    if (tradeFee) {
      if (direction === "sell-token-a") {
        return fromBaseUnits(tradeFee, this.config.TOKEN_A_DECIMALS) * currentPrice;
      }

      return fromBaseUnits(tradeFee, this.config.TOKEN_B_DECIMALS);
    }

    const routePlan = Array.isArray(quote?.routePlan) ? quote.routePlan : [];
    let totalFeeQuote = 0;
    for (const hop of routePlan) {
      const swapInfo = hop?.swapInfo;
      const feeAmount = BigInt(swapInfo?.feeAmount ?? 0);
      const feeMint = swapInfo?.feeMint;
      if (!feeAmount || !feeMint) {
        continue;
      }

      if (feeMint === this.config.TOKEN_A_MINT) {
        totalFeeQuote += fromBaseUnits(feeAmount, this.config.TOKEN_A_DECIMALS) * currentPrice;
      } else if (feeMint === this.config.TOKEN_B_MINT) {
        totalFeeQuote += fromBaseUnits(feeAmount, this.config.TOKEN_B_DECIMALS);
      }
    }

    return totalFeeQuote;
  }

  private nonNegativeBigInt(amount: bigint) {
    return amount >= 0n ? amount : 0n;
  }

  private async capBalancesToAllocation(currentPrice: number, balances: WalletBalances): Promise<WalletBalances> {
    const fallbackAllocationQuote =
      this.isUsdcQuoteToken()
        ? Number((this.config as AppConfig & { BOT_ALLOCATION_USDC?: number }).BOT_ALLOCATION_USDC ?? Number.POSITIVE_INFINITY)
        : null;
    const allocationQuoteBudget = await this.options.resolveAllocationQuoteBudget?.(currentPrice) ??
      fallbackAllocationQuote ??
      Number.POSITIVE_INFINITY;
    if (!Number.isFinite(allocationQuoteBudget) || allocationQuoteBudget <= 0) {
      return balances;
    }

    const reserve = this.config.TOKEN_A_MINT === "So11111111111111111111111111111111111111112"
      ? BigInt(this.config.SOL_RESERVE_LAMPORTS)
      : 0n;
    const deployableTokenA = balances.tokenA > reserve ? balances.tokenA - reserve : 0n;
    const deployableTokenAValue = this.baseUnitsToDecimal(deployableTokenA, this.config.TOKEN_A_DECIMALS) * currentPrice;
    const deployableTokenBValue = this.baseUnitsToDecimal(balances.tokenB, this.config.TOKEN_B_DECIMALS);
    const totalValue = deployableTokenAValue + deployableTokenBValue;

    if (!Number.isFinite(totalValue) || totalValue <= allocationQuoteBudget) {
      return balances;
    }

    const scale = allocationQuoteBudget / totalValue;
    const cappedTokenA = this.decimalToBaseUnits(deployableTokenAValue / currentPrice * scale, this.config.TOKEN_A_DECIMALS);
    const cappedTokenB = this.decimalToBaseUnits(deployableTokenBValue * scale, this.config.TOKEN_B_DECIMALS);

    return {
      tokenA: cappedTokenA + reserve,
      tokenB: cappedTokenB
    };
  }

  private baseUnitsToDecimal(amount: bigint, decimals: number) {
    return Number(amount) / 10 ** decimals;
  }

  private decimalToBaseUnits(amount: number, decimals: number) {
    if (!Number.isFinite(amount) || amount <= 0) {
      return 0n;
    }

    return BigInt(Math.floor(amount * 10 ** decimals));
  }

  private normalizePendingRebalance(pending: PendingRebalance) {
    pending.openFailureCount = Number.isFinite(pending.openFailureCount) ? pending.openFailureCount : 0;
  }

  private getPreOpenRebalanceToleranceBps(pending: PendingRebalance) {
    return pending.openFailureCount > 0
      ? Math.min(this.config.OPEN_BALANCE_TOLERANCE_BPS, RebalancerService.OPEN_RETRY_BALANCE_TOLERANCE_BPS)
      : this.config.OPEN_BALANCE_TOLERANCE_BPS;
  }

  private getOpenAttemptsForFailureCount(openFailureCount: number) {
    const openAttempts = [
      {
        slippageBps: this.config.MAX_SLIPPAGE_BPS,
        deploymentBufferBps: this.config.OPEN_DEPLOYMENT_BUFFER_BPS
      },
      {
        slippageBps: this.config.OPEN_RETRY_SLIPPAGE_BPS,
        deploymentBufferBps: this.config.OPEN_RETRY_DEPLOYMENT_BUFFER_BPS
      },
      {
        slippageBps: this.config.OPEN_FINAL_RETRY_SLIPPAGE_BPS,
        deploymentBufferBps: this.config.OPEN_FINAL_DEPLOYMENT_BUFFER_BPS
      }
    ];
    const startingAttemptIndex = openFailureCount >= 5 ? 2 : openFailureCount >= 2 ? 1 : 0;
    return openAttempts.slice(startingAttemptIndex);
  }

  private getPreOpenRebalanceAttemptLimit(pending: PendingRebalance) {
    if (pending.openFailureCount <= 0) {
      return RebalancerService.MAX_STRICT_PREOPEN_SWAPS;
    }

    return Math.min(
      RebalancerService.MAX_OPEN_FAILURE_PREOPEN_SWAPS,
      RebalancerService.MAX_STRICT_PREOPEN_SWAPS + pending.openFailureCount * 2
    );
  }

  private async performPreOpenRebalance(
    state: BotRuntimeState,
    pending: PendingRebalance,
    startingBalances: WalletBalances,
    reason: "strict pre-open rebalance" | "pre-open retry rebalance"
  ) {
    let balances = startingBalances;
    let swapsExecuted = 0;
    const valueToleranceBps = this.getPreOpenRebalanceToleranceBps(pending);
    const maxAttempts = this.getPreOpenRebalanceAttemptLimit(pending);
    const allocationQuoteBudget = await this.options.resolveAllocationQuoteBudget?.(pending.targetCenterPrice) ?? undefined;
    const nextOpenAttempt = this.getOpenAttemptsForFailureCount(pending.openFailureCount)[0];
    const deploymentBufferBps = nextOpenAttempt?.deploymentBufferBps ?? this.config.OPEN_DEPLOYMENT_BUFFER_BPS;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      const assessment = this.orcaClient.assessSwapToOpenTarget(
        pending.targetCenterPrice,
        balances.tokenA,
        balances.tokenB,
        deploymentBufferBps,
        allocationQuoteBudget,
        {
          minSwapUsdc: 0,
          valueToleranceBps
        }
      );

      if (assessment.direction === "none") {
        break;
      }

      if (
        pending.openFailureCount > 0 &&
        (
          assessment.inputAmount <= 0n ||
          Math.abs(assessment.valueDelta) < RebalancerService.MIN_STRICT_PREOPEN_SWAP_QUOTE
        )
      ) {
        this.logger.info(
          {
            reason,
            attempt: attemptIndex + 1,
            valueDelta: assessment.valueDelta,
            valueDeltaBps: assessment.valueDeltaBps,
            inputAmount: assessment.inputAmount.toString(),
            openFailureCount: pending.openFailureCount
          },
          "skipping dust-level pre-open rebalance swap"
        );
        break;
      }

      const swapResult = await this.orcaClient.swapToOpenTarget(
        pending.targetCenterPrice,
        balances.tokenA,
        balances.tokenB,
        true,
        deploymentBufferBps,
        allocationQuoteBudget,
        {
          minSwapUsdc: 0,
          valueToleranceBps
        }
      );
      pending.lastKnownSwapTxId = swapResult.txId ?? pending.lastKnownSwapTxId;
      swapsExecuted += 1;
      state.latestAction = `${reason} swap ${attemptIndex + 1}`;
      await this.stateStore.save(state);
      const swapSummary = await this.inspectTransaction(swapResult.txId);
      pending.cumulativeTxFeeLamports += swapSummary?.feeLamports ?? 0;

      this.logger.info(
        {
          execute: true,
          direction: swapResult.direction,
          inputAmount: swapResult.inputAmount.toString(),
          swapTxId: swapResult.txId,
          swapQuote: swapResult.quote ?? null,
          swapSummary,
          reason,
          attempt: attemptIndex + 1,
          maxAttempts,
          valueDeltaBps: assessment.valueDeltaBps,
          openFailureCount: pending.openFailureCount,
          desiredTokenAMax: assessment.plan.rawTargetTokenA.toString(),
          desiredTokenBMax: assessment.plan.rawTargetTokenB.toString(),
          deploymentBufferBps
        },
        "swap plan evaluated"
      );

      balances = await this.capBalancesToAllocation(
        pending.targetCenterPrice,
        await this.orcaClient.getWalletBalances()
      );
    }

    return {
      balances,
      swapsExecuted
    };
  }

  private async fundWalletForAllocationIfNeeded(
    state: BotRuntimeState,
    pending: PendingRebalance,
    balances: WalletBalances,
    phase: "swapping" | "opening"
  ) {
    const fallbackAllocationQuote =
      this.isUsdcQuoteToken()
        ? Number((this.config as AppConfig & { BOT_ALLOCATION_USDC?: number }).BOT_ALLOCATION_USDC ?? Number.POSITIVE_INFINITY)
        : null;
    const allocationQuoteBudget = await this.options.resolveAllocationQuoteBudget?.(pending.targetCenterPrice) ??
      fallbackAllocationQuote;
    const availableQuote = this.quoteValue(pending.targetCenterPrice, balances.tokenA, balances.tokenB);
    const missingQuote = typeof allocationQuoteBudget === "number" && Number.isFinite(allocationQuoteBudget)
      ? Math.max(0, allocationQuoteBudget - availableQuote)
      : 0;

    if (missingQuote <= 0) {
      return balances;
    }

    const fundingTargetRaw = toBaseUnits(missingQuote, this.config.TOKEN_B_DECIMALS);
    if (fundingTargetRaw <= 0n) {
      return balances;
    }

    const fundingResult = await this.orcaClient.fundQuoteTokenFromWallet(fundingTargetRaw, true);
    if (fundingResult.txIds.length === 0) {
      this.logger.warn(
        {
          phase,
          missingQuote,
          tokenAMint: this.config.TOKEN_A_MINT,
          tokenBMint: this.config.TOKEN_B_MINT
        },
        "no wallet funding route could satisfy the remaining allocation deficit"
      );
      return balances;
    }

    state.latestAction = `funding wallet for allocation (${fundingResult.txIds.length} swap${fundingResult.txIds.length === 1 ? "" : "s"})`;
    pending.lastKnownSwapTxId = fundingResult.txIds.at(-1) ?? pending.lastKnownSwapTxId;
    await this.stateStore.save(state);

    for (const txId of fundingResult.txIds) {
      const summary = await this.inspectTransaction(txId);
      pending.cumulativeTxFeeLamports += summary?.feeLamports ?? 0;
    }

    this.logger.info(
      {
        phase,
        missingQuote,
        fundingTxIds: fundingResult.txIds,
        fundingRoute: fundingResult.route
      },
      "wallet funding swap(s) completed before open"
    );

    return await this.orcaClient.getWalletBalances();
  }

  private async runExclusive<T>(reason: "trigger" | "manual" | "recovery", task: () => Promise<T>): Promise<T> {
    if (!this.options.runExclusive) {
      return task();
    }

    return this.options.runExclusive(reason, task);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isUsdcQuoteToken() {
    return this.config.TOKEN_B_MINT === RebalancerService.USDC_MINT || this.config.TOKEN_B_SYMBOL.toUpperCase() === "USDC";
  }
}
