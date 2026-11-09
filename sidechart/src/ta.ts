/**
 * Technical-analysis primitives. All functions take and return arrays aligned
 * with the candle array; NaN marks "no value yet".
 */
import type { Candle, Series } from './types';

const nan = (n: number): Series => new Array(n).fill(NaN);
const ok = (v: number) => !Number.isNaN(v);

export type Source = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';
export const SOURCES: Source[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];

export function source(c: Candle[], s: Source | string = 'close'): Series {
  switch (s) {
    case 'open':
      return c.map((x) => x.open);
    case 'high':
      return c.map((x) => x.high);
    case 'low':
      return c.map((x) => x.low);
    case 'hl2':
      return c.map((x) => (x.high + x.low) / 2);
    case 'hlc3':
      return c.map((x) => (x.high + x.low + x.close) / 3);
    case 'ohlc4':
      return c.map((x) => (x.open + x.high + x.low + x.close) / 4);
    default:
      return c.map((x) => x.close);
  }
}

export function sma(src: Series, n: number): Series {
  const out = nan(src.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (ok(v)) {
      sum += v;
      count++;
    } else {
      sum = 0;
      count = 0;
      continue;
    }
    if (count > n) {
      sum -= src[i - n];
      count = n;
    }
    if (count === n) out[i] = sum / n;
  }
  return out;
}

