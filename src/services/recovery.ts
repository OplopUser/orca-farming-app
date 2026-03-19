import type { PendingRebalance } from "../domain.js";

function isRecoverableRpcSendFailure(pauseReason: string | null) {
  if (!pauseReason) {
    return false;
  }

  return (
    pauseReason.includes("Transaction confirmation timeout") ||
    pauseReason.includes("HTTP error (429)") ||
    pauseReason.includes("Too Many Requests") ||
    pauseReason.includes("Connection not initialized. Call setRpc() first")
  );
}

export function classifyCloseTimeout(previousPositionMint: string | null, livePositionMint: string | null) {
  if (!previousPositionMint) {
    return "continue" as const;
  }

  return livePositionMint && livePositionMint === previousPositionMint ? "retry" as const : "continue" as const;
}

export function classifySwapTimeout(needsSwap: boolean) {
  return needsSwap ? "retry" as const : "continue" as const;
}

export function classifyOpenTimeout(args: {
  livePositionMint: string | null;
  previousPositionMint: string | null;
  plannedPositionMint: string | null;
}) {
  const { livePositionMint, previousPositionMint, plannedPositionMint } = args;

  if (!livePositionMint) {
    return "retry" as const;
  }

  if (plannedPositionMint && livePositionMint === plannedPositionMint) {
    return "complete" as const;
  }

  if (!previousPositionMint) {
    return "complete" as const;
  }

  return livePositionMint !== previousPositionMint ? "complete" as const : "retry" as const;
}

export function shouldRecoverPausedTimeout(pauseReason: string | null, pendingRebalance: PendingRebalance | null) {
  if (
    pendingRebalance?.recoveryReason?.startsWith("Ambiguous") &&
    !(
      pendingRebalance.phase === "opening" &&
      pauseReason?.includes("Ambiguous opening state after timeout") &&
      !pauseReason.includes("Multiple unclaimed positions")
    )
  ) {
    return false;
  }

  return isRecoverableRpcSendFailure(pauseReason);
}
