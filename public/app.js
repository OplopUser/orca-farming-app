import { escapeHtml } from "./escape.js";

const walletAddress = document.getElementById("walletAddress");
const enabledBots = document.getElementById("enabledBots");
const monitoringBots = document.getElementById("monitoringBots");
const allocationValue = document.getElementById("allocationValue");
const walletTokenA = document.getElementById("walletTokenA");
const walletTokenB = document.getElementById("walletTokenB");
const queueBadge = document.getElementById("queueBadge");
const formulaPnlValue = document.getElementById("formulaPnlValue");
const totalDepositValue = document.getElementById("totalDepositValue");
const totalWithdrawValue = document.getElementById("totalWithdrawValue");
const realizedPnlValue = document.getElementById("realizedPnlValue");
const openPnlValue = document.getElementById("openPnlValue");
const feesEarnedValue = document.getElementById("feesEarnedValue");
const openPositionsValue = document.getElementById("openPositionsValue");
const closedPositionsValue = document.getElementById("closedPositionsValue");
const orphanWarning = document.getElementById("orphanWarning");

function formatUsdKpi(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const amount = Number(value);
  const sign = amount > 0 ? "+" : "";
  return `${sign}$${amount.toFixed(2)}`;
}
const botsGrid = document.getElementById("botsGrid");
const pnlPositionsBody = document.getElementById("pnlPositionsBody");
const transactionsBody = document.getElementById("transactionsBody");
const transactionFilter = document.getElementById("transactionFilter");
const typeFilter = document.getElementById("typeFilter");
const statusFilter = document.getElementById("statusFilter");
const searchFilter = document.getElementById("searchFilter");
const createBotForm = document.getElementById("createBotForm");
const signOutLink = document.getElementById("signOutLink");
const activeLpGrid = document.getElementById("activeLpGrid");

let latestBots = [];
let latestTransactions = [];
let latestPnlPositions = [];
let previousBotIds = [];

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json"
    },
    ...options
  });

  if (response.status === 401) {
    // UI_TOKEN is set and the session cookie is missing or stale: go back to the login form.
    window.location.assign("/login");
    throw new Error("Not signed in");
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function formatValue(value) {
  return value ?? "-";
}

function formatUsd(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }

  const amount = Number(value);
  const sign = amount > 0 ? "+" : "";
  return `${sign}$${amount.toFixed(2)}`;
}

function formatUsdPrecise(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }

  const amount = Number(value);
  const sign = amount > 0 ? "+" : "";
  const decimals = Math.abs(amount) > 0 && Math.abs(amount) < 1 ? 4 : 2;
  return `${sign}$${amount.toFixed(decimals)}`;
}

function pnlClass(value) {
  if (value == null || Number(value) === 0) {
    return "flat";
  }

  return Number(value) > 0 ? "positive" : "negative";
}

function formatRange(lower, upper) {
  if (lower == null || upper == null) {
    return "-";
  }
  return `${lower} to ${upper}`;
}

