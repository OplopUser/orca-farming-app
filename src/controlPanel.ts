import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import dotenv from "dotenv";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { BotRegistryStore } from "./state/botRegistryStore.js";
import { BotSupervisor } from "./services/botSupervisor.js";

dotenv.config({ override: true });

const HOST = "127.0.0.1";
const PORT = Number(process.env.UI_PORT ?? 8787);
const PUBLIC_DIR = resolve("public");

const config = loadConfig();
const logger = createLogger(config);
const registryStore = new BotRegistryStore(config.BOT_REGISTRY_FILE, config.BOT_STATE_FILE, config);
const supervisor = new BotSupervisor(config, logger, registryStore);

const STATUS_CACHE_TTL_MS = 5_000;
let statusCache: { json: string; cachedAt: number } | null = null;

function invalidateStatusCache() {
  statusCache = null;
}

interface TransactionEvent {
  botId: string | null;
  botName: string | null;
  time: string;
  type: string;
  status: string;
  txId: string | null;
  fees: string;
  summary: string;
}

interface BotPnlSummaryView {
  botId: string;
  openNetPnlUsdc: number;
  realizedNetPnlUsdc: number;
  totalNetPnlUsdc: number;
  feesEarnedUsdc: number;
  openPositionCount: number;
  closedPositionCount: number;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendNoContent(response: ServerResponse) {
  response.writeHead(204);
  response.end();
}

function sendError(response: ServerResponse, statusCode: number, error: string) {
  sendJson(response, statusCode, { error });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}

function normalizeFee(value: unknown): string {
  if (value == null) {
    return "-";
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
    return String(value);
  }

  return "-";
}

function summarizeEvent(entry: Record<string, unknown>): TransactionEvent | null {
  const msg = typeof entry.msg === "string" ? entry.msg : "";
  const botId = typeof entry.botId === "string" ? entry.botId : null;
  const botName = typeof entry.botName === "string" ? entry.botName : null;
  const time = typeof entry.time === "string" ? entry.time : new Date().toISOString();

  if (msg === "position close evaluated") {
    const feeLamports = normalizeFee((entry.closeSummary as Record<string, unknown> | undefined)?.feeLamports);
    return {
      botId,
      botName,
      time,
      type: "Close",
      status: "Submitted",
      txId: typeof entry.closeTxId === "string" ? entry.closeTxId : null,
      fees: feeLamports,
      summary: typeof entry.positionMint === "string" ? `Position ${entry.positionMint}` : "Closed managed position"
    };
  }

  if (msg === "swap plan evaluated") {
    const direction = typeof entry.direction === "string" ? entry.direction : "none";
    const txId = typeof entry.swapTxId === "string" ? entry.swapTxId : null;
    const feeLamports = normalizeFee((entry.swapSummary as Record<string, unknown> | undefined)?.feeLamports);
    return {
      botId,
      botName,
      time,
      type: "Swap",
      status: txId ? "Submitted" : direction === "none" ? "Skipped" : "Planned",
      txId,
      fees: txId ? feeLamports : "-",
      summary: `${direction} ${typeof entry.inputAmount === "string" ? entry.inputAmount : ""}`.trim()
    };
  }

  if (msg === "rebalance finished") {
    const result = (entry.result as Record<string, unknown> | undefined) ?? {};
    const newPositionMint = typeof result.newPositionMint === "string" ? result.newPositionMint : null;
    const openTxId = typeof result.openTxId === "string" ? result.openTxId : null;
    const feeLamports = normalizeFee((entry.openSummary as Record<string, unknown> | undefined)?.feeLamports);
    return {
      botId,
      botName,
      time,
      type: "Deposit",
      status: "Completed",
      txId: openTxId,
      fees: feeLamports,
      summary: newPositionMint ? `Opened ${newPositionMint}` : "Opened centered position"
    };
  }

  if (msg === "rebalance failed") {
    return {
      botId,
      botName,
      time,
      type: "Rebalance",
      status: "Failed",
      txId:
        typeof entry.openTxId === "string"
          ? entry.openTxId
          : typeof entry.closeTxId === "string"
            ? entry.closeTxId
            : typeof entry.swapTxId === "string"
              ? entry.swapTxId
              : null,
      fees: "-",
      summary: typeof entry.error === "string" ? entry.error : "Rebalance failed"
    };
  }

  if (msg === "timeout detected") {
    return {
      botId,
      botName,
      time,
      type: "Recovery",
      status: "Timeout",
      txId: null,
      fees: "-",
      summary: `${typeof entry.phase === "string" ? entry.phase : "unknown"} phase`
    };
  }

  if (msg === "timeout reconciliation evaluated") {
    return {
      botId,
      botName,
      time,
      type: "Recovery",
      status: "Checked",
      txId: null,
      fees: "-",
      summary: `${typeof entry.phase === "string" ? entry.phase : "unknown"} => ${typeof entry.outcome === "string" ? entry.outcome : "unknown"}`
    };
  }

  if (msg === "retry attempt") {
    return {
      botId,
      botName,
      time,
      type: "Recovery",
      status: "Retrying",
      txId: null,
      fees: "-",
      summary: `${typeof entry.phase === "string" ? entry.phase : "unknown"} attempt ${typeof entry.attempt === "number" ? entry.attempt : "?"}`
    };
  }

  if (msg === "cycle evaluated") {
    if (!(typeof entry.shouldRebalance === "boolean" && entry.shouldRebalance)) {
      return null;
    }

    return {
      botId,
      botName,
      time,
      type: "Trigger",
      status: "Triggered",
      txId: null,
      fees: "-",
      summary: `Price ${entry.currentPrice ?? "-"} anchor ${entry.anchorPrice ?? "-"}`
    };
  }

  return null;
}

function summarizeBot(
  record: Awaited<ReturnType<typeof supervisor.listBots>>[number],
  pnlSummary?: BotPnlSummaryView
) {
  const runtime = record.runtime;
  const definition = record.definition;
  const triggerState = runtime.driftStatus
    ? `${runtime.driftStatus}${runtime.driftDirection ? ` (${runtime.driftDirection})` : ""}`
    : "idle";

  let runState = "Stopped";
  if (runtime.paused) {
    runState = "Paused";
  } else if (runtime.pendingRebalance?.nextRetryAt) {
    runState = "Waiting to retry";
  } else if (runtime.pendingRebalance?.recoveryReason) {
    runState = "Reconciling timeout";
  } else if (definition.enabled && runtime.monitoringActive) {
    runState = runtime.driftStatus === "triggered" ? "Triggered" : "Running";
  }

  return {
    id: definition.id,
    name: definition.name,
    enabled: definition.enabled,
    archived: definition.archived,
    monitoringActive: runtime.monitoringActive,
    platform: definition.platform ?? "orca",
    whirlpoolAddress: definition.whirlpoolAddress,
    allocationUsdc: definition.allocationUsdc,
    rangePct: definition.rangePct,
    rangePctBelow: definition.rangePctBelow,
    rangePctAbove: definition.rangePctAbove,
    meteoraStrategyType: definition.meteoraStrategyType,
    rebalanceDriftPct: definition.rebalanceDriftPct,
    pollSeconds: definition.pollSeconds,
    maxSlippageBps: definition.maxSlippageBps,
    tokenPair: `${definition.tokenASymbol}/${definition.tokenBSymbol}`,
    runState,
    latestAction: runtime.latestAction,
    lastObservedPrice: runtime.lastObservedPrice,
    lastCenterPrice: runtime.lastCenterPrice,
    driftTriggerLower: runtime.driftTriggerLower,
    driftTriggerUpper: runtime.driftTriggerUpper,
    triggerState,
    activePositionMint: runtime.activePositionMint,
    positionLowerPrice: runtime.positionLowerPrice,
    positionUpperPrice: runtime.positionUpperPrice,
    pendingRebalance: runtime.pendingRebalance,
    paused: runtime.paused,
    pauseReason: runtime.pauseReason,
    lastCycleAt: runtime.lastCycleAt,
    pnl: pnlSummary ?? null
  };
}

async function serveStatic(pathname: string, response: ServerResponse) {
  const filePath =
    pathname === "/" ? resolve(PUBLIC_DIR, "index.html") : resolve(PUBLIC_DIR, `.${pathname}`);
  const file = await readFile(filePath);
  const contentType =
    pathname.endsWith(".css")
      ? "text/css; charset=utf-8"
      : pathname.endsWith(".js")
        ? "application/javascript; charset=utf-8"
        : "text/html; charset=utf-8";

  // JS and CSS change with code updates — always revalidate. Only cache immutable assets long-term.
  const cacheControl = (pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".html"))
    ? "no-cache"
    : "public, max-age=3600";
  response.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
  response.end(file);
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  const pathname = url.pathname;
  const method = request.method ?? "GET";
  const parts = pathname.split("/").filter(Boolean);

