import type { Candle } from './types';
import type { Signals } from './strategies';
import type { Point } from './exchanges/types';

/**
 * Perpetual-futures backtester: isolated margin, leverage, liquidations,
 * taker fees, slippage and funding payments.
 */
export interface BacktestSettings {
  /** Wallet balance in USDT */
  initialCapital: number;
  /** Margin per trade as % of the current wallet balance */
  marginPct: number;
  leverage: number;
  /** Taker fee per side, % of notional */
  takerFeePct: number;
  /** Slippage per side, in % */
  slippagePct: number;
  direction: 'long' | 'short' | 'both';
  /** Price move in % (0 = off) */
  stopLossPct: number;
  takeProfitPct: number;
  trailingPct: number;
  fillOn: 'nextOpen' | 'close';
  /** Maintenance margin rate in % (used for the liquidation price) */
  maintMarginPct: number;
  /** history = real funding rates (fixed rate where no history), fixed = always fixedFundingPct, off = none */
  funding: 'history' | 'fixed' | 'off';
  fixedFundingPct: number;
  fundingIntervalH: number;
}

export const DEFAULT_SETTINGS: BacktestSettings = {
  initialCapital: 1000,
  marginPct: 10,
  leverage: 10,
  takerFeePct: 0.05,
  slippagePct: 0.02,
  direction: 'both',
  stopLossPct: 0,
  takeProfitPct: 0,
  trailingPct: 0,
  fillOn: 'nextOpen',
  maintMarginPct: 0.5,
  funding: 'history',
  fixedFundingPct: 0.01,
  fundingIntervalH: 8,
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
  margin: number;
  leverage: number;
  liqPrice: number;
  /** Net result after fees and funding */
  pnl: number;
  /** Return on margin (ROE) in % */
  pnlPct: number;
  /** Underlying price move in % (in the trade's favour) */
  movePct: number;
  fees: number;
  /** Funding paid (negative = received) */
  funding: number;
  bars: number;
  exitReason: string;
  liquidated: boolean;
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
  /** Average ROE per trade */
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
  fundingPaid: number;
  liquidations: number;
  maxConsecLosses: number;
  /** true when the account dropped below what is needed to open a trade */
  blownUp: boolean;
}

export interface BacktestResult {
  trades: Trade[];
  equity: number[];
  drawdown: number[];
  metrics: Metrics;
}

interface Position {
  side: 'long' | 'short';
  dir: 1 | -1;
  entryIndex: number;
  entryPrice: number;
  qty: number;
  margin: number;
  entryFee: number;
  liq: number;
  funding: number;
  best: number;
  worst: number;
}

