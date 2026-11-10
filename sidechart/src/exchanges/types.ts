import type { Candle } from '../types';

/** A USDT-margined perpetual contract. `symbol` is normalised, e.g. "BTCUSDT". */
export interface Contract {
  symbol: string;
  base: string;
  /** Exchange-specific instrument id, e.g. "BTC-USDT-SWAP" on OKX */
  instId: string;
  maxLeverage: number;
  /** Base-coin amount per contract (1 for exchanges that trade in coins) */
  contractValue: number;
}

export interface FuturesStats {
  last: number;
  mark: number;
  index: number;
  /** Funding rate of the current period, as a fraction (0.0001 = 0.01%) */
  fundingRate: number;
  /** Unix seconds of the next funding settlement */
  nextFundingTime: number;
  /** Funding interval in hours */
  fundingIntervalH: number;
  openInterestUsd: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24hUsd: number;
}

export interface MarketTicker {
  symbol: string;
  last: number;
  changePct: number;
  volumeUsd: number;
  fundingRate?: number;
}

export interface Point {
  time: number;
  value: number;
}

export interface Liquidation {
  symbol: string;
  /** Which side got liquidated */
  side: 'long' | 'short';
  price: number;
  usd: number;
  time: number;
}

/** Futures data series that indicators can request. */
export type ExtKind = 'funding' | 'oi' | 'lsr' | 'takerBuy' | 'takerSell';

export interface Exchange {
  id: 'okx' | 'bitget' | 'binance' | 'bybit';
  name: string;
  /** Native candle intervals: generic label (1m, 1h, 1d, 1w, 1M …) -> seconds */
  intervals: Record<string, number>;
  /** Futures series this exchange delivers itself (others come from src/sentiment.ts) */
  ext: ExtKind[];
  hasLiquidations: boolean;
  /** Candles include taker buy volume (Candle.buyVolume), so CVD has full history */
  candleTakerVolume?: boolean;
  /** extSeries('oi') returns coins instead of USD (converted with the candle price) */
  oiInCoins?: boolean;
  contracts(): Promise<Contract[]>;
  klines(c: Contract, interval: string, maxBars: number, onProgress?: (n: number) => void): Promise<Candle[]>;
  subscribeKlines(c: Contract, interval: string, onCandle: (k: Candle) => void): () => void;
  stats(c: Contract): Promise<FuturesStats>;
  tickers(): Promise<MarketTicker[]>;
  fundingHistory(c: Contract, sinceSec: number): Promise<Point[]>;
  /** Open interest / long-short ratio history, for exchanges that list 'oi' / 'lsr' in `ext` */
  extSeries?(c: Contract, kind: ExtKind, interval: string): Promise<Point[]>;
  subscribeLiquidations?(onLiq: (l: Liquidation) => void): () => void;
}

/** Small helpers shared by exchange adapters */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 451 || res.status === 403) {
    throw new Error(`${new URL(url).hostname} blokkeert verzoeken vanaf jouw locatie (HTTP ${res.status}). Kies een andere exchange of gebruik een VPN.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} bij ${new URL(url).hostname}`);
  return (await res.json()) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SocketOptions {
  /** Keep-alive message (string sent as-is, objects as JSON); null = none (server pings, e.g. Binance) */
  ping?: string | object | null;
  pingMs?: number;
}

/**
 * WebSocket with auto-reconnect and keep-alive pings.
 * `subscribe` (one message or a list) is sent on every (re)connect.
 */
export function socket(url: string, subscribe: unknown, onData: (msg: any) => void, opts: SocketOptions = {}): () => void {
  const pingMsg = opts.ping === undefined ? 'ping' : opts.ping;
  const pingMs = opts.pingMs ?? 20000;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 1000;
  let ping = 0;
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 1000;
      const subs = subscribe === null ? [] : Array.isArray(subscribe) ? subscribe : [subscribe];
      for (const m of subs) ws?.send(typeof m === 'string' ? m : JSON.stringify(m));
      if (pingMsg !== null) {
        const raw = typeof pingMsg === 'string' ? pingMsg : JSON.stringify(pingMsg);
        ping = window.setInterval(() => ws?.readyState === 1 && ws.send(raw), pingMs);
      }
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      try {
        onData(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    };
  };
  connect();
  return () => {
    closed = true;
    clearInterval(ping);
    ws?.close();
  };
}
