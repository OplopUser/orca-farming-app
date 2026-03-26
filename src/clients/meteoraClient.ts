/**
 * MeteoraClient — PlatformClient implementation for Meteora DLMM pools.
 *
 * All Meteora DLMM SDK calls are isolated here. The rebalancer and supervisor
 * only ever interact with this class through the PlatformClient interface.
 *
 * Architecture notes:
 * - Uses @meteora-ag/dlmm SDK for LP operations (open/close positions)
 * - Reuses Jupiter /swap endpoint (serialized transaction) for token swaps
 * - Position identity: Meteora positions are program accounts (PublicKey),
 *   stored as positionMint = positionAddress = position.publicKey.toBase58()
 * - Bin range derived from RANGE_PCT_BELOW / RANGE_PCT_ABOVE (asymmetric)
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  VersionedTransaction
} from "@solana/web3.js";

// Force CJS build of @meteora-ag/dlmm to avoid ESM source-file interop issues
const _require = createRequire(import.meta.url);
const _dlmmModule = _require("@meteora-ag/dlmm") as { StrategyType: Record<string, number> };
// The CJS export is the DLMM class itself; StrategyType is a property on it
const DLMM = _dlmmModule as unknown as { create: (connection: Connection, poolAddress: PublicKey) => Promise<any>; [key: string]: unknown };
const StrategyType = (_dlmmModule as any).StrategyType as { Spot: number; Curve: number; BidAsk: number };

import type { AppConfig } from "../config.js";
import {
  TransactionTimeoutError,
  type ManagedPosition,
  type PoolMetadata,
  type PoolSnapshot,
  type WalletBalances
} from "../domain.js";
import { RpcAccountReader } from "../infra/rpcAccountReader.js";
import { computeTargetValueWeights, fromBaseUnits, toBaseUnits } from "../strategy/bands.js";
import { InsufficientAllocationError } from "./orcaClient.js";
import type {
  PlatformClient,
  ClosePositionResult,
  OpenPositionResult,
  SwapResult,
  SwapAssessment,
  SwapOptions,
  FundResult,
  OpenPlan
} from "./platformClient.js";

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  slippageBps?: number;
  [key: string]: unknown;
}

export class MeteoraClient implements PlatformClient {
  private static readonly SOL_MINT = "So11111111111111111111111111111111111111112";
  private static readonly USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  private static readonly TX_WAIT_MS = 45_000;
  private static readonly MIN_OPEN_ALLOCATION_FILL_BPS = 9_000;
  private static readonly POSITION_CACHE_TTL_MS = 2_000;

  private static readonly KNOWN_SYMBOLS: Record<string, string> = {
    "So11111111111111111111111111111111111111112": "SOL",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
    "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH"
  };

  private connection?: Connection;
  private keypair?: Keypair;
  private walletAddress?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pool?: any; // DLMM instance — typed as any due to ESM/CJS interop limitations
  private readonly accountReader: RpcAccountReader;
  private positionCache: { positions: ManagedPosition[]; fetchedAt: number } | null = null;

  constructor(private readonly config: AppConfig) {
    this.accountReader = new RpcAccountReader(config.solanaRpcUrls);
  }

  async init(): Promise<void> {
    if (this.connection && this.keypair && this.pool) {
      return;
    }

    this.connection = new Connection(this.config.solanaRpcUrls[0]!, "confirmed");

    const walletBytes = Uint8Array.from(
      JSON.parse(await readFile(this.config.BOT_WALLET_KEYPAIR_PATH, "utf8")) as number[]
    );
    this.keypair = Keypair.fromSecretKey(walletBytes);
    this.walletAddress = this.keypair.publicKey.toBase58();

    const poolPublicKey = new PublicKey(this.config.ORCA_WHIRLPOOL_ADDRESS);
    this.pool = await DLMM.create(this.connection, poolPublicKey);
  }

  getOwnerAddress(): string {
    if (!this.walletAddress) {
      throw new Error("MeteoraClient has not been initialized");
    }
    return this.walletAddress;
  }

  clearPositionCache(): void {
    this.positionCache = null;
  }

  // ─── Pool queries ─────────────────────────────────────────────────────────────

  async fetchPoolSnapshot(): Promise<PoolSnapshot> {
    await this.init();
    const activeBin = await this.pool!.getActiveBin();
    const currentPrice = parseFloat(activeBin.pricePerToken);

    return {
      whirlpoolAddress: this.config.ORCA_WHIRLPOOL_ADDRESS,
      currentPrice,
      tokenAMint: this.config.TOKEN_A_MINT,
      tokenBMint: this.config.TOKEN_B_MINT,
      tokenADecimals: this.config.TOKEN_A_DECIMALS,
      tokenBDecimals: this.config.TOKEN_B_DECIMALS,
      raw: activeBin,
      platform: "meteora" as const,
      activeBinId: activeBin.binId
    };
  }

  async discoverPoolMetadata(poolAddress: string): Promise<PoolMetadata> {
    const connection = new Connection(this.config.solanaRpcUrls[0]!, "confirmed");
    const pool = await DLMM.create(connection, new PublicKey(poolAddress));

    const tokenXMint = pool.tokenX.mint.address.toBase58();
    const tokenYMint = pool.tokenY.mint.address.toBase58();
    const tokenXDecimals = pool.tokenX.mint.decimals;
    const tokenYDecimals = pool.tokenY.mint.decimals;
    const binStep = pool.lbPair.binStep;

    return {
      whirlpoolAddress: poolAddress,
      tokenAMint: tokenXMint,
      tokenASymbol: MeteoraClient.KNOWN_SYMBOLS[tokenXMint] ?? tokenXMint.slice(0, 4) + "...",
      tokenADecimals: tokenXDecimals,
      tokenBMint: tokenYMint,
      tokenBSymbol: MeteoraClient.KNOWN_SYMBOLS[tokenYMint] ?? tokenYMint.slice(0, 4) + "...",
      tokenBDecimals: tokenYDecimals,
      platform: "meteora" as const,
      binStep
    };
  }

  // ─── Position queries ─────────────────────────────────────────────────────────

  async findManagedPosition(expectedPositionMint?: string | null): Promise<ManagedPosition | null> {
    await this.init();
    const positions = await this.fetchCachedPositions();

    if (expectedPositionMint) {
      return positions.find((p) => p.positionMint === expectedPositionMint) ?? null;
    }

    return positions[0] ?? null;
  }

  async listManagedPositions(poolAddress = this.config.ORCA_WHIRLPOOL_ADDRESS): Promise<ManagedPosition[]> {
    await this.init();
    const positions = await this.fetchCachedPositions();
    return positions.filter((p) => p.whirlpoolAddress === poolAddress);
  }

  async listAllOwnerPositions(): Promise<ManagedPosition[]> {
    await this.init();
    return this.fetchCachedPositions();
  }

  async getWalletBalances(): Promise<WalletBalances> {
    await this.init();
    return this.accountReader.getWalletBalances(
      this.getOwnerAddress(),
      this.config.TOKEN_A_MINT,
      this.config.TOKEN_B_MINT
    );
  }

  async getSolUsdcPrice(): Promise<number> {
    const oneSol = toBaseUnits(1, 9);
    const quote = await this.fetchJupiterQuote(
      MeteoraClient.SOL_MINT,
      MeteoraClient.USDC_MINT,
      oneSol
    );
    return fromBaseUnits(BigInt(quote.outAmount), 6);
  }

  // ─── Swap assessment (pure math, no network) ─────────────────────────────────

  assessSwapToTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    options?: SwapOptions
  ): SwapAssessment {
    const { lower, upper } = this.computeRange(currentPrice);
    const targetWeights = computeTargetValueWeights(lower, currentPrice, upper);

    const tokenAUnits = fromBaseUnits(tokenA, this.config.TOKEN_A_DECIMALS);
    const tokenBUnits = fromBaseUnits(tokenB, this.config.TOKEN_B_DECIMALS);
    const totalValueInTokenB = tokenAUnits * currentPrice + tokenBUnits;
    const targetValueTokenA = totalValueInTokenB * targetWeights.tokenA;
    const currentValueTokenA = tokenAUnits * currentPrice;
    const valueDelta = targetValueTokenA - currentValueTokenA;
    const minSwapRaw = options?.minSwapUsdc ?? this.config.MIN_SWAP_USDC;
    const valueToleranceBps = options?.valueToleranceBps ?? 0;
    const valueDeltaBps = totalValueInTokenB > 0 ? Math.abs(valueDelta) / totalValueInTokenB * 10_000 : 0;

    if (valueDeltaBps <= valueToleranceBps || Math.abs(valueDelta) < minSwapRaw) {
      return { direction: "none", inputAmount: 0n, targetWeights, valueDelta, valueDeltaBps };
    }

    const direction = valueDelta > 0 ? "buy-token-a" as const : "sell-token-a" as const;
    const inputAmount =
      direction === "buy-token-a"
        ? toBaseUnits(Math.abs(valueDelta), this.config.TOKEN_B_DECIMALS)
        : toBaseUnits(Math.abs(valueDelta) / currentPrice, this.config.TOKEN_A_DECIMALS);

    return { direction, inputAmount, targetWeights, valueDelta, valueDeltaBps };
  }

  assessSwapToOpenTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    deploymentBufferBps = this.config.OPEN_DEPLOYMENT_BUFFER_BPS,
    allocationQuoteOverride?: number,
    options?: SwapOptions
  ): SwapAssessment & { plan: OpenPlan } {
    const { lower, upper } = this.computeRange(currentPrice);
    const weights = computeTargetValueWeights(lower, currentPrice, upper);

    const tokenAUnits = fromBaseUnits(tokenA, this.config.TOKEN_A_DECIMALS);
    const tokenBUnits = fromBaseUnits(tokenB, this.config.TOKEN_B_DECIMALS);
    const totalAvailableQuote = tokenAUnits * currentPrice + tokenBUnits;

    const configuredAllocationQuote =
      typeof allocationQuoteOverride === "number" && allocationQuoteOverride > 0
        ? allocationQuoteOverride
        : (this.config.BOT_ALLOCATION_USDC > 0 ? this.config.BOT_ALLOCATION_USDC : null);

    const minimumRequiredAllocationQuote =
      typeof configuredAllocationQuote === "number" && configuredAllocationQuote > 0
        ? configuredAllocationQuote * MeteoraClient.MIN_OPEN_ALLOCATION_FILL_BPS / 10_000
        : 0;

    if (
      typeof configuredAllocationQuote === "number" &&
      configuredAllocationQuote > 0 &&
      totalAvailableQuote < minimumRequiredAllocationQuote
    ) {
      throw new InsufficientAllocationError(
        configuredAllocationQuote,
        totalAvailableQuote,
        minimumRequiredAllocationQuote
      );
    }

    const allocationQuote =
      typeof configuredAllocationQuote === "number" && configuredAllocationQuote > 0
        ? Math.min(configuredAllocationQuote, totalAvailableQuote)
        : totalAvailableQuote;

    const remainingFraction = Math.max(0.0001, (10_000 - deploymentBufferBps) / 10_000);
    const rawTargetTokenA = toBaseUnits(
      (allocationQuote * weights.tokenA / currentPrice) / remainingFraction,
      this.config.TOKEN_A_DECIMALS
    );
    const rawTargetTokenB = toBaseUnits(
      (allocationQuote * weights.tokenB) / remainingFraction,
      this.config.TOKEN_B_DECIMALS
    );

    const plan = { rawTargetTokenA, rawTargetTokenB, weights, allocationQuote };

    const desiredTokenAValue = fromBaseUnits(rawTargetTokenA, this.config.TOKEN_A_DECIMALS) * currentPrice;
    const desiredTokenBValue = fromBaseUnits(rawTargetTokenB, this.config.TOKEN_B_DECIMALS);
    const tokenADeltaValue = desiredTokenAValue - tokenAUnits * currentPrice;
    const tokenBDeltaValue = desiredTokenBValue - tokenBUnits;
    const desiredTotalValue = desiredTokenAValue + desiredTokenBValue;
    const minSwapRaw = options?.minSwapUsdc ?? this.config.MIN_SWAP_USDC;
    const valueToleranceBps = options?.valueToleranceBps ?? 0;
    const effectiveValueDelta = Math.min(Math.abs(tokenADeltaValue), Math.abs(tokenBDeltaValue));
    const valueDeltaBps = desiredTotalValue > 0 ? effectiveValueDelta / desiredTotalValue * 10_000 : 0;

    if (
      tokenADeltaValue > 0 && tokenBDeltaValue < 0 &&
      valueDeltaBps > valueToleranceBps && effectiveValueDelta >= minSwapRaw
    ) {
      return {
        direction: "buy-token-a",
        inputAmount: toBaseUnits(effectiveValueDelta, this.config.TOKEN_B_DECIMALS),
        targetWeights: weights, valueDelta: tokenADeltaValue, valueDeltaBps, plan
      };
    }

    if (
      tokenADeltaValue < 0 && tokenBDeltaValue > 0 &&
      valueDeltaBps > valueToleranceBps && effectiveValueDelta >= minSwapRaw
    ) {
      return {
        direction: "sell-token-a",
        inputAmount: toBaseUnits(effectiveValueDelta / currentPrice, this.config.TOKEN_A_DECIMALS),
        targetWeights: weights, valueDelta: tokenADeltaValue, valueDeltaBps, plan
      };
    }

    return { direction: "none", inputAmount: 0n, targetWeights: weights, valueDelta: tokenADeltaValue, valueDeltaBps, plan };
  }

  // ─── Swap execution ───────────────────────────────────────────────────────────

  async swapToTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    options?: SwapOptions
  ): Promise<SwapResult> {
    await this.init();
    const assessment = this.assessSwapToTarget(currentPrice, tokenA, tokenB, options);

    if (assessment.direction === "none") {
      return { dryRun: !execute, direction: "none", inputAmount: 0n, quote: null, txId: null, targetWeights: assessment.targetWeights, assessment };
    }

    const inputMint = assessment.direction === "buy-token-a" ? this.config.TOKEN_B_MINT : this.config.TOKEN_A_MINT;
    const outputMint = assessment.direction === "buy-token-a" ? this.config.TOKEN_A_MINT : this.config.TOKEN_B_MINT;
    const result = await this.jupiterSwap(inputMint, outputMint, assessment.inputAmount, execute);

    return { dryRun: !execute, direction: assessment.direction, inputAmount: assessment.inputAmount, quote: result.quote, txId: result.txId, targetWeights: assessment.targetWeights, assessment };
  }

  async swapToOpenTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    deploymentBufferBps = this.config.OPEN_DEPLOYMENT_BUFFER_BPS,
    allocationQuoteOverride?: number,
    options?: SwapOptions
  ): Promise<SwapResult> {
    await this.init();
    const assessment = this.assessSwapToOpenTarget(currentPrice, tokenA, tokenB, deploymentBufferBps, allocationQuoteOverride, options);

    if (assessment.direction === "none") {
      return { dryRun: !execute, direction: "none", inputAmount: 0n, quote: null, txId: null, targetWeights: assessment.targetWeights, assessment };
    }

    const inputMint = assessment.direction === "buy-token-a" ? this.config.TOKEN_B_MINT : this.config.TOKEN_A_MINT;
    const outputMint = assessment.direction === "buy-token-a" ? this.config.TOKEN_A_MINT : this.config.TOKEN_B_MINT;
    const result = await this.jupiterSwap(inputMint, outputMint, assessment.inputAmount, execute);

    return { dryRun: !execute, direction: assessment.direction, inputAmount: assessment.inputAmount, quote: result.quote, txId: result.txId, targetWeights: assessment.targetWeights, assessment };
  }

  // ─── Position lifecycle ───────────────────────────────────────────────────────

  async closePosition(
    positionMint: string,
    execute: boolean,
    _slippageBps?: number
  ): Promise<ClosePositionResult> {
    await this.init();
    const pool = this.pool!;
    const user = this.keypair!.publicKey;

    const { userPositions } = await pool.getPositionsByUserAndLbPair(user);
    const lbPosition = (userPositions as any[]).find((p: any) => p.publicKey.toBase58() === positionMint);

    if (!lbPosition) {
      return { dryRun: !execute, quote: null, txId: null };
    }

    const { lowerBinId, upperBinId } = lbPosition.positionData;

    if (!execute) {
      return { dryRun: true, quote: lbPosition.positionData, txId: null };
    }

    const removeTxs = await pool.removeLiquidity({
      user,
      position: lbPosition.publicKey,
      fromBinId: lowerBinId,
      toBinId: upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true
    });

    let lastTxId: string | null = null;
    for (const tx of removeTxs) {
      lastTxId = await this.sendLegacyTransaction(tx, "closing", { positionMint });
    }

    this.positionCache = null;
    return { dryRun: false, quote: lbPosition.positionData, txId: lastTxId };
  }

  async openCenteredPosition(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    _previousPositionMint?: string | null,
    _slippageBps?: number,
    deploymentBufferBps = this.config.OPEN_DEPLOYMENT_BUFFER_BPS,
    allocationQuoteOverride?: number
  ): Promise<OpenPositionResult> {
    await this.init();
    const pool = this.pool!;
    const user = this.keypair!.publicKey;

    // Get active bin and pool parameters
    const activeBin = await pool.getActiveBin();
    const activeBinId = activeBin.binId;
    const binStep = pool.lbPair.binStep;

    // Compute asymmetric bin range
    const binsBelow = Math.max(1, Math.ceil(this.config.RANGE_PCT_BELOW / (binStep / 100)));
    const binsAbove = Math.max(1, Math.ceil(this.config.RANGE_PCT_ABOVE / (binStep / 100)));
    const minBinId = activeBinId - binsBelow;
    const maxBinId = activeBinId + binsAbove;

    // Price bounds for ledger recording
    const { lower: lowerPrice, upper: upperPrice } = this.computeRange(currentPrice);

    // Compute amounts to deploy
    const { lower, upper } = this.computeRange(currentPrice);
    const weights = computeTargetValueWeights(lower, currentPrice, upper);

    const tokenAUnits = fromBaseUnits(tokenA, this.config.TOKEN_A_DECIMALS);
    const tokenBUnits = fromBaseUnits(tokenB, this.config.TOKEN_B_DECIMALS);
    const totalAvailableQuote = tokenAUnits * currentPrice + tokenBUnits;

    const configuredAllocationQuote =
      typeof allocationQuoteOverride === "number" && allocationQuoteOverride > 0
        ? allocationQuoteOverride
        : (this.config.BOT_ALLOCATION_USDC > 0 ? this.config.BOT_ALLOCATION_USDC : null);

    const minimumRequiredAllocationQuote =
      typeof configuredAllocationQuote === "number" && configuredAllocationQuote > 0
        ? configuredAllocationQuote * MeteoraClient.MIN_OPEN_ALLOCATION_FILL_BPS / 10_000
        : 0;

    if (
      typeof configuredAllocationQuote === "number" &&
      configuredAllocationQuote > 0 &&
      totalAvailableQuote < minimumRequiredAllocationQuote
    ) {
      throw new InsufficientAllocationError(configuredAllocationQuote, totalAvailableQuote, minimumRequiredAllocationQuote);
    }

    const allocationQuote =
      typeof configuredAllocationQuote === "number" && configuredAllocationQuote > 0
        ? Math.min(configuredAllocationQuote, totalAvailableQuote)
        : totalAvailableQuote;

    const remainingFraction = Math.max(0.0001, (10_000 - deploymentBufferBps) / 10_000);
    const deployableTokenA = toBaseUnits(
      (allocationQuote * weights.tokenA / currentPrice) * remainingFraction,
      this.config.TOKEN_A_DECIMALS
    );
    const deployableTokenB = toBaseUnits(
      (allocationQuote * weights.tokenB) * remainingFraction,
      this.config.TOKEN_B_DECIMALS
    );

    const strategyType = this.resolveStrategyType(this.config.METEORA_STRATEGY_TYPE);
    const positionKeypair = Keypair.generate();

    if (!execute) {
      return {
        dryRun: true,
        positionMint: positionKeypair.publicKey.toBase58(),
        lowerPrice,
        upperPrice,
        quote: { minBinId, maxBinId, strategyType },
        txId: null,
        deployableTokenA,
        deployableTokenB
      };
    }

    const tx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      totalXAmount: new BN(deployableTokenA.toString()),
      totalYAmount: new BN(deployableTokenB.toString()),
      strategy: { minBinId, maxBinId, strategyType },
      user,
      slippage: this.config.MAX_SLIPPAGE_BPS / 100
    });

    const txId = await this.sendLegacyTransaction(
      tx,
      "opening",
      { plannedPositionMint: positionKeypair.publicKey.toBase58() },
      [positionKeypair]
    );

    this.positionCache = null;

    return {
      dryRun: false,
      positionMint: positionKeypair.publicKey.toBase58(),
      lowerPrice,
      upperPrice,
      quote: { minBinId, maxBinId, strategyType },
      txId,
      deployableTokenA,
      deployableTokenB
    };
  }

  async fundQuoteTokenFromWallet(targetQuoteAmount: bigint, execute: boolean): Promise<FundResult> {
    if (targetQuoteAmount <= 0n) {
      return { fundedQuoteAmount: 0n, txIds: [], route: null };
    }

    try {
      const result = await this.jupiterSwap(
        this.config.TOKEN_A_MINT,
        this.config.TOKEN_B_MINT,
        targetQuoteAmount,
        execute
      );
      return {
        fundedQuoteAmount: targetQuoteAmount,
        txIds: result.txId ? [result.txId] : [],
        route: result.quote
      };
    } catch {
      return { fundedQuoteAmount: 0n, txIds: [], route: null };
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private computeRange(currentPrice: number): { lower: number; upper: number } {
    return {
      lower: currentPrice * (1 - this.config.RANGE_PCT_BELOW / 100),
      upper: currentPrice * (1 + this.config.RANGE_PCT_ABOVE / 100)
    };
  }

  private resolveStrategyType(type: string): number {
    switch (type) {
      case "Curve": return StrategyType.Curve;
      case "BidAsk": return StrategyType.BidAsk;
      default: return StrategyType.Spot;
    }
  }

  private async fetchCachedPositions(): Promise<ManagedPosition[]> {
    if (this.positionCache && Date.now() - this.positionCache.fetchedAt < MeteoraClient.POSITION_CACHE_TTL_MS) {
      return this.positionCache.positions;
    }

    const pool = this.pool!;
    const user = this.keypair!.publicKey;
    const { userPositions } = await pool.getPositionsByUserAndLbPair(user);

    const positions: ManagedPosition[] = (userPositions as any[]).map((lbPos: any) => {
      const addr = lbPos.publicKey.toBase58();
      const { lowerBinId, upperBinId } = lbPos.positionData;
      const liquidity = lbPos.positionData.positionBinData.reduce(
        (sum: bigint, bin: any) => sum + BigInt(bin.positionLiquidity),
        0n
      );
      return {
        positionAddress: addr,
        positionMint: addr,
        whirlpoolAddress: this.config.ORCA_WHIRLPOOL_ADDRESS,
        liquidity,
        tickLowerIndex: lowerBinId,
        tickUpperIndex: upperBinId,
        raw: lbPos
      };
    });

    this.positionCache = { positions, fetchedAt: Date.now() };
    return positions;
  }

  private async jupiterSwap(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    execute: boolean
  ): Promise<{ quote: JupiterQuoteResponse; txId: string | null }> {
    const quote = await this.fetchJupiterQuote(inputMint, outputMint, amount);

    if (!execute) {
      return { quote, txId: null };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json"
    };
    if (this.config.JUPITER_API_KEY) {
      headers["x-api-key"] = this.config.JUPITER_API_KEY;
    }

    const swapResponse = await fetch(`${this.config.JUPITER_API_BASE_URL}/swap`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.getOwnerAddress(),
        dynamicComputeUnitLimit: true,
        dynamicSlippage: false
      })
    });

    if (!swapResponse.ok) {
      throw new Error(`Jupiter swap failed: ${swapResponse.status} ${await swapResponse.text()}`);
    }

    const { swapTransaction } = await swapResponse.json() as { swapTransaction: string };
    const txBuffer = Buffer.from(swapTransaction, "base64");
    const vtx = VersionedTransaction.deserialize(txBuffer);
    vtx.sign([this.keypair!]);

    const txId = await this.withConfirmationTimeout(async () => {
      const sig = await this.connection!.sendTransaction(vtx, { skipPreflight: false });
      await this.connection!.confirmTransaction(sig, "confirmed");
      return sig;
    }, "swapping");

    return { quote, txId };
  }

  private async fetchJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint
  ): Promise<JupiterQuoteResponse> {
    const url = new URL(`${this.config.JUPITER_API_BASE_URL}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("swapMode", "ExactIn");
    url.searchParams.set("slippageBps", String(this.config.MAX_SLIPPAGE_BPS));

    const headers: Record<string, string> = { "Accept": "application/json" };
    if (this.config.JUPITER_API_KEY) {
      headers["x-api-key"] = this.config.JUPITER_API_KEY;
    }

    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      throw new Error(`Jupiter quote failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<JupiterQuoteResponse>;
  }

  private async sendLegacyTransaction(
    tx: import("@solana/web3.js").Transaction,
    phase: "closing" | "opening",
    details: Record<string, string | undefined>,
    extraSigners: Keypair[] = []
  ): Promise<string | null> {
    const connection = this.connection!;
    const keypair = this.keypair!;

    tx.feePayer = keypair.publicKey;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    return this.withConfirmationTimeout(
      () => sendAndConfirmTransaction(connection, tx, [keypair, ...extraSigners], { commitment: "confirmed" }),
      phase,
      details
    );
  }

  private async withConfirmationTimeout<T>(
    fn: () => Promise<T>,
    phase: "closing" | "opening" | "swapping",
    details: Record<string, string | undefined> = {}
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TransactionTimeoutError(
          phase === "swapping" ? "swapping" : phase,
          Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v ?? null]))
        ));
      }, MeteoraClient.TX_WAIT_MS);

      fn().then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }
}
