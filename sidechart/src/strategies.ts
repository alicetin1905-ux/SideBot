import type { Candle, ParamDef, Params, Series } from './types';
import * as ta from './ta';

export interface Signals {
  entryLong: boolean[];
  exitLong: boolean[];
  entryShort: boolean[];
  exitShort: boolean[];
}

export interface StrategyDef {
  id: string;
  name: string;
  description: string;
  params: ParamDef[];
  /** Indicators to draw on the chart while this strategy is active. */
  indicators?: (p: Params) => { id: string; params: Params }[];
  signals(c: Candle[], p: Params): Signals;
}

const num = (key: string, label: string, def: number, step = 1, min = 1): ParamDef => ({
  key,
  label,
  type: 'number',
  default: def,
  step,
  min,
});
const N = (p: Params, k: string) => Number(p[k]);
const close = (c: Candle[]) => c.map((x) => x.close);

function blank(n: number): Signals {
  const f = () => new Array<boolean>(n).fill(false);
  return { entryLong: f(), exitLong: f(), entryShort: f(), exitShort: f() };
}

/** Build signals where a bullish event opens long / closes short, and vice versa. */
function fromEvents(n: number, bull: (i: number) => boolean, bear: (i: number) => boolean): Signals {
  const s = blank(n);
  for (let i = 0; i < n; i++) {
    if (bull(i)) s.entryLong[i] = s.exitShort[i] = true;
    if (bear(i)) s.entryShort[i] = s.exitLong[i] = true;
  }
  return s;
}

const maType: ParamDef = { key: 'type', label: 'Type', type: 'select', default: 'EMA', options: ['SMA', 'EMA', 'WMA', 'HMA'] };
const maFn = (t: unknown) => (t === 'SMA' ? ta.sma : t === 'WMA' ? ta.wma : t === 'HMA' ? ta.hma : ta.ema);

