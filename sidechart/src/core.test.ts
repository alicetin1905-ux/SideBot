import { describe, expect, it } from 'vitest';
import type { Candle } from './types';
import * as ta from './ta';
import { INDICATORS, defaultParams } from './indicators';
import { STRATEGIES, defaultParamsFor, customSignals, evalRule } from './test-helpers';
import { DEFAULT_SETTINGS, fundingEvents, liquidationPrice, optimize, runBacktest } from './backtest';
import { align } from './indicators';
import { planPosition } from './futures';
import { EXCHANGES } from './exchanges';
import { bucketStart, parseCsv, parseTimeframe, resample, baseIntervalFor } from './data';

const mk = (closes: number[], start = 1_700_000_000, step = 3600): Candle[] =>
  closes.map((c, i) => ({ time: start + i * step, open: i ? closes[i - 1] : c, high: Math.max(c, i ? closes[i - 1] : c) + 1, low: Math.min(c, i ? closes[i - 1] : c) - 1, close: c, volume: 100 + i }));

// Deterministic pseudo-random walk
function walk(n: number, seed = 42): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p *= 1 + (rnd() - 0.5) * 0.04;
    closes.push(p);
  }
  return mk(closes);
}

describe('ta primitives', () => {
  it('sma', () => {
    expect(ta.sma([1, 2, 3, 4, 5], 3).slice(2)).toEqual([2, 3, 4]);
    expect(Number.isNaN(ta.sma([1, 2, 3], 3)[1])).toBe(true);
  });
  it('ema seeds with sma and smooths', () => {
    const e = ta.ema([1, 2, 3, 4, 5], 3);
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(4);
  });
  it('rsi is 100 for a rising series and 0 for a falling one', () => {
    const up = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(ta.rsi(up, 14)[29]).toBe(100);
    expect(ta.rsi([...up].reverse(), 14)[29]).toBe(0);
  });
  it('rsi matches a reference value (Wilder)', () => {
    // Classic StockCharts example data; first RSI(14) = 100 - 100/(1 + avgGain/avgLoss) ≈ 70.464
    const d = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(ta.rsi(d, 14)[14]).toBeCloseTo(70.464, 2);
  });
  it('bollinger bands are symmetric around the basis', () => {
    const c = walk(100).map((x) => x.close);
    const b = ta.bollinger(c, 20, 2);
    expect(b.upper[50] - b.basis[50]).toBeCloseTo(b.basis[50] - b.lower[50]);
  });
  it('highest/lowest', () => {
    expect(ta.highest([1, 5, 3, 2], 2).slice(1)).toEqual([5, 5, 3]);
    expect(ta.lowest([1, 5, 3, 2], 2).slice(1)).toEqual([1, 3, 2]);
  });
  it('crossover / crossunder', () => {
    expect(ta.crossover([1, 3], [2, 2], 1)).toBe(true);
    expect(ta.crossunder([3, 1], [2, 2], 1)).toBe(true);
    expect(ta.crossover([3, 4], [2, 2], 1)).toBe(false);
  });
});

// Fake futures data aligned with the candles
function fakeExt(c: Candle[]) {
  return {
    funding: c.filter((_, i) => i % 8 === 0).map((x, i) => ({ time: x.time, value: Math.sin(i / 5) * 0.0005 })),
    oi: c.map((x, i) => ({ time: x.time, value: 1e9 + i * 1e6 * Math.sin(i / 30) })),
    lsr: c.map((x, i) => ({ time: x.time, value: 1 + Math.sin(i / 20) * 1.5 + 1 })),
    takerBuy: c.map((x, i) => ({ time: x.time, value: 1000 + (i % 7) * 100 })),
    takerSell: c.map((x, i) => ({ time: x.time, value: 1000 + (i % 5) * 120 })),
  };
}

describe('every indicator computes without errors and with aligned output', () => {
  const c = walk(400);
  const ext = fakeExt(c);
  for (const def of INDICATORS) {
    it(def.id, () => {
      const out = def.compute(c, defaultParams(def.params), ext);
      for (const o of def.outputs) {
        expect(out[o.key], `${def.id}.${o.key}`).toHaveLength(c.length);
        expect(out[o.key].slice(-50).some(Number.isFinite), `${def.id}.${o.key} has values`).toBe(true);
      }
    });
  }
});

