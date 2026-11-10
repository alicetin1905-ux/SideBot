/**
 * Futures sentiment data that exchanges don't offer as deep, browser-accessible history:
 *
 * - Open interest is recorded locally from the live stats while the app is open.
 * - Long/short account ratio and taker buy/sell volume come from Bitget's public API
 *   (only the latest ~30 periods) and are stored locally so history grows over time.
 */
import type { Point } from './exchanges/types';

const STORE_KEY = 'sidechart:recorded:v1';
const MAX_POINTS = 3000;

type Store = Record<string, Point[]>;
let store: Store | null = null;

function load(): Store {
  if (store) return store;
  try {
    store = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Store;
  } catch {
    store = {};
  }
  return store;
}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
      /* storage full or unavailable — keep in memory */
    }
  }, 1000);
}

/** Merge points into a recorded series (same timestamp = replaced). */
export function record(key: string, points: Point[]) {
  const s = load();
  const map = new Map((s[key] ?? []).map((p) => [p.time, p.value]));
  for (const p of points) if (Number.isFinite(p.value)) map.set(p.time, p.value);
  s[key] = [...map].map(([time, value]) => ({ time, value })).sort((a, b) => a.time - b.time).slice(-MAX_POINTS);
  persist();
  return s[key];
}

export function recorded(key: string): Point[] {
  return load()[key] ?? [];
}

/** Record one open-interest snapshot (5-minute resolution). */
export function recordOpenInterest(exchange: string, symbol: string, usd: number, nowSec = Date.now() / 1000) {
  return record(`${exchange}:${symbol}:oi`, [{ time: Math.floor(nowSec / 300) * 300, value: usd }]);
}

export function openInterestHistory(exchange: string, symbol: string): Point[] {
  return recorded(`${exchange}:${symbol}:oi`);
}

/** Bitget sentiment periods; daily and longer fall back to 4h data. */
export function sentimentPeriod(interval: string): string {
  const map: Record<string, string> = {
    '1m': '5m', '3m': '5m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
  };
  return map[interval] ?? '4h';
}

const BITGET = 'https://api.bitget.com/api/v2/mix/market';

export interface Sentiment {
  lsr: Point[];
  takerBuy: Point[];
  takerSell: Point[];
}

/** Long/short ratio and taker volume (base coin) for a USDT perpetual, merged with what was stored before. */
export async function fetchSentiment(symbol: string, interval: string): Promise<Sentiment> {
  const period = sentimentPeriod(interval);
  const get = async <T>(path: string): Promise<T[]> => {
    const res = await fetch(`${BITGET}/${path}`);
    if (!res.ok) throw new Error(`Bitget HTTP ${res.status}`);
    const j = (await res.json()) as { code: string; msg: string; data: T[] };
    if (j.code !== '00000') throw new Error(`Bitget: ${j.msg}`);
    return j.data ?? [];
  };
  const [ls, tk] = await Promise.all([
    get<{ longShortAccountRatio: string; ts: string }>(`account-long-short?symbol=${symbol}&period=${period}`).catch(() => []),
    get<{ buyVolume: string; sellVolume: string; ts: string }>(`taker-buy-sell?symbol=${symbol}&period=${period}`).catch(() => []),
  ]);
  const t = (ts: string) => Math.floor(+ts / 1000);
  const base = `bitget:${symbol}:${period}`;
  return {
    lsr: record(`${base}:lsr`, ls.map((r) => ({ time: t(r.ts), value: +r.longShortAccountRatio }))),
    takerBuy: record(`${base}:takerBuy`, tk.map((r) => ({ time: t(r.ts), value: +r.buyVolume }))),
    takerSell: record(`${base}:takerSell`, tk.map((r) => ({ time: t(r.ts), value: +r.sellVolume }))),
  };
}
