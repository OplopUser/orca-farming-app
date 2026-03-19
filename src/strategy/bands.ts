import type { DriftDirection } from "../domain.js";

export interface PriceBand {
  lower: number;
  upper: number;
}

export interface DriftEvaluation {
  direction: DriftDirection | null;
  lowerTrigger: number;
  upperTrigger: number;
  shouldRebalance: boolean;
}

export function computeBand(centerPrice: number, rangePct: number): PriceBand {
  const factor = 1 + rangePct / 100;
  return {
    lower: centerPrice / factor,
    upper: centerPrice * factor
  };
}

export function evaluateDriftTrigger(
  anchorPrice: number,
  currentPrice: number,
  driftPct: number
): DriftEvaluation {
  const factor = 1 + driftPct / 100;
  const lowerTrigger = anchorPrice / factor;
  const upperTrigger = anchorPrice * factor;

  if (currentPrice < lowerTrigger) {
    return { direction: "below", lowerTrigger, upperTrigger, shouldRebalance: true };
  }

  if (currentPrice > upperTrigger) {
    return { direction: "above", lowerTrigger, upperTrigger, shouldRebalance: true };
  }

  return { direction: null, lowerTrigger, upperTrigger, shouldRebalance: false };
}

export function computeTargetValueWeights(lowerPrice: number, currentPrice: number, upperPrice: number) {
  const sqrtLower = Math.sqrt(lowerPrice);
  const sqrtCurrent = Math.sqrt(currentPrice);
  const sqrtUpper = Math.sqrt(upperPrice);

  const amountA = (sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper);
  const amountB = sqrtCurrent - sqrtLower;
  const valueA = amountA * currentPrice;
  const valueB = amountB;
  const total = valueA + valueB;

  return {
    tokenA: valueA / total,
    tokenB: valueB / total
  };
}

export function toBaseUnits(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}