describe('strategies', () => {
  const c = walk(1500);
  const ext = fakeExt(c);
  for (const def of STRATEGIES.filter((s) => s.id !== 'custom')) {
    it(`${def.id} produces signals and a valid backtest`, () => {
      const sig = def.signals(c, defaultParamsFor(def), ext);
      const r = runBacktest(c, sig, { ...DEFAULT_SETTINGS, direction: 'both' });
      expect(r.equity).toHaveLength(c.length);
      expect(Number.isFinite(r.metrics.netProfit)).toBe(true);
    });
  }
  it('futures operands work in custom rules', () => {
    const s = customSignals(c, { entryLong: 'FUNDING < -0.02', exitLong: 'FUNDING > 0', entryShort: 'FUNDING > 0.03 AND close < EMA(20)', exitShort: '' }, ext);
    expect(s.entryLong.some(Boolean)).toBe(true);
    expect(s.entryShort.some(Boolean)).toBe(true);
  });
  it('every rule example parses and produces signals', async () => {
    const { RULE_EXAMPLES } = await import('./strategies');
    for (const ex of RULE_EXAMPLES) {
      const sig = customSignals(c, ex.rules, ext);
      const any = sig.entryLong.some(Boolean) || sig.entryShort.some(Boolean);
      expect(any, ex.name).toBe(true);
    }
  });
  it('new strategies trade in both directions', () => {
    for (const id of ['squeeze', 'chandelier', 'ema_ribbon', 'hull_trend', 'zscore_revert', 'heikin_trend', 'macd_rsi']) {
      const def = STRATEGIES.find((x) => x.id === id)!;
      const sig = def.signals(c, defaultParamsFor(def), ext);
      expect(sig.entryLong.some(Boolean), `${id} long`).toBe(true);
      expect(sig.entryShort.some(Boolean), `${id} short`).toBe(true);
    }
  });
  it('opening range breakout trades at most once per day and is flat at day end', () => {
    // 15-minute bars over 5 days
    const m = mk(Array.from({ length: 96 * 5 }, (_, i) => 100 + Math.sin(i / 7) * 3 + i * 0.01), 1_700_006_400, 900);
    const def = STRATEGIES.find((x) => x.id === 'orb')!;
    const sig = def.signals(m, defaultParamsFor(def), {});
    const perDay = new Map<number, number>();
    sig.entryLong.forEach((v, i) => {
      if (v || sig.entryShort[i]) perDay.set(Math.floor(m[i].time / 86400), (perDay.get(Math.floor(m[i].time / 86400)) ?? 0) + 1);
    });
    expect([...perDay.values()].every((n) => n <= 1)).toBe(true);
    expect(perDay.size).toBeGreaterThan(0);
  });
  it('keltner breakout enters long on a breakout up and short on a breakdown', () => {
    // quiet range, sharp rally, quiet, sharp drop
    const prices = [
      ...Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 0.3),
      ...Array.from({ length: 10 }, (_, i) => 101 + i * 1.5),
      ...Array.from({ length: 60 }, (_, i) => 115 + Math.sin(i) * 0.3),
      ...Array.from({ length: 10 }, (_, i) => 114 - i * 1.5),
    ];
    const k = prices.map((p, i) => ({ time: i * 3600, open: i ? prices[i - 1] : p, high: Math.max(p, i ? prices[i - 1] : p) + 0.1, low: Math.min(p, i ? prices[i - 1] : p) - 0.1, close: p, volume: 1 }));
    const def = STRATEGIES.find((x) => x.id === 'keltner_breakout')!;
    const sig = def.signals(k, defaultParamsFor(def), {});
    const firstLong = sig.entryLong.indexOf(true);
    const firstShort = sig.entryShort.indexOf(true);
    expect(firstLong).toBeGreaterThanOrEqual(60);
    expect(firstLong).toBeLessThan(70);
    expect(firstShort).toBeGreaterThanOrEqual(130);
  });
  it('VOLSMA works in rules', () => {
    expect(evalRule(c, 'volume > VOLSMA(20)').some(Boolean)).toBe(true);
  });
  it('custom rules parse and evaluate', () => {
    const s = customSignals(c, { entryLong: 'EMA(9) crosses above EMA(21) AND RSI(14) > 40', exitLong: 'EMA(9) crosses below EMA(21)', entryShort: '', exitShort: '' });
    expect(s.entryLong.some(Boolean)).toBe(true);
    expect(s.entryShort.some(Boolean)).toBe(false);
    expect(evalRule(c, 'close > 0').every(Boolean)).toBe(true);
    expect(evalRule(c, 'PREV(close) > 0')[0]).toBe(false);
    expect(() => evalRule(c, 'FOO(3) > 1')).toThrow();
  });
});

