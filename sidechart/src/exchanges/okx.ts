import type { Candle } from '../types';
import { getJson, sleep, socket, type Contract, type Exchange, type Point } from './types';

const REST = 'https://www.okx.com/api/v5';
// Port 443 instead of 8443: works behind more firewalls and proxies.
const WS_BUSINESS = 'wss://ws.okx.com/ws/v5/business';
const WS_PUBLIC = 'wss://ws.okx.com/ws/v5/public';

/** Generic interval -> OKX bar code. 6h and above use the UTC-aligned variants. */
const BARS: Record<string, [string, number]> = {
  '1m': ['1m', 60],
  '3m': ['3m', 180],
  '5m': ['5m', 300],
  '15m': ['15m', 900],
  '30m': ['30m', 1800],
  '1h': ['1H', 3600],
  '2h': ['2H', 7200],
  '4h': ['4H', 14400],
  '6h': ['6Hutc', 21600],
  '12h': ['12Hutc', 43200],
  '1d': ['1Dutc', 86400],
  '1w': ['1Wutc', 604800],
  '1M': ['1Mutc', 2592000],
};

type Resp<T> = { code: string; msg: string; data: T };

async function okx<T>(path: string): Promise<T> {
  const r = await getJson<Resp<T>>(`${REST}${path}`);
  if (r.code !== '0') throw new Error(`OKX: ${r.msg || r.code}`);
  return r.data;
}

const row = (k: string[]): Candle => ({
  time: Math.floor(+k[0] / 1000),
  open: +k[1],
  high: +k[2],
  low: +k[3],
  close: +k[4],
  volume: +k[6], // volume in base coin
});

let contractCache: Contract[] | null = null;
const ctValByInst = new Map<string, number>();

