import type { Candle } from './types';
import type { Signals } from './strategies';

export interface BacktestSettings {
  initialCapital: number;
  /** Position size as % of current equity */
  positionPct: number;
  /** Commission per side, in % */
  commissionPct: number;
  /** Slippage per side, in % */
  slippagePct: number;
  direction: 'long' | 'short' | 'both';
  /** 0 = off */
  stopLossPct: number;
  /** 0 = off */
  takeProfitPct: number;
  /** 0 = off. Trailing stop distance in % from the best price since entry. */
  trailingPct: number;
  /** Fill at the next bar's open (realistic) or at the signal bar's close. */
  fillOn: 'nextOpen' | 'close';
}

export const DEFAULT_SETTINGS: BacktestSettings = {
  initialCapital: 10000,
  positionPct: 100,
  commissionPct: 0.1,
  slippagePct: 0.02,
  direction: 'long',
  stopLossPct: 0,
  takeProfitPct: 0,
  trailingPct: 0,
  fillOn: 'nextOpen',
};

export interface Trade {
  side: 'long' | 'short';
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  exitIndex: number;
  exitTime: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  bars: number;
  exitReason: string;
  /** Biggest unrealised gain/loss during the trade, % of entry */
  runUpPct: number;
  drawdownPct: number;
}

export interface Metrics {
  netProfit: number;
  netProfitPct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  avgTrade: number;
  avgTradePct: number;
  avgWin: number;
  avgLoss: number;
  ratioWinLoss: number;
  largestWin: number;
  largestLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  buyHoldPct: number;
  sharpe: number;
  sortino: number;
  cagrPct: number;
  exposurePct: number;
  avgBars: number;
  totalFees: number;
  maxConsecLosses: number;
}

export interface BacktestResult {
  trades: Trade[];
  /** Equity at each bar close (mark-to-market) */
  equity: number[];
  drawdown: number[];
  metrics: Metrics;
}

interface Position {
  side: 'long' | 'short';
  entryIndex: number;
  entryPrice: number;
  qty: number;
  entryFee: number;
  best: number;
  worst: number;
}

