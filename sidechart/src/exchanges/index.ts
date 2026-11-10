import { okxExchange } from './okx';
import { bitgetExchange } from './bitget';
import { binanceExchange } from './binance';
import { bybitExchange } from './bybit';
import type { Exchange } from './types';

export const EXCHANGES: Record<Exchange['id'], Exchange> = {
  okx: okxExchange,
  bitget: bitgetExchange,
  binance: binanceExchange,
  bybit: bybitExchange,
};

export * from './types';