describe('futures backtest engine', () => {
  const flat = { ...DEFAULT_SETTINGS, takerFeePct: 0, slippagePct: 0, funding: 'off' as const, marginPct: 100, leverage: 1, direction: 'long' as const };
  const signalsAt = (n: number, entries: number[], exits: number[]) => ({
    entryLong: Array.from({ length: n }, (_, i) => entries.includes(i)),
    exitLong: Array.from({ length: n }, (_, i) => exits.includes(i)),
    entryShort: new Array(n).fill(false),
    exitShort: new Array(n).fill(false),
  });

  it('1x long fills on the next open and computes profit exactly', () => {
    const c = mk([100, 100, 110, 120, 130, 125]); // opens: 100,100,100,110,120,130
    const r = runBacktest(c, signalsAt(c.length, [1], [3]), flat);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].entryPrice).toBe(100);
    expect(r.trades[0].exitPrice).toBe(120);
    expect(r.trades[0].pnl).toBeCloseTo(200); // 1000 balance · +20%
    expect(r.metrics.netProfitPct).toBeCloseTo(20);
  });

  it('leverage multiplies the result on the margin', () => {
    const c = mk([100, 100, 110, 120, 130, 125]);
    const r = runBacktest(c, signalsAt(c.length, [1], [3]), { ...flat, marginPct: 10, leverage: 5 });
    // margin 100, notional 500, +20% move = +100 → ROE 100%
    expect(r.trades[0].pnl).toBeCloseTo(100);
    expect(r.trades[0].pnlPct).toBeCloseTo(100);
  });

  it('liquidates a highly leveraged position and loses only the margin', () => {
    const c: Candle[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: 60, open: 100, high: 100, low: 99, close: 100, volume: 1 },
      { time: 120, open: 100, high: 100, low: 80, close: 85, volume: 1 },
      { time: 180, open: 85, high: 86, low: 84, close: 85, volume: 1 },
    ];
    const r = runBacktest(c, signalsAt(4, [0], []), { ...flat, marginPct: 10, leverage: 20 });
    expect(r.trades[0].liquidated).toBe(true);
    expect(r.trades[0].exitReason).toBe('Liquidatie');
    expect(r.trades[0].pnl).toBeCloseTo(-100); // whole 10% margin of 1000
    expect(r.metrics.liquidations).toBe(1);
    expect(r.metrics.netProfit).toBeCloseTo(-100);
  });

  it('a stop loss above the liquidation price triggers first', () => {
    const c: Candle[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: 60, open: 100, high: 100, low: 99, close: 100, volume: 1 },
      { time: 120, open: 100, high: 100, low: 80, close: 85, volume: 1 },
    ];
    const r = runBacktest(c, signalsAt(3, [0], []), { ...flat, marginPct: 10, leverage: 10, stopLossPct: 2 });
    expect(r.trades[0].exitReason).toBe('Stop loss');
    expect(r.trades[0].exitPrice).toBeCloseTo(98);
    expect(r.trades[0].pnl).toBeCloseTo(-20); // 1000 notional · -2%
  });

  it('liquidation price formula', () => {
    expect(liquidationPrice('long', 100, 10, 0.5)).toBeCloseTo(90.5);
    expect(liquidationPrice('short', 100, 10, 0.5)).toBeCloseTo(109.5);
  });

  it('longs pay positive funding, shorts receive it', () => {
    const c = mk(new Array(40).fill(100), 0, 3600); // flat price, 40 hours
    const funding = [{ time: 8 * 3600, value: 0.001 }, { time: 16 * 3600, value: 0.001 }, { time: 24 * 3600, value: 0.001 }];
    const settings = { ...flat, funding: 'history' as const, direction: 'both' as const };
    const long = runBacktest(c, signalsAt(40, [0], [30]), settings, funding);
    expect(long.trades[0].funding).toBeCloseTo(3); // 1000 notional · 0.1% · 3
    const shortSig = { entryLong: new Array(40).fill(false), exitLong: new Array(40).fill(false), entryShort: c.map((_, i) => i === 0), exitShort: c.map((_, i) => i === 30) };
    const short = runBacktest(c, shortSig, settings, funding);
    expect(short.trades[0].funding).toBeCloseTo(-3);
    expect(short.trades[0].pnl).toBeGreaterThan(long.trades[0].pnl);
  });

  it('fills funding gaps with the fixed rate', () => {
    const c = mk(new Array(48).fill(100), 0, 3600);
    const ev = fundingEvents(c, { ...DEFAULT_SETTINGS, funding: 'history', fixedFundingPct: 0.01 }, [{ time: 40 * 3600, value: 0.002 }]);
    expect(ev.map((e) => e.time / 3600)).toEqual([0, 8, 16, 24, 32, 40]);
    expect(ev[0].value).toBeCloseTo(0.0001);
    expect(fundingEvents(c, { ...DEFAULT_SETTINGS, funding: 'off' })).toHaveLength(0);
  });

  it('short trades profit when price falls', () => {
    const c = mk([100, 100, 90, 80, 70]);
    const sig = { entryLong: [false, false, false, false, false], exitLong: [false, false, false, false, false], entryShort: [true, false, false, false, false], exitShort: [false, false, true, false, false] };
    const r = runBacktest(c, sig, { ...flat, direction: 'short' });
    expect(r.trades[0].side).toBe('short');
    expect(r.trades[0].pnl).toBeGreaterThan(0);
  });

  it('equity drawdown is never positive and fees are charged', () => {
    const c = walk(800);
    const def = STRATEGIES.find((s) => s.id === 'ma_cross')!;
    const r = runBacktest(c, def.signals(c, defaultParamsFor(def), {}), DEFAULT_SETTINGS);
    expect(r.drawdown.every((d) => d <= 0)).toBe(true);
    expect(r.metrics.totalFees).toBeGreaterThan(0);
  });

  it('optimizer runs a grid including leverage', () => {
    const c = walk(600);
    const def = STRATEGIES.find((s) => s.id === 'ma_cross')!;
    const rows = optimize(c, (v) => def.signals(c, { ...defaultParamsFor(def), ...v }, {}), [
      { key: 'fast', from: 5, to: 10, step: 5 },
      { key: '__leverage', from: 1, to: 3, step: 2 },
    ], DEFAULT_SETTINGS);
    expect(rows).toHaveLength(4);
  });
});

