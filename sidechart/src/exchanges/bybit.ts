import type { Candle } from '../types';
import { getJson, sleep, socket, type Contract, type Exchange, type ExtKind, type Liquidation, type Point } from './types';

/**
 * Bybit V5 linear perpetuals (public market data, no API key).
 * Docs: https://bybit-exchange.github.io/docs/v5/intro
 * Note: Bybit blocks some regions (HTTP 403); the app then shows a clear message.
 */
const REST = 'https://api.bybit.com/v5/market';
const WS = 'wss://stream.bybit.com/v5/public/linear';

/** Generic interval -> Bybit interval code. */
const BARS: Record<string, [string, number]> = {
  '1m': ['1', 60],
  '3m': ['3', 180],
  '5m': ['5', 300],
  '15m': ['15', 900],
  '30m': ['30', 1800],
  '1h': ['60', 3600],
  '2h': ['120', 7200],
  '4h': ['240', 14400],
  '6h': ['360', 21600],
  '12h': ['720', 43200],
  '1d': ['D', 86400],
  '1w': ['W', 604800],
  '1M': ['M', 2592000],
};

/** Periods for open interest / account ratio. */
function statPeriod(interval: string): { oi: string; ratio: string } {
  const sec = BARS[interval]?.[1] ?? 3600;
  if (sec <= 300) return { oi: '5min', ratio: '5min' };
  if (sec <= 900) return { oi: '15min', ratio: '15min' };
  if (sec <= 1800) return { oi: '30min', ratio: '30min' };
  if (sec <= 7200) return { oi: '1h', ratio: '1h' };
  if (sec <= 43200) return { oi: '4h', ratio: '4h' };
  return { oi: '1d', ratio: '1d' };
}

type Resp<T> = { retCode: number; retMsg: string; result: T };