/** Exponential average with smoothing factor `alpha`, seeded with the SMA of the first n values. */
function expAvg(src: Series, n: number, alpha: number): Series {
  const out = nan(src.length);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!ok(v)) {
      if (ok(prev)) out[i] = prev;
      continue;
    }
    if (!ok(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount === n) {
        prev = seedSum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export const ema = (src: Series, n: number) => expAvg(src, n, 2 / (n + 1));
/** Wilder's moving average (RMA / SMMA). */
export const rma = (src: Series, n: number) => expAvg(src, n, 1 / n);

export function wma(src: Series, n: number): Series {
  const out = nan(src.length);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < src.length; i++) {
    let s = 0;
    let valid = true;
    for (let j = 0; j < n; j++) {
      const v = src[i - j];
      if (!ok(v)) {
        valid = false;
        break;
      }
      s += v * (n - j);
    }
    if (valid) out[i] = s / denom;
  }
  return out;
}

export function hma(src: Series, n: number): Series {
  const half = wma(src, Math.max(1, Math.floor(n / 2)));
  const full = wma(src, n);
  return wma(
    half.map((v, i) => 2 * v - full[i]),
    Math.max(1, Math.round(Math.sqrt(n))),
  );
}

export function vwma(src: Series, vol: Series, n: number): Series {
  const num = sma(
    src.map((v, i) => v * vol[i]),
    n,
  );
  const den = sma(vol, n);
  return num.map((v, i) => (den[i] ? v / den[i] : NaN));
}

/** Least-squares moving average (end point of a linear regression over n bars). */
export function linreg(src: Series, n: number, offset = 0): Series {
  const out = nan(src.length);
  const sx = (n * (n - 1)) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  for (let i = n - 1; i < src.length; i++) {
    let sy = 0;
    let sxy = 0;
    let valid = true;
    for (let j = 0; j < n; j++) {
      const y = src[i - n + 1 + j];
      if (!ok(y)) {
        valid = false;
        break;
      }
      sy += y;
      sxy += j * y;
    }
    if (!valid) continue;
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    out[i] = intercept + slope * (n - 1 - offset);
  }
  return out;
}

/** Population standard deviation over n bars (same as TradingView's ta.stdev). */
export function stdev(src: Series, n: number): Series {
  const mean = sma(src, n);
  const out = nan(src.length);
  for (let i = n - 1; i < src.length; i++) {
    if (!ok(mean[i])) continue;
    let s = 0;
    for (let j = 0; j < n; j++) s += (src[i - j] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

function windowed(src: Series, n: number, pick: (a: number, b: number) => number): Series {
  const out = nan(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let v = src[i];
    for (let j = 1; j < n; j++) v = pick(v, src[i - j]);
    out[i] = v;
  }
  return out;
}
export const highest = (src: Series, n: number) => windowed(src, n, Math.max);
export const lowest = (src: Series, n: number) => windowed(src, n, Math.min);

/** Bars since the highest / lowest value within the window (0 = current bar). */
function barsSinceExtreme(src: Series, n: number, isBetter: (a: number, b: number) => boolean): Series {
  const out = nan(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let best = i;
    for (let j = i - n + 1; j <= i; j++) if (isBetter(src[j], src[best]) || src[j] === src[best]) best = j;
    out[i] = i - best;
  }
  return out;
}

export function change(src: Series, n = 1): Series {
  return src.map((v, i) => (i >= n ? v - src[i - n] : NaN));
}

export function trueRange(c: Candle[]): Series {
  return c.map((x, i) =>
    i === 0
      ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)),
  );
}

export const atr = (c: Candle[], n: number) => rma(trueRange(c), n);

export function rsi(src: Series, n: number): Series {
  const ch = change(src);
  const up = rma(
    ch.map((v) => (ok(v) ? Math.max(v, 0) : NaN)),
    n,
  );
  const down = rma(
    ch.map((v) => (ok(v) ? Math.max(-v, 0) : NaN)),
    n,
  );
  return up.map((u, i) => {
    const d = down[i];
    if (!ok(u) || !ok(d)) return NaN;
    if (d === 0) return 100;
    if (u === 0) return 0;
    return 100 - 100 / (1 + u / d);
  });
}

export function macd(src: Series, fast: number, slow: number, signal: number) {
  const f = ema(src, fast);
  const s = ema(src, slow);
  const line = f.map((v, i) => v - s[i]);
  const sig = ema(line, signal);
  return { macd: line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

export function bollinger(src: Series, n: number, mult: number) {
  const basis = sma(src, n);
  const dev = stdev(src, n);
  return {
    basis,
    upper: basis.map((b, i) => b + mult * dev[i]),
    lower: basis.map((b, i) => b - mult * dev[i]),
  };
}

export function stochastic(c: Candle[], n: number, smoothK: number, smoothD: number) {
  const hh = highest(
    c.map((x) => x.high),
    n,
  );
  const ll = lowest(
    c.map((x) => x.low),
    n,
  );
  const raw = c.map((x, i) => (hh[i] - ll[i] === 0 ? 50 : (100 * (x.close - ll[i])) / (hh[i] - ll[i])));
  const k = sma(raw, smoothK);
  return { k, d: sma(k, smoothD) };
}

export function stochRsi(src: Series, rsiLen: number, stochLen: number, smoothK: number, smoothD: number) {
  const r = rsi(src, rsiLen);
  const hh = highest(r, stochLen);
  const ll = lowest(r, stochLen);
  const raw = r.map((v, i) => (hh[i] - ll[i] === 0 ? 0 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
  const k = sma(raw, smoothK);
  return { k, d: sma(k, smoothD) };
}

export function cci(c: Candle[], n: number): Series {
  const tp = source(c, 'hlc3');
  const mean = sma(tp, n);
  return tp.map((v, i) => {
    if (!ok(mean[i])) return NaN;
    let dev = 0;
    for (let j = 0; j < n; j++) dev += Math.abs(tp[i - j] - mean[i]);
    dev /= n;
    return dev === 0 ? 0 : (v - mean[i]) / (0.015 * dev);
  });
}

export function dmi(c: Candle[], diLen: number, adxLen: number) {
  const plusDM = c.map((x, i) => {
    if (i === 0) return NaN;
    const up = x.high - c[i - 1].high;
    const down = c[i - 1].low - x.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDM = c.map((x, i) => {
    if (i === 0) return NaN;
    const up = x.high - c[i - 1].high;
    const down = c[i - 1].low - x.low;
    return down > up && down > 0 ? down : 0;
  });
  const tr = rma(
    trueRange(c).map((v, i) => (i === 0 ? NaN : v)),
    diLen,
  );
  const plus = rma(plusDM, diLen).map((v, i) => (100 * v) / tr[i]);
  const minus = rma(minusDM, diLen).map((v, i) => (100 * v) / tr[i]);
  const dx = plus.map((p, i) => {
    const s = p + minus[i];
    return s === 0 ? 0 : (100 * Math.abs(p - minus[i])) / s;
  });
  return { plus, minus, adx: rma(dx, adxLen) };
}

export function williamsR(c: Candle[], n: number): Series {
  const hh = highest(
    c.map((x) => x.high),
    n,
  );
  const ll = lowest(
    c.map((x) => x.low),
    n,
  );
  return c.map((x, i) => (hh[i] - ll[i] === 0 ? 0 : (-100 * (hh[i] - x.close)) / (hh[i] - ll[i])));
}

export function mfi(c: Candle[], n: number): Series {
  const tp = source(c, 'hlc3');
  const out = nan(c.length);
  for (let i = n; i < c.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = tp[j] * c[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

export function obv(c: Candle[]): Series {
  let acc = 0;
  return c.map((x, i) => {
    if (i > 0) acc += x.close > c[i - 1].close ? x.volume : x.close < c[i - 1].close ? -x.volume : 0;
    return acc;
  });
}

export function accDist(c: Candle[]): Series {
  let acc = 0;
  return c.map((x) => {
    const r = x.high - x.low;
    acc += r === 0 ? 0 : ((x.close - x.low - (x.high - x.close)) / r) * x.volume;
    return acc;
  });
}

export function cmf(c: Candle[], n: number): Series {
  const mfv = c.map((x) => {
    const r = x.high - x.low;
    return r === 0 ? 0 : ((x.close - x.low - (x.high - x.close)) / r) * x.volume;
  });
  const a = sma(mfv, n);
  const v = sma(
    c.map((x) => x.volume),
    n,
  );
  return a.map((x, i) => (v[i] ? x / v[i] : 0));
}

export function aroon(c: Candle[], n: number) {
  const len = n + 1;
  const up = barsSinceExtreme(
    c.map((x) => x.high),
    len,
    (a, b) => a > b,
  ).map((v) => (100 * (n - v)) / n);
  const down = barsSinceExtreme(
    c.map((x) => x.low),
    len,
    (a, b) => a < b,
  ).map((v) => (100 * (n - v)) / n);
  return { up, down };
}

export function parabolicSar(c: Candle[], start: number, inc: number, max: number): Series {
  const out = nan(c.length);
  if (c.length < 2) return out;
  let long = c[1].close >= c[0].close;
  let af = start;
  let ep = long ? Math.max(c[0].high, c[1].high) : Math.min(c[0].low, c[1].low);
  let sar = long ? Math.min(c[0].low, c[1].low) : Math.max(c[0].high, c[1].high);
  out[1] = sar;
  for (let i = 2; i < c.length; i++) {
    sar = sar + af * (ep - sar);
    if (long) {
      sar = Math.min(sar, c[i - 1].low, c[i - 2].low);
      if (c[i].low < sar) {
        long = false;
        sar = ep;
        ep = c[i].low;
        af = start;
      } else if (c[i].high > ep) {
        ep = c[i].high;
        af = Math.min(af + inc, max);
      }
    } else {
      sar = Math.max(sar, c[i - 1].high, c[i - 2].high);
      if (c[i].high > sar) {
        long = true;
        sar = ep;
        ep = c[i].high;
        af = start;
      } else if (c[i].low < ep) {
        ep = c[i].low;
        af = Math.min(af + inc, max);
      }
    }
    out[i] = sar;
  }
  return out;
}

export function supertrend(c: Candle[], n: number, mult: number) {
  const a = atr(c, n);
  const hl2 = source(c, 'hl2');
  const up = nan(c.length);
  const down = nan(c.length);
  const dir = nan(c.length); // 1 = uptrend, -1 = downtrend
  let finalUpper = NaN;
  let finalLower = NaN;
  let trend = 1;
  for (let i = 0; i < c.length; i++) {
    if (!ok(a[i])) continue;
    const basicUpper = hl2[i] + mult * a[i];
    const basicLower = hl2[i] - mult * a[i];
    const prevClose = i > 0 ? c[i - 1].close : c[i].close;
    finalUpper = !ok(finalUpper) || basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = !ok(finalLower) || basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
    if (trend === 1 && c[i].close < finalLower) trend = -1;
    else if (trend === -1 && c[i].close > finalUpper) trend = 1;
    dir[i] = trend;
    if (trend === 1) up[i] = finalLower;
    else down[i] = finalUpper;
  }
  return { up, down, dir };
}

export function ichimoku(c: Candle[], conv: number, base: number, spanB: number) {
  const mid = (n: number) => {
    const hh = highest(
      c.map((x) => x.high),
      n,
    );
    const ll = lowest(
      c.map((x) => x.low),
      n,
    );
    return hh.map((h, i) => (h + ll[i]) / 2);
  };
  const tenkan = mid(conv);
  const kijun = mid(base);
  return {
    tenkan,
    kijun,
    spanA: tenkan.map((t, i) => (t + kijun[i]) / 2),
    spanB: mid(spanB),
    chikou: c.map((x) => x.close),
  };
}

/** VWAP that resets at the start of every session / week / month (UTC). */
export function vwap(c: Candle[], anchor: string, src: Series): Series {
  let pv = 0;
  let vol = 0;
  let key = '';
  return c.map((x, i) => {
    const d = new Date(x.time * 1000);
    let k: string;
    if (anchor === 'Week') {
      k = String(Math.floor((x.time - 4 * 86400) / 604800));
    } else if (anchor === 'Month') {
      k = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    } else {
      k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    }
    if (k !== key) {
      key = k;
      pv = 0;
      vol = 0;
    }
    pv += src[i] * x.volume;
    vol += x.volume;
    return vol ? pv / vol : src[i];
  });
}

export function heikinAshi(c: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    const close = (x.open + x.high + x.low + x.close) / 4;
    const open = i === 0 ? (x.open + x.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      time: x.time,
      open,
      close,
      high: Math.max(x.high, open, close),
      low: Math.min(x.low, open, close),
      volume: x.volume,
    });
  }
  return out;
}

export function crossover(a: Series, b: Series, i: number): boolean {
  return i > 0 && a[i] > b[i] && a[i - 1] <= b[i - 1];
}
export function crossunder(a: Series, b: Series, i: number): boolean {
  return i > 0 && a[i] < b[i] && a[i - 1] >= b[i - 1];
}
