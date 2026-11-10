import { okxExchange } from './okx';
import { bitgetExchange } from './bitget';
import type { Exchange } from './types';

export const EXCHANGES: Record<Exchange['id'], Exchange> = {
  okx: okxExchange,
  bitget: bitgetExchange,
};

export * from './types';
