import { describe, expect, it, vi } from "vitest";

import { DryRunSendBlockedError, FundingSwapError, OrcaClient } from "../src/clients/orcaClient.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = "Other1111111111111111111111111111111111111";

/**
 * An OrcaClient whose SDK, RPC and Jupiter calls are stubbed, so fundQuoteTokenFromWallet runs offline.
 * The quote stub always fails ExactOut (forcing the ExactIn path) and returns 1 quote unit per input unit.
 */
function createFundingClient(
  assets: Array<{ mint: string; amount: bigint; decimals: number }>,
  options: { reserveLamports?: number; failQuoteFor?: string[]; failSwapFor?: string[] } = {}
) {
  const client = new OrcaClient(
    {
      solanaRpcUrls: ["https://rpc.example"],
      SOL_RESERVE_LAMPORTS: options.reserveLamports ?? 50_000_000,
      TOKEN_A_MINT: SOL_MINT,
      TOKEN_B_MINT: USDC_MINT,
      MAX_SLIPPAGE_BPS: 25
    } as never,
    {}
  );
  const internals = client as any;
  internals.sdk = {};
  internals.kit = {};
  internals.txSender = {};
  internals.rpc = {};
  internals.walletAddress = "owner";
  internals.accountReader = { listWalletAssets: vi.fn(async () => assets) };

  const fetchJupiterQuote = vi.fn(async (inputMint: string, outputMint: string, amount: bigint, swapMode: string) => {
    if (options.failQuoteFor?.includes(inputMint)) {
      throw new Error(`HTTP error (400): no route for ${inputMint}`);
    }
    if (swapMode === "ExactOut") {
      throw new Error("ExactOut not supported in this stub");
    }
    return { inputMint, outputMint, inAmount: amount.toString(), outAmount: amount.toString() };
  });
  const jupiterSwap = vi.fn(async (params: { inputMint: string; amount: bigint }) => {
    if (options.failSwapFor?.includes(params.inputMint)) {
      throw new Error("simulation failed");
    }
    return { dryRun: false, quote: {}, txId: `tx-${params.inputMint.slice(0, 5)}` };
  });
  internals.fetchJupiterQuote = fetchJupiterQuote;
  internals.jupiterSwap = jupiterSwap;

  return { client, fetchJupiterQuote, jupiterSwap };
}

describe("fundQuoteTokenFromWallet", () => {
  it("never spends SOL below SOL_RESERVE_LAMPORTS", async () => {
    const { client, jupiterSwap } = createFundingClient([
      { mint: SOL_MINT, amount: 80_000_000n, decimals: 9 }
    ]);

    const result = await client.fundQuoteTokenFromWallet(1_000_000_000n, true);

    expect(jupiterSwap).toHaveBeenCalledTimes(1);
    expect(jupiterSwap.mock.calls[0][0].amount).toBe(30_000_000n);
    expect(result.fundedQuoteAmount).toBe(30_000_000n);
  });

  it("skips SOL entirely when the balance is at or below the reserve", async () => {
    const { client, fetchJupiterQuote, jupiterSwap } = createFundingClient([
      { mint: SOL_MINT, amount: 50_000_000n, decimals: 9 }
    ]);

    const result = await client.fundQuoteTokenFromWallet(1_000_000n, true);

    expect(fetchJupiterQuote).not.toHaveBeenCalled();
    expect(jupiterSwap).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fundedQuoteAmount: 0n, txIds: [], route: null, failures: [] });
  });

  it("records sources that cannot be quoted and moves on to the next one", async () => {
    const { client, jupiterSwap } = createFundingClient(
      [
        { mint: SOL_MINT, amount: 150_000_000n, decimals: 9 },
        { mint: OTHER_MINT, amount: 5_000_000n, decimals: 6 }
      ],
      { failQuoteFor: [SOL_MINT] }
    );

    const result = await client.fundQuoteTokenFromWallet(5_000_000n, true);

    expect(result.failures).toEqual([
      { sourceMint: SOL_MINT, error: `HTTP error (400): no route for ${SOL_MINT}` }
    ]);
    expect(jupiterSwap).toHaveBeenCalledTimes(1);
    expect(jupiterSwap.mock.calls[0][0].inputMint).toBe(OTHER_MINT);
    expect(result.fundedQuoteAmount).toBe(5_000_000n);
  });

  it("propagates a failed swap with the signatures that already landed", async () => {
    const { client } = createFundingClient(
      [
        { mint: SOL_MINT, amount: 60_000_000n, decimals: 9 },
        { mint: OTHER_MINT, amount: 5_000_000n, decimals: 6 }
      ],
      { failSwapFor: [OTHER_MINT] }
    );

    const error = await client.fundQuoteTokenFromWallet(100_000_000n, true).catch((caught) => caught);

    expect(error).toBeInstanceOf(FundingSwapError);
    expect(error.sourceMint).toBe(OTHER_MINT);
    expect(error.completedTxIds).toEqual(["tx-So111"]);
    expect(error.message).toContain("simulation failed");
  });

  it("does not swallow the dry-run send guard", async () => {
    const { client, jupiterSwap } = createFundingClient([{ mint: SOL_MINT, amount: 60_000_000n, decimals: 9 }]);
    jupiterSwap.mockRejectedValueOnce(new DryRunSendBlockedError("swapping"));

    await expect(client.fundQuoteTokenFromWallet(1_000_000n, true)).rejects.toBeInstanceOf(DryRunSendBlockedError);
  });
});
