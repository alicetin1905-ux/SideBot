import type { Candle, ParamDef, Params, Series } from './types';
import * as ta from './ta';

export interface OutputDef {
  key: string;
  label: string;
  type: 'line' | 'histogram';
  color: string;
  /** Shift the plot forward (+) or backward (-) by this many bars. */
  offset?: number | ((p: Params) => number);
  /** Colour histogram bars by candle direction or by the sign of the value. */
  colorBy?: 'candle' | 'sign';
  lineWidth?: number;
  dashed?: boolean;
}

export interface IndicatorDef {
  id: string;
  name: string;
  category: 'Moving averages' | 'Bands & channels' | 'Trend' | 'Oscillators' | 'Volume' | 'Volatility';
  /** true = drawn on the price chart, false = own pane below */
  overlay: boolean;
  params: ParamDef[];
  outputs: OutputDef[];
  levels?: number[];
  compute(c: Candle[], p: Params): Record<string, Series>;
}

const num = (key: string, label: string, def: number, step = 1, min = 1): ParamDef => ({
  key,
  label,
  type: 'number',
  default: def,
  step,
  min,
});
const len = (def: number, label = 'Lengte') => num('length', label, def);
const src: ParamDef = { key: 'source', label: 'Bron', type: 'select', default: 'close', options: ta.SOURCES };
const N = (p: Params, k: string) => Number(p[k]);
const S = (c: Candle[], p: Params) => ta.source(c, String(p.source ?? 'close'));

const ma = (id: string, name: string, color: string, fn: (s: Series, n: number, c: Candle[]) => Series): IndicatorDef => ({
  id,
  name,
  category: 'Moving averages',
  overlay: true,
  params: [len(20), src],
  outputs: [{ key: 'value', label: id.toUpperCase(), type: 'line', color }],
  compute: (c, p) => ({ value: fn(S(c, p), N(p, 'length'), c) }),
});

