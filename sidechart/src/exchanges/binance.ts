import type { Candle } from '../types';
import { getJson, sleep, socket, type Contract, type Exchange, type ExtKind, type Point } from './types';

/**
 * Binance USDⓈ-M Futures (public market data, no API key).
 * Docs: https://developers.binance.com/docs/derivatives/usds-margined-futures
 * Note: Binance blocks some regions (HTTP 451); the app then shows a clear message.
 */
const REST = 'https://fapi.binance.com';
const WS = 'wss://fstream.binance.com/ws';

/** Generic interval -> Binance interval (identical labels). */
const INTERVALS: Record<string, number> = {
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

/** Periods supported by the /futures/data statistics endpoints (max ~30 days of history). */
function statPeriod(interval: string): string {
  const ok = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
  if (ok.includes(interval)) return interval;
  if (['1m', '3m'].includes(interval)) return '5m';
  if (interval === '8h') return '4h';
  return '1d';
}

type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

const row = (k: RawKline): Candle => ({
  time: Math.floor(k[0] / 1000),
  open: +k[1],
  high: +k[2],
  low: +k[3],
  close: +k[4],
  volume: +k[5],
  buyVolume: +k[9], // taker buy base-asset volume
});

let contractCache: Contract[] | null = null;
let fundingIntervals: Map<string, number> | null = null;

async function fundingIntervalH(symbol: string): Promise<number> {
  if (!fundingIntervals) {
    // Only symbols with a non-default interval are listed; the rest settle every 8 hours.
    const rows = await getJson<{ symbol: string; fundingIntervalHours: number }[]>(`${REST}/fapi/v1/fundingInfo`).catch(() => []);
    fundingIntervals = new Map(rows.map((r) => [r.symbol, r.fundingIntervalHours]));
  }
  return fundingIntervals.get(symbol) ?? 8;
}

export const binanceExchange: Exchange = {
  id: 'binance',
  name: 'Binance',
  intervals: INTERVALS,
  ext: ['funding', 'oi', 'lsr'],
  hasLiquidations: true,
  candleTakerVolume: true,

  async contracts() {
    if (contractCache) return contractCache;
    const info = await getJson<{
      symbols: { symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string }[];
    }>(`${REST}/fapi/v1/exchangeInfo`);
    contractCache = info.symbols
      .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
      // Max leverage needs a signed request on Binance, so it's unknown here (0).
      .map((s) => ({ symbol: s.symbol, base: s.baseAsset, instId: s.symbol, maxLeverage: 0, contractValue: 1 }));
    return contractCache;
  },

  async klines(c, interval, maxBars, onProgress) {
    let all: Candle[] = [];
    let endTime: number | undefined;
    while (all.length < maxBars) {
      const limit = Math.min(1500, maxBars - all.length);
      const rows = await getJson<RawKline[]>(
        `${REST}/fapi/v1/klines?symbol=${c.instId}&interval=${interval}&limit=${limit}${endTime !== undefined ? `&endTime=${endTime}` : ''}`,
      );
      if (!rows.length) break;
      all = rows.map(row).concat(all);
      onProgress?.(all.length);
      if (rows.length < limit) break;
      endTime = rows[0][0] - 1;
      await sleep(80);
    }
    return all.slice(-maxBars);
  },

  subscribeKlines(c, interval, onCandle) {
    // Binance pings the client; the browser answers automatically, so no keep-alive message is needed.
    return socket(
      `${WS}/${c.instId.toLowerCase()}@kline_${interval}`,
      null,
      (msg) => {
        const k = msg.k;
        if (!k) return;
        onCandle({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, buyVolume: +k.V });
      },
      { ping: null },
    );
  },

  async stats(c) {
    const [p, t, oi, interval] = await Promise.all([
      getJson<{ markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number }>(`${REST}/fapi/v1/premiumIndex?symbol=${c.instId}`),
      getJson<Record<string, string>>(`${REST}/fapi/v1/ticker/24hr?symbol=${c.instId}`),
      getJson<{ openInterest: string }>(`${REST}/fapi/v1/openInterest?symbol=${c.instId}`),
      fundingIntervalH(c.instId),
    ]);
    return {
      last: +t.lastPrice,
      mark: +p.markPrice,
      index: +p.indexPrice,
      fundingRate: +p.lastFundingRate,
      nextFundingTime: Math.floor(p.nextFundingTime / 1000),
      fundingIntervalH: interval,
      openInterestUsd: +oi.openInterest * +p.markPrice,
      change24hPct: +t.priceChangePercent,
      high24h: +t.highPrice,
      low24h: +t.lowPrice,
      volume24hUsd: +t.quoteVolume,
    };
  },

  async tickers() {
    const [t, p] = await Promise.all([
      getJson<Record<string, string>[]>(`${REST}/fapi/v1/ticker/24hr`),
      getJson<{ symbol: string; lastFundingRate: string }[]>(`${REST}/fapi/v1/premiumIndex`).catch(() => []),
    ]);
    const funding = new Map(p.map((x) => [x.symbol, +x.lastFundingRate]));
    const perps = new Set((await this.contracts()).map((c) => c.symbol));
    return t
      .filter((r) => perps.has(r.symbol))
      .map((r) => ({
        symbol: r.symbol,
        last: +r.lastPrice,
        changePct: +r.priceChangePercent,
        volumeUsd: +r.quoteVolume,
        fundingRate: funding.get(r.symbol),
      }));
  },

  async fundingHistory(c, sinceSec) {
    const out: Point[] = [];
    let start = sinceSec * 1000;
    for (let page = 0; page < 20; page++) {
      const rows = await getJson<{ fundingTime: number; fundingRate: string }[]>(
        `${REST}/fapi/v1/fundingRate?symbol=${c.instId}&startTime=${start}&limit=1000`,
      );
      if (!rows.length) break;
      for (const r of rows) out.push({ time: Math.floor(r.fundingTime / 1000), value: +r.fundingRate });
      if (rows.length < 1000) break;
      start = rows[rows.length - 1].fundingTime + 1;
      await sleep(150);
    }
    return out;
  },

  async extSeries(c, kind: ExtKind, interval) {
    const period = statPeriod(interval);
    if (kind === 'oi') {
      const rows = await getJson<{ sumOpenInterestValue: string; timestamp: number }[]>(
        `${REST}/futures/data/openInterestHist?symbol=${c.instId}&period=${period}&limit=500`,
      );
      return rows.map((r) => ({ time: Math.floor(r.timestamp / 1000), value: +r.sumOpenInterestValue }));
    }
    if (kind === 'lsr') {
      const rows = await getJson<{ longShortRatio: string; timestamp: number }[]>(
        `${REST}/futures/data/globalLongShortAccountRatio?symbol=${c.instId}&period=${period}&limit=500`,
      );
      return rows.map((r) => ({ time: Math.floor(r.timestamp / 1000), value: +r.longShortRatio }));
    }
    return [];
  },

  subscribeLiquidations(onLiq) {
    return socket(
      `${WS}/!forceOrder@arr`,
      null,
      (msg) => {
        const o = msg.o;
        if (msg.e !== 'forceOrder' || !o || !String(o.s).endsWith('USDT')) return;
        const price = +o.ap || +o.p;
        onLiq({
          symbol: o.s,
          // A SELL order closes a long position: the long got liquidated.
          side: o.S === 'SELL' ? 'long' : 'short',
          price,
          usd: +(o.z || o.q) * price,
          time: Math.floor(o.T / 1000),
        });
      },
      { ping: null },
    );
  },
};
