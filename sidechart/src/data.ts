import type { Candle } from './types';

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

/**
 * Pick the native interval to download for a timeframe; resample if it isn't native.
 * `natives` maps generic labels (1m, 1h, 1d, 1w, 1M …) to seconds.
 */
export function baseIntervalFor(tf: Timeframe, natives: Record<string, number>): { interval: string; resample: boolean } {
  const native = `${tf.count}${tf.unit}`;
  if (native in natives) return { interval: native, resample: false };
  if (tf.unit === 'M' && '1M' in natives) return { interval: '1M', resample: true };
  if (tf.unit === 'w' && '1w' in natives) return { interval: '1w', resample: true };
  // Largest native interval (below 1w) that divides the timeframe evenly.
  const candidates = Object.entries(natives)
    .filter(([k, sec]) => !k.endsWith('M') && !k.endsWith('w') && sec <= tf.seconds && tf.seconds % sec === 0)
    .sort((a, b) => b[1] - a[1]);
  return { interval: candidates[0]?.[0] ?? Object.keys(natives)[0], resample: true };
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
