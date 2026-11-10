export interface Candle {
  /** Unix time in seconds (bar open time, UTC) */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Taker buy volume in base coin (only exchanges that include it in candles, e.g. Binance) */
  buyVolume?: number;
}

/** A series of values aligned with the candle array. NaN = no value. */
export type Series = number[];

export type ParamDef =
  | { key: string; label: string; type: 'number'; default: number; min?: number; max?: number; step?: number }
  | { key: string; label: string; type: 'select'; default: string; options: string[] };

export type Params = Record<string, number | string>;
