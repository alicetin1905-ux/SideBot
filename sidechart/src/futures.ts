import { liquidationPrice } from './backtest';

/** Position-size / risk calculator for a perpetual futures trade. */
export interface PositionInput {
  balance: number;
  /** % of the balance you are willing to lose if the stop is hit */
  riskPct: number;
  entry: number;
  stop: number;
  /** 0 = none */
  target: number;
  leverage: number;
  takerFeePct: number;
  maintMarginPct: number;
}

export interface PositionPlan {
  side: 'long' | 'short';
  qty: number;
  notional: number;
  margin: number;
  riskUsd: number;
  liqPrice: number;
  rewardUsd: number;
  rr: number;
  stopDistPct: number;
  feesUsd: number;
  warnings: string[];
}

export function planPosition(p: PositionInput): PositionPlan | null {
  if (!(p.entry > 0) || !(p.stop > 0) || p.entry === p.stop || !(p.balance > 0) || !(p.leverage >= 1)) return null;
  const side = p.stop < p.entry ? 'long' : 'short';
  const dist = Math.abs(p.entry - p.stop);
  const fee = p.takerFeePct / 100;
  const riskUsd = (p.balance * p.riskPct) / 100;
  // Loss at the stop = qty·dist + fees on entry and exit
  const qty = riskUsd / (dist + fee * (p.entry + p.stop));
  const notional = qty * p.entry;
  const margin = notional / p.leverage;
  const liqPrice = liquidationPrice(side, p.entry, p.leverage, p.maintMarginPct);
  const hasTarget = p.target > 0 && (side === 'long' ? p.target > p.entry : p.target < p.entry);
  const rewardUsd = hasTarget ? qty * Math.abs(p.target - p.entry) - fee * qty * (p.entry + p.target) : 0;
  const warnings: string[] = [];
  if (side === 'long' ? liqPrice >= p.stop : liqPrice <= p.stop) {
    warnings.push('Je liquidatieprijs ligt vóór je stop loss: verlaag de leverage.');
  }
  if (margin > p.balance) warnings.push('Benodigde marge is groter dan je saldo: verhoog de leverage of verklein het risico.');
  if (p.riskPct > 3) warnings.push('Meer dan 2–3% risico per trade is erg agressief.');
  if (p.target > 0 && !hasTarget) warnings.push('Je take profit ligt aan de verkeerde kant van je entry.');
  return {
    side,
    qty,
    notional,
    margin,
    riskUsd,
    liqPrice,
    rewardUsd,
    rr: hasTarget ? rewardUsd / riskUsd : 0,
    stopDistPct: (dist / p.entry) * 100,
    feesUsd: fee * qty * (p.entry + (hasTarget ? p.target : p.stop)),
    warnings,
  };
}
