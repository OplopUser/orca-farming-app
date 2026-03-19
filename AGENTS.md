# Orca Farming App — Agent Guide

## Project Purpose

Automated Orca Whirlpool concentrated-liquidity LP bot. The primary objective is **maximising fee income** from LP positions while keeping capital actively deployed. The bot does this by:

1. Opening a tight concentrated-liquidity range around the current price to maximise fee APR.
2. Monitoring price drift and rebalancing (close → swap → open) whenever price moves outside the drift trigger, so the position stays in-range and keeps earning fees.
3. Running multiple bots in parallel from a single wallet, each targeting a different Whirlpool pool, to spread fee capture across pools.

---

## Architecture

```
src/
  index.ts              — CLI entry point (run / dry-run / rebalance-now)
  controlPanel.ts       — HTTP control panel at http://127.0.0.1:8787
  config.ts             — Env-var schema (zod), loads AppConfig
  botConfig.ts          — Merges per-bot overrides into AppConfig
  domain.ts             — All shared types (BotDefinition, BotState, PnL records, …)
  strategy/bands.ts     — computeBand, evaluateDriftTrigger, computeTargetValueWeights
  services/
    rebalancer.ts       — Core rebalance loop: close → swap → open with retry/recovery
    botSupervisor.ts    — Runs N monitoring loops in parallel, one queue for execution
    pnlMath.ts          — Net PnL calculations (fees earned, swap costs, tx fees)
    positionPnlService.ts — Position open/close ledger helpers
    recovery.ts         — Timeout classification and recovery decisions
  clients/orcaClient.ts — All Orca Whirlpool SDK calls isolated here
  infra/
    rpcAccountReader.ts — Wallet balance and position account reads
    rpcFailover.ts      — RPC rotation on rate-limit / transport errors
    transactionInspector.ts — Fee and CU extraction from confirmed txs
  state/
    botRegistryStore.ts — Reads/writes data/bots.json
    pnlLedgerStore.ts   — Reads/writes data/pnl-ledger.json
    store.ts            — Legacy single-bot state (migration only)
  oracle/coingeckoOracle.ts — External price feed for divergence guard
```

**Key invariants:**
- All wallet-mutating operations (close / swap / open) are serialised through a single execution queue — never run two bots' rebalances concurrently.
- Each bot's monitoring loop is independent and in-parallel.
- Orca SDK surface is confined to `src/clients/orcaClient.ts`. Every future SDK change is absorbed there.

---

## Strategy Parameters — Fee Optimisation Focus

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `RANGE_PCT` | `1` | ±1 % LP band. Narrow = more fees per dollar, more rebalances. |
| `REBALANCE_DRIFT_PCT` | `0.5` | Trigger rebalance when price moves ±0.5 % from anchor. |
| `POLL_SECONDS` | `15` | Price check cadence. Lower = faster trigger response. |
| `BOT_ALLOCATION_USDC` | per-bot | Capital deployed per bot. |
| `SOL_RESERVE_LAMPORTS` | `50_000_000` | SOL kept for tx fees (~0.05 SOL). |

**Tuning guidance:**
- Tighter `RANGE_PCT` (e.g. `0.5`) concentrates liquidity and earns more fees at the cost of more frequent rebalances (and swap cost drag). Balance against pool volatility.
- `REBALANCE_DRIFT_PCT` should be ≤ `RANGE_PCT / 2` to ensure rebalance fires before price exits the range entirely.
- For stable pairs (USDC/USDT, SOL/jitoSOL) very tight ranges (0.1–0.3 %) work well. For volatile pairs (SOL/USDC) 1–2 % is typical.

---

## Commands

```bash
npm run ui            # Start browser control panel at http://127.0.0.1:8787
npm run run           # Start all enabled bots (live trading)
npm run dry-run       # Full logic, no transactions sent
npm run rebalance-now # Force-rebalance all active bots immediately
npm test              # Run vitest unit tests
npm run build         # tsc compile to dist/
npm run typecheck     # Type-check without emitting
```

---

## Environment Variables (`.env`)

Copy `.env.example` → `.env`. Required:

```
SOLANA_RPC_URL=              # Primary RPC endpoint
SOLANA_RPC_FALLBACK_URLS=    # Comma-separated backup RPCs (optional)
BOT_WALLET_KEYPAIR_PATH=     # Path to keypair JSON (not Phantom)
ORCA_WHIRLPOOL_ADDRESS=      # Used for legacy single-bot path; ignored in multi-bot
```

Data paths (defaults work out of box):
```
BOT_REGISTRY_FILE=./data/bots.json
BOT_PNL_LEDGER_FILE=./data/pnl-ledger.json
LOG_FILE=./data/logs/rebalancer.log
```

---

## State Files

| File | Contents |
|------|----------|
| `data/bots.json` | Bot registry — definitions + runtime state for all bots |
| `data/pnl-ledger.json` | Position PnL ledger — open/closed positions with fee accounting |
| `data/state.json` | Legacy single-bot state (one-time migration only, ignore) |
| `data/logs/rebalancer.log` | Structured pino JSON log |

---

## Rebalance Flow

```
Price poll → evaluateDriftTrigger
  ↓ triggered
Close existing position (with slippage ladder: base → CLOSE_RETRY → CLOSE_FINAL)
  ↓
Swap to target ratio (computeTargetValueWeights determines token split)
  ↓
Open new position centred on current price (with deployment buffer ladder)
  ↓
Record to PnL ledger (entry capital, fees earned, swap cost, tx fees)
```

Recovery is applied on startup and on timeout: `classifyCloseTimeout`, `classifySwapTimeout`, `classifyOpenTimeout` decide whether to retry or pause.

---

## PnL Accounting

Net PnL = `feesEarned - cumulativeSwapFees - cumulativeTxFees ± positionValueChange`

- `feesEarnedUsdc` — LP fees collected from the Whirlpool position.
- `cumulativeSwapFeesUsdc` — Jupiter swap fees paid during rebalances.
- `cumulativeTxFeesUsdc` — Solana tx fees in lamports converted to USD.
- Realised PnL is locked in on position close. Unrealised PnL is marked on each poll.

---

## Testing

Tests live in `tests/`. Run with `npm test` (vitest). No mocking of the RPC or Orca SDK — tests use recorded fixtures or pure-function unit tests. Do not introduce RPC mocks; the test suite intentionally avoids them to prevent mock/prod divergence.

---

## Code Conventions

- TypeScript strict mode; all domain types in `domain.ts`.
- `zod` for all external input validation (env vars, API responses).
- `pino` for structured JSON logging — use the injected `logger` instance, not `console.log`.
- All Orca SDK calls go through `OrcaClient` — never import `@orca-so/whirlpools` directly outside `src/clients/orcaClient.ts`.
- Avoid adding new state files; extend `BotDefinition` / `BotState` in `domain.ts` and the registry store.
- Do not add backwards-compat shims; change the code directly.