function getBadgeClass(runState) {
  if (runState === "Paused") {
    return "paused";
  }
  if (runState === "Waiting to retry") {
    return "recovering";
  }
  if (runState === "Reconciling timeout") {
    return "recovering";
  }
  if (runState === "Triggered") {
    return "triggered";
  }
  if (runState === "Running") {
    return "running";
  }
  return "idle";
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function formatRecovery(bot) {
  const pending = bot.pendingRebalance;
  if (!pending) {
    return "-";
  }

  if (pending.nextRetryAt) {
    return `Waiting to retry ${pending.phase} at ${formatDateTime(pending.nextRetryAt)}`;
  }

  if (pending.recoveryReason) {
    return `${pending.phase} (${pending.recoveryReason})`;
  }

  return pending.phase ?? "-";
}

function renderWallet(wallet) {
  walletAddress.textContent = formatValue(wallet.walletAddress);
  enabledBots.textContent = formatValue(wallet.enabledBots);
  monitoringBots.textContent = formatValue(wallet.monitoringBots);
  allocationValue.textContent = `$${formatValue(wallet.totalAllocatedUsdc)}`;
  walletTokenA.textContent = formatValue(wallet.availableTokenA);
  walletTokenB.textContent = formatValue(wallet.availableTokenB);
  queueBadge.textContent = `Queue ${wallet.queueDepth}`;
  queueBadge.className = `badge ${wallet.queueDepth ? "triggered" : wallet.overAllocated ? "paused" : "idle"}`;
}

function formatUsdAbs(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return `$${Number(value).toFixed(2)}`;
}

function renderPnl(summary) {
  formulaPnlValue.textContent = formatUsdKpi(summary?.formulaPnlUsdc);
  formulaPnlValue.className = `kpi-value ${pnlClass(summary?.formulaPnlUsdc)}`;
  totalDepositValue.textContent = formatUsdAbs(summary?.totalDepositUsdc);
  totalWithdrawValue.textContent = formatUsdAbs(summary?.totalWithdrawUsdc);
  realizedPnlValue.textContent = formatUsdKpi(summary?.realizedNetPnlUsdc);
  realizedPnlValue.className = `kpi-value ${pnlClass(summary?.realizedNetPnlUsdc)}`;
  openPnlValue.textContent = formatUsdKpi(summary?.openNetPnlUsdc);
  openPnlValue.className = `kpi-value ${pnlClass(summary?.openNetPnlUsdc)}`;
  feesEarnedValue.textContent = formatUsdKpi(summary?.feesEarnedUsdc);
  feesEarnedValue.className = `kpi-value ${pnlClass(summary?.feesEarnedUsdc)}`;
  openPositionsValue.textContent = formatValue(summary?.openPositionCount);
  closedPositionsValue.textContent = formatValue(summary?.closedPositionCount);

  if (!summary?.orphanedPositionCount) {
    orphanWarning.hidden = true;
    orphanWarning.textContent = "";
    return;
  }

  orphanWarning.hidden = false;
  orphanWarning.textContent = `${summary.orphanedPositionCount} wallet position${summary.orphanedPositionCount === 1 ? "" : "s"} not mapped to the bot PnL ledger.`;
}

function renderTransactionFilter(bots) {
  const previous = transactionFilter.value;
  transactionFilter.innerHTML = `<option value="">All bots</option>${bots
    .map((bot) => `<option value="${escapeHtml(bot.id)}">${escapeHtml(bot.name)}</option>`)
    .join("")}`;
  transactionFilter.value = bots.some((bot) => bot.id === previous) ? previous : "";
}

function renderSelectOptions(select, values, allLabel) {
  const previous = select.value;
  select.innerHTML = `<option value="">${allLabel}</option>${values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("")}`;
  select.value = values.includes(previous) ? previous : "";
}

function botCardHtml(bot) {
  return `
    <article class="bot-card" data-bot-id="${escapeHtml(bot.id)}">
      <div class="bot-head">
        <div>
          <p class="eyebrow">${escapeHtml(bot.tokenPair)}</p>
          <h3>${escapeHtml(bot.name)}</h3>
        </div>
        <span class="badge ${getBadgeClass(bot.runState)}">${escapeHtml(bot.runState)}</span>
      </div>
      <dl class="bot-grid">
        <div><dt>Pool</dt><dd data-field="pool">${escapeHtml(formatValue(bot.whirlpoolAddress))}</dd></div>
        <div><dt>Allocation</dt><dd data-field="allocation">${escapeHtml(formatValue(bot.allocationUsdc))} USDC</dd></div>
        <div><dt>Observed</dt><dd data-field="observed">${escapeHtml(formatValue(bot.lastObservedPrice))}</dd></div>
        <div><dt>Anchor</dt><dd data-field="anchor">${escapeHtml(formatValue(bot.lastCenterPrice))}</dd></div>
        <div><dt>Trigger Window</dt><dd data-field="triggerWindow">${escapeHtml(formatRange(bot.driftTriggerLower, bot.driftTriggerUpper))}</dd></div>
        <div><dt>Trigger State</dt><dd data-field="triggerState">${escapeHtml(formatValue(bot.triggerState))}</dd></div>
        <div><dt>Position</dt><dd data-field="position">${escapeHtml(formatValue(bot.activePositionMint))}</dd></div>
        <div><dt>Last Action</dt><dd data-field="lastAction">${escapeHtml(formatValue(bot.latestAction))}</dd></div>
        <div><dt>Open PnL</dt><dd data-field="openPnl" class="${pnlClass(bot.pnl?.openNetPnlUsdc)}">${formatUsd(bot.pnl?.openNetPnlUsdc)}</dd></div>
        <div><dt>Realized PnL</dt><dd data-field="realizedPnl" class="${pnlClass(bot.pnl?.realizedNetPnlUsdc)}">${formatUsd(bot.pnl?.realizedNetPnlUsdc)}</dd></div>
        <div><dt>Total PnL</dt><dd data-field="totalPnl" class="${pnlClass(bot.pnl?.totalNetPnlUsdc)}">${formatUsd(bot.pnl?.totalNetPnlUsdc)}</dd></div>
        <div><dt>Fees Earned</dt><dd data-field="feesEarned" class="${pnlClass(bot.pnl?.feesEarnedUsdc)}">${formatUsd(bot.pnl?.feesEarnedUsdc)}</dd></div>
        <div><dt>Pause Reason</dt><dd data-field="pauseReason">${escapeHtml(formatValue(bot.pauseReason))}</dd></div>
        <div><dt>Recovery</dt><dd data-field="recovery">${escapeHtml(formatRecovery(bot))}</dd></div>
      </dl>
      <div class="card-actions">
        <button class="play" data-action="start">Start</button>
        <button class="stop" data-action="stop">Stop</button>
        <button class="rebalance" data-action="rebalance">Rebalance</button>
        <button class="secondary" data-action="compound">Compound</button>
        <button class="secondary" data-action="resume">Resume</button>
        <button class="secondary" data-action="archive">Archive</button>
      </div>
      <form class="edit-form" data-edit-form="${escapeHtml(bot.id)}">
        <label><span>Name</span><input name="name" value="${escapeHtml(bot.name)}" /></label>
        <label><span>Allocation</span><input name="allocationUsdc" type="number" min="1" step="0.01" value="${escapeHtml(bot.allocationUsdc)}" /></label>
        <label><span>Range %</span><input name="rangePct" type="number" min="0.01" step="0.01" value="${escapeHtml(bot.rangePct)}" /></label>
        <label><span>Drift %</span><input name="rebalanceDriftPct" type="number" min="0.01" step="0.01" value="${escapeHtml(bot.rebalanceDriftPct)}" /></label>
        <label><span>Poll Seconds</span><input name="pollSeconds" type="number" min="5" step="1" value="${escapeHtml(bot.pollSeconds)}" /></label>
        <label><span>Max Slippage</span><input name="maxSlippageBps" type="number" min="1" step="1" value="${escapeHtml(bot.maxSlippageBps)}" /></label>
        <label><span>Compound Interval (s)</span><input name="compoundIntervalSeconds" type="number" min="0" step="1" value="${escapeHtml(bot.compoundIntervalSeconds)}" /></label>
        <label><span>Compound Min Value</span><input name="compoundMinQuoteValue" type="number" min="0" step="0.01" value="${escapeHtml(bot.compoundMinQuoteValue)}" /></label>
        <div class="form-actions"><button class="secondary" type="submit">Save Changes</button></div>
      </form>
    </article>
  `;
}

function updateBotCard(card, bot) {
  const badge = card.querySelector(".badge");
  if (badge) {
    badge.textContent = bot.runState;
    badge.className = `badge ${getBadgeClass(bot.runState)}`;
  }

  const fields = {
    allocation: `${formatValue(bot.allocationUsdc)} USDC`,
    observed: formatValue(bot.lastObservedPrice),
    anchor: formatValue(bot.lastCenterPrice),
    triggerWindow: formatRange(bot.driftTriggerLower, bot.driftTriggerUpper),
    triggerState: formatValue(bot.triggerState),
    position: formatValue(bot.activePositionMint),
    lastAction: formatValue(bot.latestAction),
    openPnl: formatUsd(bot.pnl?.openNetPnlUsdc),
    realizedPnl: formatUsd(bot.pnl?.realizedNetPnlUsdc),
    totalPnl: formatUsd(bot.pnl?.totalNetPnlUsdc),
    feesEarned: formatUsd(bot.pnl?.feesEarnedUsdc),
    pauseReason: formatValue(bot.pauseReason),
    recovery: formatRecovery(bot)
  };

  for (const [field, value] of Object.entries(fields)) {
    const dd = card.querySelector(`dd[data-field="${field}"]`);
    if (dd) {
      dd.textContent = value;
      if (["openPnl", "realizedPnl", "totalPnl", "feesEarned"].includes(field)) {
        const pnlKey = { openPnl: "openNetPnlUsdc", realizedPnl: "realizedNetPnlUsdc", totalPnl: "totalNetPnlUsdc", feesEarned: "feesEarnedUsdc" }[field];
        dd.className = pnlClass(bot.pnl?.[pnlKey]);
      }
    }
  }
}

function renderBots(bots) {
  latestBots = bots;
  renderTransactionFilter(bots);

  if (!bots.length) {
    botsGrid.innerHTML = `<p class="empty-state">No bots yet.</p>`;
    previousBotIds = [];
    return;
  }

  const currentIds = bots.map((bot) => bot.id);
  const idsMatch = currentIds.length === previousBotIds.length && currentIds.every((id, i) => id === previousBotIds[i]);

  if (idsMatch) {
    for (const bot of bots) {
      const card = botsGrid.querySelector(`[data-bot-id="${CSS.escape(String(bot.id))}"]`);
      if (card) {
        updateBotCard(card, bot);
      }
    }
  } else {
    botsGrid.innerHTML = bots.map(botCardHtml).join("");
    previousBotIds = currentIds;
  }
}

function renderTransactions(events) {
  if (!events.length) {
    transactionsBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-row">No transaction events yet.</td>
      </tr>
    `;
    return;
  }

  transactionsBody.innerHTML = events
    .map((event) => {
      const txId = event.txId ? `<code title="${escapeHtml(event.txId)}">${escapeHtml(event.txId)}</code>` : "-";
      return `
        <tr>
          <td>${escapeHtml(formatValue(event.time))}</td>
          <td>${escapeHtml(formatValue(event.botName ?? event.botId))}</td>
          <td>${escapeHtml(formatValue(event.type))}</td>
          <td>${escapeHtml(formatValue(event.status))}</td>
          <td>${txId}</td>
          <td>${escapeHtml(formatValue(event.fees))}</td>
          <td>${escapeHtml(formatValue(event.summary))}</td>
        </tr>
      `;
    })
    .join("");
}

function formatDuration(openedAt) {
  if (!openedAt) return "-";
  const ms = Date.now() - new Date(openedAt).getTime();
  if (ms < 0) return "-";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 1) return `${minutes}m`;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function computeYieldPct(record) {
  if (!record.entryCapitalUsdc || record.entryCapitalUsdc <= 0) return null;
  return ((record.feesEarnedUsdc ?? 0) / record.entryCapitalUsdc) * 100;
}

function computeAnnualisedApr(record) {
  if (!record.openedAt || !record.entryCapitalUsdc || record.entryCapitalUsdc <= 0) return null;
  const ms = Date.now() - new Date(record.openedAt).getTime();
  if (ms <= 0) return null;
  const years = ms / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 0.0001) return null;
  return ((record.feesEarnedUsdc ?? 0) / record.entryCapitalUsdc / years) * 100;
}

function computePositionPnl(record) {
  if (!record || record.entryCapitalUsdc == null || record.latestGrossValueUsdc == null) {
    return null;
  }

  return record.latestGrossValueUsdc - record.entryCapitalUsdc;
}

function computePrincipalBalance(record) {
  if (!record || record.latestGrossValueUsdc == null) {
    return null;
  }

  return record.latestGrossValueUsdc - (record.feesEarnedUsdc ?? 0);
}

function rangeBarHtml(record) {
  const lower = record.entryLowerPrice;
  const upper = record.entryUpperPrice;
  const center = record.entryCenterPrice;
  if (lower == null || upper == null || center == null) return "";

  const bot = latestBots.find((b) => b.id === record.botId);
  const currentPrice = bot?.lastObservedPrice ?? center;
  const range = upper - lower;
  if (range <= 0) return "";

  const fillLeft = 0;
  const fillWidth = 100;
  const cursorPct = Math.max(0, Math.min(100, ((currentPrice - lower) / range) * 100));
  const inRange = currentPrice >= lower && currentPrice <= upper;
  const cursorColor = inRange ? "var(--play)" : "var(--stop)";

  return `
    <div class="lp-range-bar">
      <div class="range-track">
        <div class="range-fill" style="left:${fillLeft}%;width:${fillWidth}%"></div>
        <div class="range-cursor" style="left:${cursorPct}%;border-color:${cursorColor}"></div>
      </div>
      <div class="range-labels">
        <span>${lower.toFixed(4)}</span>
        <span>${currentPrice.toFixed(4)}</span>
        <span>${upper.toFixed(4)}</span>
      </div>
    </div>
  `;
}

function getLiveActivePositions(records) {
  const openRecordByMint = new Map(
    records.filter((record) => record.status === "open").map((record) => [record.positionMint, record])
  );

  return latestBots
    .filter((bot) => bot.activePositionMint)
    .map((bot) => {
      const ledgerRecord = openRecordByMint.get(bot.activePositionMint);
      return {
        bot,
        ledgerRecord
      };
    });
}

function renderActiveLpPositions(records) {
  const activePositions = getLiveActivePositions(records);

  if (!activePositions.length) {
    activeLpGrid.innerHTML = `<p class="empty-state">No active LP positions.</p>`;
    return;
  }

  activeLpGrid.innerHTML = activePositions
    .map(({ bot, ledgerRecord }) => {
      const currentPrice = bot?.lastObservedPrice;
      const lowerPrice = ledgerRecord?.entryLowerPrice ?? bot.positionLowerPrice;
      const upperPrice = ledgerRecord?.entryUpperPrice ?? bot.positionUpperPrice;
      const inRange =
        currentPrice != null &&
        lowerPrice != null &&
        upperPrice != null &&
        currentPrice >= lowerPrice &&
        currentPrice <= upperPrice;
      const badgeText =
        currentPrice == null || lowerPrice == null || upperPrice == null
          ? "Live Position"
          : inRange
            ? "In Range"
            : "Out of Range";
      const badgeClass =
        currentPrice == null || lowerPrice == null || upperPrice == null
          ? "badge recovering"
          : inRange
            ? "badge running"
            : "badge paused";
      const yieldPct = ledgerRecord ? computeYieldPct(ledgerRecord) : null;
      const apr = ledgerRecord ? computeAnnualisedApr(ledgerRecord) : null;
      const positionPnl = ledgerRecord ? computePositionPnl(ledgerRecord) : null;
      const principalBalance = ledgerRecord ? computePrincipalBalance(ledgerRecord) : null;
      const totalCosts = ledgerRecord
        ? (ledgerRecord.cumulativeSwapFeesUsdc ?? 0) + (ledgerRecord.cumulativeTxFeesUsdc ?? 0)
        : null;
      const netYieldPct =
        ledgerRecord && ledgerRecord.entryCapitalUsdc > 0 && totalCosts != null
          ? (((ledgerRecord.feesEarnedUsdc ?? 0) - totalCosts) / ledgerRecord.entryCapitalUsdc) * 100
          : null;

      return `
        <article class="lp-card" data-bot-id="${escapeHtml(bot.id)}">
          <div class="lp-head">
            <div>
              <p class="eyebrow">${escapeHtml(bot.tokenPair)}</p>
              <h3>${escapeHtml(bot.name)}</h3>
            </div>
            <span class="${badgeClass}">${badgeText}</span>
          </div>
          <dl class="lp-yield-row">
            <div>
              <dt>Pending Yield</dt>
              <dd class="${pnlClass(ledgerRecord?.feesEarnedUsdc)}">${formatUsdPrecise(ledgerRecord?.feesEarnedUsdc)}</dd>
            </div>
            <div>
              <dt>Yield</dt>
              <dd class="${pnlClass(yieldPct)}">${yieldPct != null ? yieldPct.toFixed(3) + "%" : "-"}</dd>
            </div>
            <div>
              <dt>Est. APR</dt>
              <dd class="${pnlClass(apr)}">${apr != null ? apr.toFixed(1) + "%" : "-"}</dd>
            </div>
          </dl>
          ${ledgerRecord ? rangeBarHtml(ledgerRecord) : ""}
          <dl class="lp-details">
            <div>
              <dt>Position</dt>
              <dd><code title="${escapeHtml(bot.activePositionMint)}">${escapeHtml(bot.activePositionMint)}</code></dd>
            </div>
            <div>
              <dt>Entry Capital</dt>
              <dd>${formatUsd(ledgerRecord?.entryCapitalUsdc)}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd>${formatUsd(principalBalance)}</dd>
            </div>
            <div>
              <dt>Total PnL</dt>
              <dd class="${pnlClass(positionPnl)}">${formatUsdPrecise(positionPnl)}</dd>
            </div>
            <div>
              <dt>Bot Net PnL</dt>
              <dd class="${pnlClass(ledgerRecord?.latestNetPnlUsdc)}">${formatUsdPrecise(ledgerRecord?.latestNetPnlUsdc)}</dd>
            </div>
            <div>
              <dt>Swap Costs</dt>
              <dd class="negative">${formatUsd(ledgerRecord?.cumulativeSwapFeesUsdc)}</dd>
            </div>
            <div>
              <dt>Tx Costs</dt>
              <dd class="negative">${formatUsd(ledgerRecord?.cumulativeTxFeesUsdc)}</dd>
            </div>
            <div>
              <dt>Net Yield</dt>
              <dd class="${pnlClass(netYieldPct)}">${netYieldPct != null ? netYieldPct.toFixed(3) + "%" : "-"}</dd>
            </div>
            <div>
              <dt>Compounded</dt>
              <dd>${formatUsd(ledgerRecord?.cumulativeCompoundedFeesUsdc)} (${ledgerRecord?.compoundCount ?? 0}x)</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>${formatDuration(ledgerRecord?.openedAt)}</dd>
            </div>
            <div>
              <dt>Center Price</dt>
              <dd>${ledgerRecord?.entryCenterPrice?.toFixed(4) ?? bot.lastCenterPrice?.toFixed(4) ?? "-"}</dd>
            </div>
            <div>
              <dt>Current Price</dt>
              <dd>${bot?.lastObservedPrice?.toFixed(4) ?? "-"}</dd>
            </div>
            <div>
              <dt>Range Low</dt>
              <dd>${lowerPrice?.toFixed(4) ?? "-"}</dd>
            </div>
            <div>
              <dt>Range High</dt>
              <dd>${upperPrice?.toFixed(4) ?? "-"}</dd>
            </div>
            <div>
              <dt>Entry Token A</dt>
              <dd>${escapeHtml(ledgerRecord?.entryTokenA ?? "-")}</dd>
            </div>
            <div>
              <dt>Entry Token B</dt>
              <dd>${escapeHtml(ledgerRecord?.entryTokenB ?? "-")}</dd>
            </div>
            ${ledgerRecord ? "" : `
            <div>
              <dt>Ledger Status</dt>
              <dd>Awaiting open-position sync</dd>
            </div>`}
          </dl>
          <div class="card-actions">
            <button class="secondary" data-action="compound">Compound</button>
            <button class="stop" data-action="close-position">Close Position</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderPnlPositions(records) {
  latestPnlPositions = records;

  if (!records.length) {
    pnlPositionsBody.innerHTML = `
      <tr>
        <td colspan="10" class="empty-row">No tracked positions yet.</td>
      </tr>
    `;
    return;
  }

  pnlPositionsBody.innerHTML = records
    .map((record) => `
      <tr>
        <td>${escapeHtml(formatValue(record.botName))}</td>
        <td>${escapeHtml(formatValue(record.tokenPair))}</td>
        <td>${escapeHtml(formatValue(record.status))}</td>
        <td><code title="${escapeHtml(record.positionMint)}">${escapeHtml(record.positionMint)}</code></td>
        <td>${escapeHtml(formatValue(record.openedAt))}</td>
        <td>${escapeHtml(formatValue(record.closedAt))}</td>
        <td>${formatUsd(record.entryCapitalUsdc)}</td>
        <td>${formatUsd(record.status === "open" ? record.latestGrossValueUsdc : record.exitGrossValueUsdc)}</td>
        <td class="${pnlClass(record.status === "open" ? record.latestNetPnlUsdc : record.realizedNetPnlUsdc)}">${formatUsd(record.status === "open" ? record.latestNetPnlUsdc : record.realizedNetPnlUsdc)}</td>
        <td>${formatUsd(record.feesEarnedUsdc)} / ${formatUsd((record.cumulativeSwapFeesUsdc ?? 0) + (record.cumulativeTxFeesUsdc ?? 0))}</td>
      </tr>
    `)
    .join("");
}

function applyTransactionFilters() {
  const botId = transactionFilter.value;
  const type = typeFilter.value;
  const status = statusFilter.value;
  const query = searchFilter.value.trim().toLowerCase();

  return latestTransactions.filter((event) => {
    if (botId && event.botId !== botId) {
      return false;
    }

    if (type && event.type !== type) {
      return false;
    }

    if (status && event.status !== status) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      event.botName,
      event.botId,
      event.type,
      event.status,
      event.txId,
      event.summary
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

async function refreshPnlPositions() {
  const payload = await request("/api/pnl");
  const positions = payload.positions ?? [];
  renderActiveLpPositions(positions);
  renderPnlPositions(positions);
}

async function refreshTransactions() {
  const payload = await request("/api/transactions");
  latestTransactions = payload.events ?? [];
  renderSelectOptions(typeFilter, [...new Set(latestTransactions.map((event) => event.type).filter(Boolean))], "All types");
  renderSelectOptions(statusFilter, [...new Set(latestTransactions.map((event) => event.status).filter(Boolean))], "All statuses");
  renderTransactions(applyTransactionFilters());
}

async function refreshStatus() {
  const payload = await request("/api/status");
  if (signOutLink) {
    signOutLink.hidden = !payload.panel?.authEnabled;
  }
  renderWallet(payload.wallet);
  renderPnl(payload.pnl);
  renderBots(payload.bots ?? []);
  await Promise.all([refreshPnlPositions(), refreshTransactions()]);
}

// Pre-fill the create form from the server's config defaults (src/config.ts is the single source of truth).
// Setting defaultValue (not value) means createBotForm.reset() restores these defaults too.
async function loadBotDefaults() {
  const payload = await request("/api/bot-defaults");
  const defaults = payload?.defaults ?? {};
  for (const [name, value] of Object.entries(defaults)) {
    const input = createBotForm.elements.namedItem(name);
    if (!(input instanceof HTMLInputElement)) {
      continue;
    }
    // An allocation of 0 means "no cap" for the CLI; a panel bot needs an explicit amount.
    if (name === "allocationUsdc" && !(Number(value) > 0)) {
      continue;
    }
    input.defaultValue = String(value);
  }
}

createBotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(createBotForm);
  const stringFields = new Set(["name", "whirlpoolAddress"]);
  const payload = {};
  for (const [key, value] of formData.entries()) {
    const text = String(value).trim();
    if (stringFields.has(key)) {
      payload[key] = text;
    } else if (text !== "") {
      // Blank numeric fields are omitted so the server applies its config default.
      payload[key] = Number(text);
    }
  }

  try {
    await request("/api/bots", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    createBotForm.reset();
    await refreshStatus();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
});

botsGrid.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  if (!action) {
    return;
  }

  const card = target.closest("[data-bot-id]");
  if (!card) {
    return;
  }

  const botId = card.getAttribute("data-bot-id");
  if (!botId) {
    return;
  }

  try {
    if (action === "archive") {
      await request(`/api/bots/${encodeURIComponent(botId)}`, { method: "DELETE" });
    } else if (action === "rebalance") {
      await request(`/api/bots/${encodeURIComponent(botId)}/rebalance`, { method: "POST" });
    } else if (action === "compound") {
      await request(`/api/bots/${encodeURIComponent(botId)}/compound`, { method: "POST" });
    } else {
      await request(`/api/bots/${encodeURIComponent(botId)}/${action}`, { method: "POST" });
    }
    await refreshStatus();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
});

botsGrid.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  event.preventDefault();
  const botId = form.getAttribute("data-edit-form");
  if (!botId) {
    return;
  }

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  for (const key of Object.keys(payload)) {
    if (key !== "name") {
      payload[key] = Number(payload[key]);
    }
  }

  try {
    await request(`/api/bots/${encodeURIComponent(botId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    await refreshStatus();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
});

activeLpGrid.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  if (!action) {
    return;
  }

  const card = target.closest("[data-bot-id]");
  if (!card) {
    return;
  }

  const botId = card.getAttribute("data-bot-id");
  if (!botId) {
    return;
  }

  if (action === "compound") {
    target.disabled = true;
    target.textContent = "Compounding...";

    try {
      await request(`/api/bots/${encodeURIComponent(botId)}/compound`, { method: "POST" });
      await refreshStatus();
    } catch (error) {
      console.error(error);
      alert(error.message);
    } finally {
      target.disabled = false;
      target.textContent = "Compound";
    }
    return;
  }

  if (action === "close-position") {
    if (!confirm("Close this LP position? Tokens will be returned to the wallet.")) {
      return;
    }

    target.disabled = true;
    target.textContent = "Closing...";

    try {
      const result = await request(`/api/bots/${encodeURIComponent(botId)}/close-position`, { method: "POST" });
      alert(`Position closed. Tx: ${result?.txId ?? "unknown"}`);
      await refreshStatus();
    } catch (error) {
      console.error(error);
      alert(error.message);
    } finally {
      target.disabled = false;
      target.textContent = "Close Position";
    }
  }
});

transactionFilter.addEventListener("change", () => renderTransactions(applyTransactionFilters()));
typeFilter.addEventListener("change", () => renderTransactions(applyTransactionFilters()));
statusFilter.addEventListener("change", () => renderTransactions(applyTransactionFilters()));

let searchTimeout;
searchFilter.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => renderTransactions(applyTransactionFilters()), 300);
});

loadBotDefaults().catch((error) => console.error(error));
refreshStatus().catch((error) => {
  console.error(error);
});

setInterval(() => {
  refreshStatus().catch((error) => console.error(error));
}, 15000);
