import { readFile } from "node:fs/promises";

import type { AppConfig } from "../config.js";
import {
  TransactionTimeoutError,
  type ManagedPosition,
  type PoolMetadata,
  type PoolSnapshot,
  type RebalancePhase
} from "../domain.js";
import { RpcAccountReader, type WalletAssetBalance } from "../infra/rpcAccountReader.js";
import { isRecoverableRpcError } from "../infra/rpcFailover.js";
import { computeBand, computeTargetValueWeights, fromBaseUnits, toBaseUnits } from "../strategy/bands.js";

interface WhirlpoolSdkModule {
  fetchWhirlpool?: (...args: unknown[]) => Promise<any>;
  fetchConcentratedLiquidityPool?: (...args: unknown[]) => Promise<any>;
  fetchWhirlpoolsByTokenPair?: (...args: unknown[]) => Promise<any[]>;
  fetchPositionsForOwner?: (...args: unknown[]) => Promise<any[]>;
  closePosition: (...args: unknown[]) => Promise<any>;
  swap: (...args: unknown[]) => Promise<any>;
  openConcentratedPosition?: (...args: unknown[]) => Promise<any>;
  openPositionInstructions?: (...args: unknown[]) => Promise<any>;
  setRpc?: (...args: unknown[]) => void;
  setPayerFromBytes?: (...args: unknown[]) => Promise<any>;
  setWhirlpoolsConfig?: (...args: unknown[]) => Promise<void>;
  setDefaultFunder?: (...args: unknown[]) => void;
  getPayer?: () => unknown;
}

interface TxSenderModule {
  buildAndSendTransaction: (...args: unknown[]) => Promise<string>;
}

interface SolanaKitModule {
  createSolanaRpc: (...args: unknown[]) => unknown;
  address?: (value: string) => unknown;
  AccountRole?: {
    READONLY: number;
    WRITABLE: number;
    READONLY_SIGNER: number;
    WRITABLE_SIGNER: number;
  };
}

interface WhirlpoolClientModule {
  fetchMaybeWhirlpool?: (...args: unknown[]) => Promise<any>;
}

interface JupiterRouteHop {
  ammKey?: string;
  inputMint: string;
  outputMint: string;
  feeAmount?: string;
  feeMint?: string;
}

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold?: string;
  swapMode?: "ExactIn" | "ExactOut";
  slippageBps?: number;
  routePlan?: Array<{
    swapInfo?: JupiterRouteHop;
    percent?: number;
  }>;
}

interface JupiterInstructionAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

interface JupiterInstructionPayload {
  programId: string;
  accounts: JupiterInstructionAccount[];
  data: string;
}

interface JupiterSwapInstructionsResponse {
  tokenLedgerInstruction?: JupiterInstructionPayload | null;
  computeBudgetInstructions?: JupiterInstructionPayload[];
  setupInstructions?: JupiterInstructionPayload[];
  swapInstruction?: JupiterInstructionPayload | null;
  cleanupInstruction?: JupiterInstructionPayload | null;
  otherInstructions?: JupiterInstructionPayload[];
  addressLookupTableAddresses?: string[];
}

interface FundingRouteHop {
  quote: JupiterQuoteResponse;
  inputAmount: bigint;
  outputAmount: bigint;
}

interface FundingRoute {
  hops: FundingRouteHop[];
  sourceMint: string;
  outputAmount: bigint;
}

interface CenteredOpenPlan {
  band: { lower: number; upper: number };
  weights: { tokenA: number; tokenB: number };
  availableTokenA: bigint;
  totalAvailableQuote: number;
  configuredAllocationQuote: number | null;
  minimumRequiredAllocationQuote: number;
  allocationQuote: number;
  remainingFraction: number;
  rawTargetTokenA: bigint;
  rawTargetTokenB: bigint;
  bufferedDeployableTokenA: bigint;
  bufferedDeployableTokenB: bigint;
}

export class InsufficientAllocationError extends Error {
  readonly configuredAllocationQuote: number;
  readonly availableAllocationQuote: number;
  readonly minimumRequiredAllocationQuote: number;

  constructor(configuredAllocationQuote: number, availableAllocationQuote: number, minimumRequiredAllocationQuote: number) {
    super(
      `Insufficient free wallet balance to fund the requested allocation. ` +
        `targetQuote=${configuredAllocationQuote.toFixed(6)} ` +
        `availableQuote=${availableAllocationQuote.toFixed(6)} ` +
        `minimumRequiredQuote=${minimumRequiredAllocationQuote.toFixed(6)}`
    );
    this.name = "InsufficientAllocationError";
    this.configuredAllocationQuote = configuredAllocationQuote;
    this.availableAllocationQuote = availableAllocationQuote;
    this.minimumRequiredAllocationQuote = minimumRequiredAllocationQuote;
  }
}

export class OrcaClient {
  private static readonly SOL_MINT = "So11111111111111111111111111111111111111112";
  private static readonly USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  private static readonly COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
  private static readonly TX_WAIT_MS = 45_000;
  private static readonly SEND_RATE_LIMIT_RETRIES = 3;
  private static readonly SEND_RATE_LIMIT_BACKOFF_MS = 1_500;
  private static readonly MIN_OPEN_ALLOCATION_FILL_BPS = 9_000;
  private readonly rpcUrls: string[];
  private currentRpcIndex = 0;
  private sdk?: WhirlpoolSdkModule;
  private kit?: SolanaKitModule;
  private txSender?: TxSenderModule;
  private whirlpoolClient?: WhirlpoolClientModule;
  private rpc?: unknown;
  private walletAddress?: string;
  private readonly accountReader: RpcAccountReader;
  private static readonly POSITION_CACHE_TTL_MS = 2_000;
  private positionCache: { positions: any[]; fetchedAt: number } | null = null;

