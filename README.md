# Orca Multi-Bot Control Panel

Local TypeScript control panel and worker supervisor for managing multiple Orca Whirlpool LP bots from one shared wallet. Each bot keeps its own pool id, allocation, strategy params, runtime state, and transaction history while actual wallet-changing execution is serialized through one shared queue.

## Commands

```bash
npm run ui
npm run dry-run
npm run run
npm run rebalance-now
```

## Configuration

Copy `.env.example` to `.env` and set:

- `SOLANA_RPC_URL`
- `SOLANA_RPC_FALLBACK_URLS` optional comma-separated backup RPCs
- `BOT_WALLET_KEYPAIR_PATH`
- `BOT_REGISTRY_FILE`
- `BOT_PNL_LEDGER_FILE`

The browser control panel lives at `http://127.0.0.1:8787` after:

```bash
npm run ui
```

From the panel you can:

- create new bots from a Whirlpool address
- assign a fixed allocation amount
- set LP range, drift trigger, poll interval, and retry/slippage controls
- start, stop, resume, rebalance, archive, and edit each bot
- view a shared wallet summary plus per-bot and all-bots transaction history
- view net PnL for each bot, a total realized/all-in PnL summary, and a position ledger for open and closed positions

The defaults already match the planned strategy:

- `RANGE_PCT=1`
- `REBALANCE_DRIFT_PCT=0.5`
- `POLL_SECONDS=15`
- `BOT_ALLOCATION_USDC=100`
- `SOL_RESERVE_LAMPORTS=50000000`

State now lives in:

- bot registry: `./data/bots.json`
- pnl ledger: `./data/pnl-ledger.json`
- legacy single-bot state: `./data/state.json` only used for one-time migration
- logs: `./data/logs/rebalancer.log`

If the primary RPC starts rate-limiting or returning recoverable transport errors, the bot will rotate through `SOLANA_RPC_FALLBACK_URLS` and retry against the next endpoint.

For close, swap, and open transactions, the bot records:

- transaction signature
- quote payload returned by Orca
- fee in lamports when `getTransaction` is available from RPC
- compute units consumed when exposed by RPC
- confirmation status and on-chain error metadata

Close attempts use the base slippage first, then widen through `CLOSE_RETRY_SLIPPAGE_BPS` and `CLOSE_FINAL_RETRY_SLIPPAGE_BPS` before pausing on a stale quote. Before reopening, the bot now enforces a stricter wallet-balance check via `OPEN_BALANCE_TOLERANCE_BPS`, executes a final balancing swap if needed, and then retries the open with higher slippage plus larger deployment buffers from `OPEN_DEPLOYMENT_BUFFER_BPS` through `OPEN_RETRY_DEPLOYMENT_BUFFER_BPS` and `OPEN_FINAL_DEPLOYMENT_BUFFER_BPS`.

## Notes

- This service is intentionally built around a dedicated bot wallet, not Phantom.
- The control panel supervisor runs per-bot monitoring loops in parallel and serializes live close/swap/open execution through one shared queue.
- The Orca adapter uses the official Whirlpool SDK surface and keeps its SDK calls isolated in one file so future API drift is easier to absorb.
- `dry-run` performs full trigger evaluation and quote planning without sending transactions.