export function liquidationPrice(side: 'long' | 'short', entry: number, leverage: number, maintMarginPct: number): number {
  const mmr = maintMarginPct / 100;
  return side === 'long' ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

/** Funding settlements to apply: real history, padded with a fixed rate where history is missing. */
export function fundingEvents(c: Candle[], s: BacktestSettings, history: Point[] = []): Point[] {
  if (s.funding === 'off' || !c.length) return [];
  const step = s.fundingIntervalH * 3600;
  const start = c[0].time;
  const end = c[c.length - 1].time;
  const fixed = s.fixedFundingPct / 100;
  const real = s.funding === 'history' ? history.filter((p) => p.time >= start && p.time <= end) : [];
  const firstReal = real.length ? real[0].time : Infinity;
  const synthetic: Point[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end && t < firstReal; t += step) synthetic.push({ time: t, value: fixed });
  return synthetic.concat(real);
}

export function runBacktest(c: Candle[], sig: Signals, s: BacktestSettings, fundingHistory: Point[] = []): BacktestResult {
  const n = c.length;
  const trades: Trade[] = [];
  const equity = new Array<number>(n).fill(s.initialCapital);
  const events = fundingEvents(c, s, fundingHistory);
  let ev = 0;
  let balance = s.initialCapital;
  let pos: Position | null = null;
  let barsInMarket = 0;
  let blownUp = false;
  const lev = Math.max(1, s.leverage);
  const fee = s.takerFeePct / 100;
  const slip = s.slippagePct / 100;
  const allowLong = s.direction !== 'short';
  const allowShort = s.direction !== 'long';

  type Order = { action: 'open' | 'close'; side: 'long' | 'short'; reason: string };
  let pending: Order[] = [];

  const open = (side: 'long' | 'short', i: number, raw: number) => {
    const price = side === 'long' ? raw * (1 + slip) : raw * (1 - slip);
    let margin = (balance * s.marginPct) / 100;
    if (margin * (1 + lev * fee) > balance) margin = balance / (1 + lev * fee);
    if (margin < 1e-6 || balance < s.initialCapital * 0.001) {
      blownUp = true;
      return;
    }
    const notional = margin * lev;
    const entryFee = notional * fee;
    balance -= entryFee;
    pos = {
      side,
      dir: side === 'long' ? 1 : -1,
      entryIndex: i,
      entryPrice: price,
      qty: notional / price,
      margin,
      entryFee,
      liq: liquidationPrice(side, price, lev, s.maintMarginPct),
      funding: 0,
      best: price,
      worst: price,
    };
  };

  const close = (i: number, raw: number, reason: string, liquidated = false) => {
    if (!pos) return;
    const p: Position = pos;
    let exitPrice: number;
    let gross: number;
    let exitFee: number;
    if (liquidated) {
      // Isolated margin: the whole position margin is lost.
      exitPrice = p.liq;
      gross = -p.margin;
      exitFee = 0;
    } else {
      exitPrice = p.side === 'long' ? raw * (1 - slip) : raw * (1 + slip);
      gross = (exitPrice - p.entryPrice) * p.qty * p.dir;
      gross = Math.max(gross, -p.margin); // can't lose more than the isolated margin
      exitFee = p.qty * exitPrice * fee;
    }
    balance += gross - exitFee;
    const pnl = gross - exitFee - p.entryFee - p.funding;
    const fav = p.side === 'long' ? p.best : p.worst;
    const adv = p.side === 'long' ? p.worst : p.best;
    trades.push({
      side: p.side,
      entryIndex: p.entryIndex,
      entryTime: c[p.entryIndex].time,
      entryPrice: p.entryPrice,
      exitIndex: i,
      exitTime: c[i].time,
      exitPrice,
      qty: p.qty,
      margin: p.margin,
      leverage: lev,
      liqPrice: p.liq,
      pnl,
      pnlPct: (pnl / p.margin) * 100,
      movePct: ((exitPrice - p.entryPrice) / p.entryPrice) * 100 * p.dir,
      fees: exitFee + p.entryFee,
      funding: p.funding,
      bars: i - p.entryIndex,
      exitReason: reason,
      liquidated,
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

    // 1) Funding settlements up to this bar's open.
    while (ev < events.length && events[ev].time <= bar.time) {
      const e = events[ev++];
      const held = pos as Position | null;
      if (held && c[held.entryIndex].time <= e.time && (s.fillOn === 'nextOpen' || c[held.entryIndex].time < e.time)) {
        const pay = held.qty * bar.open * e.value * held.dir; // longs pay when the rate is positive
        balance -= pay;
        held.funding += pay;
      }
    }

    // 2) Orders decided on the previous bar fill at this open.
    if (pending.length) {
      execute(pending, i, bar.open);
      pending = [];
    }

    // 3) Intrabar exits: liquidation, stop loss / trailing, take profit.
    const cur = pos as Position | null;
    if (cur && (s.fillOn === 'nextOpen' || cur.entryIndex < i)) {
      const long = cur.side === 'long';
      const e = cur.entryPrice;
      let stop = s.stopLossPct > 0 ? e * (1 - (cur.dir * s.stopLossPct) / 100) : NaN;
      if (s.trailingPct > 0) {
        const trail = long ? cur.best * (1 - s.trailingPct / 100) : cur.worst * (1 + s.trailingPct / 100);
        stop = Number.isNaN(stop) ? trail : long ? Math.max(stop, trail) : Math.min(stop, trail);
      }
      const target = s.takeProfitPct > 0 ? e * (1 + (cur.dir * s.takeProfitPct) / 100) : NaN;
      const hitDown = (lvl: number) => (long ? bar.low <= lvl : bar.high >= lvl);
      const stopBeforeLiq = !Number.isNaN(stop) && (long ? stop > cur.liq : stop < cur.liq);
      const gapped = (lvl: number) => (long ? bar.open < lvl : bar.open > lvl);
      if (stopBeforeLiq && hitDown(stop)) {
        close(i, gapped(stop) ? bar.open : stop, s.trailingPct > 0 && s.stopLossPct === 0 ? 'Trailing stop' : 'Stop loss');
      } else if (hitDown(cur.liq)) {
        close(i, cur.liq, 'Liquidatie', true);
      } else if (!Number.isNaN(target) && (long ? bar.high >= target : bar.low <= target)) {
        const gap = long ? bar.open > target : bar.open < target;
        close(i, gap ? bar.open : target, 'Take profit');
      }
    }

    const held = pos as Position | null;
    if (held) {
      held.best = Math.max(held.best, bar.high);
      held.worst = Math.min(held.worst, bar.low);
    }

    // 4) Signals at the bar close.
    const orders: Order[] = [];
    const now = pos as Position | null;
    if (now?.side === 'long' && (sig.exitLong[i] || (allowShort && sig.entryShort[i]))) {
      orders.push({ action: 'close', side: 'long', reason: sig.exitLong[i] ? 'Exit signaal' : 'Omkeren' });
    }
    if (now?.side === 'short' && (sig.exitShort[i] || (allowLong && sig.entryLong[i]))) {
      orders.push({ action: 'close', side: 'short', reason: sig.exitShort[i] ? 'Exit signaal' : 'Omkeren' });
    }
    if (!now || orders.length) {
      if (allowLong && sig.entryLong[i] && now?.side !== 'long') orders.push({ action: 'open', side: 'long', reason: '' });
      else if (allowShort && sig.entryShort[i] && now?.side !== 'short') orders.push({ action: 'open', side: 'short', reason: '' });
    }
    if (orders.length) {
      if (s.fillOn === 'close') execute(orders, i, bar.close);
      else if (i < n - 1) pending = orders;
    }

    // 5) Mark to market (unrealised loss is capped at the isolated margin).
    const m = pos as Position | null;
    if (m) {
      barsInMarket++;
      const upnl = Math.max((bar.close - m.entryPrice) * m.qty * m.dir, -m.margin);
      equity[i] = balance + upnl;
    } else {
      equity[i] = balance;
    }
  }

  if (pos && n) {
    close(n - 1, c[n - 1].close, 'Einde data');
    equity[n - 1] = balance;
  }

  const drawdown = new Array<number>(n).fill(0);
  let peak = s.initialCapital;
  let maxDd = 0;
  let maxDdPct = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, equity[i]);
    const dd = peak - equity[i];
    drawdown[i] = peak ? (-dd / peak) * 100 : 0;
    maxDd = Math.max(maxDd, dd);
    if (peak) maxDdPct = Math.max(maxDdPct, dd / peak);
  }

  return {
    trades,
    equity,
    drawdown,
    metrics: computeMetrics(c, trades, equity, s, maxDd, maxDdPct * 100, barsInMarket, blownUp),
  };
}

function computeMetrics(
  c: Candle[],
  trades: Trade[],
  equity: number[],
  s: BacktestSettings,
  maxDd: number,
  maxDdPct: number,
  barsInMarket: number,
  blownUp: boolean,
): Metrics {
  const n = c.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const final = equity[n - 1] ?? s.initialCapital;
  const netProfit = final - s.initialCapital;

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
    cagrPct: years > 0 && final > 0 ? ((final / s.initialCapital) ** (1 / years) - 1) * 100 : final <= 0 ? -100 : 0,
    exposurePct: n ? (barsInMarket / n) * 100 : 0,
    avgBars: trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : 0,
    totalFees: trades.reduce((a, t) => a + t.fees, 0),
    fundingPaid: trades.reduce((a, t) => a + t.funding, 0),
    liquidations: trades.filter((t) => t.liquidated).length,
    maxConsecLosses: maxConsec,
    blownUp,
  };
}

export interface OptimizeRow {
  values: Record<string, number>;
  metrics: Metrics;
}

/** Grid search over up to two numeric parameters (leverage can be one of them). */
export function optimize(
  c: Candle[],
  makeSignals: (values: Record<string, number>) => Signals,
  ranges: { key: string; from: number; to: number; step: number }[],
  s: BacktestSettings,
  fundingHistory: Point[] = [],
  maxRuns = 2500,
): OptimizeRow[] {
  const axes = ranges.map((r) => {
    const vals: number[] = [];
    if (r.step <= 0) return [r.from];
    for (let v = r.from; v <= r.to + 1e-9 && vals.length < 500; v += r.step) vals.push(+v.toFixed(6));
    return vals;
  });
  let combos: Record<string, number>[] = [{}];
  ranges.forEach((r, k) => {
    const next: Record<string, number>[] = [];
    for (const base of combos) for (const v of axes[k]) next.push({ ...base, [r.key]: v });
    combos = next;
  });
  return combos.slice(0, maxRuns).map((values) => {
    const settings = values.__leverage !== undefined ? { ...s, leverage: values.__leverage } : s;
    return { values, metrics: runBacktest(c, makeSignals(values), settings, fundingHistory).metrics };
  });
}