  constructor(private readonly config: AppConfig) {
    this.rpcUrls = config.solanaRpcUrls;
    this.accountReader = new RpcAccountReader(this.rpcUrls);
  }

  clearPositionCache() {
    this.positionCache = null;
  }

  private async fetchCachedPositions(): Promise<any[]> {
    if (this.positionCache && Date.now() - this.positionCache.fetchedAt < OrcaClient.POSITION_CACHE_TTL_MS) {
      return this.positionCache.positions;
    }

    if (!this.sdk?.fetchPositionsForOwner) {
      return [];
    }

    const positions = await this.sdk.fetchPositionsForOwner(this.rpc, this.toAddress(this.getOwnerAddress()));
    this.positionCache = { positions, fetchedAt: Date.now() };
    return positions;
  }

  async init(): Promise<void> {
    if (this.sdk && this.kit && this.txSender && this.rpc && this.walletAddress) {
      return;
    }

    const [sdk, kit, txSender, whirlpoolClient] = await Promise.all([
      import("@orca-so/whirlpools"),
      import("@solana/kit"),
      import("@orca-so/tx-sender"),
      import("@orca-so/whirlpools-client")
    ]);

    this.sdk = sdk as unknown as WhirlpoolSdkModule;
    this.kit = kit as unknown as SolanaKitModule;
    this.txSender = txSender as unknown as TxSenderModule;
    this.whirlpoolClient = whirlpoolClient as unknown as WhirlpoolClientModule;
    this.rpc = this.kit.createSolanaRpc(this.currentRpcUrl());

    await this.sdk.setWhirlpoolsConfig?.("solanaMainnet");
    await Promise.resolve(this.sdk.setRpc?.(this.currentRpcUrl()));

    const walletBytes = Uint8Array.from(
      JSON.parse(await readFile(this.config.BOT_WALLET_KEYPAIR_PATH, "utf8")) as number[]
    );
    const payer = await this.sdk.setPayerFromBytes?.(walletBytes);
    await Promise.resolve(this.sdk.setDefaultFunder?.(payer));

    this.walletAddress = this.extractAddress(payer);
    if (!this.walletAddress) {
      throw new Error("Unable to derive the bot wallet address from the configured keypair");
    }
  }

  getOwnerAddress(): string {
    if (!this.walletAddress) {
      throw new Error("Orca client has not been initialized");
    }
    return this.walletAddress;
  }

  async fetchPoolSnapshot(): Promise<PoolSnapshot> {
    await this.init();
    const pool = await this.fetchWhirlpoolByAddress(this.config.ORCA_WHIRLPOOL_ADDRESS);
    const poolData = pool?.data ?? pool;

    const currentPrice = this.extractPrice(poolData);

    return {
      whirlpoolAddress: this.config.ORCA_WHIRLPOOL_ADDRESS,
      currentPrice,
      tokenAMint: this.config.TOKEN_A_MINT,
      tokenBMint: this.config.TOKEN_B_MINT,
      tokenADecimals: this.config.TOKEN_A_DECIMALS,
      tokenBDecimals: this.config.TOKEN_B_DECIMALS,
      raw: pool
    };
  }

  async discoverPoolMetadata(whirlpoolAddress: string): Promise<PoolMetadata> {
    await this.init();
    const pool = await this.fetchWhirlpoolByAddress(whirlpoolAddress);
    const poolData = pool?.data ?? pool;
    const tokenAMint = this.extractString(poolData?.tokenMintA ?? poolData?.tokenA?.mint);
    const tokenBMint = this.extractString(poolData?.tokenMintB ?? poolData?.tokenB?.mint);

    if (!tokenAMint || !tokenBMint) {
      throw new Error(`Unable to extract token mints for Whirlpool ${whirlpoolAddress}`);
    }

    const [tokenADecimals, tokenBDecimals] = await Promise.all([
      this.accountReader.getTokenDecimals(tokenAMint),
      this.accountReader.getTokenDecimals(tokenBMint)
    ]);

    return {
      whirlpoolAddress,
      tokenAMint,
      tokenBMint,
      tokenADecimals,
      tokenBDecimals,
      tokenASymbol: this.inferTokenSymbol(tokenAMint),
      tokenBSymbol: this.inferTokenSymbol(tokenBMint)
    };
  }

  async findManagedPosition(expectedPositionMint?: string | null): Promise<ManagedPosition | null> {
    await this.init();

    const positions = await this.fetchCachedPositions();
    if (!positions.length) {
      return null;
    }
    const matchingPosition = positions.find((position: any) => {
      const data = position?.data ?? position;
      const whirlpool = this.extractString(data?.whirlpool ?? data?.whirlpoolAddress);
      const positionMint = this.extractString(
        position?.positionMint ?? data?.positionMint ?? position?.address ?? data?.address
      );
      if (expectedPositionMint) {
        return positionMint === expectedPositionMint;
      }
      return whirlpool === this.config.ORCA_WHIRLPOOL_ADDRESS;
    });

    if (!matchingPosition) {
      return null;
    }

    const data = matchingPosition?.data ?? matchingPosition;

    return {
      positionAddress: this.extractString(matchingPosition.address ?? data.address),
      positionMint: this.extractString(
        matchingPosition.positionMint ?? data.positionMint ?? matchingPosition.address ?? data.address
      ),
      whirlpoolAddress: this.extractString(data?.whirlpool ?? data?.whirlpoolAddress),
      liquidity: BigInt(data?.liquidity?.toString?.() ?? data?.liquidity ?? 0),
      tickLowerIndex: this.extractOptionalNumber(data?.tickLowerIndex),
      tickUpperIndex: this.extractOptionalNumber(data?.tickUpperIndex),
      raw: matchingPosition
    };
  }