export const STRATEGIES: StrategyDef[] = [
  {
    id: 'ma_cross',
    name: 'MA Crossover',
    description: 'Koop als het snelle gemiddelde boven het trage kruist, verkoop bij kruising omlaag.',
    params: [num('fast', 'Snel', 9), num('slow', 'Traag', 21), maType],
    indicators: (p) => [
      { id: String(p.type).toLowerCase(), params: { length: p.fast, source: 'close' } },
      { id: String(p.type).toLowerCase(), params: { length: p.slow, source: 'close' } },
    ],
    signals: (c, p) => {
      const f = maFn(p.type)(close(c), N(p, 'fast'));
      const s = maFn(p.type)(close(c), N(p, 'slow'));
      return fromEvents(c.length, (i) => ta.crossover(f, s, i), (i) => ta.crossunder(f, s, i));
    },
  },
  {
    id: 'golden_cross',
    name: 'Golden / Death Cross (50/200)',
    description: 'Klassieke lange-termijn trend: SMA 50 kruist SMA 200.',
    params: [num('fast', 'Snel', 50), num('slow', 'Traag', 200)],
    indicators: (p) => [{ id: 'macross', params: { fast: p.fast, slow: p.slow, type: 'SMA' } }],
    signals: (c, p) => {
      const f = ta.sma(close(c), N(p, 'fast'));
      const s = ta.sma(close(c), N(p, 'slow'));
      return fromEvents(c.length, (i) => ta.crossover(f, s, i), (i) => ta.crossunder(f, s, i));
    },
  },
  {
    id: 'rsi_revert',
    name: 'RSI Overbought/Oversold',
    description: 'Koop als RSI terug boven oversold kruist, verkoop als hij onder overbought zakt.',
    params: [num('length', 'RSI lengte', 14), num('os', 'Oversold', 30), num('ob', 'Overbought', 70)],
    indicators: (p) => [{ id: 'rsi', params: { length: p.length, source: 'close' } }],
    signals: (c, p) => {
      const r = ta.rsi(close(c), N(p, 'length'));
      const os = new Array(c.length).fill(N(p, 'os'));
      const ob = new Array(c.length).fill(N(p, 'ob'));
      return fromEvents(c.length, (i) => ta.crossover(r, os, i), (i) => ta.crossunder(r, ob, i));
    },
  },
  {
    id: 'macd_cross',
    name: 'MACD Signal Cross',
    description: 'Koop als MACD boven de signaallijn kruist, verkoop bij kruising omlaag.',
    params: [num('fast', 'Snel', 12), num('slow', 'Traag', 26), num('signal', 'Signaal', 9)],
    indicators: (p) => [{ id: 'macd', params: { fast: p.fast, slow: p.slow, signal: p.signal, source: 'close' } }],
    signals: (c, p) => {
      const m = ta.macd(close(c), N(p, 'fast'), N(p, 'slow'), N(p, 'signal'));
      return fromEvents(c.length, (i) => ta.crossover(m.macd, m.signal, i), (i) => ta.crossunder(m.macd, m.signal, i));
    },
  },
  {
    id: 'bb_revert',
    name: 'Bollinger Mean Reversion',
    description: 'Koop als prijs terug boven de onderste band komt, sluit bij de middenlijn (short omgekeerd).',
    params: [num('length', 'Lengte', 20), num('mult', 'StdDev', 2, 0.1, 0.1)],
    indicators: (p) => [{ id: 'bb', params: { length: p.length, mult: p.mult, source: 'close' } }],
    signals: (c, p) => {
      const cl = close(c);
      const b = ta.bollinger(cl, N(p, 'length'), N(p, 'mult'));
      const s = blank(c.length);
      for (let i = 0; i < c.length; i++) {
        s.entryLong[i] = ta.crossover(cl, b.lower, i);
        s.exitLong[i] = ta.crossover(cl, b.basis, i);
        s.entryShort[i] = ta.crossunder(cl, b.upper, i);
        s.exitShort[i] = ta.crossunder(cl, b.basis, i);
      }
      return s;
    },
  },
  {
    id: 'bb_breakout',
    name: 'Bollinger Breakout',
    description: 'Koop bij een slot boven de bovenste band, sluit onder de middenlijn (short omgekeerd).',
    params: [num('length', 'Lengte', 20), num('mult', 'StdDev', 2, 0.1, 0.1)],
    indicators: (p) => [{ id: 'bb', params: { length: p.length, mult: p.mult, source: 'close' } }],
    signals: (c, p) => {
      const cl = close(c);
      const b = ta.bollinger(cl, N(p, 'length'), N(p, 'mult'));
      const s = blank(c.length);
      for (let i = 0; i < c.length; i++) {
        s.entryLong[i] = ta.crossover(cl, b.upper, i);
        s.exitLong[i] = ta.crossunder(cl, b.basis, i);
        s.entryShort[i] = ta.crossunder(cl, b.lower, i);
        s.exitShort[i] = ta.crossover(cl, b.basis, i);
      }
      return s;
    },
  },
  {
    id: 'supertrend',
    name: 'SuperTrend',
    description: 'Volg de trend: koop als SuperTrend naar boven omslaat, verkoop als hij omlaag omslaat.',
    params: [num('length', 'ATR lengte', 10), num('mult', 'Factor', 3, 0.1, 0.1)],
    indicators: (p) => [{ id: 'supertrend', params: { length: p.length, mult: p.mult } }],
    signals: (c, p) => {
      const { dir } = ta.supertrend(c, N(p, 'length'), N(p, 'mult'));
      return fromEvents(c.length, (i) => i > 0 && dir[i] === 1 && dir[i - 1] === -1, (i) => i > 0 && dir[i] === -1 && dir[i - 1] === 1);
    },
  },
  {
    id: 'donchian',
    name: 'Donchian Breakout (Turtle)',
    description: 'Koop bij een nieuwe N-bar high, sluit bij een M-bar low (short omgekeerd).',
    params: [num('entry', 'Entry lengte', 20), num('exit', 'Exit lengte', 10)],
    indicators: (p) => [{ id: 'donchian', params: { length: p.entry } }],
    signals: (c, p) => {
      const hi = c.map((x) => x.high);
      const lo = c.map((x) => x.low);
      const hhE = ta.highest(hi, N(p, 'entry'));
      const llE = ta.lowest(lo, N(p, 'entry'));
      const hhX = ta.highest(hi, N(p, 'exit'));
      const llX = ta.lowest(lo, N(p, 'exit'));
      const s = blank(c.length);
      for (let i = 1; i < c.length; i++) {
        s.entryLong[i] = c[i].close > hhE[i - 1];
        s.entryShort[i] = c[i].close < llE[i - 1];
        s.exitLong[i] = c[i].close < llX[i - 1];
        s.exitShort[i] = c[i].close > hhX[i - 1];
      }
      return s;
    },
  },
  {
    id: 'stoch_cross',
    name: 'Stochastic Cross',
    description: 'Koop als %K boven %D kruist in de oversold-zone, verkoop bij kruising omlaag in overbought.',
    params: [num('length', '%K lengte', 14), num('smoothK', '%K smoothing', 3), num('smoothD', '%D', 3), num('os', 'Oversold', 20), num('ob', 'Overbought', 80)],
    indicators: (p) => [{ id: 'stoch', params: { length: p.length, smoothK: p.smoothK, smoothD: p.smoothD } }],
    signals: (c, p) => {
      const { k, d } = ta.stochastic(c, N(p, 'length'), N(p, 'smoothK'), N(p, 'smoothD'));
      return fromEvents(
        c.length,
        (i) => ta.crossover(k, d, i) && k[i] < N(p, 'os') + 10,
        (i) => ta.crossunder(k, d, i) && k[i] > N(p, 'ob') - 10,
      );
    },
  },
  {
    id: 'psar',
    name: 'Parabolic SAR Flip',
    description: 'Koop als prijs boven de SAR komt, verkoop als hij eronder zakt.',
    params: [num('start', 'Start', 0.02, 0.01, 0.001), num('inc', 'Stap', 0.02, 0.01, 0.001), num('max', 'Max', 0.2, 0.01, 0.01)],
    indicators: (p) => [{ id: 'psar', params: { start: p.start, inc: p.inc, max: p.max } }],
    signals: (c, p) => {
      const sar = ta.parabolicSar(c, N(p, 'start'), N(p, 'inc'), N(p, 'max'));
      const cl = close(c);
      return fromEvents(c.length, (i) => ta.crossover(cl, sar, i), (i) => ta.crossunder(cl, sar, i));
    },
  },
  {
    id: 'ichimoku',
    name: 'Ichimoku Cloud Breakout',
    description: 'Koop als prijs boven de wolk uitbreekt en Tenkan > Kijun, verkoop omgekeerd.',
    params: [num('conv', 'Tenkan', 9), num('base', 'Kijun', 26), num('spanB', 'Senkou B', 52), num('disp', 'Verschuiving', 26)],
    indicators: (p) => [{ id: 'ichimoku', params: { conv: p.conv, base: p.base, spanB: p.spanB, disp: p.disp } }],
    signals: (c, p) => {
      const ich = ta.ichimoku(c, N(p, 'conv'), N(p, 'base'), N(p, 'spanB'));
      const d = N(p, 'disp') - 1;
      const cloudTop = c.map((_, i) => (i >= d ? Math.max(ich.spanA[i - d], ich.spanB[i - d]) : NaN));
      const cloudBot = c.map((_, i) => (i >= d ? Math.min(ich.spanA[i - d], ich.spanB[i - d]) : NaN));
      const cl = close(c);
      return fromEvents(
        c.length,
        (i) => ta.crossover(cl, cloudTop, i) && ich.tenkan[i] > ich.kijun[i],
        (i) => ta.crossunder(cl, cloudBot, i) && ich.tenkan[i] < ich.kijun[i],
      );
    },
  },
  {
    id: 'adx_di',
    name: 'ADX Trend + DI Cross',
    description: 'Koop als +DI boven -DI kruist terwijl ADX een sterke trend aangeeft.',
    params: [num('di', 'DI lengte', 14), num('adx', 'ADX smoothing', 14), num('threshold', 'ADX minimum', 25)],
    indicators: (p) => [{ id: 'adx', params: { di: p.di, adx: p.adx } }],
    signals: (c, p) => {
      const d = ta.dmi(c, N(p, 'di'), N(p, 'adx'));
      const t = N(p, 'threshold');
      return fromEvents(
        c.length,
        (i) => ta.crossover(d.plus, d.minus, i) && d.adx[i] > t,
        (i) => ta.crossunder(d.plus, d.minus, i) && d.adx[i] > t,
      );
    },
  },
  {
    id: 'trend_rsi',
    name: 'Trendfilter + RSI Pullback',
    description: 'Alleen kopen boven EMA 200 als RSI een dip maakt; alleen shorten eronder bij een piek.',
    params: [num('trend', 'Trend EMA', 200), num('length', 'RSI lengte', 14), num('os', 'Oversold', 35), num('ob', 'Overbought', 65)],
    indicators: (p) => [
      { id: 'ema', params: { length: p.trend, source: 'close' } },
      { id: 'rsi', params: { length: p.length, source: 'close' } },
    ],
    signals: (c, p) => {
      const cl = close(c);
      const e = ta.ema(cl, N(p, 'trend'));
      const r = ta.rsi(cl, N(p, 'length'));
      const os = new Array(c.length).fill(N(p, 'os'));
      const ob = new Array(c.length).fill(N(p, 'ob'));
      const s = blank(c.length);
      for (let i = 0; i < c.length; i++) {
        s.entryLong[i] = cl[i] > e[i] && ta.crossover(r, os, i);
        s.exitLong[i] = ta.crossover(r, ob, i) || ta.crossunder(cl, e, i);
        s.entryShort[i] = cl[i] < e[i] && ta.crossunder(r, ob, i);
        s.exitShort[i] = ta.crossunder(r, os, i) || ta.crossover(cl, e, i);
      }
      return s;
    },
  },
  {
    id: 'custom',
    name: 'Eigen regels (no-code)',
    description:
      'Schrijf je eigen regels, bv. "EMA(9) crosses above EMA(21) AND RSI(14) > 50". Laat een regel leeg om die kant over te slaan.',
    params: [],
    signals: () => blank(0), // replaced by custom rules in the backtest panel
  },
];