describe('futures helpers', () => {
  it('position calculator sizes by risk', () => {
    const p = planPosition({ balance: 1000, riskPct: 1, entry: 100, stop: 98, target: 106, leverage: 10, takerFeePct: 0, maintMarginPct: 0.5 })!;
    expect(p.side).toBe('long');
    expect(p.qty).toBeCloseTo(5); // $10 risk / $2 stop distance
    expect(p.margin).toBeCloseTo(50);
    expect(p.rr).toBeCloseTo(3);
    expect(p.liqPrice).toBeCloseTo(90.5);
    expect(p.warnings).toHaveLength(0);
  });
  it('warns when liquidation comes before the stop', () => {
    const p = planPosition({ balance: 1000, riskPct: 1, entry: 100, stop: 90, target: 0, leverage: 20, takerFeePct: 0.05, maintMarginPct: 0.5 })!;
    expect(p.warnings.join(' ')).toMatch(/liquidatie/i);
  });
  it('aligns step and summed series', () => {
    const c = mk([1, 2, 3, 4], 0, 60);
    expect(align(c, [{ time: 60, value: 5 }])).toEqual([NaN, 5, 5, 5]);
    expect(align(c, [{ time: 60, value: 1 }, { time: 90, value: 2 }, { time: 180, value: 4 }], 'sum')).toEqual([NaN, 3, NaN, 4]);
  });
});

describe('timeframes & data', () => {
  const NAT = EXCHANGES.okx.intervals;
  it('parses timeframes', () => {
    expect(parseTimeframe('15')?.label).toBe('15m');
    expect(parseTimeframe('4H')?.seconds).toBe(14400);
    expect(parseTimeframe('2D')?.label).toBe('2D');
    expect(parseTimeframe('3M')?.unit).toBe('M');
    expect(parseTimeframe('abc')).toBeNull();
  });
  it('picks a base interval for custom timeframes', () => {
    expect(baseIntervalFor(parseTimeframe('4h')!, NAT)).toEqual({ interval: '4h', resample: false });
    expect(baseIntervalFor(parseTimeframe('45m')!, NAT)).toEqual({ interval: '15m', resample: true });
    expect(baseIntervalFor(parseTimeframe('10m')!, NAT)).toEqual({ interval: '5m', resample: true });
    expect(baseIntervalFor(parseTimeframe('8h')!, NAT)).toEqual({ interval: '4h', resample: true });
    expect(baseIntervalFor(parseTimeframe('3M')!, NAT)).toEqual({ interval: '1M', resample: true });
  });
  it('resamples 1h into 3h', () => {
    const c = mk([1, 2, 3, 4, 5, 6], 0, 3600);
    const r = resample(c, parseTimeframe('3h')!);
    expect(r).toHaveLength(2);
    expect(r[0].close).toBe(3);
    expect(r[0].volume).toBe(100 + 101 + 102);
  });
  it('weekly buckets start on Monday', () => {
    const wed = Date.UTC(2024, 0, 3) / 1000; // Wednesday 3 Jan 2024
    expect(new Date(bucketStart(wed, parseTimeframe('1W')!) * 1000).getUTCDay()).toBe(1);
  });
  it('parses CSV', () => {
    const c = parseCsv('Date,Open,High,Low,Close,Volume\n2024-01-02,10,12,9,11,1000\n2024-01-01,9,10,8,10,500');
    expect(c).toHaveLength(2);
    expect(c[0].close).toBe(10);
  });
});