export const INDICATORS: IndicatorDef[] = [
  // ---- Moving averages ----
  ma('sma', 'Simple Moving Average (SMA)', '#2962ff', ta.sma),
  ma('ema', 'Exponential Moving Average (EMA)', '#ff9800', ta.ema),
  ma('wma', 'Weighted Moving Average (WMA)', '#ab47bc', ta.wma),
  ma('hma', 'Hull Moving Average (HMA)', '#26a69a', ta.hma),
  ma('rma', 'Smoothed Moving Average (SMMA/RMA)', '#8d6e63', ta.rma),
  ma('dema', 'Double EMA (DEMA)', '#ec407a', (s, n) => {
    const e1 = ta.ema(s, n);
    const e2 = ta.ema(e1, n);
    return e1.map((v, i) => 2 * v - e2[i]);
  }),
  ma('tema', 'Triple EMA (TEMA)', '#7e57c2', (s, n) => {
    const e1 = ta.ema(s, n);
    const e2 = ta.ema(e1, n);
    const e3 = ta.ema(e2, n);
    return e1.map((v, i) => 3 * v - 3 * e2[i] + e3[i]);
  }),
  ma('vwma', 'Volume Weighted MA (VWMA)', '#42a5f5', (s, n, c) =>
    ta.vwma(
      s,
      c.map((x) => x.volume),
      n,
    ),
  ),
  ma('lsma', 'Least Squares MA (LSMA)', '#d4e157', (s, n) => ta.linreg(s, n)),
  {
    id: 'macross',
    name: 'MA Cross (2 lijnen)',
    category: 'Moving averages',
    overlay: true,
    params: [
      num('fast', 'Snel', 50),
      num('slow', 'Traag', 200),
      { key: 'type', label: 'Type', type: 'select', default: 'SMA', options: ['SMA', 'EMA'] },
    ],
    outputs: [
      { key: 'fast', label: 'Snel', type: 'line', color: '#00bcd4' },
      { key: 'slow', label: 'Traag', type: 'line', color: '#f44336' },
    ],
    compute: (c, p) => {
      const f = p.type === 'EMA' ? ta.ema : ta.sma;
      const s = ta.source(c, 'close');
      return { fast: f(s, N(p, 'fast')), slow: f(s, N(p, 'slow')) };
    },
  },
  {
    id: 'vwap',
    name: 'VWAP',
    category: 'Moving averages',
    overlay: true,
    params: [{ key: 'anchor', label: 'Anker', type: 'select', default: 'Session', options: ['Session', 'Week', 'Month'] }, { ...src, default: 'hlc3' }],
    outputs: [{ key: 'value', label: 'VWAP', type: 'line', color: '#2196f3' }],
    compute: (c, p) => ({ value: ta.vwap(c, String(p.anchor), S(c, p)) }),
  },

  // ---- Bands & channels ----
  {
    id: 'bb',
    name: 'Bollinger Bands',
    category: 'Bands & channels',
    overlay: true,
    params: [len(20), num('mult', 'StdDev', 2, 0.1, 0.1), src],
    outputs: [
      { key: 'upper', label: 'Boven', type: 'line', color: '#f23645' },
      { key: 'basis', label: 'Basis', type: 'line', color: '#ff9800' },
      { key: 'lower', label: 'Onder', type: 'line', color: '#089981' },
    ],
    compute: (c, p) => ta.bollinger(S(c, p), N(p, 'length'), N(p, 'mult')),
  },
  {
    id: 'keltner',
    name: 'Keltner Channels',
    category: 'Bands & channels',
    overlay: true,
    params: [len(20), num('mult', 'Multiplier', 2, 0.1, 0.1), num('atr', 'ATR lengte', 10)],
    outputs: [
      { key: 'upper', label: 'Boven', type: 'line', color: '#2962ff' },
      { key: 'basis', label: 'Basis', type: 'line', color: '#2962ff', dashed: true },
      { key: 'lower', label: 'Onder', type: 'line', color: '#2962ff' },
    ],
    compute: (c, p) => {
      const basis = ta.ema(ta.source(c), N(p, 'length'));
      const a = ta.atr(c, N(p, 'atr'));
      return {
        basis,
        upper: basis.map((b, i) => b + N(p, 'mult') * a[i]),
        lower: basis.map((b, i) => b - N(p, 'mult') * a[i]),
      };
    },
  },
  {
    id: 'donchian',
    name: 'Donchian Channels',
    category: 'Bands & channels',
    overlay: true,
    params: [len(20)],
    outputs: [
      { key: 'upper', label: 'Boven', type: 'line', color: '#26a69a' },
      { key: 'mid', label: 'Midden', type: 'line', color: '#ff6d00', dashed: true },
      { key: 'lower', label: 'Onder', type: 'line', color: '#ef5350' },
    ],
    compute: (c, p) => {
      const upper = ta.highest(
        c.map((x) => x.high),
        N(p, 'length'),
      );
      const lower = ta.lowest(
        c.map((x) => x.low),
        N(p, 'length'),
      );
      return { upper, lower, mid: upper.map((u, i) => (u + lower[i]) / 2) };
    },
  },
  {
    id: 'envelope',
    name: 'Envelope',
    category: 'Bands & channels',
    overlay: true,
    params: [len(20), num('pct', 'Procent', 2.5, 0.1, 0.1)],
    outputs: [
      { key: 'upper', label: 'Boven', type: 'line', color: '#2962ff' },
      { key: 'basis', label: 'Basis', type: 'line', color: '#ff6d00' },
      { key: 'lower', label: 'Onder', type: 'line', color: '#2962ff' },
    ],
    compute: (c, p) => {
      const basis = ta.sma(ta.source(c), N(p, 'length'));
      const k = N(p, 'pct') / 100;
      return { basis, upper: basis.map((b) => b * (1 + k)), lower: basis.map((b) => b * (1 - k)) };
    },
  },

  // ---- Trend ----
  {
    id: 'ichimoku',
    name: 'Ichimoku Cloud',
    category: 'Trend',
    overlay: true,
    params: [num('conv', 'Tenkan', 9), num('base', 'Kijun', 26), num('spanB', 'Senkou B', 52), num('disp', 'Verschuiving', 26)],
    outputs: [
      { key: 'tenkan', label: 'Tenkan', type: 'line', color: '#2962ff' },
      { key: 'kijun', label: 'Kijun', type: 'line', color: '#b71c1c' },
      { key: 'chikou', label: 'Chikou', type: 'line', color: '#43a047', offset: (p) => -(N(p, 'disp') - 1) },
      { key: 'spanA', label: 'Senkou A', type: 'line', color: '#a5d6a7', offset: (p) => N(p, 'disp') - 1 },
      { key: 'spanB', label: 'Senkou B', type: 'line', color: '#ef9a9a', offset: (p) => N(p, 'disp') - 1 },
    ],
    compute: (c, p) => ta.ichimoku(c, N(p, 'conv'), N(p, 'base'), N(p, 'spanB')),
  },
  {
    id: 'psar',
    name: 'Parabolic SAR',
    category: 'Trend',
    overlay: true,
    params: [num('start', 'Start', 0.02, 0.01, 0.001), num('inc', 'Stap', 0.02, 0.01, 0.001), num('max', 'Max', 0.2, 0.01, 0.01)],
    outputs: [{ key: 'value', label: 'SAR', type: 'line', color: '#2962ff', lineWidth: 1, dashed: true }],
    compute: (c, p) => ({ value: ta.parabolicSar(c, N(p, 'start'), N(p, 'inc'), N(p, 'max')) }),
  },
  {
    id: 'supertrend',
    name: 'SuperTrend',
    category: 'Trend',
    overlay: true,
    params: [num('length', 'ATR lengte', 10), num('mult', 'Factor', 3, 0.1, 0.1)],
    outputs: [
      { key: 'up', label: 'Op', type: 'line', color: '#089981', lineWidth: 2 },
      { key: 'down', label: 'Neer', type: 'line', color: '#f23645', lineWidth: 2 },
    ],
    compute: (c, p) => ta.supertrend(c, N(p, 'length'), N(p, 'mult')),
  },
  {
    id: 'adx',
    name: 'ADX / DMI',
    category: 'Trend',
    overlay: false,
    params: [num('di', 'DI lengte', 14), num('adx', 'ADX smoothing', 14)],
    outputs: [
      { key: 'adx', label: 'ADX', type: 'line', color: '#ff9800', lineWidth: 2 },
      { key: 'plus', label: '+DI', type: 'line', color: '#089981' },
      { key: 'minus', label: '-DI', type: 'line', color: '#f23645' },
    ],
    levels: [25],
    compute: (c, p) => ta.dmi(c, N(p, 'di'), N(p, 'adx')),
  },
  {
    id: 'aroon',
    name: 'Aroon',
    category: 'Trend',
    overlay: false,
    params: [len(14)],
    outputs: [
      { key: 'up', label: 'Up', type: 'line', color: '#ff6d00' },
      { key: 'down', label: 'Down', type: 'line', color: '#2962ff' },
    ],
    compute: (c, p) => ta.aroon(c, N(p, 'length')),
  },
  {
    id: 'chop',
    name: 'Choppiness Index',
    category: 'Trend',
    overlay: false,
    params: [len(14)],
    outputs: [{ key: 'value', label: 'CHOP', type: 'line', color: '#2962ff' }],
    levels: [38.2, 61.8],
    compute: (c, p) => {
      const n = N(p, 'length');
      const trSum = ta.sma(ta.trueRange(c), n).map((v) => v * n);
      const hh = ta.highest(
        c.map((x) => x.high),
        n,
      );
      const ll = ta.lowest(
        c.map((x) => x.low),
        n,
      );
      return { value: trSum.map((s, i) => (100 * Math.log10(s / (hh[i] - ll[i]))) / Math.log10(n)) };
    },
  },

  // ---- Oscillators ----
  {
    id: 'rsi',
    name: 'Relative Strength Index (RSI)',
    category: 'Oscillators',
    overlay: false,
    params: [len(14), src],
    outputs: [{ key: 'value', label: 'RSI', type: 'line', color: '#7e57c2' }],
    levels: [30, 50, 70],
    compute: (c, p) => ({ value: ta.rsi(S(c, p), N(p, 'length')) }),
  },
  {
    id: 'macd',
    name: 'MACD',
    category: 'Oscillators',
    overlay: false,
    params: [num('fast', 'Snel', 12), num('slow', 'Traag', 26), num('signal', 'Signaal', 9), src],
    outputs: [
      { key: 'hist', label: 'Histogram', type: 'histogram', color: '#26a69a', colorBy: 'sign' },
      { key: 'macd', label: 'MACD', type: 'line', color: '#2962ff' },
      { key: 'signal', label: 'Signaal', type: 'line', color: '#ff6d00' },
    ],
    levels: [0],
    compute: (c, p) => ta.macd(S(c, p), N(p, 'fast'), N(p, 'slow'), N(p, 'signal')),
  },
  {
    id: 'stoch',
    name: 'Stochastic',
    category: 'Oscillators',
    overlay: false,
    params: [len(14, '%K lengte'), num('smoothK', '%K smoothing', 1), num('smoothD', '%D smoothing', 3)],
    outputs: [
      { key: 'k', label: '%K', type: 'line', color: '#2962ff' },
      { key: 'd', label: '%D', type: 'line', color: '#ff6d00' },
    ],
    levels: [20, 80],
    compute: (c, p) => ta.stochastic(c, N(p, 'length'), N(p, 'smoothK'), N(p, 'smoothD')),
  },
  {
    id: 'stochrsi',
    name: 'Stochastic RSI',
    category: 'Oscillators',
    overlay: false,
    params: [num('rsi', 'RSI lengte', 14), num('stoch', 'Stoch lengte', 14), num('smoothK', 'K', 3), num('smoothD', 'D', 3)],
    outputs: [
      { key: 'k', label: 'K', type: 'line', color: '#2962ff' },
      { key: 'd', label: 'D', type: 'line', color: '#ff6d00' },
    ],
    levels: [20, 80],
    compute: (c, p) => ta.stochRsi(ta.source(c), N(p, 'rsi'), N(p, 'stoch'), N(p, 'smoothK'), N(p, 'smoothD')),
  },
  {
    id: 'cci',
    name: 'Commodity Channel Index (CCI)',
    category: 'Oscillators',
    overlay: false,
    params: [len(20)],
    outputs: [{ key: 'value', label: 'CCI', type: 'line', color: '#2962ff' }],
    levels: [-100, 0, 100],
    compute: (c, p) => ({ value: ta.cci(c, N(p, 'length')) }),
  },
  {
    id: 'willr',
    name: 'Williams %R',
    category: 'Oscillators',
    overlay: false,
    params: [len(14)],
    outputs: [{ key: 'value', label: '%R', type: 'line', color: '#7e57c2' }],
    levels: [-80, -20],
    compute: (c, p) => ({ value: ta.williamsR(c, N(p, 'length')) }),
  },
  {
    id: 'roc',
    name: 'Rate of Change (ROC)',
    category: 'Oscillators',
    overlay: false,
    params: [len(9), src],
    outputs: [{ key: 'value', label: 'ROC', type: 'line', color: '#2962ff' }],
    levels: [0],
    compute: (c, p) => {
      const s = S(c, p);
      const n = N(p, 'length');
      return { value: s.map((v, i) => (i >= n ? (100 * (v - s[i - n])) / s[i - n] : NaN)) };
    },
  },
  {
    id: 'mom',
    name: 'Momentum',
    category: 'Oscillators',
    overlay: false,
    params: [len(10), src],
    outputs: [{ key: 'value', label: 'MOM', type: 'line', color: '#2962ff' }],
    levels: [0],
    compute: (c, p) => ({ value: ta.change(S(c, p), N(p, 'length')) }),
  },
  {
    id: 'ao',
    name: 'Awesome Oscillator',
    category: 'Oscillators',
    overlay: false,
    params: [],
    outputs: [{ key: 'value', label: 'AO', type: 'histogram', color: '#26a69a', colorBy: 'sign' }],
    compute: (c) => {
      const hl2 = ta.source(c, 'hl2');
      const f = ta.sma(hl2, 5);
      const s = ta.sma(hl2, 34);
      return { value: f.map((v, i) => v - s[i]) };
    },
  },
  {
    id: 'trix',
    name: 'TRIX',
    category: 'Oscillators',
    overlay: false,
    params: [len(18)],
    outputs: [{ key: 'value', label: 'TRIX', type: 'line', color: '#f23645' }],
    levels: [0],
    compute: (c, p) => {
      const n = N(p, 'length');
      const e = ta.ema(ta.ema(ta.ema(ta.source(c).map(Math.log), n), n), n);
      return { value: ta.change(e).map((v) => v * 10000) };
    },
  },
  {
    id: 'uo',
    name: 'Ultimate Oscillator',
    category: 'Oscillators',
    overlay: false,
    params: [num('fast', 'Snel', 7), num('mid', 'Midden', 14), num('slow', 'Traag', 28)],
    outputs: [{ key: 'value', label: 'UO', type: 'line', color: '#f23645' }],
    levels: [30, 70],
    compute: (c, p) => {
      const bp = c.map((x, i) => x.close - Math.min(x.low, i ? c[i - 1].close : x.low));
      const tr = ta.trueRange(c);
      const avg = (n: number) => {
        const b = ta.sma(bp, n);
        const t = ta.sma(tr, n);
        return b.map((v, i) => v / t[i]);
      };
      const a1 = avg(N(p, 'fast'));
      const a2 = avg(N(p, 'mid'));
      const a3 = avg(N(p, 'slow'));
      return { value: a1.map((v, i) => (100 * (4 * v + 2 * a2[i] + a3[i])) / 7) };
    },
  },
  {
    id: 'cmo',
    name: 'Chande Momentum Oscillator',
    category: 'Oscillators',
    overlay: false,
    params: [len(9)],
    outputs: [{ key: 'value', label: 'CMO', type: 'line', color: '#2962ff' }],
    levels: [-50, 0, 50],
    compute: (c, p) => {
      const ch = ta.change(ta.source(c));
      const n = N(p, 'length');
      const up = ta.sma(
        ch.map((v) => Math.max(v, 0)),
        n,
      );
      const dn = ta.sma(
        ch.map((v) => Math.max(-v, 0)),
        n,
      );
      return { value: up.map((u, i) => (u + dn[i] === 0 ? 0 : (100 * (u - dn[i])) / (u + dn[i]))) };
    },
  },
  {
    id: 'dpo',
    name: 'Detrended Price Oscillator',
    category: 'Oscillators',
    overlay: false,
    params: [len(21)],
    outputs: [{ key: 'value', label: 'DPO', type: 'line', color: '#43a047' }],
    levels: [0],
    compute: (c, p) => {
      const n = N(p, 'length');
      const shift = Math.floor(n / 2) + 1;
      const s = ta.source(c);
      const m = ta.sma(s, n);
      return { value: s.map((v, i) => (i >= shift ? v - m[i - shift] : NaN)) };
    },
  },

  // ---- Volume ----
  {
    id: 'volume',
    name: 'Volume',
    category: 'Volume',
    overlay: false,
    params: [num('ma', 'MA lengte', 20)],
    outputs: [
      { key: 'volume', label: 'Volume', type: 'histogram', color: '#26a69a', colorBy: 'candle' },
      { key: 'ma', label: 'MA', type: 'line', color: '#2962ff' },
    ],
    compute: (c, p) => {
      const v = c.map((x) => x.volume);
      return { volume: v, ma: ta.sma(v, N(p, 'ma')) };
    },
  },
  {
    id: 'obv',
    name: 'On Balance Volume (OBV)',
    category: 'Volume',
    overlay: false,
    params: [],
    outputs: [{ key: 'value', label: 'OBV', type: 'line', color: '#2962ff' }],
    compute: (c) => ({ value: ta.obv(c) }),
  },
  {
    id: 'mfi',
    name: 'Money Flow Index (MFI)',
    category: 'Volume',
    overlay: false,
    params: [len(14)],
    outputs: [{ key: 'value', label: 'MFI', type: 'line', color: '#7e57c2' }],
    levels: [20, 80],
    compute: (c, p) => ({ value: ta.mfi(c, N(p, 'length')) }),
  },
  {
    id: 'cmf',
    name: 'Chaikin Money Flow (CMF)',
    category: 'Volume',
    overlay: false,
    params: [len(20)],
    outputs: [{ key: 'value', label: 'CMF', type: 'line', color: '#43a047' }],
    levels: [0],
    compute: (c, p) => ({ value: ta.cmf(c, N(p, 'length')) }),
  },
  {
    id: 'ad',
    name: 'Accumulation/Distribution',
    category: 'Volume',
    overlay: false,
    params: [],
    outputs: [{ key: 'value', label: 'A/D', type: 'line', color: '#ff9800' }],
    compute: (c) => ({ value: ta.accDist(c) }),
  },
  {
    id: 'efi',
    name: 'Elder Force Index',
    category: 'Volume',
    overlay: false,
    params: [len(13)],
    outputs: [{ key: 'value', label: 'EFI', type: 'line', color: '#f23645' }],
    levels: [0],
    compute: (c, p) => ({
      value: ta.ema(
        c.map((x, i) => (i ? (x.close - c[i - 1].close) * x.volume : NaN)),
        N(p, 'length'),
      ),
    }),
  },

  // ---- Volatility ----
  {
    id: 'atr',
    name: 'Average True Range (ATR)',
    category: 'Volatility',
    overlay: false,
    params: [len(14)],
    outputs: [{ key: 'value', label: 'ATR', type: 'line', color: '#f23645' }],
    compute: (c, p) => ({ value: ta.atr(c, N(p, 'length')) }),
  },
  {
    id: 'stdev',
    name: 'Standard Deviation',
    category: 'Volatility',
    overlay: false,
    params: [len(20), src],
    outputs: [{ key: 'value', label: 'StdDev', type: 'line', color: '#2962ff' }],
    compute: (c, p) => ({ value: ta.stdev(S(c, p), N(p, 'length')) }),
  },
  {
    id: 'bbw',
    name: 'Bollinger BandWidth',
    category: 'Volatility',
    overlay: false,
    params: [len(20), num('mult', 'StdDev', 2, 0.1, 0.1)],
    outputs: [{ key: 'value', label: 'BBW', type: 'line', color: '#2962ff' }],
    compute: (c, p) => {
      const b = ta.bollinger(ta.source(c), N(p, 'length'), N(p, 'mult'));
      return { value: b.basis.map((m, i) => (100 * (b.upper[i] - b.lower[i])) / m) };
    },
  },
  {
    id: 'hv',
    name: 'Historical Volatility',
    category: 'Volatility',
    overlay: false,
    params: [len(10), num('annual', 'Bars per jaar', 365)],
    outputs: [{ key: 'value', label: 'HV', type: 'line', color: '#2962ff' }],
    compute: (c, p) => {
      const s = ta.source(c);
      const r = s.map((v, i) => (i ? Math.log(v / s[i - 1]) : NaN));
      return { value: ta.stdev(r, N(p, 'length')).map((v) => 100 * v * Math.sqrt(N(p, 'annual'))) };
    },
  },
];

export const INDICATOR_MAP = new Map(INDICATORS.map((d) => [d.id, d]));

export function defaultParams(defs: ParamDef[]): Params {
  return Object.fromEntries(defs.map((d) => [d.key, d.default]));
}

export function resolveOffset(o: OutputDef, p: Params): number {
  return typeof o.offset === 'function' ? o.offset(p) : (o.offset ?? 0);
}
