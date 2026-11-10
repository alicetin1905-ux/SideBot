import { afterEach, describe, expect, it, vi } from 'vitest';
import { binanceExchange } from './exchanges/binance';
import { bybitExchange } from './exchanges/bybit';
import { okxExchange } from './exchanges/okx';
import { INDICATOR_MAP, defaultParams } from './indicators';
import { resample, parseTimeframe } from './data';

/** Route fetch() calls to canned JSON responses by URL substring. */
function mockFetch(routes: [string, unknown | ((url: string) => unknown), number?][]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const hit = routes.find(([part]) => url.includes(part));
    if (!hit) return new Response('not found', { status: 404 });
    const body = typeof hit[1] === 'function' ? (hit[1] as (u: string) => unknown)(url) : hit[1];
    return new Response(JSON.stringify(body), { status: hit[2] ?? 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const H = 3600_000;

describe('Binance USDⓈ-M adapter', () => {
  it('lists only trading USDT perpetuals', async () => {
    mockFetch([
      [
        '/fapi/v1/exchangeInfo',
        {
          symbols: [
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING' },
            { symbol: 'BTCUSDT_261225', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'CURRENT_QUARTER', status: 'TRADING' },
            { symbol: 'ETHUSDC', baseAsset: 'ETH', quoteAsset: 'USDC', contractType: 'PERPETUAL', status: 'TRADING' },
            { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'SETTLING' },
          ],
        },
      ],
    ]);
    const c = await binanceExchange.contracts();
    expect(c.map((x) => x.symbol)).toEqual(['BTCUSDT']);
  });

  it('pages klines backwards (1500 per request) and keeps taker buy volume', async () => {
    const kline = (t: number) => [t, '1', '2', '0.5', String(t / H), '10', t + H - 1, '100', 5, '6', '60', '0'];
    const all = Array.from({ length: 2000 }, (_, i) => kline(i * H));
    // Behaves like the real API: the newest `limit` bars with openTime <= endTime.
    const calls = mockFetch([
      [
        '/fapi/v1/klines',
        (url: string) => {
          const limit = +/limit=(\d+)/.exec(url)![1];
          const end = /endTime=(\d+)/.exec(url);
          const rows = end ? all.filter((k) => (k[0] as number) <= +end[1]) : all;
          return rows.slice(-limit);
        },
      ],
    ]);
    const contract = { symbol: 'BTCUSDT', base: 'BTC', instId: 'BTCUSDT', maxLeverage: 0, contractValue: 1 };
    const k = await binanceExchange.klines(contract, '1h', 1800);
    expect(k).toHaveLength(1800);
    expect(k[0].close).toBe(200);
    expect(k[1799].close).toBe(1999);
    expect(k.every((x, i) => i === 0 || x.time - k[i - 1].time === 3600)).toBe(true);
    expect(k[0].buyVolume).toBe(6);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('limit=300');
    expect(calls[1]).toContain(`endTime=${500 * H - 1}`);
  });

  it('maps stats (mark, index, funding, OI in USD)', async () => {
    mockFetch([
      ['/fapi/v1/premiumIndex', { markPrice: '100', indexPrice: '101', lastFundingRate: '0.0001', nextFundingTime: 1_800_000_000_000 }],
      ['/fapi/v1/ticker/24hr', { lastPrice: '99', priceChangePercent: '2.5', highPrice: '110', lowPrice: '90', quoteVolume: '5000000' }],
      ['/fapi/v1/openInterest', { openInterest: '1000' }],
      ['/fapi/v1/fundingInfo', [{ symbol: 'XYZUSDT', fundingIntervalHours: 4 }]],
    ]);
    const s = await binanceExchange.stats({ symbol: 'BTCUSDT', base: 'BTC', instId: 'BTCUSDT', maxLeverage: 0, contractValue: 1 });
    expect(s).toMatchObject({ last: 99, mark: 100, index: 101, fundingRate: 0.0001, openInterestUsd: 100000, change24hPct: 2.5, fundingIntervalH: 8 });
    expect(s.nextFundingTime).toBe(1_800_000_000);
  });

  it('shows a clear message when the region is blocked', async () => {
    mockFetch([['/fapi/v1/exchangeInfo', { code: 0, msg: 'restricted' }, 451]]);
    // contracts are cached from the first test, so call another endpoint
    await expect(binanceExchange.fundingHistory({ symbol: 'X', base: 'X', instId: 'X', maxLeverage: 0, contractValue: 1 }, 0)).rejects.toThrow();
    mockFetch([['/fapi/v1/fundingRate', {}, 451]]);
    await expect(binanceExchange.fundingHistory({ symbol: 'X', base: 'X', instId: 'X', maxLeverage: 0, contractValue: 1 }, 0)).rejects.toThrow(/locatie/);
  });
});

describe('Bybit V5 adapter', () => {
  const contract = { symbol: 'BTCUSDT', base: 'BTC', instId: 'BTCUSDT', maxLeverage: 100, contractValue: 1 };

  it('pages instruments with a cursor and keeps linear USDT perpetuals', async () => {
    const calls = mockFetch([
      [
        '/instruments-info',
        (url: string) => ({
          retCode: 0,
          retMsg: 'OK',
          result: url.includes('cursor=')
            ? { list: [{ symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', fundingInterval: 240, leverageFilter: { maxLeverage: '75' } }], nextPageCursor: '' }
            : {
                list: [
                  { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', fundingInterval: 480, leverageFilter: { maxLeverage: '100' } },
                  { symbol: 'BTC-26DEC26', baseCoin: 'BTC', quoteCoin: 'USDT', contractType: 'LinearFutures', status: 'Trading', fundingInterval: 0, leverageFilter: { maxLeverage: '50' } },
                ],
                nextPageCursor: 'abc',
              },
        }),
      ],
    ]);
    const c = await bybitExchange.contracts();
    expect(c.map((x) => `${x.symbol}:${x.maxLeverage}`)).toEqual(['BTCUSDT:100', 'ETHUSDT:75']);
    expect(calls).toHaveLength(2);
  });

  it('reverses newest-first klines', async () => {
    mockFetch([
      ['/kline', { retCode: 0, retMsg: 'OK', result: { list: [[String(2 * H), '1', '2', '0', '3', '9', '90'], [String(H), '1', '2', '0', '2', '9', '90'], ['0', '1', '2', '0', '1', '9', '90']] } }],
    ]);
    const k = await bybitExchange.klines(contract, '1h', 100);
    expect(k.map((x) => x.close)).toEqual([1, 2, 3]);
    expect(k[0].buyVolume).toBeUndefined();
  });

  it('maps stats using the funding interval from instruments', async () => {
    mockFetch([
      [
        '/tickers',
        {
          retCode: 0,
          retMsg: 'OK',
          result: { list: [{ symbol: 'BTCUSDT', lastPrice: '100', markPrice: '100.5', indexPrice: '100.2', fundingRate: '-0.0002', nextFundingTime: '1800000000000', openInterestValue: '2500000', price24hPcnt: '0.031', highPrice24h: '105', lowPrice24h: '95', turnover24h: '9000000' }] },
        },
      ],
    ]);
    const s = await bybitExchange.stats(contract);
    expect(s).toMatchObject({ last: 100, mark: 100.5, fundingRate: -0.0002, openInterestUsd: 2500000, fundingIntervalH: 8, volume24hUsd: 9000000 });
    expect(s.change24hPct).toBeCloseTo(3.1);
  });

  it('turns buy/sell account ratios into a long/short ratio', async () => {
    mockFetch([
      ['/account-ratio', { retCode: 0, retMsg: 'OK', result: { list: [{ buyRatio: '0.75', sellRatio: '0.25', timestamp: String(2 * H) }, { buyRatio: '0.5', sellRatio: '0.5', timestamp: String(H) }] } }],
    ]);
    const pts = await bybitExchange.extSeries!(contract, 'lsr', '1h');
    expect(pts).toEqual([
      { time: 3600, value: 1 },
      { time: 7200, value: 3 },
    ]);
  });

  it('reads funding history newest-first and sorts it', async () => {
    mockFetch([
      ['/funding/history', { retCode: 0, retMsg: 'OK', result: { list: [{ fundingRate: '0.0002', fundingRateTimestamp: String(16 * H) }, { fundingRate: '0.0001', fundingRateTimestamp: String(8 * H) }] } }],
    ]);
    const f = await bybitExchange.fundingHistory(contract, 0);
    expect(f.map((p) => p.value)).toEqual([0.0001, 0.0002]);
  });

  it('reports API errors', async () => {
    mockFetch([['/funding/history', { retCode: 10001, retMsg: 'params error', result: {} }]]);
    await expect(bybitExchange.fundingHistory(contract, 0)).rejects.toThrow(/params error/);
  });
});

describe('OKX parallel candle paging', () => {
  it('returns a continuous series without gaps or duplicates', async () => {
    // 1200 hourly bars, with one missing bar (exchange maintenance) at index 500
    const times = Array.from({ length: 1200 }, (_, i) => i * H).filter((_, i) => i !== 500);
    vi.stubGlobal('setTimeout', ((fn: () => void) => (fn(), 0)) as unknown as typeof setTimeout);
    mockFetch([
      [
        '/market/history-candles',
        (url: string) => {
          const after = /after=(\d+)/.exec(url);
          const older = after ? times.filter((t) => t < +after[1]) : times;
          // newest first, max 100
          const page = older.slice(-100).reverse();
          return { code: '0', msg: '', data: page.map((t) => [String(t), '1', '2', '0', String(t / H), '5', '5', '50', '1']) };
        },
      ],
    ]);
    const contract = { symbol: 'BTCUSDT', base: 'BTC', instId: 'BTC-USDT-SWAP', maxLeverage: 100, contractValue: 0.01 };
    const k = await okxExchange.klines(contract, '1h', 1000);
    expect(k).toHaveLength(1000);
    expect(new Set(k.map((x) => x.time)).size).toBe(1000);
    expect(k.every((x, i) => i === 0 || x.time > k[i - 1].time)).toBe(true);
    expect(k[k.length - 1].time).toBe(1199 * 3600);
    // every bar present except the missing one
    const expected = times.slice(-1000).map((t) => t / 1000);
    expect(k.map((x) => x.time)).toEqual(expected);
  });
});

describe('candle taker volume (Binance)', () => {
  const candles = [
    { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 10, buyVolume: 7 },
    { time: 3600, open: 1, high: 1, low: 1, close: 1, volume: 10, buyVolume: 2 },
    { time: 7200, open: 1, high: 1, low: 1, close: 1, volume: 10, buyVolume: 5 },
  ];
  it('CVD and delta use the candles directly', () => {
    const cvd = INDICATOR_MAP.get('cvd')!;
    expect(cvd.compute(candles, defaultParams(cvd.params), {}).value).toEqual([4, -2, -2]);
    const delta = INDICATOR_MAP.get('takerdelta')!;
    expect(delta.compute(candles, {}, {}).value).toEqual([4, -6, 0]);
  });
  it('resampling sums taker buy volume', () => {
    const r = resample(candles, parseTimeframe('3h')!);
    expect(r).toHaveLength(1);
    expect(r[0].buyVolume).toBe(14);
  });
});
