import type { Candle, ParamDef, Params, Series } from './types';
import * as ta from './ta';
import { align, type ExtData } from './indicators';
import type { ExtKind } from './exchanges/types';

export interface Signals {
  entryLong: boolean[];
  exitLong: boolean[];
  entryShort: boolean[];
  exitShort: boolean[];
}

type IndRef = { id: string; params: Params };

export interface StrategyDef {
  id: string;
  name: string;
  description: string;
  params: ParamDef[];
  /** Indicators to draw on the chart while this strategy is active. */
  indicators?: (p: Params) => IndRef[];
  /** Futures data the strategy needs */
  external?: ExtKind[];
  signals(c: Candle[], p: Params, ext: ExtData): Signals;
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
    id: 'funding_contra',
    name: '⚡ Funding Contrarian',
    description:
      'Futures: ga tegen de massa in. Short als de funding uitzonderlijk hoog is vergeleken met normaal (te veel longs), long als hij uitzonderlijk laag is. Sluit als funding weer normaal wordt. Werkt met de echte funding-historie (~3 maanden).',
    params: [num('lookback', 'Vergelijk met laatste N bars', 240, 10, 20), num('z', 'Extreem bij z-score', 2, 0.1, 0.5), num('trend', 'Trend EMA (0 = uit)', 0, 1, 0)],
    external: ['funding'],
    indicators: (p): IndRef[] => [{ id: 'funding', params: { mode: 'Per periode %' } }, ...(N(p, 'trend') > 0 ? [{ id: 'ema', params: { length: p.trend, source: 'close' } }] : [])],
    signals: (c, p, ext) => {
      const f = align(c, ext.funding);
      const L = N(p, 'lookback');
      const mean = ta.sma(f, L);
      const sd = ta.stdev(f, L);
      // How unusual the current funding is compared with the recent past.
      const z = f.map((v, i) => (sd[i] > 0 ? (v - mean[i]) / sd[i] : 0));
      const zt = N(p, 'z');
      const e = N(p, 'trend') > 0 ? ta.ema(close(c), N(p, 'trend')) : null;
      const s = blank(c.length);
      for (let i = 1; i < c.length; i++) {
        if (!Number.isFinite(f[i]) || !Number.isFinite(mean[i])) continue;
        const okLong = !e || c[i].close > e[i];
        const okShort = !e || c[i].close < e[i];
        s.entryLong[i] = z[i] <= -zt && z[i - 1] > -zt && okLong;
        s.entryShort[i] = z[i] >= zt && z[i - 1] < zt && okShort;
        s.exitLong[i] = z[i] > -0.5 && z[i - 1] <= -0.5;
        s.exitShort[i] = z[i] < 0.5 && z[i - 1] >= 0.5;
      }
      return s;
    },
  },
  {
    id: 'ma_cross',
    name: 'MA Crossover',
    description: 'Koop als het snelle gemiddelde boven het trage kruist, verkoop bij kruising omlaag.',
    params: [num('fast', 'Snel', 9), num('slow', 'Traag', 21), maType],
    indicators: (p): IndRef[] => [
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
    indicators: (p): IndRef[] => [{ id: 'macross', params: { fast: p.fast, slow: p.slow, type: 'SMA' } }],
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
    indicators: (p): IndRef[] => [{ id: 'rsi', params: { length: p.length, source: 'close' } }],
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
    indicators: (p): IndRef[] => [{ id: 'macd', params: { fast: p.fast, slow: p.slow, signal: p.signal, source: 'close' } }],
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
    indicators: (p): IndRef[] => [{ id: 'bb', params: { length: p.length, mult: p.mult, source: 'close' } }],
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
    indicators: (p): IndRef[] => [{ id: 'bb', params: { length: p.length, mult: p.mult, source: 'close' } }],
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
    indicators: (p): IndRef[] => [{ id: 'supertrend', params: { length: p.length, mult: p.mult } }],
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
    indicators: (p): IndRef[] => [{ id: 'donchian', params: { length: p.entry } }],
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
    indicators: (p): IndRef[] => [{ id: 'stoch', params: { length: p.length, smoothK: p.smoothK, smoothD: p.smoothD } }],
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
    indicators: (p): IndRef[] => [{ id: 'psar', params: { start: p.start, inc: p.inc, max: p.max } }],
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
    indicators: (p): IndRef[] => [{ id: 'ichimoku', params: { conv: p.conv, base: p.base, spanB: p.spanB, disp: p.disp } }],
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
    indicators: (p): IndRef[] => [{ id: 'adx', params: { di: p.di, adx: p.adx } }],
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
    indicators: (p): IndRef[] => [
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
    id: 'squeeze',
    name: 'Squeeze Breakout (BB in Keltner)',
    description:
      'Volatiliteit loopt op als de Bollinger Bands binnen de Keltner Channels zakken (de "squeeze"). Zodra de squeeze loslaat: koop bij momentum omhoog, short bij momentum omlaag. Sluit als het momentum keert.',
    params: [num('length', 'Lengte', 20), num('bbMult', 'BB StdDev', 2, 0.1, 0.1), num('kcMult', 'Keltner factor', 1.5, 0.1, 0.1)],
    indicators: (p): IndRef[] => [
      { id: 'bb', params: { length: p.length, mult: p.bbMult, source: 'close' } },
      { id: 'keltner', params: { length: p.length, mult: p.kcMult, atr: p.length } },
    ],
    signals: (c, p) => {
      const n = N(p, 'length');
      const cl = close(c);
      const bb = ta.bollinger(cl, n, N(p, 'bbMult'));
      const mid = ta.ema(cl, n);
      const a = ta.atr(c, n);
      const squeeze = cl.map((_, i) => bb.upper[i] < mid[i] + N(p, 'kcMult') * a[i] && bb.lower[i] > mid[i] - N(p, 'kcMult') * a[i]);
      // Momentum: price relative to the mid of the recent range and its average (like the TTM squeeze)
      const hh = ta.highest(c.map((x) => x.high), n);
      const ll = ta.lowest(c.map((x) => x.low), n);
      const avg = ta.sma(cl, n);
      const mom = ta.linreg(cl.map((v, i) => v - ((hh[i] + ll[i]) / 2 + avg[i]) / 2), n);
      const s = blank(c.length);
      for (let i = 1; i < c.length; i++) {
        const fired = squeeze[i - 1] && !squeeze[i];
        s.entryLong[i] = fired && mom[i] > 0;
        s.entryShort[i] = fired && mom[i] < 0;
        s.exitLong[i] = mom[i] < mom[i - 1] && mom[i - 1] >= (mom[i - 2] ?? -Infinity);
        s.exitShort[i] = mom[i] > mom[i - 1] && mom[i - 1] <= (mom[i - 2] ?? Infinity);
      }
      return s;
    },
  },
  {
    id: 'chandelier',
    name: 'Chandelier Exit (ATR trend)',
    description: 'Trendvolger met een ATR-stop vanaf de hoogste high / laagste low. Koop als de prijs boven de short-stop breekt, short als hij onder de long-stop zakt.',
    params: [num('length', 'Lengte', 22), num('mult', 'ATR factor', 3, 0.1, 0.1)],
    indicators: (p): IndRef[] => [{ id: 'atr', params: { length: p.length } }],
    signals: (c, p) => {
      const n = N(p, 'length');
      const a = ta.atr(c, n);
      const hh = ta.highest(c.map((x) => x.close), n);
      const ll = ta.lowest(c.map((x) => x.close), n);
      const dir: number[] = new Array(c.length).fill(0);
      let longStop = NaN;
      let shortStop = NaN;
      for (let i = 1; i < c.length; i++) {
        const ls = hh[i] - N(p, 'mult') * a[i];
        const ss = ll[i] + N(p, 'mult') * a[i];
        longStop = c[i - 1].close > longStop ? Math.max(ls, longStop) : ls;
        shortStop = c[i - 1].close < shortStop ? Math.min(ss, shortStop) : ss;
        dir[i] = c[i].close > shortStop ? 1 : c[i].close < longStop ? -1 : dir[i - 1];
      }
      return fromEvents(c.length, (i) => i > 0 && dir[i] === 1 && dir[i - 1] !== 1, (i) => i > 0 && dir[i] === -1 && dir[i - 1] !== -1);
    },
  },
  {
    id: 'ema_ribbon',
    name: 'EMA Ribbon (8/21/55)',
    description: 'Koop als de drie EMA\'s netjes op volgorde liggen (8 > 21 > 55) en de prijs erboven staat; short omgekeerd. Sluit zodra de volgorde breekt.',
    params: [num('fast', 'Snel', 8), num('mid', 'Midden', 21), num('slow', 'Traag', 55)],
    indicators: (p): IndRef[] => [
      { id: 'ema', params: { length: p.fast, source: 'close' } },
      { id: 'ema', params: { length: p.mid, source: 'close' } },
      { id: 'ema', params: { length: p.slow, source: 'close' } },
    ],
    signals: (c, p) => {
      const cl = close(c);
      const f = ta.ema(cl, N(p, 'fast'));
      const m = ta.ema(cl, N(p, 'mid'));
      const sl = ta.ema(cl, N(p, 'slow'));
      const bull = cl.map((v, i) => v > f[i] && f[i] > m[i] && m[i] > sl[i]);
      const bear = cl.map((v, i) => v < f[i] && f[i] < m[i] && m[i] < sl[i]);
      const s = blank(c.length);
      for (let i = 1; i < c.length; i++) {
        s.entryLong[i] = bull[i] && !bull[i - 1];
        s.entryShort[i] = bear[i] && !bear[i - 1];
        s.exitLong[i] = f[i] < m[i];
        s.exitShort[i] = f[i] > m[i];
      }
      return s;
    },
  },
  {
    id: 'hull_trend',
    name: 'Hull MA Trend',
    description: 'De Hull Moving Average reageert snel en glad. Koop als hij omhoog draait, short als hij omlaag draait.',
    params: [num('length', 'Lengte', 55)],
    indicators: (p): IndRef[] => [{ id: 'hma', params: { length: p.length, source: 'close' } }],
    signals: (c, p) => {
      const h = ta.hma(close(c), N(p, 'length'));
      return fromEvents(
        c.length,
        (i) => i > 1 && h[i] > h[i - 1] && h[i - 1] <= h[i - 2],
        (i) => i > 1 && h[i] < h[i - 1] && h[i - 1] >= h[i - 2],
      );
    },
  },
  {
    id: 'keltner_breakout',
    name: 'Keltner Breakout',
    description: 'Koop bij een slot boven het bovenste Keltner Channel, short onder het onderste. Sluit terug bij de middenlijn.',
    params: [num('length', 'Lengte', 20), num('mult', 'ATR factor', 2, 0.1, 0.1)],
    indicators: (p): IndRef[] => [{ id: 'keltner', params: { length: p.length, mult: p.mult, atr: 10 } }],
    signals: (c, p) => {
      const cl = close(c);
      const mid = ta.ema(cl, N(p, 'length'));
      const a = ta.atr(c, 10);
      const up = mid.map((m, i) => m + N(p, 'mult') * a[i]);
      const dn = mid.map((m, i) => m - N(p, 'mult') * a[i]);
      const s = blank(c.length);
      for (let i = 0; i < c.length; i++) {
        s.entryLong[i] = ta.crossover(cl, up, i);
        s.entryShort[i] = ta.crossunder(cl, dn, i);
        s.exitLong[i] = ta.crossunder(cl, mid, i);
        s.exitShort[i] = ta.crossover(cl, mid, i);
      }
      return s;
    },
  },
  {
    id: 'vwap_trend',
    name: 'VWAP Trend (intraday)',
    description: 'Voor korte timeframes: koop als de prijs boven de dag-VWAP kruist terwijl de EMA stijgt, short omgekeerd. Sluit bij een kruising terug door de VWAP.',
    params: [num('ema', 'Trend EMA', 50)],
    indicators: (p): IndRef[] => [
      { id: 'vwap', params: { anchor: 'Session', source: 'hlc3' } },
      { id: 'ema', params: { length: p.ema, source: 'close' } },
    ],
    signals: (c, p) => {
      const cl = close(c);
      const v = ta.vwap(c, 'Session', ta.source(c, 'hlc3'));
      const e = ta.ema(cl, N(p, 'ema'));
      const s = blank(c.length);
      for (let i = 1; i < c.length; i++) {
        s.entryLong[i] = ta.crossover(cl, v, i) && e[i] > e[i - 1];
        s.entryShort[i] = ta.crossunder(cl, v, i) && e[i] < e[i - 1];
        s.exitLong[i] = ta.crossunder(cl, v, i);
        s.exitShort[i] = ta.crossover(cl, v, i);
      }
      return s;
    },
  },
  {
    id: 'zscore_revert',
    name: 'Z-score Mean Reversion',
    description: 'Hoe ver staat de prijs van zijn gemiddelde, in standaarddeviaties? Koop bij een extreme onderschrijding, short bij een extreme overschrijding. Sluit terug bij het gemiddelde.',
    params: [num('length', 'Lengte', 50), num('z', 'Instap bij z', 2, 0.1, 0.5), num('exitZ', 'Uitstap bij z', 0, 0.1, 0)],
    indicators: (p): IndRef[] => [{ id: 'bb', params: { length: p.length, mult: p.z, source: 'close' } }],
    signals: (c, p) => {
      const cl = close(c);
      const m = ta.sma(cl, N(p, 'length'));
      const sd = ta.stdev(cl, N(p, 'length'));
      const z = cl.map((v, i) => (sd[i] > 0 ? (v - m[i]) / sd[i] : 0));
      const zt = N(p, 'z');
      const zx = N(p, 'exitZ');
      const s = blank(c.length);
      for (let i = 1; i < c.length; i++) {
        s.entryLong[i] = z[i] <= -zt && z[i - 1] > -zt;
        s.entryShort[i] = z[i] >= zt && z[i - 1] < zt;
        s.exitLong[i] = z[i] >= -zx;
        s.exitShort[i] = z[i] <= zx;
      }
      return s;
    },
  },
  {
    id: 'orb',
    name: 'Opening Range Breakout (UTC dag)',
    description:
      'Voor intraday: de high/low van de eerste N bars van de dag (UTC) vormen de "opening range". Koop bij een uitbraak erboven, short eronder. Sluit aan het einde van de dag of bij terugval door het midden.',
    params: [num('bars', 'Bars in opening range', 4)],
    signals: (c, p) => {
      const n = N(p, 'bars');
      const s = blank(c.length);
      let day = -1;
      let count = 0;
      let hi = -Infinity;
      let lo = Infinity;
      let traded = false;
      for (let i = 0; i < c.length; i++) {
        const d = Math.floor(c[i].time / 86400);
        if (d !== day) {
          if (i > 0) {
            s.exitLong[i - 1] = true; // flat at the end of the day
            s.exitShort[i - 1] = true;
          }
          day = d;
          count = 0;
          hi = -Infinity;
          lo = Infinity;
          traded = false;
        }
        count++;
        if (count <= n) {
          hi = Math.max(hi, c[i].high);
          lo = Math.min(lo, c[i].low);
          continue;
        }
        const mid = (hi + lo) / 2;
        if (!traded && c[i].close > hi) {
          s.entryLong[i] = true;
          traded = true;
        } else if (!traded && c[i].close < lo) {
          s.entryShort[i] = true;
          traded = true;
        }
        if (c[i].close < mid) s.exitLong[i] = true;
        if (c[i].close > mid) s.exitShort[i] = true;
      }
      return s;
    },
  },
  {
    id: 'heikin_trend',
    name: 'Heikin Ashi Trend',
    description: 'Heikin Ashi-candles filteren ruis. Koop na N groene HA-candles op rij boven de EMA, short na N rode eronder. Sluit bij de eerste candle in de andere kleur.',
    params: [num('streak', 'Candles op rij', 2), num('ema', 'Trend EMA', 50)],
    indicators: (p): IndRef[] => [{ id: 'ema', params: { length: p.ema, source: 'close' } }],
    signals: (c, p) => {
      const ha = ta.heikinAshi(c);
      const e = ta.ema(close(c), N(p, 'ema'));
      const k = N(p, 'streak');
      const green = ha.map((x) => x.close > x.open);
      const s = blank(c.length);
      for (let i = k; i < c.length; i++) {
        let up = true;
        let down = true;
        for (let j = 0; j < k; j++) {
          up = up && green[i - j];
          down = down && !green[i - j];
        }
        s.entryLong[i] = up && !green[i - k] && c[i].close > e[i];
        s.entryShort[i] = down && green[i - k] && c[i].close < e[i];
        s.exitLong[i] = !green[i];
        s.exitShort[i] = green[i];
      }
      return s;
    },
  },
  {
    id: 'macd_rsi',
    name: 'MACD + RSI Combo',
    description: 'Koop als MACD boven de signaallijn kruist én de RSI boven 50 staat (momentum bevestigd); short omgekeerd. Sluit bij de tegengestelde MACD-kruising.',
    params: [num('fast', 'MACD snel', 12), num('slow', 'MACD traag', 26), num('signal', 'Signaal', 9), num('rsi', 'RSI lengte', 14)],
    indicators: (p): IndRef[] => [
      { id: 'macd', params: { fast: p.fast, slow: p.slow, signal: p.signal, source: 'close' } },
      { id: 'rsi', params: { length: p.rsi, source: 'close' } },
    ],
    signals: (c, p) => {
      const cl = close(c);
      const m = ta.macd(cl, N(p, 'fast'), N(p, 'slow'), N(p, 'signal'));
      const r = ta.rsi(cl, N(p, 'rsi'));
      const s = blank(c.length);
      for (let i = 0; i < c.length; i++) {
        const up = ta.crossover(m.macd, m.signal, i);
        const dn = ta.crossunder(m.macd, m.signal, i);
        s.entryLong[i] = up && r[i] > 50;
        s.entryShort[i] = dn && r[i] < 50;
        s.exitLong[i] = dn;
        s.exitShort[i] = up;
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
HIGHEST(n) LOWEST(n) SUPERTREND(n,f) PSAR VOLSMA(n) (gemiddeld volume)  — gebruik PREV(...) voor de vorige bar
Futures: FUNDING = funding rate in % per periode (echte historie), bv. FUNDING > 0.03
Operatoren: crosses above, crosses below, >, <, >=, <=
Combineer met AND / OR, bv: EMA(9) crosses above EMA(21) AND RSI(14) > 50`;

function operand(c: Candle[], raw: string, cache: Map<string, Series>, ext: ExtData = {}): Series {
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
  } else if (key === 'FUNDING') {
    out = align(c, ext.funding).map((v) => v * 100);
  } else if (key === 'PSAR') {
    out = ta.parabolicSar(c, 0.02, 0.02, 0.2);
  } else {
    const m = /^([A-Z]+)\((.*)\)$/.exec(key);
    if (!m) throw new Error(`Onbekende operand: "${raw.trim()}"`);
    const fn = m[1];
    if (fn === 'PREV') {
      const inner = operand(c, m[2], cache, ext);
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
        case 'VOLSMA': out = ta.sma(c.map((x) => x.volume), arg(0, 20)); break;
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
export function evalRule(c: Candle[], rule: string, cache = new Map<string, Series>(), ext: ExtData = {}): boolean[] {
  const res = new Array<boolean>(c.length).fill(false);
  if (!rule.trim()) return res;
  const orParts = rule.split(/\s+OR\s+/i);
  const groups = orParts.map((part) =>
    part.split(/\s+AND\s+/i).map((cond) => {
      const m = /^(.+?)\s*(crosses\s+above|crosses\s+below|>=|<=|>|<)\s*(.+)$/i.exec(cond.trim());
      if (!m) throw new Error(`Kan regel niet lezen: "${cond.trim()}"`);
      return { a: operand(c, m[1], cache, ext), op: m[2].toLowerCase().replace(/\s+/g, ' '), b: operand(c, m[3], cache, ext) };
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

/** Ready-made rule sets the user can load into the no-code editor. */
export const RULE_EXAMPLES: { name: string; rules: CustomRules }[] = [
  {
    name: 'EMA-kruising met RSI-filter',
    rules: {
      entryLong: 'EMA(9) crosses above EMA(21) AND RSI(14) > 50',
      exitLong: 'EMA(9) crosses below EMA(21)',
      entryShort: 'EMA(9) crosses below EMA(21) AND RSI(14) < 50',
      exitShort: 'EMA(9) crosses above EMA(21)',
    },
  },
  {
    name: 'Funding-extreem tegen de trend in',
    rules: {
      entryLong: 'FUNDING < -0.01 AND close > EMA(200)',
      exitLong: 'FUNDING > 0.01',
      entryShort: 'FUNDING > 0.03 AND close < EMA(50)',
      exitShort: 'FUNDING < 0.005',
    },
  },
  {
    name: 'Bollinger bounce',
    rules: {
      entryLong: 'close crosses above BBLOWER(20,2) AND RSI(14) < 40',
      exitLong: 'close crosses above BBMID(20,2)',
      entryShort: 'close crosses below BBUPPER(20,2) AND RSI(14) > 60',
      exitShort: 'close crosses below BBMID(20,2)',
    },
  },
  {
    name: 'Breakout met volume',
    rules: {
      entryLong: 'close > HIGHEST(20) AND volume > VOLSMA(20)',
      exitLong: 'close < LOWEST(10)',
      entryShort: 'close < LOWEST(20) AND volume > VOLSMA(20)',
      exitShort: 'close > HIGHEST(10)',
    },
  },
  {
    name: 'Trend + pullback (ADX)',
    rules: {
      entryLong: 'ADX(14) > 25 AND PLUSDI(14) > MINUSDI(14) AND RSI(14) crosses above 50',
      exitLong: 'PLUSDI(14) crosses below MINUSDI(14)',
      entryShort: 'ADX(14) > 25 AND MINUSDI(14) > PLUSDI(14) AND RSI(14) crosses below 50',
      exitShort: 'MINUSDI(14) crosses below PLUSDI(14)',
    },
  },
];

export interface CustomRules {
  entryLong: string;
  exitLong: string;
  entryShort: string;
  exitShort: string;
}

/** Which futures data series a set of custom rules refers to. */
export function rulesExternal(r: CustomRules): ExtKind[] {
  const text = Object.values(r).join(' ').toUpperCase();
  const out: ExtKind[] = [];
  if (/\bFUNDING\b/.test(text)) out.push('funding');
  return out;
}

export function customSignals(c: Candle[], r: CustomRules, ext: ExtData = {}): Signals {
  const cache = new Map<string, Series>();
  return {
    entryLong: evalRule(c, r.entryLong, cache, ext),
    exitLong: evalRule(c, r.exitLong, cache, ext),
    entryShort: evalRule(c, r.entryShort, cache, ext),
    exitShort: evalRule(c, r.exitShort, cache, ext),
  };
}
