import { describe, expect, it } from 'vitest';
import type { Candle } from './types';
import * as ta from './ta';
import { INDICATORS, defaultParams } from './indicators';
import { STRATEGIES, defaultParamsFor, customSignals, evalRule } from './test-helpers';
import { DEFAULT_SETTINGS, optimize, runBacktest } from './backtest';
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

describe('every indicator computes without errors and with aligned output', () => {
  const c = walk(400);
  for (const def of INDICATORS) {
    it(def.id, () => {
      const out = def.compute(c, defaultParams(def.params));
      for (const o of def.outputs) {
        expect(out[o.key], `${def.id}.${o.key}`).toHaveLength(c.length);
        expect(out[o.key].slice(-50).some(Number.isFinite), `${def.id}.${o.key} has values`).toBe(true);
      }
    });
  }
});

describe('strategies', () => {
  const c = walk(1500);
  for (const def of STRATEGIES.filter((s) => s.id !== 'custom')) {
    it(`${def.id} produces signals and a valid backtest`, () => {
      const sig = def.signals(c, defaultParamsFor(def));
      const r = runBacktest(c, sig, { ...DEFAULT_SETTINGS, direction: 'both' });
      expect(r.equity).toHaveLength(c.length);
      expect(Number.isFinite(r.metrics.netProfit)).toBe(true);
    });
  }
  it('custom rules parse and evaluate', () => {
    const s = customSignals(c, { entryLong: 'EMA(9) crosses above EMA(21) AND RSI(14) > 40', exitLong: 'EMA(9) crosses below EMA(21)', entryShort: '', exitShort: '' });
    expect(s.entryLong.some(Boolean)).toBe(true);
    expect(s.entryShort.some(Boolean)).toBe(false);
    expect(evalRule(c, 'close > 0').every(Boolean)).toBe(true);
    expect(evalRule(c, 'PREV(close) > 0')[0]).toBe(false);
    expect(() => evalRule(c, 'FOO(3) > 1')).toThrow();
  });
});

describe('backtest engine', () => {
  const flat = { ...DEFAULT_SETTINGS, commissionPct: 0, slippagePct: 0 };
  const signalsAt = (n: number, entries: number[], exits: number[]) => ({
    entryLong: Array.from({ length: n }, (_, i) => entries.includes(i)),
    exitLong: Array.from({ length: n }, (_, i) => exits.includes(i)),
    entryShort: new Array(n).fill(false),
    exitShort: new Array(n).fill(false),
  });

  it('fills on the next open and computes profit exactly', () => {
    const c = mk([100, 100, 110, 120, 130, 125]); // opens: 100,100,100,110,120,130
    const r = runBacktest(c, signalsAt(c.length, [1], [3]), flat);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entryPrice).toBe(100); // bar 2 open
    expect(t.exitPrice).toBe(120); // bar 4 open
    expect(t.pnl).toBeCloseTo(2000);
    expect(r.metrics.netProfitPct).toBeCloseTo(20);
  });

  it('applies commission on both sides', () => {
    const c = mk([100, 100, 100, 100]);
    const r = runBacktest(c, signalsAt(c.length, [0], [1]), { ...flat, commissionPct: 0.1 });
    expect(r.trades[0].pnl).toBeLessThan(0);
    expect(r.trades[0].fees).toBeCloseTo(20, 0); // ~0.1% of 10k twice
  });

  it('triggers the stop loss intrabar', () => {
    const c: Candle[] = [
      { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: 60, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: 120, open: 100, high: 100, low: 90, close: 95, volume: 1 },
      { time: 180, open: 95, high: 96, low: 94, close: 95, volume: 1 },
    ];
    const r = runBacktest(c, signalsAt(4, [0], []), { ...flat, stopLossPct: 5 });
    expect(r.trades[0].exitReason).toBe('Stop loss');
    expect(r.trades[0].exitPrice).toBeCloseTo(95);
  });

  it('short trades profit when price falls', () => {
    const c = mk([100, 100, 90, 80, 70]);
    const sig = { entryLong: [false, false, false, false, false], exitLong: [false, false, false, false, false], entryShort: [true, false, false, false, false], exitShort: [false, false, true, false, false] };
    const r = runBacktest(c, sig, { ...flat, direction: 'short' });
    expect(r.trades[0].side).toBe('short');
    expect(r.trades[0].pnl).toBeGreaterThan(0);
  });

  it('equity drawdown is never positive', () => {
    const c = walk(800);
    const r = runBacktest(c, STRATEGIES[0].signals(c, defaultParamsFor(STRATEGIES[0])), DEFAULT_SETTINGS);
    expect(r.drawdown.every((d) => d <= 0)).toBe(true);
  });

  it('optimizer runs a grid', () => {
    const c = walk(600);
    const def = STRATEGIES[0];
    const rows = optimize(c, (v) => def.signals(c, { ...defaultParamsFor(def), ...v }), [
      { key: 'fast', from: 5, to: 10, step: 5 },
      { key: 'slow', from: 20, to: 30, step: 10 },
    ], DEFAULT_SETTINGS);
    expect(rows).toHaveLength(4);
  });
});

describe('timeframes & data', () => {
  it('parses timeframes', () => {
    expect(parseTimeframe('15')?.label).toBe('15m');
    expect(parseTimeframe('4H')?.seconds).toBe(14400);
    expect(parseTimeframe('2D')?.label).toBe('2D');
    expect(parseTimeframe('3M')?.unit).toBe('M');
    expect(parseTimeframe('abc')).toBeNull();
  });
  it('picks a base interval for custom timeframes', () => {
    expect(baseIntervalFor(parseTimeframe('4h')!)).toEqual({ interval: '4h', resample: false });
    expect(baseIntervalFor(parseTimeframe('45m')!)).toEqual({ interval: '15m', resample: true });
    expect(baseIntervalFor(parseTimeframe('10m')!)).toEqual({ interval: '5m', resample: true });
    expect(baseIntervalFor(parseTimeframe('3M')!)).toEqual({ interval: '1M', resample: true });
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