export function runBacktest(c: Candle[], sig: Signals, s: BacktestSettings): BacktestResult {
  const n = c.length;
  const trades: Trade[] = [];
  const equity = new Array<number>(n).fill(s.initialCapital);
  let cash = s.initialCapital;
  let pos: Position | null = null;
  let barsInMarket = 0;
  const allowLong = s.direction !== 'short';
  const allowShort = s.direction !== 'long';
  const comm = s.commissionPct / 100;
  const slip = s.slippagePct / 100;

  // Orders decided on bar i are executed on bar i+1 (nextOpen) or immediately at close.
  type Order = { action: 'open' | 'close'; side: 'long' | 'short'; reason: string };
  let pending: Order[] = [];

  const open = (side: 'long' | 'short', i: number, rawPrice: number) => {
    const price = side === 'long' ? rawPrice * (1 + slip) : rawPrice * (1 - slip);
    const budget = (cash * s.positionPct) / 100;
    if (budget <= 0) return;
    const qty = budget / (price * (1 + comm));
    const fee = qty * price * comm;
    if (side === 'long') cash -= qty * price + fee;
    else cash += qty * price - fee; // short sale proceeds
    pos = { side, entryIndex: i, entryPrice: price, qty, entryFee: fee, best: price, worst: price };
  };

  const close = (i: number, rawPrice: number, reason: string) => {
    if (!pos) return;
    const p: Position = pos;
    const price = p.side === 'long' ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
    const fee = p.qty * price * comm;
    if (p.side === 'long') cash += p.qty * price - fee;
    else cash -= p.qty * price + fee;
    const gross = p.side === 'long' ? (price - p.entryPrice) * p.qty : (p.entryPrice - price) * p.qty;
    const pnl = gross - fee - p.entryFee;
    const cost = p.entryPrice * p.qty;
    const fav = p.side === 'long' ? p.best : p.worst;
    const adv = p.side === 'long' ? p.worst : p.best;
    trades.push({
      side: p.side,
      entryIndex: p.entryIndex,
      entryTime: c[p.entryIndex].time,
      entryPrice: p.entryPrice,
      exitIndex: i,
      exitTime: c[i].time,
      exitPrice: price,
      qty: p.qty,
      pnl,
      pnlPct: (pnl / cost) * 100,
      fees: fee + p.entryFee,
      bars: i - p.entryIndex,
      exitReason: reason,
      runUpPct: (Math.abs(fav - p.entryPrice) / p.entryPrice) * 100,
      drawdownPct: (-Math.abs(adv - p.entryPrice) / p.entryPrice) * 100,
    });
    pos = null;
  };

  const execute = (orders: Order[], i: number, price: number) => {
    for (const o of orders) {
      const cur = pos as Position | null;
      if (o.action === 'close' && cur && cur.side === o.side) close(i, price, o.reason);
      if (o.action === 'open' && !pos) open(o.side, i, price);
    }
  };

  for (let i = 0; i < n; i++) {
    const bar = c[i];

    // 1) Fill orders decided on the previous bar at this bar's open.
    if (pending.length) {
      execute(pending, i, bar.open);
      pending = [];
    }

    // 2) Intrabar stop loss / take profit / trailing stop (checked from the bar after entry
    //    when filling at close, from the entry bar itself when filling at open).
    const cur = pos as Position | null;
    if (cur && (s.fillOn === 'nextOpen' || cur.entryIndex < i)) {
      const long = cur.side === 'long';
      const e = cur.entryPrice;
      let stop = s.stopLossPct > 0 ? (long ? e * (1 - s.stopLossPct / 100) : e * (1 + s.stopLossPct / 100)) : NaN;
      if (s.trailingPct > 0) {
        const trail = long ? cur.best * (1 - s.trailingPct / 100) : cur.worst * (1 + s.trailingPct / 100);
        stop = Number.isNaN(stop) ? trail : long ? Math.max(stop, trail) : Math.min(stop, trail);
      }
      const target = s.takeProfitPct > 0 ? (long ? e * (1 + s.takeProfitPct / 100) : e * (1 - s.takeProfitPct / 100)) : NaN;
      const stopHit = !Number.isNaN(stop) && (long ? bar.low <= stop : bar.high >= stop);
      const targetHit = !Number.isNaN(target) && (long ? bar.high >= target : bar.low <= target);
      // If both are hit inside one bar we can't know the order: assume the stop (conservative).
      if (stopHit) {
        const gapped = long ? bar.open < stop : bar.open > stop;
        close(i, gapped ? bar.open : stop, s.trailingPct > 0 && s.stopLossPct === 0 ? 'Trailing stop' : 'Stop loss');
      } else if (targetHit) {
        const gapped = long ? bar.open > target : bar.open < target;
        close(i, gapped ? bar.open : target, 'Take profit');
      }
    }

    // Track best/worst price for trailing stop and run-up statistics.
    const held = pos as Position | null;
    if (held) {
      held.best = Math.max(held.best, bar.high);
      held.worst = Math.min(held.worst, bar.low);
    }

    // 3) Evaluate signals at the bar close.
    const orders: Order[] = [];
    const now = pos as Position | null;
    if (now?.side === 'long' && (sig.exitLong[i] || (allowShort && sig.entryShort[i]))) {
      orders.push({ action: 'close', side: 'long', reason: sig.exitLong[i] ? 'Exit signaal' : 'Omkeren' });
    }
    if (now?.side === 'short' && (sig.exitShort[i] || (allowLong && sig.entryLong[i]))) {
      orders.push({ action: 'close', side: 'short', reason: sig.exitShort[i] ? 'Exit signaal' : 'Omkeren' });
    }
    const flatAfter = !now || orders.length > 0;
    if (flatAfter) {
      if (allowLong && sig.entryLong[i] && now?.side !== 'long') orders.push({ action: 'open', side: 'long', reason: '' });
      else if (allowShort && sig.entryShort[i] && now?.side !== 'short') orders.push({ action: 'open', side: 'short', reason: '' });
    }
    if (orders.length) {
      if (s.fillOn === 'close') execute(orders, i, bar.close);
      else if (i < n - 1) pending = orders;
    }

    // 4) Mark to market.
    const m = pos as Position | null;
    if (m) {
      barsInMarket++;
      equity[i] = m.side === 'long' ? cash + m.qty * bar.close : cash - m.qty * bar.close;
    } else {
      equity[i] = cash;
    }
  }

  // Close any open position at the last close so its result is included.
  if (pos && n) {
    close(n - 1, c[n - 1].close, 'Einde data');
    equity[n - 1] = cash;
  }

  const drawdown = new Array<number>(n).fill(0);
  let peak = s.initialCapital;
  let maxDd = 0;
  let maxDdPct = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, equity[i]);
    const dd = peak - equity[i];
    drawdown[i] = peak ? (-dd / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    if (peak && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }

  return { trades, equity, drawdown, metrics: computeMetrics(c, trades, equity, s, maxDd, maxDdPct * 100, barsInMarket) };
}