  if (pathname === "/api/status" && method === "GET") {
    if (statusCache && Date.now() - statusCache.cachedAt < STATUS_CACHE_TTL_MS) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(statusCache.json);
      return;
    }
    const [wallet, bots, pnl] = await Promise.all([
      supervisor.getWalletSummary(),
      supervisor.listBots(),
      supervisor.getPnlDashboard()
    ]);
    const payload = {
      wallet,
      bots: bots.map((bot) => summarizeBot(bot, pnl.botSummaries[bot.definition.id])),
      pnl: pnl.summary
    };
    const json = JSON.stringify(payload);
    statusCache = { json, cachedAt: Date.now() };
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(json);
    return;
  }

  if (pathname === "/api/bots" && method === "GET") {
    const [bots, pnl] = await Promise.all([supervisor.listBots(), supervisor.getPnlDashboard()]);
    return sendJson(response, 200, { bots: bots.map((bot) => summarizeBot(bot, pnl.botSummaries[bot.definition.id])) });
  }

  if (pathname === "/api/bots" && method === "POST") {
    const payload = await readJson<{
      name: string;
      whirlpoolAddress: string;
      allocationUsdc: number;
      rangePct: number;
      rangePctBelow?: number;
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
      platform?: string;
      meteoraStrategyType?: string;
    }>(request);
    const bot = await supervisor.createBot({
      ...payload,
      platform: payload.platform === "meteora" ? "meteora" : "orca",
      meteoraStrategyType: payload.meteoraStrategyType === "Curve"
        ? "Curve"
        : payload.meteoraStrategyType === "BidAsk"
          ? "BidAsk"
          : "Spot"
    });
    invalidateStatusCache();
    return sendJson(response, 201, { bot: summarizeBot(bot) });
  }

  if (pathname === "/api/transactions" && method === "GET") {
    const botId = url.searchParams.get("botId") ?? undefined;
    const events = (await supervisor.getTransactions(config.LOG_FILE, botId))
      .map(summarizeEvent)
      .filter((event): event is TransactionEvent => Boolean(event))
      .slice(-100)
      .reverse();
    return sendJson(response, 200, { events });
  }

  if (pathname === "/api/pnl" && method === "GET") {
    const pnl = await supervisor.getPnlDashboard();
    return sendJson(response, 200, pnl);
  }

  if (parts[0] === "api" && parts[1] === "bots" && parts[2]) {
    const botId = parts[2];

    if (method !== "GET") {
      invalidateStatusCache();
    }

    if (parts.length === 3 && method === "PATCH") {
      const payload = await readJson<{
        name?: string;
        allocationUsdc?: number;
        rangePct?: number;
        rebalanceDriftPct?: number;
        pollSeconds?: number;
        maxSlippageBps?: number;
      }>(request);
      const bot = await supervisor.updateBot(botId, payload);
      if (!bot) {
        return sendError(response, 404, "Bot not found");
      }
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts.length === 3 && method === "DELETE") {
      const bot = await supervisor.archiveBot(botId);
      if (!bot) {
        return sendError(response, 404, "Bot not found");
      }
      return sendNoContent(response);
    }

    if (parts[3] === "start" && method === "POST") {
      const bot = await supervisor.startBot(botId);
      if (!bot) {
        return sendError(response, 404, "Bot not found");
      }
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts[3] === "stop" && method === "POST") {
      const bot = await supervisor.stopBot(botId);
      if (!bot) {
        return sendError(response, 404, "Bot not found");
      }
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts[3] === "pause" && method === "POST") {
      const bot = await supervisor.pauseBot(botId);
      if (!bot) {
        return sendError(response, 404, "Bot not found");
      }
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts[3] === "resume" && method === "POST") {
      const bot = await supervisor.resumeBot(botId);
      if (!bot) {
        return sendError(response, 404, "Bot not found");
      }
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts[3] === "rebalance" && method === "POST") {
      await supervisor.rebalanceNow(botId);
      return sendNoContent(response);
    }

    if (parts[3] === "transactions" && method === "GET") {
      const events = (await supervisor.getTransactions(config.LOG_FILE, botId))
        .map(summarizeEvent)
        .filter((event): event is TransactionEvent => Boolean(event))
        .slice(-60)
        .reverse();
      return sendJson(response, 200, { events });
    }
  }

  sendError(response, 404, "Not found");
}

async function main() {
  await supervisor.init();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      sendError(response, 500, (error as Error).message);
    }
  });

  server.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, "multi-bot control panel listening");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