async function bybit<T>(path: string): Promise<T> {
  const r = await getJson<Resp<T>>(`${REST}${path}`);
  if (r.retCode !== 0) throw new Error(`Bybit: ${r.retMsg || r.retCode}`);
  return r.result;
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
const fundingMinutes = new Map<string, number>();

export const bybitExchange: Exchange = {
  id: 'bybit',
  name: 'Bybit',
  intervals: Object.fromEntries(Object.entries(BARS).map(([k, v]) => [k, v[1]])),
  ext: ['funding', 'oi', 'lsr'],
  hasLiquidations: true,
  oiInCoins: true,

  async contracts() {
    if (contractCache) return contractCache;
    const out: Contract[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const r = await bybit<{
        list: { symbol: string; baseCoin: string; quoteCoin: string; contractType: string; status: string; fundingInterval: number; leverageFilter: { maxLeverage: string } }[];
        nextPageCursor: string;
      }>(`/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const s of r.list) {
        if (s.contractType !== 'LinearPerpetual' || s.quoteCoin !== 'USDT' || s.status !== 'Trading') continue;
        fundingMinutes.set(s.symbol, s.fundingInterval);
        out.push({ symbol: s.symbol, base: s.baseCoin, instId: s.symbol, maxLeverage: +s.leverageFilter.maxLeverage, contractValue: 1 });
      }
      cursor = r.nextPageCursor;
      if (!cursor) break;
    }
    contractCache = out;
    return out;
  },

  async klines(c, interval, maxBars, onProgress) {
    const code = BARS[interval][0];
    let all: Candle[] = [];
    let end = '';
    while (all.length < maxBars) {
      const r = await bybit<{ list: string[][] }>(`/kline?category=linear&symbol=${c.instId}&interval=${code}&limit=1000${end ? `&end=${end}` : ''}`);
      const rows = r.list;
      if (!rows.length) break;
      const chunk = rows.map(row).reverse(); // newest first -> oldest first
      const oldest = all[0]?.time ?? Infinity;
      all = chunk.filter((x) => x.time < oldest).concat(all);
      onProgress?.(all.length);
      if (rows.length < 1000) break;
      end = String(+rows[rows.length - 1][0] - 1);
      await sleep(80);
    }
    return all.slice(-maxBars);
  },

  subscribeKlines(c, interval, onCandle) {
    const topic = `kline.${BARS[interval][0]}.${c.instId}`;
    return socket(
      WS,
      { op: 'subscribe', args: [topic] },
      (msg) => {
        if (msg.topic !== topic || !Array.isArray(msg.data)) return;
        for (const k of msg.data as Record<string, string | number>[]) {
          onCandle({ time: Math.floor(+k.start / 1000), open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume });
        }
      },
      { ping: { op: 'ping' }, pingMs: 20000 },
    );
  },

  async stats(c) {
    const r = await bybit<{ list: Record<string, string>[] }>(`/tickers?category=linear&symbol=${c.instId}`);
    const t = r.list[0];
    return {
      last: +t.lastPrice,
      mark: +t.markPrice,
      index: +t.indexPrice,
      fundingRate: +t.fundingRate,
      nextFundingTime: Math.floor(+t.nextFundingTime / 1000),
      fundingIntervalH: (fundingMinutes.get(c.instId) ?? 480) / 60,
      openInterestUsd: +t.openInterestValue,
      change24hPct: +t.price24hPcnt * 100,
      high24h: +t.highPrice24h,
      low24h: +t.lowPrice24h,
      volume24hUsd: +t.turnover24h,
    };
  },

  async tickers() {
    const r = await bybit<{ list: Record<string, string>[] }>('/tickers?category=linear');
    const perps = new Set((await this.contracts()).map((c) => c.symbol));
    return r.list
      .filter((t) => perps.has(t.symbol))
      .map((t) => ({
        symbol: t.symbol,
        last: +t.lastPrice,
        changePct: +t.price24hPcnt * 100,
        volumeUsd: +t.turnover24h,
        fundingRate: +t.fundingRate,
      }));
  },

  async fundingHistory(c, sinceSec) {
    const out: Point[] = [];
    let endTime = '';
    for (let page = 0; page < 20; page++) {
      const r = await bybit<{ list: { fundingRate: string; fundingRateTimestamp: string }[] }>(
        `/funding/history?category=linear&symbol=${c.instId}&limit=200${endTime ? `&endTime=${endTime}` : ''}`,
      );
      if (!r.list.length) break;
      for (const x of r.list) out.push({ time: Math.floor(+x.fundingRateTimestamp / 1000), value: +x.fundingRate });
      const oldest = +r.list[r.list.length - 1].fundingRateTimestamp;
      if (oldest / 1000 < sinceSec || r.list.length < 200) break;
      endTime = String(oldest - 1);
      await sleep(120);
    }
    return out.sort((a, b) => a.time - b.time);
  },

  async extSeries(c, kind: ExtKind, interval) {
    const p = statPeriod(interval);
    if (kind === 'oi') {
      // Bybit reports open interest in coins; the app converts it to USD with the candle price.
      const out: Point[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page++) {
        const r = await bybit<{ list: { openInterest: string; timestamp: string }[]; nextPageCursor: string }>(
          `/open-interest?category=linear&symbol=${c.instId}&intervalTime=${p.oi}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        for (const x of r.list) out.push({ time: Math.floor(+x.timestamp / 1000), value: +x.openInterest });
        cursor = r.nextPageCursor;
        if (!cursor || r.list.length < 200) break;
        await sleep(120);
      }
      return out.sort((a, b) => a.time - b.time);
    }
    if (kind === 'lsr') {
      const r = await bybit<{ list: { buyRatio: string; sellRatio: string; timestamp: string }[] }>(
        `/account-ratio?category=linear&symbol=${c.instId}&period=${p.ratio}&limit=500`,
      );
      return r.list
        .map((x) => ({ time: Math.floor(+x.timestamp / 1000), value: +x.sellRatio ? +x.buyRatio / +x.sellRatio : NaN }))
        .sort((a, b) => a.time - b.time);
    }
    return [];
  },

  subscribeLiquidations(onLiq: (l: Liquidation) => void) {
    // Bybit has no "all symbols" liquidation stream: subscribe to the 100 most traded contracts.
    let stop: (() => void) | null = null;
    let cancelled = false;
    void this.tickers()
      .then((t) => {
        if (cancelled) return;
        const top = t.sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 100).map((x) => `allLiquidation.${x.symbol}`);
        const batches: unknown[] = [];
        for (let i = 0; i < top.length; i += 10) batches.push({ op: 'subscribe', args: top.slice(i, i + 10) });
        stop = socket(
          WS,
          batches,
          (msg) => {
            if (!String(msg.topic ?? '').startsWith('allLiquidation.') || !Array.isArray(msg.data)) return;
            for (const d of msg.data as { T: number; s: string; S: string; v: string; p: string }[]) {
              onLiq({
                symbol: d.s,
                // "Buy" = a long position was liquidated (Bybit docs).
                side: d.S === 'Buy' ? 'long' : 'short',
                price: +d.p,
                usd: +d.v * +d.p,
                time: Math.floor(d.T / 1000),
              });
            }
          },
          { ping: { op: 'ping' }, pingMs: 20000 },
        );
      })
      .catch(() => {
        /* region blocked or offline: no liquidation feed */
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  },
};