function computeMetrics(
  c: Candle[],
  trades: Trade[],
  equity: number[],
  s: BacktestSettings,
  maxDd: number,
  maxDdPct: number,
  barsInMarket: number,
): Metrics {
  const n = c.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const final = equity[n - 1] ?? s.initialCapital;
  const netProfit = final - s.initialCapital;

  // Per-bar returns for Sharpe/Sortino, annualised using the average bar length.
  const rets: number[] = [];
  for (let i = 1; i < n; i++) if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1));
  const downside = Math.sqrt(rets.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / (rets.length || 1));
  const spanSec = n > 1 ? c[n - 1].time - c[0].time : 0;
  const barSec = n > 1 ? spanSec / (n - 1) : 86400;
  const barsPerYear = (365 * 86400) / barSec;
  const years = spanSec / (365 * 86400);

  let consec = 0;
  let maxConsec = 0;
  for (const t of trades) {
    consec = t.pnl <= 0 ? consec + 1 : 0;
    maxConsec = Math.max(maxConsec, consec);
  }

  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  return {
    netProfit,
    netProfitPct: (netProfit / s.initialCapital) * 100,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
    totalTrades: trades.length,
    winners: wins.length,
    losers: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    avgTrade: trades.length ? netProfit / trades.length : 0,
    avgTradePct: trades.length ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length : 0,
    avgWin,
    avgLoss,
    ratioWinLoss: avgLoss ? avgWin / -avgLoss : 0,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    buyHoldPct: n ? ((c[n - 1].close - c[0].open) / c[0].open) * 100 : 0,
    sharpe: sd ? (mean / sd) * Math.sqrt(barsPerYear) : 0,
    sortino: downside ? (mean / downside) * Math.sqrt(barsPerYear) : 0,
    cagrPct: years > 0 && final > 0 ? ((final / s.initialCapital) ** (1 / years) - 1) * 100 : 0,
    exposurePct: n ? (barsInMarket / n) * 100 : 0,
    avgBars: trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : 0,
    totalFees: trades.reduce((a, t) => a + t.fees, 0),
    maxConsecLosses: maxConsec,
  };
}

export interface OptimizeRow {
  values: Record<string, number>;
  metrics: Metrics;
}

/** Grid search over up to two numeric parameters. */
export function optimize(
  c: Candle[],
  makeSignals: (values: Record<string, number>) => Signals,
  ranges: { key: string; from: number; to: number; step: number }[],
  s: BacktestSettings,
  maxRuns = 2500,
): OptimizeRow[] {
  const axes = ranges.map((r) => {
    const vals: number[] = [];
    if (r.step <= 0) return [r.from];
    for (let v = r.from; v <= r.to + 1e-9 && vals.length < 500; v += r.step) vals.push(+v.toFixed(6));
    return vals;
  });
  const combos: Record<string, number>[] = [{}];
  ranges.forEach((r, k) => {
    const next: Record<string, number>[] = [];
    for (const base of combos) for (const v of axes[k]) next.push({ ...base, [r.key]: v });
    combos.splice(0, combos.length, ...next);
  });
  return combos.slice(0, maxRuns).map((values) => ({
    values,
    metrics: runBacktest(c, makeSignals(values), s).metrics,
  }));
}
