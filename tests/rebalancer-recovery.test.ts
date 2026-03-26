import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransactionTimeoutError, type BotState, type PendingRebalance } from "../src/domain.js";
import { InsufficientAllocationError } from "../src/clients/orcaClient.js";
import { RebalancerService } from "../src/services/rebalancer.js";

function createState(overrides: Partial<BotState> = {}): BotState {
  return {
    activePositionMint: "old-position",
    lastRebalanceAt: "2026-03-13T00:00:00.000Z",
    lastCenterPrice: 100,
    latestAction: null,
    lastPnlMarkAt: null,
    paused: false,
    pauseReason: null,
    inFlightRebalance: false,
    lastObservedPrice: 99.4,
    lastOraclePrice: 100,
    lastOracleAt: "2026-03-13T00:00:00.000Z",
    driftTriggerLower: 99.5,
    driftTriggerUpper: 100.5,
    driftDirection: "below",
    driftStatus: "triggered",
    pendingRebalance: null,
    positionLowerPrice: null,
    positionUpperPrice: null,
    ...overrides
  };
}

function createPending(overrides: Partial<PendingRebalance> = {}): PendingRebalance {
  return {
    phase: "closing",
    startedAt: "2026-03-13T00:05:00.000Z",
    nextRetryAt: null,
    anchorPrice: 100,
    targetCenterPrice: 99.4,
    previousPositionMint: "old-position",
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
    cumulativeTxFeeLamports: 0,
    ...overrides
  };
}

function cloneState(state: BotState) {
  return JSON.parse(JSON.stringify(state)) as BotState;
}