export const STRATEGY_MAP = new Map(STRATEGIES.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// No-code rule language
// ---------------------------------------------------------------------------

export const RULE_HELP = `Operanden: close, open, high, low, volume, hl2, hlc3, getallen (50, 0.5)
SMA(n) EMA(n) WMA(n) HMA(n) VWAP RSI(n) ATR(n) CCI(n) MFI(n) WILLR(n) ROC(n) OBV
ADX(n) PLUSDI(n) MINUSDI(n) MACD(f,s,sig) MACDSIGNAL(f,s,sig) MACDHIST(f,s,sig)
BBUPPER(n,k) BBMID(n,k) BBLOWER(n,k) STOCHK(n,k,d) STOCHD(n,k,d)
HIGHEST(n) LOWEST(n) SUPERTREND(n,f) PSAR  — gebruik PREV(...) voor de vorige bar
Operatoren: crosses above, crosses below, >, <, >=, <=
Combineer met AND / OR, bv: EMA(9) crosses above EMA(21) AND RSI(14) > 50`;

function operand(c: Candle[], raw: string, cache: Map<string, Series>): Series {
  const key = raw.trim().toUpperCase().replace(/\s+/g, '');
  const hit = cache.get(key);
  if (hit) return hit;
  let out: Series;
  const n = c.length;
  if (/^-?\d+(\.\d+)?$/.test(key)) {
    out = new Array(n).fill(parseFloat(key));
  } else if (['CLOSE', 'OPEN', 'HIGH', 'LOW', 'HL2', 'HLC3', 'OHLC4'].includes(key)) {
    out = ta.source(c, key.toLowerCase());
  } else if (key === 'VOLUME') {
    out = c.map((x) => x.volume);
  } else if (key === 'OBV') {
    out = ta.obv(c);
  } else if (key === 'VWAP') {
    out = ta.vwap(c, 'Session', ta.source(c, 'hlc3'));
  } else if (key === 'PSAR') {
    out = ta.parabolicSar(c, 0.02, 0.02, 0.2);
  } else {
    const m = /^([A-Z]+)\((.*)\)$/.exec(key);
    if (!m) throw new Error(`Onbekende operand: "${raw.trim()}"`);
    const fn = m[1];
    if (fn === 'PREV') {
      const inner = operand(c, m[2], cache);
      out = inner.map((_, i) => (i > 0 ? inner[i - 1] : NaN));
    } else {
      const a = m[2] ? m[2].split(',').map(Number) : [];
      if (a.some((x) => Number.isNaN(x))) throw new Error(`Ongeldige parameters in "${raw.trim()}"`);
      const arg = (i: number, d: number) => a[i] ?? d;
      const cl = close(c);
      switch (fn) {
        case 'SMA': out = ta.sma(cl, arg(0, 20)); break;
        case 'EMA': out = ta.ema(cl, arg(0, 20)); break;
        case 'WMA': out = ta.wma(cl, arg(0, 20)); break;
        case 'HMA': out = ta.hma(cl, arg(0, 20)); break;
        case 'RSI': out = ta.rsi(cl, arg(0, 14)); break;
        case 'ATR': out = ta.atr(c, arg(0, 14)); break;
        case 'CCI': out = ta.cci(c, arg(0, 20)); break;
        case 'MFI': out = ta.mfi(c, arg(0, 14)); break;
        case 'WILLR': out = ta.williamsR(c, arg(0, 14)); break;
        case 'ROC': {
          const k = arg(0, 9);
          out = cl.map((v, i) => (i >= k ? (100 * (v - cl[i - k])) / cl[i - k] : NaN));
          break;
        }
        case 'ADX': out = ta.dmi(c, arg(0, 14), arg(1, arg(0, 14))).adx; break;
        case 'PLUSDI': out = ta.dmi(c, arg(0, 14), 14).plus; break;
        case 'MINUSDI': out = ta.dmi(c, arg(0, 14), 14).minus; break;
        case 'MACD': out = ta.macd(cl, arg(0, 12), arg(1, 26), arg(2, 9)).macd; break;
        case 'MACDSIGNAL': out = ta.macd(cl, arg(0, 12), arg(1, 26), arg(2, 9)).signal; break;
        case 'MACDHIST': out = ta.macd(cl, arg(0, 12), arg(1, 26), arg(2, 9)).hist; break;
        case 'BBUPPER': out = ta.bollinger(cl, arg(0, 20), arg(1, 2)).upper; break;
        case 'BBMID': out = ta.bollinger(cl, arg(0, 20), arg(1, 2)).basis; break;
        case 'BBLOWER': out = ta.bollinger(cl, arg(0, 20), arg(1, 2)).lower; break;
        case 'STOCHK': out = ta.stochastic(c, arg(0, 14), arg(1, 3), arg(2, 3)).k; break;
        case 'STOCHD': out = ta.stochastic(c, arg(0, 14), arg(1, 3), arg(2, 3)).d; break;
        case 'HIGHEST': {
          // Highest high of the previous n bars (excluding the current bar), useful for breakouts.
          const h = ta.highest(c.map((x) => x.high), arg(0, 20));
          out = h.map((_, i) => (i > 0 ? h[i - 1] : NaN));
          break;
        }
        case 'LOWEST': {
          const l = ta.lowest(c.map((x) => x.low), arg(0, 20));
          out = l.map((_, i) => (i > 0 ? l[i - 1] : NaN));
          break;
        }
        case 'SUPERTREND': {
          const st = ta.supertrend(c, arg(0, 10), arg(1, 3));
          out = st.up.map((u, i) => (Number.isNaN(u) ? st.down[i] : u));
          break;
        }
        default:
          throw new Error(`Onbekende functie: ${fn}`);
      }
    }
  }
  cache.set(key, out);
  return out;
}

/** Compile a rule string into a per-bar boolean array. Empty rule = never true. */
export function evalRule(c: Candle[], rule: string, cache = new Map<string, Series>()): boolean[] {
  const res = new Array<boolean>(c.length).fill(false);
  if (!rule.trim()) return res;
  const orParts = rule.split(/\s+OR\s+/i);
  const groups = orParts.map((part) =>
    part.split(/\s+AND\s+/i).map((cond) => {
      const m = /^(.+?)\s*(crosses\s+above|crosses\s+below|>=|<=|>|<)\s*(.+)$/i.exec(cond.trim());
      if (!m) throw new Error(`Kan regel niet lezen: "${cond.trim()}"`);
      return { a: operand(c, m[1], cache), op: m[2].toLowerCase().replace(/\s+/g, ' '), b: operand(c, m[3], cache) };
    }),
  );
  for (let i = 0; i < c.length; i++) {
    res[i] = groups.some((g) =>
      g.every(({ a, op, b }) => {
        switch (op) {
          case 'crosses above': return ta.crossover(a, b, i);
          case 'crosses below': return ta.crossunder(a, b, i);
          case '>': return a[i] > b[i];
          case '<': return a[i] < b[i];
          case '>=': return a[i] >= b[i];
          case '<=': return a[i] <= b[i];
          default: return false;
        }
      }),
    );
  }
  return res;
}

export interface CustomRules {
  entryLong: string;
  exitLong: string;
  entryShort: string;
  exitShort: string;
}

export function customSignals(c: Candle[], r: CustomRules): Signals {
  const cache = new Map<string, Series>();
  return {
    entryLong: evalRule(c, r.entryLong, cache),
    exitLong: evalRule(c, r.exitLong, cache),
    entryShort: evalRule(c, r.entryShort, cache),
    exitShort: evalRule(c, r.exitShort, cache),
  };
}