  async listManagedPositions(whirlpoolAddress = this.config.ORCA_WHIRLPOOL_ADDRESS): Promise<ManagedPosition[]> {
    await this.init();

    const positions = await this.fetchCachedPositions();

    return positions
      .map((position: any) => {
        const data = position?.data ?? position;
        return {
          positionAddress: this.extractString(position.address ?? data.address),
          positionMint: this.extractString(
            position?.positionMint ?? data?.positionMint ?? position?.address ?? data?.address
          ),
          whirlpoolAddress: this.extractString(data?.whirlpool ?? data?.whirlpoolAddress),
          liquidity: BigInt(data?.liquidity?.toString?.() ?? data?.liquidity ?? 0),
          tickLowerIndex: this.extractOptionalNumber(data?.tickLowerIndex),
          tickUpperIndex: this.extractOptionalNumber(data?.tickUpperIndex),
          raw: position
        } satisfies ManagedPosition;
      })
      .filter((position) => position.whirlpoolAddress === whirlpoolAddress);
  }

  async listAllOwnerPositions(): Promise<ManagedPosition[]> {
    await this.init();

    const positions = await this.fetchCachedPositions();

    return positions.map((position: any) => {
      const data = position?.data ?? position;
      return {
        positionAddress: this.extractString(position.address ?? data.address),
        positionMint: this.extractString(
          position?.positionMint ?? data?.positionMint ?? position?.address ?? data?.address
        ),
        whirlpoolAddress: this.extractString(data?.whirlpool ?? data?.whirlpoolAddress),
        liquidity: BigInt(data?.liquidity?.toString?.() ?? data?.liquidity ?? 0),
        tickLowerIndex: this.extractOptionalNumber(data?.tickLowerIndex),
        tickUpperIndex: this.extractOptionalNumber(data?.tickUpperIndex),
        raw: position
      } satisfies ManagedPosition;
    });
  }

  async closePosition(positionMint: string, execute: boolean, slippageBps = this.config.MAX_SLIPPAGE_BPS) {
    await this.init();
    return this.withRpcFailover(async () => {
      const result = await this.sdk!.closePosition(this.toAddress(positionMint), slippageBps);
      if (!execute) {
        return {
          dryRun: true,
          quote: result,
          txId: null
        };
      }

      const txId = await this.sendFromResult(result, "closing", { positionMint });
      this.positionCache = null;
      return { dryRun: false, quote: result, txId };
    });
  }

  assessSwapToTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    options?: {
      minSwapUsdc?: number;
      valueToleranceBps?: number;
    }
  ) {
    const availableTokenA = this.reserveTokenAForFees(tokenA);
    const band = computeBand(currentPrice, this.config.RANGE_PCT);
    const targetWeights = computeTargetValueWeights(band.lower, currentPrice, band.upper);
    const tokenAUnits = fromBaseUnits(availableTokenA, this.config.TOKEN_A_DECIMALS);
    const tokenBUnits = fromBaseUnits(tokenB, this.config.TOKEN_B_DECIMALS);
    const totalValueInTokenB = tokenAUnits * currentPrice + tokenBUnits;
    const targetValueTokenA = totalValueInTokenB * targetWeights.tokenA;
    const currentValueTokenA = tokenAUnits * currentPrice;
    const valueDelta = targetValueTokenA - currentValueTokenA;
    const minSwapRaw = options?.minSwapUsdc ?? this.config.MIN_SWAP_USDC;
    const valueToleranceBps = options?.valueToleranceBps ?? 0;
    const valueDeltaBps = totalValueInTokenB > 0 ? Math.abs(valueDelta) / totalValueInTokenB * 10_000 : 0;

    if (valueDeltaBps <= valueToleranceBps || Math.abs(valueDelta) < minSwapRaw) {
      return {
        direction: "none" as const,
        inputAmount: 0n,
        targetWeights,
        valueDelta,
        valueDeltaBps
      };
    }

    const direction = valueDelta > 0 ? "buy-token-a" as const : "sell-token-a" as const;
    const inputAmount =
      direction === "buy-token-a"
        ? toBaseUnits(Math.abs(valueDelta), this.config.TOKEN_B_DECIMALS)
        : toBaseUnits(Math.abs(valueDelta) / currentPrice, this.config.TOKEN_A_DECIMALS);

    return {
      direction,
      inputAmount,
      targetWeights,
      valueDelta,
      valueDeltaBps
    };
  }

  assessSwapToOpenTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    deploymentBufferBps = this.config.OPEN_DEPLOYMENT_BUFFER_BPS,
    allocationQuoteOverride?: number,
    options?: {
      minSwapUsdc?: number;
      valueToleranceBps?: number;
    }
  ) {
    const plan = this.createCenteredOpenPlan(
      currentPrice,
      tokenA,
      tokenB,
      deploymentBufferBps,
      allocationQuoteOverride
    );
    const currentTokenA = this.reserveTokenAForFees(tokenA);
    const currentTokenB = tokenB;
    const desiredTokenAValue = fromBaseUnits(plan.rawTargetTokenA, this.config.TOKEN_A_DECIMALS) * currentPrice;
    const currentTokenAValue = fromBaseUnits(currentTokenA, this.config.TOKEN_A_DECIMALS) * currentPrice;
    const desiredTokenBValue = fromBaseUnits(plan.rawTargetTokenB, this.config.TOKEN_B_DECIMALS);
    const currentTokenBValue = fromBaseUnits(currentTokenB, this.config.TOKEN_B_DECIMALS);
    const tokenADeltaValue = desiredTokenAValue - currentTokenAValue;
    const tokenBDeltaValue = desiredTokenBValue - currentTokenBValue;
    const desiredTotalValue = desiredTokenAValue + desiredTokenBValue;
    const minSwapRaw = options?.minSwapUsdc ?? this.config.MIN_SWAP_USDC;
    const valueToleranceBps = options?.valueToleranceBps ?? 0;
    const effectiveValueDelta = Math.min(Math.abs(tokenADeltaValue), Math.abs(tokenBDeltaValue));
    const valueDeltaBps = desiredTotalValue > 0 ? effectiveValueDelta / desiredTotalValue * 10_000 : 0;

    if (
      tokenADeltaValue > 0 &&
      tokenBDeltaValue < 0 &&
      valueDeltaBps > valueToleranceBps &&
      effectiveValueDelta >= minSwapRaw
    ) {
      return {
        direction: "buy-token-a" as const,
        inputAmount: toBaseUnits(effectiveValueDelta, this.config.TOKEN_B_DECIMALS),
        targetWeights: plan.weights,
        valueDelta: tokenADeltaValue,
        valueDeltaBps,
        plan
      };
    }

    if (
      tokenADeltaValue < 0 &&
      tokenBDeltaValue > 0 &&
      valueDeltaBps > valueToleranceBps &&
      effectiveValueDelta >= minSwapRaw
    ) {
      return {
        direction: "sell-token-a" as const,
        inputAmount: toBaseUnits(effectiveValueDelta / currentPrice, this.config.TOKEN_A_DECIMALS),
        targetWeights: plan.weights,
        valueDelta: tokenADeltaValue,
        valueDeltaBps,
        plan
      };
    }

    return {
      direction: "none" as const,
      inputAmount: 0n,
      targetWeights: plan.weights,
      valueDelta: tokenADeltaValue,
      valueDeltaBps,
      plan
    };
  }

  async swapToTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    options?: {
      minSwapUsdc?: number;
      valueToleranceBps?: number;
    }
  ) {
    await this.init();
    const assessment = this.assessSwapToTarget(currentPrice, tokenA, tokenB, options);

    if (assessment.direction === "none") {
      return {
        dryRun: !execute,
        direction: "none" as const,
        inputAmount: 0n,
        quote: null,
        txId: null,
        targetWeights: assessment.targetWeights,
        assessment
      };
    }

    const inputMint = assessment.direction === "buy-token-a" ? this.config.TOKEN_B_MINT : this.config.TOKEN_A_MINT;
    const outputMint = assessment.direction === "buy-token-a" ? this.config.TOKEN_A_MINT : this.config.TOKEN_B_MINT;

    return this.withRpcFailover(async () => {
      const result = await this.jupiterSwap({
        inputMint,
        outputMint,
        amount: assessment.inputAmount,
        swapMode: "ExactIn",
        execute
      });
      if (!execute) {
        return {
          dryRun: true,
          direction: assessment.direction,
          inputAmount: assessment.inputAmount,
          quote: result.quote,
          txId: result.txId,
          targetWeights: assessment.targetWeights,
          assessment
        };
      }

      return {
        dryRun: false,
        direction: assessment.direction,
        inputAmount: assessment.inputAmount,
        quote: result.quote,
        txId: result.txId,
        targetWeights: assessment.targetWeights,
        assessment
      };
    });
  }

  async swapToOpenTarget(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    deploymentBufferBps = this.config.OPEN_DEPLOYMENT_BUFFER_BPS,
    allocationQuoteOverride?: number,
    options?: {
      minSwapUsdc?: number;
      valueToleranceBps?: number;
    }
  ) {
    await this.init();
    const assessment = this.assessSwapToOpenTarget(
      currentPrice,
      tokenA,
      tokenB,
      deploymentBufferBps,
      allocationQuoteOverride,
      options
    );

    if (assessment.direction === "none") {
      return {
        dryRun: !execute,
        direction: "none" as const,
        inputAmount: 0n,
        quote: null,
        txId: null,
        targetWeights: assessment.targetWeights,
        assessment
      };
    }

    const inputMint = assessment.direction === "buy-token-a" ? this.config.TOKEN_B_MINT : this.config.TOKEN_A_MINT;
    const outputMint = assessment.direction === "buy-token-a" ? this.config.TOKEN_A_MINT : this.config.TOKEN_B_MINT;

    return this.withRpcFailover(async () => {
      const result = await this.jupiterSwap({
        inputMint,
        outputMint,
        amount: assessment.inputAmount,
        swapMode: "ExactIn",
        execute
      });

      return {
        dryRun: !execute,
        direction: assessment.direction,
        inputAmount: assessment.inputAmount,
        quote: result.quote,
        txId: result.txId,
        targetWeights: assessment.targetWeights,
        assessment
      };
    });
  }

  async openCenteredPosition(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    execute: boolean,
    previousPositionMint: string | null = null,
    slippageBps = this.config.MAX_SLIPPAGE_BPS,
    deploymentBufferBps = this.config.OPEN_DEPLOYMENT_BUFFER_BPS,
    allocationQuoteOverride?: number
  ) {
    await this.init();
    if (!this.sdk?.openPositionInstructions || !this.sdk.getPayer || !this.txSender?.buildAndSendTransaction) {
      throw new Error("Installed Orca SDK does not expose the instruction-level position open flow");
    }

    const openPositionInstructions = this.sdk.openPositionInstructions;
    const getPayer = this.sdk.getPayer;
    const buildAndSendTransaction = this.txSender.buildAndSendTransaction;
    const plan = this.createCenteredOpenPlan(
      currentPrice,
      tokenA,
      tokenB,
      deploymentBufferBps,
      allocationQuoteOverride
    );
    const band = plan.band;
    const bufferedDeployableTokenA = plan.bufferedDeployableTokenA;
    const bufferedDeployableTokenB = plan.bufferedDeployableTokenB;

    if (bufferedDeployableTokenA <= 0n || bufferedDeployableTokenB <= 0n) {
      throw new Error(
        `Insufficient deployable balance to open a position for ${this.config.TOKEN_A_SYMBOL}/${this.config.TOKEN_B_SYMBOL}. ` +
        `tokenMaxA=${bufferedDeployableTokenA.toString()} tokenMaxB=${bufferedDeployableTokenB.toString()} ` +
        `(allocation may be too small for this pool, price range, or token decimals)`
      );
    }

    return this.withRpcFailover(async () => {
      const result = await openPositionInstructions(
        this.rpc,
        this.toAddress(this.config.ORCA_WHIRLPOOL_ADDRESS),
        {
          tokenMaxA: bufferedDeployableTokenA,
          tokenMaxB: bufferedDeployableTokenB
        },
        band.lower,
        band.upper,
        slippageBps
      );

      const plannedPositionMint = this.extractString(result?.positionMint ?? result?.quote?.positionMint ?? result?.mint);

      if (!execute) {
        return {
          dryRun: true,
          positionMint: plannedPositionMint,
          lowerPrice: band.lower,
          upperPrice: band.upper,
          quote: result,
          txId: null,
          deployableTokenA: bufferedDeployableTokenA,
          deployableTokenB: bufferedDeployableTokenB
        };
      }

      const txId = await this.sendWithConfirmationTimeout(
        async () => this.normalizeTxId(
          await buildAndSendTransaction(
            result.instructions,
            getPayer(),
            undefined,
            "confirmed"
          )
        ),
        "opening",
        {
          plannedPositionMint,
          previousPositionMint
        }
      );
      this.positionCache = null;
      return {
        dryRun: false,
        positionMint: plannedPositionMint,
        lowerPrice: band.lower,
        upperPrice: band.upper,
        quote: result,
        txId,
        deployableTokenA: bufferedDeployableTokenA,
        deployableTokenB: bufferedDeployableTokenB
      };
    });
  }

  async getWalletBalances() {
    await this.init();
    return this.accountReader.getWalletBalances(
      this.getOwnerAddress(),
      this.config.TOKEN_A_MINT,
      this.config.TOKEN_B_MINT
    );
  }

  async getSolUsdcPrice() {
    await this.init();
    const oneSol = toBaseUnits(1, 9);
    const quote = await this.fetchJupiterQuote(
      OrcaClient.SOL_MINT,
      OrcaClient.USDC_MINT,
      oneSol,
      "ExactIn"
    );

    return fromBaseUnits(BigInt(quote.outAmount), 6);
  }

  async fundQuoteTokenFromWallet(targetQuoteAmount: bigint, execute: boolean) {
    await this.init();
    if (targetQuoteAmount <= 0n) {
      return {
        fundedQuoteAmount: 0n,
        txIds: [] as string[],
        route: null as FundingRoute | null
      };
    }

    const owner = this.getOwnerAddress();
    const assets = await this.accountReader.listWalletAssets(owner);
    const candidateAssets = this.prioritizeFundingAssets(assets.filter((asset) => asset.mint !== this.config.TOKEN_B_MINT));
    const txIds: string[] = [];
    const routes: FundingRoute[] = [];
    let fundedQuoteAmount = 0n;
    let remainingQuoteAmount = targetQuoteAmount;

    for (const asset of candidateAssets) {
      if (remainingQuoteAmount <= 0n) {
        break;
      }

      const route = await this.findFundingRoute(asset.mint, asset.amount, remainingQuoteAmount);
      if (!route) {
        continue;
      }

      try {
        const routeTxIds: string[] = [];
        for (const hop of route.hops) {
          const swapResult = await this.jupiterSwap({
            inputMint: hop.quote.inputMint,
            outputMint: hop.quote.outputMint,
            amount: hop.inputAmount,
            swapMode: "ExactIn",
            execute,
            quoteResponse: hop.quote
          });
          if (swapResult.txId) {
            routeTxIds.push(swapResult.txId);
          }
        }

        txIds.push(...routeTxIds);
        routes.push(route);
        fundedQuoteAmount += route.outputAmount;
        remainingQuoteAmount = remainingQuoteAmount > route.outputAmount ? remainingQuoteAmount - route.outputAmount : 0n;
      } catch (error) {
        // Skip bad funding routes so a single failing asset path does not pause the whole bot.
        continue;
      }
    }

    return {
      fundedQuoteAmount,
      txIds,
      route: routes.length === 1
        ? routes[0]
        : routes.length > 1
          ? {
              sourceMint: "multiple",
              outputAmount: fundedQuoteAmount,
              hops: routes.flatMap((route) => route.hops)
            }
          : null as FundingRoute | null
    };
  }

  private async jupiterSwap(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    swapMode: "ExactIn" | "ExactOut";
    execute: boolean;
    quoteResponse?: JupiterQuoteResponse;
  }) {
    await this.init();
    const quote = params.quoteResponse ?? await this.fetchJupiterQuote(
      params.inputMint,
      params.outputMint,
      params.amount,
      params.swapMode
    );

    if (!params.execute) {
      return {
        dryRun: true,
        quote,
        txId: null as string | null
      };
    }

    const instructionPayload = await this.fetchJupiterSwapInstructions(quote);
    const instructions = this.toSolanaInstructions(instructionPayload);
    const txId = await this.sendJupiterInstructions(
      instructions,
      instructionPayload.addressLookupTableAddresses ?? [],
      params
    );

    return {
      dryRun: false,
      quote,
      txId
    };
  }

  private async fetchJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    swapMode: "ExactIn" | "ExactOut"
  ): Promise<JupiterQuoteResponse> {
    if (amount <= 0n) {
      throw new Error("Jupiter quote amount must be positive");
    }

    const url = new URL(`${this.config.JUPITER_API_BASE_URL}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("swapMode", swapMode);
    url.searchParams.set("slippageBps", String(this.config.MAX_SLIPPAGE_BPS));
    url.searchParams.set("onlyDirectRoutes", "false");

    const response = await fetch(url, {
      headers: this.jupiterHeaders()
    });
    if (!response.ok) {
      throw new Error(`HTTP error (${response.status}): ${await response.text()}`);
    }

    return await response.json() as JupiterQuoteResponse;
  }

  private async fetchJupiterSwapInstructions(quoteResponse: JupiterQuoteResponse): Promise<JupiterSwapInstructionsResponse> {
    const response = await fetch(`${this.config.JUPITER_API_BASE_URL}/swap-instructions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.jupiterHeaders()
      },
      body: JSON.stringify({
        userPublicKey: this.getOwnerAddress(),
        quoteResponse,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        useSharedAccounts: true
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error (${response.status}): ${await response.text()}`);
    }

    return await response.json() as JupiterSwapInstructionsResponse;
  }

  private toSolanaInstructions(payload: JupiterSwapInstructionsResponse) {
    const instructions = this.normalizeJupiterInstructions([
      ...(payload.otherInstructions ?? []),
      ...(payload.setupInstructions ?? []),
      ...(payload.tokenLedgerInstruction ? [payload.tokenLedgerInstruction] : []),
      ...(payload.swapInstruction ? [payload.swapInstruction] : []),
      ...(payload.cleanupInstruction ? [payload.cleanupInstruction] : [])
    ]);

    return instructions.map((instruction) => ({
      programAddress: this.toAddress(instruction.programId),
      accounts: instruction.accounts.map((account) => ({
        address: this.toAddress(account.pubkey),
        role: this.accountRole(account.isSigner, account.isWritable)
      })),
      data: Uint8Array.from(Buffer.from(instruction.data, "base64"))
    }));
  }

  private normalizeJupiterInstructions(instructions: JupiterInstructionPayload[]) {
    const normalized: JupiterInstructionPayload[] = [];
    const computeBudgetByOpcode = new Map<number, number>();
    const seenInstructionKeys = new Set<string>();

    for (const instruction of instructions) {
      const instructionKey = JSON.stringify({
        programId: instruction.programId,
        accounts: instruction.accounts.map((account) => [account.pubkey, account.isSigner, account.isWritable]),
        data: instruction.data
      });
      if (seenInstructionKeys.has(instructionKey)) {
        continue;
      }

      if (instruction.programId !== OrcaClient.COMPUTE_BUDGET_PROGRAM_ID) {
        seenInstructionKeys.add(instructionKey);
        normalized.push(instruction);
        continue;
      }

      const rawData = Buffer.from(instruction.data, "base64");
      const opcode = rawData[0];
      if (opcode == null) {
        normalized.push(instruction);
        continue;
      }

      const existingIndex = computeBudgetByOpcode.get(opcode);
      if (existingIndex != null) {
        normalized[existingIndex] = instruction;
        continue;
      }

      computeBudgetByOpcode.set(opcode, normalized.length);
      seenInstructionKeys.add(instructionKey);
      normalized.push(instruction);
    }

    return normalized;
  }

  private createCenteredOpenPlan(
    currentPrice: number,
    tokenA: bigint,
    tokenB: bigint,
    deploymentBufferBps: number,
    allocationQuoteOverride?: number
  ): CenteredOpenPlan {
    const band = computeBand(currentPrice, this.config.RANGE_PCT);
    const weights = computeTargetValueWeights(band.lower, currentPrice, band.upper);
    const availableTokenA = this.reserveTokenAForFees(tokenA);
    const tokenAUnits = fromBaseUnits(availableTokenA, this.config.TOKEN_A_DECIMALS);
    const tokenBUnits = fromBaseUnits(tokenB, this.config.TOKEN_B_DECIMALS);
    const totalAvailableQuote = tokenAUnits * currentPrice + tokenBUnits;
    const fallbackAllocationQuote =
      this.isUsdcQuoteToken() &&
      Number.isFinite(this.config.BOT_ALLOCATION_USDC) &&
      this.config.BOT_ALLOCATION_USDC > 0
        ? this.config.BOT_ALLOCATION_USDC
        : null;
    const configuredAllocationQuote =
      typeof allocationQuoteOverride === "number" && Number.isFinite(allocationQuoteOverride) && allocationQuoteOverride > 0
        ? allocationQuoteOverride
        : fallbackAllocationQuote;
    const minimumRequiredAllocationQuote =
      typeof configuredAllocationQuote === "number" && configuredAllocationQuote > 0
        ? configuredAllocationQuote * OrcaClient.MIN_OPEN_ALLOCATION_FILL_BPS / 10_000
        : 0;

    if (
      typeof configuredAllocationQuote === "number" &&
      Number.isFinite(configuredAllocationQuote) &&
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
      typeof configuredAllocationQuote === "number" && Number.isFinite(configuredAllocationQuote) && configuredAllocationQuote > 0
        ? Math.min(configuredAllocationQuote, totalAvailableQuote)
        : totalAvailableQuote;
    const remainingFraction = Math.max(0.0001, (10_000 - deploymentBufferBps) / 10_000);
    const targetBufferedTokenAUnits = allocationQuote * weights.tokenA / currentPrice;
    const targetBufferedTokenBUnits = allocationQuote * weights.tokenB;
    const rawTargetTokenAUnits = targetBufferedTokenAUnits / remainingFraction;
    const rawTargetTokenBUnits = targetBufferedTokenBUnits / remainingFraction;
    const tokenAScale = rawTargetTokenAUnits > 0 ? tokenAUnits / rawTargetTokenAUnits : 1;
    const tokenBScale = rawTargetTokenBUnits > 0 ? tokenBUnits / rawTargetTokenBUnits : 1;
    const targetScale = Math.min(1, tokenAScale, tokenBScale);
    const deployableAUnits = rawTargetTokenAUnits * targetScale;
    const deployableBUnits = rawTargetTokenBUnits * targetScale;
    const rawDeployableTokenA = toBaseUnits(deployableAUnits, this.config.TOKEN_A_DECIMALS);
    const rawDeployableTokenB = toBaseUnits(deployableBUnits, this.config.TOKEN_B_DECIMALS);
    const bufferedDeployableTokenA = this.applyOpenDeploymentBuffer(rawDeployableTokenA, deploymentBufferBps);
    const bufferedDeployableTokenB = this.applyOpenDeploymentBuffer(rawDeployableTokenB, deploymentBufferBps);

    if (bufferedDeployableTokenA <= 0n || bufferedDeployableTokenB <= 0n) {
      throw new Error(
        `Insufficient deployable balance to open a position for ${this.config.TOKEN_A_SYMBOL}/${this.config.TOKEN_B_SYMBOL}. ` +
        `tokenMaxA=${bufferedDeployableTokenA.toString()} tokenMaxB=${bufferedDeployableTokenB.toString()} ` +
        `(allocation may be too small for this pool, price range, or token decimals)`
      );
    }

    return {
      band,
      weights,
      availableTokenA,
      totalAvailableQuote,
      configuredAllocationQuote,
      minimumRequiredAllocationQuote,
      allocationQuote,
      remainingFraction,
      rawTargetTokenA: toBaseUnits(rawTargetTokenAUnits, this.config.TOKEN_A_DECIMALS),
      rawTargetTokenB: toBaseUnits(rawTargetTokenBUnits, this.config.TOKEN_B_DECIMALS),
      bufferedDeployableTokenA,
      bufferedDeployableTokenB
    };
  }

  private async sendJupiterInstructions(
    instructions: Array<{ programAddress: unknown; accounts: Array<{ address: unknown; role: number }>; data: Uint8Array }>,
    lookupTableAddresses: string[],
    details: { inputMint: string; outputMint: string; amount: bigint; swapMode: "ExactIn" | "ExactOut" }
  ) {
    if (!this.sdk?.getPayer || !this.txSender?.buildAndSendTransaction) {
      throw new Error("Installed Solana tooling does not expose transaction sending for Jupiter swaps");
    }

    const txId = await this.sendWithConfirmationTimeout(
      async () => this.normalizeTxId(
        await this.txSender!.buildAndSendTransaction(
          instructions as never,
          this.sdk!.getPayer!(),
          lookupTableAddresses.map((address) => this.toAddress(address)),
          "confirmed"
        )
      ),
      "swapping",
      {
        inputMint: details.inputMint,
        outputMint: details.outputMint,
        amount: details.amount.toString(),
        swapMode: details.swapMode
      }
    );

    return txId;
  }

  private jupiterHeaders() {
    const headers: Record<string, string> = {};
    if (this.config.JUPITER_API_KEY) {
      headers["x-api-key"] = this.config.JUPITER_API_KEY;
    }
    return headers;
  }

  private accountRole(isSigner: boolean, isWritable: boolean) {
    const roles = this.kit?.AccountRole;
    if (!roles) {
      return isSigner ? (isWritable ? 3 : 2) : (isWritable ? 1 : 0);
    }

    if (isSigner) {
      return isWritable ? roles.WRITABLE_SIGNER : roles.READONLY_SIGNER;
    }

    return isWritable ? roles.WRITABLE : roles.READONLY;
  }

  private prioritizeFundingAssets(assets: WalletAssetBalance[]) {
    const preferredOrder = [
      OrcaClient.USDC_MINT,
      OrcaClient.SOL_MINT,
      this.config.TOKEN_A_MINT
    ];

    return [...assets]
      .filter((asset) => asset.amount > 0n)
      .sort((left, right) => {
        const leftPriority = preferredOrder.indexOf(left.mint);
        const rightPriority = preferredOrder.indexOf(right.mint);
        if (leftPriority !== rightPriority) {
          return (leftPriority === -1 ? preferredOrder.length : leftPriority) -
            (rightPriority === -1 ? preferredOrder.length : rightPriority);
        }

        return right.amount > left.amount ? 1 : right.amount < left.amount ? -1 : 0;
      });
  }

  private async findFundingRoute(
    sourceMint: string,
    availableAmount: bigint,
    targetQuoteAmount: bigint
  ): Promise<FundingRoute | null> {
    const targetMint = this.config.TOKEN_B_MINT;

    try {
      const exactOutQuote = await this.fetchJupiterQuote(sourceMint, targetMint, targetQuoteAmount, "ExactOut");
      const requiredInput = BigInt(exactOutQuote.inAmount);
      if (requiredInput <= availableAmount) {
        return {
          sourceMint,
          outputAmount: BigInt(exactOutQuote.outAmount),
          hops: [
            {
              quote: exactOutQuote,
              inputAmount: requiredInput,
              outputAmount: BigInt(exactOutQuote.outAmount)
            }
          ]
        };
      }
    } catch {
      // Fall through to an exact-in quote using the full available asset balance.
    }

    if (availableAmount <= 0n) {
      return null;
    }

    const exactInQuote = await this.fetchJupiterQuote(sourceMint, targetMint, availableAmount, "ExactIn");
    const outAmount = BigInt(exactInQuote.outAmount);
    if (outAmount <= 0n) {
      return null;
    }

    return {
      sourceMint,
      outputAmount: outAmount,
      hops: [
        {
          quote: exactInQuote,
          inputAmount: availableAmount,
          outputAmount: outAmount
        }
      ]
    };
  }

  private async sendFromResult(
    result: any,
    phase: RebalancePhase,
    details: Record<string, string | null> = {}
  ): Promise<string | null> {
    const sendTx =
      result?.callback ??
      result?.sendTx ??
      result?.buildAndExecute ??
      result?.execute ??
      result?.transaction?.sendTx;

    if (typeof sendTx !== "function") {
      return null;
    }

    return this.sendWithConfirmationTimeout(
      async () => this.normalizeTxId(await sendTx()),
      phase,
      details
    );
  }

  private extractPrice(poolData: any): number {
    const candidate =
      poolData?.price ??
      poolData?.currentPrice ??
      poolData?.tokenBPrice ??
      poolData?.sqrtPriceToPrice?.();

    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }

    const tickCurrentIndex = this.extractOptionalNumber(poolData?.tickCurrentIndex);
    if (typeof tickCurrentIndex === "number") {
      return Math.pow(1.0001, tickCurrentIndex) * Math.pow(10, this.config.TOKEN_A_DECIMALS - this.config.TOKEN_B_DECIMALS);
    }

    throw new Error("Unable to extract the current Whirlpool price from fetchWhirlpool");
  }

  private async fetchWhirlpoolByAddress(whirlpoolAddress: string): Promise<any> {
    if (this.whirlpoolClient?.fetchMaybeWhirlpool) {
      const maybePool = await this.whirlpoolClient.fetchMaybeWhirlpool(this.rpc, this.toAddress(whirlpoolAddress));
      if (maybePool?.exists) {
        return {
          address: whirlpoolAddress,
          data: maybePool.data
        };
      }
    }

    if (this.sdk?.fetchWhirlpool) {
      const fetched = await this.sdk.fetchWhirlpool(this.rpc, this.toAddress(whirlpoolAddress));
      if (fetched) {
        return fetched;
      }
    }

    const tokenA = this.toAddress(this.config.TOKEN_A_MINT);
    const tokenB = this.toAddress(this.config.TOKEN_B_MINT);

    if (this.sdk?.fetchWhirlpoolsByTokenPair) {
      const pools = await this.sdk.fetchWhirlpoolsByTokenPair(this.rpc, tokenA, tokenB);
      const match = pools.find((candidate: any) => {
        const address = this.extractString(candidate?.address ?? candidate?.data?.address);
        return address === whirlpoolAddress;
      });

      if (match) {
        return match;
      }
    }

    if (this.sdk?.fetchConcentratedLiquidityPool) {
      const pool = await this.sdk.fetchConcentratedLiquidityPool(this.rpc, tokenA, tokenB, 64);
      const address = this.extractString(pool?.address ?? pool?.data?.address);
      if (address === whirlpoolAddress) {
        return pool;
      }
    }

    throw new Error(`Unable to find the configured Whirlpool ${whirlpoolAddress}`);
  }

  private extractAddress(payer: any): string | undefined {
    return this.extractString(
      payer?.address ??
        payer?.publicKey ??
        payer?.keypair?.publicKey ??
        payer?.signer?.address
    );
  }

  private extractString(value: unknown): string {
    if (!value) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof (value as { toString?: () => string }).toString === "function") {
      return (value as { toString: () => string }).toString();
    }

    return "";
  }

  private extractOptionalNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "bigint") {
      return Number(value);
    }

    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private inferTokenSymbol(mint: string) {
    if (mint === "So11111111111111111111111111111111111111112") {
      return "SOL";
    }

    if (mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
      return "USDC";
    }

    return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
  }

  private isUsdcQuoteToken() {
    return this.config.TOKEN_B_MINT === OrcaClient.USDC_MINT || this.config.TOKEN_B_SYMBOL.toUpperCase() === "USDC";
  }

  private toAddress(value: string): unknown {
    return this.kit?.address ? this.kit.address(value) : value;
  }

  private reserveTokenAForFees(tokenA: bigint) {
    if (this.config.TOKEN_A_MINT !== "So11111111111111111111111111111111111111112") {
      return tokenA;
    }

    const reserve = BigInt(this.config.SOL_RESERVE_LAMPORTS);
    return tokenA > reserve ? tokenA - reserve : 0n;
  }

  private applyOpenDeploymentBuffer(amount: bigint, deploymentBufferBps: number) {
    const remainingBps = BigInt(10_000 - deploymentBufferBps);
    return amount * remainingBps / 10_000n;
  }

  private normalizeTxId(txId: unknown): string | null {
    return typeof txId === "string" ? txId : (txId as { signature?: string; txId?: string } | null)?.signature ?? (txId as { signature?: string; txId?: string } | null)?.txId ?? null;
  }

  private async sendWithConfirmationTimeout(
    send: () => Promise<string | null>,
    phase: RebalancePhase,
    details: Record<string, string | null> = {}
  ) {
    for (let attempt = 0; attempt < OrcaClient.SEND_RATE_LIMIT_RETRIES; attempt += 1) {
      try {
        const sendPromise = send();
        const result = await Promise.race([
          sendPromise,
          this.sleep(OrcaClient.TX_WAIT_MS).then(() => "__tx_timeout__")
        ]);

        if (result !== "__tx_timeout__") {
          return result as string | null;
        }

        throw new TransactionTimeoutError(phase, details);
      } catch (error) {
        if (!this.isRateLimitError(error) || attempt === OrcaClient.SEND_RATE_LIMIT_RETRIES - 1) {
          throw error;
        }

        await this.advanceRpcEndpoint();
        await this.sleep(OrcaClient.SEND_RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      }
    }

    throw new TransactionTimeoutError(phase, details);
  }

  private isRateLimitError(error: unknown) {
    const message = (error as Error).message ?? "";
    return message.includes("HTTP error (429)") || message.includes("Too Many Requests");
  }

  private async withRpcFailover<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.rpcUrls.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRecoverableRpcError(error) || attempt === this.rpcUrls.length - 1) {
          throw error;
        }

        lastError = error as Error;
        await this.advanceRpcEndpoint();
      }
    }

    throw lastError ?? new Error("RPC failover exhausted");
  }

  private currentRpcUrl() {
    return this.rpcUrls[this.currentRpcIndex];
  }

  private async advanceRpcEndpoint() {
    if (this.rpcUrls.length <= 1) {
      return;
    }

    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;

    if (!this.kit || !this.sdk) {
      return;
    }

    this.rpc = this.kit.createSolanaRpc(this.currentRpcUrl());
    await Promise.resolve(this.sdk.setRpc?.(this.currentRpcUrl()));
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