function createHarness(initialState: BotState, overrides: Record<string, unknown> = {}) {
  let currentState = cloneState(initialState);
  let livePosition: { positionMint: string } | null = { positionMint: currentState.activePositionMint ?? "old-position" };
  let poolPositions: Array<{ positionMint: string }> = livePosition ? [livePosition] : [];

  const store = {
    load: vi.fn(async () => cloneState(currentState)),
    save: vi.fn(async (next: BotState) => {
      currentState = cloneState(next);
    })
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const orcaClient = {
    clearPositionCache: vi.fn(),
    getOwnerAddress: vi.fn(() => "owner"),
    fetchPoolSnapshot: vi.fn(async () => ({
      whirlpoolAddress: "whirlpool",
      currentPrice: 99.4,
      tokenAMint: "sol",
      tokenBMint: "usdc",
      tokenADecimals: 9,
      tokenBDecimals: 6,
      raw: {}
    })),
    findManagedPosition: vi.fn(async () =>
      livePosition
        ? {
            positionAddress: livePosition.positionMint,
            positionMint: livePosition.positionMint,
            whirlpoolAddress: "whirlpool",
            liquidity: 1n,
            raw: {}
          }
        : null
    ),
    listManagedPositions: vi.fn(async () =>
      poolPositions.map((position) => ({
        positionAddress: position.positionMint,
        positionMint: position.positionMint,
        whirlpoolAddress: "whirlpool",
        liquidity: 1n,
        raw: {}
      }))
    ),
    getWalletBalances: vi.fn(async () => ({
      tokenA: 2_000_000_000n,
      tokenB: 200_000_000n
    })),
    fundQuoteTokenFromWallet: vi.fn(async () => ({
      fundedQuoteAmount: 0n,
      txIds: [],
      route: null
    })),
    assessSwapToTarget: vi.fn(() => ({
      direction: "none",
      inputAmount: 0n,
      targetWeights: { tokenA: 0.5, tokenB: 0.5 },
      valueDelta: 0,
      valueDeltaBps: 0
    })),
    assessSwapToOpenTarget: vi.fn(() => ({
      direction: "none",
      inputAmount: 0n,
      targetWeights: { tokenA: 0.5, tokenB: 0.5 },
      valueDelta: 0,
      valueDeltaBps: 0,
      plan: {
        rawTargetTokenA: 1n,
        rawTargetTokenB: 1n
      }
    })),
    closePosition: vi.fn(async () => {
      livePosition = null;
      return {
        dryRun: false,
        quote: { quote: { tokenMinA: "0", tokenMinB: "0" } },
        txId: "close-tx"
      };
    }),
    swapToTarget: vi.fn(async () => ({
      dryRun: false,
      direction: "none",
      inputAmount: 0n,
      quote: null,
      txId: null,
      targetWeights: { tokenA: 0.5, tokenB: 0.5 }
    })),
    swapToOpenTarget: vi.fn(async () => ({
      dryRun: false,
      direction: "none",
      inputAmount: 0n,
      quote: null,
      txId: null,
      targetWeights: { tokenA: 0.5, tokenB: 0.5 },
      assessment: {
        plan: {
          rawTargetTokenA: 1n,
          rawTargetTokenB: 1n
        }
      }
    })),
    openCenteredPosition: vi.fn(async () => {
      livePosition = { positionMint: "new-position" };
      poolPositions = [livePosition];
      return {
        dryRun: false,
        positionMint: "new-position",
        lowerPrice: 98.4,
        upperPrice: 100.4,
        quote: null,
        txId: "open-tx",
        deployableTokenA: 1n,
        deployableTokenB: 1n
      };
    }),
    ...overrides
  };

  const service = new RebalancerService(
    {
      SOLANA_RPC_URL: "https://rpc.example",
      SOLANA_RPC_FALLBACK_URLS: "https://api.mainnet-beta.solana.com",
      BOT_WALLET_KEYPAIR_PATH: "./wallet.json",
      ORCA_WHIRLPOOL_ADDRESS: "whirlpool",
      BOT_STATE_FILE: "./data/state.json",
      BOT_REGISTRY_FILE: "./data/bots.json",
      BOT_PNL_LEDGER_FILE: "./data/pnl-ledger.json",
      LOG_FILE: "./data/logs/rebalancer.log",
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
      OPEN_DEPLOYMENT_BUFFER_BPS: 100,
      OPEN_RETRY_DEPLOYMENT_BUFFER_BPS: 300,
      OPEN_FINAL_DEPLOYMENT_BUFFER_BPS: 500,
      SOL_RESERVE_LAMPORTS: 50_000_000,
      MIN_SWAP_USDC: 10,
      OPEN_BALANCE_TOLERANCE_BPS: 25,
      TOKEN_A_MINT: "sol",
      TOKEN_A_SYMBOL: "SOL",
      TOKEN_A_DECIMALS: 9,
      TOKEN_B_MINT: "usdc",
      TOKEN_B_SYMBOL: "USDC",
      TOKEN_B_DECIMALS: 6,
      maxSlippageFraction: 0.01,
      solanaRpcUrls: ["https://rpc.example", "https://api.mainnet-beta.solana.com"],
      RANGE_PCT_BELOW: 1,
      RANGE_PCT_ABOVE: 1,
      BOT_PLATFORM: "orca" as const,
      METEORA_STRATEGY_TYPE: "Spot" as const
    },
    logger as never,
    store as never,
    orcaClient as never,
    {
      listClaimedPositionMints: vi.fn(async () => [])
    }
  );

  (service as any).oracle = {
    getPrice: vi.fn(async () => ({
      source: "oracle",
      price: 99.4,
      observedAt: "2026-03-13T00:05:00.000Z"
    }))
  };
  (service as any).accountReader = {
    getWalletBalances: vi.fn(async () => ({
      tokenA: 2_000_000_000n,
      tokenB: 200_000_000n
    }))
  };
  (service as any).transactionInspector = {
    inspect: vi.fn(async () => null),
    inspectOwnerTokenDebits: vi.fn(async () => null)
  };

  return {
    service,
    store,
    logger,
    orcaClient,
    getState: () => currentState,
    setLivePosition: (positionMint: string | null) => {
      livePosition = positionMint ? { positionMint } : null;
      poolPositions = livePosition ? [livePosition] : [];
    },
    setPoolPositions: (positionMints: string[]) => {
      poolPositions = positionMints.map((positionMint) => ({ positionMint }));
      livePosition = poolPositions[0] ?? null;
    }
  };
}

describe("rebalancer timeout recovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resumes a saved closing phase and finishes the rebalance", async () => {
    const harness = createHarness(
      createState({
        pendingRebalance: createPending({ phase: "closing" }),
        inFlightRebalance: true
      })
    );

    await harness.service.runCycle("run");

    expect(harness.getState().pendingRebalance).toBeNull();
    expect(harness.getState().activePositionMint).toBe("new-position");
    expect(harness.getState().latestAction).toBe("rebalance complete");
  });

  it("bootstraps an initial position when the bot has none", async () => {
    const harness = createHarness(
      createState({
        activePositionMint: null,
        lastRebalanceAt: null,
        lastCenterPrice: null,
        driftStatus: null
      })
    );

    await harness.service.runCycle("run");

    expect(harness.orcaClient.openCenteredPosition).toHaveBeenCalled();
    expect(harness.getState().activePositionMint).toBe("new-position");
    expect(harness.getState().latestAction).toBe("rebalance complete");
  });

  it("does not adopt another position in the same pool when bootstrapping a new bot", async () => {
    const harness = createHarness(
      createState({
        activePositionMint: null,
        lastRebalanceAt: null,
        lastCenterPrice: null,
        driftStatus: null
      })
    );

    await harness.service.runCycle("run");

    expect(harness.orcaClient.closePosition).not.toHaveBeenCalledWith("old-position", expect.anything(), expect.anything());
    expect(harness.orcaClient.openCenteredPosition).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(BigInt),
      expect.any(BigInt),
      true,
      null,
      expect.any(Number),
      expect.any(Number),
      undefined
    );
  });

  it("marks open timeout as successful when a new live position already exists", async () => {
    const openCenteredPosition = vi.fn(async () => {
      throw new TransactionTimeoutError("opening", { plannedPositionMint: "new-position" });
    });

    const harness = createHarness(
      createState({
        pendingRebalance: createPending({ phase: "opening", retryCount: 0 }),
        inFlightRebalance: true
      }),
      {
        openCenteredPosition
      }
    );
    harness.setLivePosition("new-position");

    await harness.service.runCycle("run");

    expect(harness.getState().pendingRebalance).toBeNull();
    expect(harness.getState().activePositionMint).toBe("new-position");
    expect(openCenteredPosition).toHaveBeenCalledTimes(1);
  });

  it("adopts a single unclaimed same-pool position after an opening timeout", async () => {
    const openCenteredPosition = vi.fn(async () => {
      throw new TransactionTimeoutError("opening", { plannedPositionMint: "planned-position" });
    });

    const harness = createHarness(
      createState({
        activePositionMint: null,
        pendingRebalance: createPending({
          phase: "opening",
          previousPositionMint: null,
          plannedPositionMint: "planned-position",
          retryCount: 0
        }),
        inFlightRebalance: true
      }),
      {
        openCenteredPosition,
        findManagedPosition: vi.fn(async () => null)
      }
    );
    harness.setPoolPositions(["unclaimed-position"]);

    await harness.service.runCycle("run");

    expect(harness.getState().pendingRebalance).toBeNull();
    expect(harness.getState().activePositionMint).toBe("unclaimed-position");
    expect(openCenteredPosition).toHaveBeenCalledTimes(1);
  });

  it("continues from a swap timeout when balances are already within tolerance", async () => {
    const swapToTarget = vi.fn(async () => {
      throw new TransactionTimeoutError("swapping");
    });

    const harness = createHarness(
      createState({
        pendingRebalance: createPending({ phase: "swapping", retryCount: 0 }),
        inFlightRebalance: true
      }),
      {
        swapToTarget
      }
    );
    harness.setLivePosition(null);

    await harness.service.runCycle("run");

    expect(harness.getState().pendingRebalance).toBeNull();
    expect(harness.getState().activePositionMint).toBe("new-position");
  });

  it("does not open a materially underfunded position and retries automatically later", async () => {
    const openCenteredPosition = vi.fn(async () => {
      throw new InsufficientAllocationError(45, 15, 40.5);
    });

    const harness = createHarness(
      createState({
        activePositionMint: null,
        lastRebalanceAt: null,
        lastCenterPrice: null,
        driftStatus: null
      }),
      {
        openCenteredPosition
      }
    );
    (harness.service as any).options.resolveAllocationQuoteBudget = vi.fn(async () => 250);
    (harness.service as any).accountReader.getWalletBalances = vi.fn(async () => ({
      tokenA: 1_000_000_000n,
      tokenB: 10_000_000n
    }));

    await harness.service.runCycle("run");

    expect(harness.getState().pendingRebalance).toBeNull();
    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().activePositionMint).toBeNull();
    expect(harness.getState().latestAction).toBe("waiting for enough free balance to meet configured allocation");
  });

  it("pauses with a phase-specific reason after an unresolved timeout retry", async () => {
    const closePosition = vi.fn(async () => {
      throw new TransactionTimeoutError("closing", { positionMint: "old-position" });
    });

    const harness = createHarness(
      createState({
        pendingRebalance: createPending({ phase: "closing", retryCount: 0 }),
        inFlightRebalance: true
      }),
      {
        closePosition
      }
    );
    harness.setLivePosition("old-position");

    await harness.service.runCycle("run");

    expect(harness.getState().paused).toBe(true);
    expect(harness.getState().pauseReason).toContain("Ambiguous closing state after timeout");
    expect(closePosition).toHaveBeenCalledTimes(2);
  });

  it("schedules an automatic retry after a deterministic close simulation failure", async () => {
    const closePosition = vi.fn(async () => {
      throw new Error('Transaction simulation failed: {"InstructionError":["5",{"Custom":"3007"}]}');
    });

    const harness = createHarness(
      createState({
        pendingRebalance: createPending({ phase: "closing", retryCount: 0 }),
        inFlightRebalance: true
      }),
      {
        closePosition
      }
    );
    harness.setLivePosition("old-position");

    await harness.service.runCycle("run");

    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().pendingRebalance?.phase).toBe("closing");
    expect(harness.getState().pendingRebalance?.nextRetryAt).not.toBeNull();
    expect(harness.getState().latestAction).toBe("retrying close after simulation failure");
    expect(closePosition).toHaveBeenCalledTimes(1);
  });

  it("resumes an already-paused close simulation failure into automatic retry recovery", async () => {
    const closePosition = vi.fn(async () => {
      throw new Error('Transaction simulation failed: {"InstructionError":["5",{"Custom":"3007"}]}');
    });

    const harness = createHarness(
      createState({
        paused: true,
        pauseReason:
          'Rebalance failed during closing phase. Manual reconciliation required: Transaction simulation failed: {"InstructionError":["5",{"Custom":"3007"}]}',
        pendingRebalance: createPending({ phase: "closing", retryCount: 0 }),
        inFlightRebalance: false
      }),
      {
        closePosition
      }
    );
    harness.setLivePosition("old-position");

    await harness.service.runCycle("run");

    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().pendingRebalance?.nextRetryAt).not.toBeNull();
    expect(harness.getState().latestAction).toBe("retrying close after simulation failure");
    expect(closePosition).toHaveBeenCalledTimes(1);
  });

  it("resumes an already-paused swap simulation failure into automatic retry recovery", async () => {
    const swapToTarget = vi.fn(async () => {
      throw new Error('Transaction simulation failed: {"InstructionError":["4",{"Custom":"1"}]}');
    });

    const harness = createHarness(
      createState({
        paused: true,
        pauseReason:
          'Rebalance failed during swapping phase. Manual reconciliation required: Transaction simulation failed: {"InstructionError":["4",{"Custom":"1"}]}',
        pendingRebalance: createPending({
          phase: "swapping",
          previousPositionMint: null,
          retryCount: 0
        }),
        inFlightRebalance: false
      }),
      {
        swapToTarget
      }
    );
    harness.setLivePosition(null);

    await harness.service.runCycle("run");

    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().pendingRebalance?.nextRetryAt).not.toBeNull();
    expect(harness.getState().latestAction).toBe("retrying swap after simulation failure");
  });

  it("releases a stale opening rebalance after too many recoverable rpc failures", async () => {
    const openCenteredPosition = vi.fn(async () => {
      throw new Error("HTTP error (429): Too Many Requests");
    });

    const harness = createHarness(
      createState({
        activePositionMint: null,
        pendingRebalance: createPending({
          phase: "opening",
          previousPositionMint: null,
          retryCount: 11
        }),
        inFlightRebalance: true,
        driftStatus: "triggered",
        driftDirection: "below"
      }),
      {
        openCenteredPosition
      }
    );
    harness.setLivePosition(null);

    await harness.service.runCycle("run");

    expect(harness.getState().pendingRebalance).toBeNull();
    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().inFlightRebalance).toBe(false);
    expect(harness.getState().latestAction).toBe("recoverable rpc retries exhausted; retrying from a fresh cycle");
    expect(harness.getState().driftStatus).toBe("triggered");
    expect(openCenteredPosition).toHaveBeenCalledTimes(1);
  });

  it("schedules an automatic retry after an opening simulation failure", async () => {
    const openCenteredPosition = vi.fn(async () => {
      throw new Error('Transaction simulation failed: {"InstructionError":["4",{"Custom":"1"}]}');
    });

    const harness = createHarness(
      createState({
        activePositionMint: null,
        pendingRebalance: createPending({
          phase: "opening",
          previousPositionMint: null,
          retryCount: 0
        }),
        inFlightRebalance: true
      }),
      {
        openCenteredPosition
      }
    );
    harness.setLivePosition(null);

    await harness.service.runCycle("run");

    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().pendingRebalance?.phase).toBe("swapping");
    expect(harness.getState().pendingRebalance?.openFailureCount).toBe(1);
    expect(harness.getState().pendingRebalance?.nextRetryAt).not.toBeNull();
    expect(harness.getState().latestAction).toBe("retrying rebalance before open after simulation failure");
    expect(openCenteredPosition).toHaveBeenCalledTimes(3);
  });

  it("rebalances again instead of pausing when open sizing leaves one side undeployable", async () => {
    const openCenteredPosition = vi.fn(async () => {
      throw new Error(
        "Insufficient deployable balance to open a position for SOL/USDC. tokenMaxA=0 tokenMaxB=1000"
      );
    });

    const harness = createHarness(
      createState({
        activePositionMint: null,
        pendingRebalance: createPending({
          phase: "opening",
          previousPositionMint: null,
          retryCount: 0
        }),
        inFlightRebalance: true
      }),
      {
        openCenteredPosition
      }
    );
    harness.setLivePosition(null);

    await harness.service.runCycle("run");

    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().pendingRebalance?.phase).toBe("swapping");
    expect(harness.getState().pendingRebalance?.openFailureCount).toBe(1);
    expect(harness.getState().pendingRebalance?.nextRetryAt).not.toBeNull();
    expect(openCenteredPosition).toHaveBeenCalledTimes(1);
  });

  it("resumes a paused insufficient-allocation rebalance into the automatic wait state", async () => {
    const harness = createHarness(
      createState({
        paused: true,
        pauseReason:
          "Rebalance failed during swapping phase. Manual reconciliation required: " +
          "Insufficient free wallet balance to fund the requested allocation. " +
          "targetQuote=45.000000 availableQuote=15.000000 minimumRequiredQuote=40.500000",
        pendingRebalance: createPending({
          phase: "swapping",
          previousPositionMint: null
        }),
        inFlightRebalance: false
      }),
      {
        assessSwapToOpenTarget: vi.fn(() => {
          throw new InsufficientAllocationError(45, 15, 40.5);
        })
      }
    );

    await harness.service.runCycle("run");

    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().pendingRebalance).toBeNull();
    expect(harness.getState().latestAction).toBe("waiting for enough free balance to meet configured allocation");
  });

  it("skips dust-level retry swaps after an open failure and proceeds back to opening", async () => {
    const swapToOpenTarget = vi.fn(async () => ({
      dryRun: false,
      direction: "buy-token-a",
      inputAmount: 1n,
      quote: null,
      txId: "swap-tx",
      targetWeights: { tokenA: 0.5, tokenB: 0.5 }
    }));
    const openCenteredPosition = vi.fn(async () => ({
      dryRun: false,
      positionMint: "new-position",
      lowerPrice: 98.4,
      upperPrice: 100.4,
      quote: null,
      txId: "open-tx",
      deployableTokenA: 1n,
      deployableTokenB: 1n
    }));

    const harness = createHarness(
      createState({
        activePositionMint: null,
        pendingRebalance: createPending({
          phase: "swapping",
          previousPositionMint: null,
          recoveryReason: 'Transaction simulation failed: {"InstructionError":["4",{"Custom":"1"}]}',
          openFailureCount: 1
        }),
        inFlightRebalance: true
      }),
      {
        assessSwapToOpenTarget: vi.fn(() => ({
          direction: "buy-token-a",
          inputAmount: 1n,
          targetWeights: { tokenA: 0.5, tokenB: 0.5 },
          valueDelta: 0.005,
          valueDeltaBps: 0.2,
          plan: {
            rawTargetTokenA: 1n,
            rawTargetTokenB: 1n
          }
        })),
        swapToOpenTarget,
        openCenteredPosition
      }
    );

    await harness.service.runCycle("run");

    expect(swapToOpenTarget).not.toHaveBeenCalled();
    expect(openCenteredPosition).toHaveBeenCalledTimes(1);
    expect(harness.getState().activePositionMint).toBe("new-position");
    expect(harness.getState().latestAction).toBe("rebalance complete");
  });

  it("uses exact open-target swaps after an open failure instead of the generic swap path", async () => {
    const swapToOpenTarget = vi.fn(async () => ({
      dryRun: false,
      direction: "buy-token-a",
      inputAmount: 10n,
      quote: null,
      txId: "swap-tx",
      targetWeights: { tokenA: 0.5, tokenB: 0.5 },
      assessment: {
        plan: {
          rawTargetTokenA: 20n,
          rawTargetTokenB: 30n
        }
      }
    }));

    const harness = createHarness(
      createState({
        activePositionMint: null,
        pendingRebalance: createPending({
          phase: "swapping",
          previousPositionMint: null,
          recoveryReason: 'Transaction simulation failed: {"InstructionError":["4",{"Custom":"1"}]}',
          openFailureCount: 1
        }),
        inFlightRebalance: true
      }),
      {
        assessSwapToOpenTarget: vi.fn(() => ({
          direction: "buy-token-a",
          inputAmount: 10n,
          targetWeights: { tokenA: 0.5, tokenB: 0.5 },
          valueDelta: 1,
          valueDeltaBps: 10,
          plan: {
            rawTargetTokenA: 20n,
            rawTargetTokenB: 30n
          }
        })),
        swapToOpenTarget
      }
    );

    await harness.service.runCycle("run");

    expect(swapToOpenTarget).toHaveBeenCalled();
    expect(harness.orcaClient.swapToTarget).not.toHaveBeenCalled();
    expect(harness.getState().activePositionMint).toBe("new-position");
  });

  it("converts a legacy paused timeout into a reconcilable pending rebalance", async () => {
    const harness = createHarness(
      createState({
        pendingRebalance: null,
        paused: true,
        pauseReason: "Transaction confirmation timeout",
        driftStatus: "triggered"
      })
    );

    await harness.service.runCycle("run");

    expect(harness.getState().paused).toBe(false);
    expect(harness.getState().pendingRebalance).toBeNull();
    expect(harness.getState().activePositionMint).toBe("new-position");
  });
});
