import { isRecoverableRpcError, isRecoverableRpcStatus } from "./rpcFailover.js";

export interface TransactionSummary {
  signature: string;
  slot: number | null;
  feeLamports: number | null;
  computeUnitsConsumed: number | null;
  confirmationStatus: string | null;
  error: unknown;
}

interface RpcResponse<T> {
  result?: T;
  error?: { message: string };
}

interface TransactionMetaResponse {
  slot?: number;
  meta?: {
    fee?: number;
    err?: unknown;
    computeUnitsConsumed?: number;
  } | null;
  confirmationStatus?: string | null;
}

export class TransactionInspector {
  private readonly rpcUrls: string[];
  private currentRpcIndex = 0;

  constructor(rpcUrls: string | string[]) {
    this.rpcUrls = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls];
  }

  async inspect(signature: string): Promise<TransactionSummary | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.rpcUrls.length; attempt += 1) {
      const rpcUrl = this.rpcUrls[this.currentRpcIndex];

      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [
              signature,
              {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0
              }
            ]
          })
        });

        if (!response.ok) {
          const error = new Error(`RPC request getTransaction failed with status ${response.status}`);
          if (isRecoverableRpcStatus(response.status) && attempt < this.rpcUrls.length - 1) {
            lastError = error;
            this.advanceRpcUrl();
            continue;
          }
          throw error;
        }

        const body = (await response.json()) as RpcResponse<TransactionMetaResponse | null>;
        if (body.error) {
          throw new Error(`RPC request getTransaction failed: ${body.error.message}`);
        }

        if (!("result" in body)) {
          throw new Error("RPC request getTransaction returned an empty result");
        }

        if (!body.result) {
          return null;
        }

        return {
          signature,
          slot: body.result.slot ?? null,
          feeLamports: body.result.meta?.fee ?? null,
          computeUnitsConsumed: body.result.meta?.computeUnitsConsumed ?? null,
          confirmationStatus: body.result.confirmationStatus ?? null,
          error: body.result.meta?.err ?? null
        };
      } catch (error) {
        if (isRecoverableRpcError(error) && attempt < this.rpcUrls.length - 1) {
          lastError = error as Error;
          this.advanceRpcUrl();
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new Error("RPC request getTransaction failed");
  }

  private advanceRpcUrl() {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
  }
}