export const okxExchange: Exchange = {
  id: 'okx',
  name: 'OKX',
  intervals: Object.fromEntries(Object.entries(BARS).map(([k, v]) => [k, v[1]])),
  ext: ['funding'],
  hasLiquidations: true,

  async contracts() {
    if (contractCache) return contractCache;
    const rows = await okx<{ instId: string; ctVal: string; ctValCcy: string; settleCcy: string; lever: string; state: string; ctType: string }[]>(
      '/public/instruments?instType=SWAP',
    );
    contractCache = rows
      .filter((r) => r.settleCcy === 'USDT' && r.ctType === 'linear' && r.state === 'live')
      .map((r) => {
        ctValByInst.set(r.instId, +r.ctVal);
        const base = r.instId.split('-')[0];
        return { symbol: `${base}USDT`, base, instId: r.instId, maxLeverage: +r.lever, contractValue: +r.ctVal };
      });
    return contractCache;
  },

  async klines(c, interval, maxBars, onProgress) {
    const [bar, sec] = BARS[interval];
    const page = (after?: number) =>
      okx<string[][]>(`/market/history-candles?instId=${c.instId}&bar=${bar}&limit=100${after ? `&after=${after}` : ''}`).then((rows) =>
        rows.map(row),
      );
    const first = await page();
    let all = first;
    onProgress?.(all.length);
    const pages = Math.ceil(maxBars / 100) - 1;
    if (first.length === 100 && pages > 0) {
      const newestMs = Math.max(...first.map((x) => x.time)) * 1000;
      if (interval === '1M') {
        // Months have no fixed length: page sequentially.
        let after = Math.min(...first.map((x) => x.time)) * 1000;
        for (let k = 0; k < pages; k++) {
          const rows = await page(after);
          if (!rows.length) break;
          all = all.concat(rows);
          onProgress?.(all.length);
          after = Math.min(...rows.map((x) => x.time)) * 1000;
          await sleep(110);
        }
      } else {
        // Candles are evenly spaced, so page boundaries can be computed and fetched in parallel
        // (8 at a time, under OKX's limit of 20 requests per 2 seconds).
        const anchors = Array.from({ length: pages }, (_, k) => newestMs - (k + 1) * 100 * sec * 1000 + 1);
        for (let i = 0; i < anchors.length; i += 8) {
          const batch = await Promise.all(anchors.slice(i, i + 8).map((a) => page(a)));
          const rows = batch.flat();
          all = all.concat(rows);
          onProgress?.(all.length);
          if (batch.some((r) => r.length < 100)) break; // reached the listing date
          await sleep(850);
        }
      }
    }
    // Sort oldest-first and de-duplicate (pages overlap when the exchange skipped a candle).
    const dedupe = () => {
      all.sort((x, y) => x.time - y.time);
      all = all.filter((x, i) => i === 0 || x.time !== all[i - 1].time);
    };
    dedupe();
    // Missing candles make the computed pages cover slightly fewer bars: top up from the oldest one.
    for (let k = 0; k < 5 && all.length < maxBars && all.length >= 100; k++) {
      const rows = await page(all[0].time * 1000);
      if (!rows.length) break;
      all = all.concat(rows);
      dedupe();
      if (rows.length < 100) break;
    }
    return all.slice(-maxBars);
  },

  subscribeKlines(c, interval, onCandle) {
    const channel = `candle${BARS[interval][0]}`;
    return socket(WS_BUSINESS, { op: 'subscribe', args: [{ channel, instId: c.instId }] }, (msg) => {
      if (msg.arg?.channel !== channel || !Array.isArray(msg.data)) return;
      for (const k of msg.data as string[][]) onCandle(row(k));
    });
  },

  async stats(c) {
    const [t, f, m, oi, idx] = await Promise.all([
      okx<Record<string, string>[]>(`/market/ticker?instId=${c.instId}`),
      okx<Record<string, string>[]>(`/public/funding-rate?instId=${c.instId}`),
      okx<Record<string, string>[]>(`/public/mark-price?instType=SWAP&instId=${c.instId}`),
      okx<Record<string, string>[]>(`/public/open-interest?instType=SWAP&instId=${c.instId}`),
      okx<Record<string, string>[]>(`/market/index-tickers?instId=${c.base}-USDT`).catch(() => [{ idxPx: 'NaN' }]),
    ]);
    const tk = t[0];
    const fundingTime = +f[0].fundingTime;
    const nextTime = +f[0].nextFundingTime;
    return {
      last: +tk.last,
      mark: +m[0].markPx,
      index: +idx[0].idxPx,
      fundingRate: +f[0].fundingRate,
      nextFundingTime: Math.floor(fundingTime / 1000),
      fundingIntervalH: nextTime && fundingTime ? Math.round((nextTime - fundingTime) / 3600000) : 8,
      openInterestUsd: +oi[0].oiUsd,
      change24hPct: ((+tk.last - +tk.open24h) / +tk.open24h) * 100,
      high24h: +tk.high24h,
      low24h: +tk.low24h,
      volume24hUsd: +tk.volCcy24h * +tk.last,
    };
  },

  async tickers() {
    const rows = await okx<Record<string, string>[]>('/market/tickers?instType=SWAP');
    return rows
      .filter((r) => r.instId.endsWith('-USDT-SWAP'))
      .map((r) => {
        const base = r.instId.split('-')[0];
        return {
          symbol: `${base}USDT`,
          last: +r.last,
          changePct: +r.open24h ? ((+r.last - +r.open24h) / +r.open24h) * 100 : 0,
          volumeUsd: +r.volCcy24h * +r.last,
        };
      });
  },

  async fundingHistory(c, sinceSec) {
    const out: Point[] = [];
    let after = '';
    for (let page = 0; page < 10; page++) {
      const rows = await okx<{ fundingTime: string; realizedRate: string; fundingRate: string }[]>(
        `/public/funding-rate-history?instId=${c.instId}&limit=100${after ? `&after=${after}` : ''}`,
      );
      if (!rows.length) break;
      for (const r of rows) out.push({ time: Math.floor(+r.fundingTime / 1000), value: +(r.realizedRate || r.fundingRate) });
      after = rows[rows.length - 1].fundingTime;
      if (+after / 1000 < sinceSec || rows.length < 100) break;
      await sleep(120);
    }
    return out.sort((a, b) => a.time - b.time);
  },

  subscribeLiquidations(onLiq) {
    void this.contracts(); // make sure contract sizes are known
    return socket(WS_PUBLIC, { op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] }, (msg) => {
      if (msg.arg?.channel !== 'liquidation-orders' || !Array.isArray(msg.data)) return;
      for (const d of msg.data as { instId: string; details: { side: string; posSide: string; sz: string; bkPx: string; ts: string }[] }[]) {
        if (!d.instId.endsWith('-USDT-SWAP')) continue;
        const ctVal = ctValByInst.get(d.instId) ?? 1;
        for (const x of d.details) {
          const side = x.posSide === 'long' || (x.posSide === 'net' && x.side === 'sell') ? 'long' : 'short';
          onLiq({
            symbol: `${d.instId.split('-')[0]}USDT`,
            side,
            price: +x.bkPx,
            usd: +x.sz * ctVal * +x.bkPx,
            time: Math.floor(+x.ts / 1000),
          });
        }
      }
    });
  },
};
