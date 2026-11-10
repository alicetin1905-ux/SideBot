import type { Candle } from '../types';
import { getJson, sleep, socket, type Contract, type Exchange, type Point } from './types';

const REST = 'https://api.bitget.com/api/v2/mix/market';
const WS = 'wss://ws.bitget.com/v2/ws/public';
const PT = 'productType=usdt-futures';

/** Generic interval -> Bitget granularity. 6h and above use the UTC-aligned variants. */
const BARS: Record<string, [string, number]> = {
  '1m': ['1m', 60],
  '3m': ['3m', 180],
  '5m': ['5m', 300],
  '15m': ['15m', 900],
  '30m': ['30m', 1800],
  '1h': ['1H', 3600],
  '4h': ['4H', 14400],
  '6h': ['6Hutc', 21600],
  '12h': ['12Hutc', 43200],
  '1d': ['1Dutc', 86400],
  '3d': ['3Dutc', 259200],
  '1w': ['1Wutc', 604800],
  '1M': ['1Mutc', 2592000],
};

type Resp<T> = { code: string; msg: string; data: T };

async function bg<T>(path: string): Promise<T> {
  const r = await getJson<Resp<T>>(`${REST}${path}`);
  if (r.code !== '00000') throw new Error(`Bitget: ${r.msg || r.code}`);
  return r.data;
}

const row = (k: string[]): Candle => ({
  time: Math.floor(+k[0] / 1000),
  open: +k[1],
  high: +k[2],
  low: +k[3],
  close: +k[4],
  volume: +k[5],
});

let contractCache: Contract[] | null = null;

export const bitgetExchange: Exchange = {
  id: 'bitget',
  name: 'Bitget',
  intervals: Object.fromEntries(Object.entries(BARS).map(([k, v]) => [k, v[1]])),
  ext: ['funding'],
  hasLiquidations: false,

  async contracts() {
    if (contractCache) return contractCache;
    const rows = await bg<{ symbol: string; baseCoin: string; quoteCoin: string; maxLever: string; symbolStatus: string }[]>(`/contracts?${PT}`);
    contractCache = rows
      .filter((r) => r.quoteCoin === 'USDT' && r.symbolStatus === 'normal')
      .map((r) => ({ symbol: r.symbol, base: r.baseCoin, instId: r.symbol, maxLeverage: +r.maxLever, contractValue: 1 }));
    return contractCache;
  },

  async klines(c, interval, maxBars, onProgress) {
    const g = BARS[interval][0];
    let all: Candle[] = [];
    let endTime = '';
    while (all.length < maxBars) {
      const rows = await bg<string[][]>(
        `/history-candles?symbol=${c.instId}&${PT}&granularity=${g}&limit=200${endTime ? `&endTime=${endTime}` : ''}`,
      );
      if (!rows.length) break;
      const chunk = rows.map(row).sort((a, b) => a.time - b.time);
      const oldest = all[0]?.time ?? Infinity;
      all = chunk.filter((x) => x.time < oldest).concat(all);
      onProgress?.(all.length);
      endTime = String(chunk[0].time * 1000 - 1);
      if (rows.length < 200) break;
      await sleep(60);
    }
    // The newest (still forming) bar comes from the regular candles endpoint.
    try {
      const recent = (await bg<string[][]>(`/candles?symbol=${c.instId}&${PT}&granularity=${g}&limit=5`)).map(row);
      for (const r of recent) {
        const last = all[all.length - 1];
        if (!last || r.time > last.time) all.push(r);
        else if (r.time === last.time) all[all.length - 1] = r;
      }
    } catch {
      /* history is enough */
    }
    return all.slice(-maxBars);
  },

  subscribeKlines(c, interval, onCandle) {
    const channel = `candle${BARS[interval][0]}`;
    return socket(
      WS,
      { op: 'subscribe', args: [{ instType: 'USDT-FUTURES', channel, instId: c.instId }] },
      (msg) => {
        if (msg.arg?.channel !== channel || !Array.isArray(msg.data)) return;
        const rows = (msg.data as string[][]).map(row).sort((a, b) => a.time - b.time);
        // A snapshot contains many bars; only the latest two matter for a live update.
        for (const k of rows.slice(-2)) onCandle(k);
      },
      25000,
    );
  },

  async stats(c) {
    const [t, ft, oi] = await Promise.all([
      bg<Record<string, string>[]>(`/ticker?symbol=${c.instId}&${PT}`),
      bg<{ nextFundingTime: string; ratePeriod: string }[]>(`/funding-time?symbol=${c.instId}&${PT}`),
      bg<{ openInterestList: { size: string }[] }>(`/open-interest?symbol=${c.instId}&${PT}`),
    ]);
    const tk = t[0];
    return {
      last: +tk.lastPr,
      mark: +tk.markPrice,
      index: +tk.indexPrice,
      fundingRate: +tk.fundingRate,
      nextFundingTime: Math.floor(+ft[0].nextFundingTime / 1000),
      fundingIntervalH: +ft[0].ratePeriod || 8,
      openInterestUsd: +oi.openInterestList[0].size * +tk.markPrice,
      change24hPct: +tk.change24h * 100,
      high24h: +tk.high24h,
      low24h: +tk.low24h,
      volume24hUsd: +tk.usdtVolume,
    };
  },

  async tickers() {
    const rows = await bg<Record<string, string>[]>(`/tickers?${PT}`);
    return rows.map((r) => ({
      symbol: r.symbol,
      last: +r.lastPr,
      changePct: +r.change24h * 100,
      volumeUsd: +r.usdtVolume,
      fundingRate: +r.fundingRate,
    }));
  },

  async fundingHistory(c, sinceSec) {
    const out: Point[] = [];
    for (let page = 1; page <= 10; page++) {
      const rows = await bg<{ fundingTime: string; fundingRate: string }[]>(
        `/history-fund-rate?symbol=${c.instId}&${PT}&pageSize=100&pageNo=${page}`,
      );
      if (!rows.length) break;
      for (const r of rows) out.push({ time: Math.floor(+r.fundingTime / 1000), value: +r.fundingRate });
      if (+rows[rows.length - 1].fundingTime / 1000 < sinceSec || rows.length < 100) break;
      await sleep(100);
    }
    return out.sort((a, b) => a.time - b.time);
  },
};
