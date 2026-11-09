import type { Candle } from './types';

/**
 * Market data from Binance's public market-data endpoints (no API key needed).
 * data-api.binance.vision only serves public market data and allows browser (CORS) requests.
 */
const REST = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/ws';

/** Native intervals the exchange serves, with their length in seconds (months are approximate). */
export const NATIVE_INTERVALS: Record<string, number> = {
  '1s': 1,
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '8h': 28800,
  '12h': 43200,
  '1d': 86400,
  '3d': 259200,
  '1w': 604800,
  '1M': 2592000,
};

export interface Timeframe {
  /** Normalised label, e.g. "45m", "2h", "1D", "2W", "3M" */
  label: string;
  unit: 's' | 'm' | 'h' | 'd' | 'w' | 'M';
  count: number;
  /** Length in seconds (months approximated as 30 days) */
  seconds: number;
}

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 } as const;

/**
 * Parse a timeframe like "1", "15", "45m", "4h", "1D", "2W", "3M", "30s".
 * A bare number means minutes. Lower-case "m" = minutes, upper-case "M" = months.
 */
export function parseTimeframe(input: string): Timeframe | null {
  const s = input.trim();
  const m = /^(\d+)\s*([smhHdDwWM]?)$/.exec(s);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  if (!count || count > 1000) return null;
  let u = m[2] || 'm';
  if (u === 'H') u = 'h';
  if (u === 'D') u = 'd';
  if (u === 'W') u = 'w';
  const unit = u as Timeframe['unit'];
  const display = unit === 'd' ? 'D' : unit === 'w' ? 'W' : unit;
  return { label: `${count}${display}`, unit, count, seconds: count * UNIT_SECONDS[unit] };
}

/** Pick the native interval to download for a timeframe; resample if it isn't native. */
export function baseIntervalFor(tf: Timeframe): { interval: string; resample: boolean } {
  const native = `${tf.count}${tf.unit}`;
  if (native in NATIVE_INTERVALS) return { interval: native, resample: false };
  if (tf.unit === 'M') return { interval: '1M', resample: true };
  if (tf.unit === 'w') return { interval: '1w', resample: true };
  // Largest native interval (below 1w) that divides the timeframe evenly.
  const candidates = Object.entries(NATIVE_INTERVALS)
    .filter(([k, sec]) => !k.endsWith('M') && !k.endsWith('w') && sec <= tf.seconds && tf.seconds % sec === 0)
    .sort((a, b) => b[1] - a[1]);
  return { interval: candidates[0]?.[0] ?? '1m', resample: true };
}

/** Start of the bucket a bar belongs to, for resampling into a custom timeframe. */
export function bucketStart(time: number, tf: Timeframe): number {
  if (tf.unit === 'M') {
    const d = new Date(time * 1000);
    const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const start = months - (months % tf.count);
    return Date.UTC(Math.floor(start / 12), start % 12, 1) / 1000;
  }
  if (tf.unit === 'w') {
    // Weeks start on Monday. 1970-01-05 was a Monday.
    const monday = 4 * 86400;
    return Math.floor((time - monday) / tf.seconds) * tf.seconds + monday;
  }
  return Math.floor(time / tf.seconds) * tf.seconds;
}

export function resample(candles: Candle[], tf: Timeframe): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = bucketStart(c.time, tf);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: t });
    }
  }
  return out;
}

type RawKline = [number, string, string, string, string, string, ...unknown[]];

function parseKline(k: RawKline): Candle {
  return {
    time: Math.floor(k[0] / 1000),
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  };
}

/** Download up to `maxBars` most recent bars, paging backwards 1000 at a time. */
export async function fetchKlines(
  symbol: string,
  interval: string,
  maxBars: number,
  onProgress?: (loaded: number) => void,
): Promise<Candle[]> {
  let all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < maxBars) {
    const limit = Math.min(1000, maxBars - all.length);
    const url = `${REST}/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}${
      endTime !== undefined ? `&endTime=${endTime}` : ''
    }`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Kon data niet laden (${res.status}): ${await res.text()}`);
    const rows = ((await res.json()) as RawKline[]).map(parseKline);
    if (!rows.length) break;
    all = rows.concat(all);
    onProgress?.(all.length);
    if (rows.length < limit) break;
    endTime = rows[0].time * 1000 - 1;
  }
  return all;
}

export interface SymbolInfo {
  symbol: string;
  base: string;
  quote: string;
}

let symbolCache: SymbolInfo[] | null = null;

export async function fetchSymbols(): Promise<SymbolInfo[]> {
  if (symbolCache) return symbolCache;
  const res = await fetch(`${REST}/exchangeInfo?permissions=SPOT`);
  if (!res.ok) throw new Error('Kon symbolen niet laden');
  const json = (await res.json()) as {
    symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string }[];
  };
  symbolCache = json.symbols
    .filter((s) => s.status === 'TRADING')
    .map((s) => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset }));
  return symbolCache;
}

export interface Ticker {
  symbol: string;
  last: number;
  changePct: number;
}

export async function fetchTickers(symbols: string[]): Promise<Ticker[]> {
  if (!symbols.length) return [];
  const res = await fetch(`${REST}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}&type=MINI`);
  if (!res.ok) return [];
  const rows = (await res.json()) as { symbol: string; lastPrice: string; openPrice: string }[];
  return rows.map((r) => ({
    symbol: r.symbol,
    last: +r.lastPrice,
    changePct: +r.openPrice ? ((+r.lastPrice - +r.openPrice) / +r.openPrice) * 100 : 0,
  }));
}

/** Live kline stream. Returns a function that closes the connection. */
export function subscribeKlines(symbol: string, interval: string, onCandle: (c: Candle) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 1000;
  const connect = () => {
    ws = new WebSocket(`${WS}/${symbol.toLowerCase()}@kline_${interval}`);
    ws.onopen = () => (retry = 1000);
    ws.onmessage = (ev) => {
      const k = JSON.parse(ev.data).k;
      if (!k) return;
      onCandle({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}

/**
 * Parse OHLCV CSV for any market (stocks, forex, ...). Expects a header row with
 * columns named time/date/timestamp, open, high, low, close and optionally volume.
 */
export function parseCsv(text: string): Candle[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV is leeg');
  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const header = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/"/g, ''));
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iT = idx(['time', 'date', 'datetime', 'timestamp', 'open time', 'opentime']);
  const iO = idx(['open', 'o']);
  const iH = idx(['high', 'h']);
  const iL = idx(['low', 'l']);
  const iC = idx(['close', 'c', 'adj close', 'price']);
  const iV = idx(['volume', 'vol', 'v']);
  if ([iT, iO, iH, iL, iC].some((i) => i < 0)) {
    throw new Error('CSV mist kolommen. Nodig: time/date, open, high, low, close (volume optioneel)');
  }
  const out: Candle[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(sep).map((c) => c.trim().replace(/"/g, ''));
    const raw = cols[iT];
    let t = Number(raw);
    if (Number.isNaN(t)) t = Date.parse(raw.includes('T') || raw.includes(':') ? raw : `${raw}T00:00:00Z`) / 1000;
    else if (t > 1e11) t = t / 1000; // milliseconds
    const c: Candle = {
      time: Math.floor(t),
      open: +cols[iO],
      high: +cols[iH],
      low: +cols[iL],
      close: +cols[iC],
      volume: iV >= 0 ? +cols[iV] || 0 : 0,
    };
    if (Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every(Number.isFinite)) out.push(c);
  }
  out.sort((a, b) => a.time - b.time);
  // Remove duplicate timestamps
  return out.filter((c, i) => i === 0 || c.time !== out[i - 1].time);
}
