import './style.css';
import type { Candle, ParamDef, Params } from './types';
import { baseIntervalFor, bucketStart, parseCsv, parseTimeframe, resample, type Timeframe } from './data';
import { ChartView, EquityChart, NEON, type ChartType, type Drawing, type DrawTool } from './chart';
import { INDICATORS, INDICATOR_MAP, defaultParams, type ExtData } from './indicators';
import { RULE_HELP, STRATEGIES, STRATEGY_MAP, customSignals, rulesExternal, type CustomRules, type Signals } from './strategies';
import { DEFAULT_SETTINGS, optimize, runBacktest, type BacktestResult, type BacktestSettings, type Metrics } from './backtest';
import { planPosition } from './futures';
import { fetchSentiment, openInterestHistory, recordOpenInterest } from './sentiment';
import { EXCHANGES, type Contract, type Exchange, type ExtKind, type FuturesStats, type Liquidation, type MarketTicker } from './exchanges';

// ============================================================================
// State (persisted in localStorage)
// ============================================================================

interface Alert {
  id: number;
  exchange: Exchange['id'];
  symbol: string;
  price: number;
  above: boolean;
}

type SideTab = 'markets' | 'liqs' | 'calc' | 'chart';

interface State {
  exchange: Exchange['id'];
  symbol: string;
  tf: string;
  chartType: ChartType;
  bars: number;
  sidebar: boolean;
  sideTab: SideTab;
  testerCollapsed: boolean;
  favorites: string[];
  marketSort: string;
  liqMin: number;
  liqOnlyCurrent: boolean;
  indicators: { id: string; params: Params; hidden?: boolean }[];
  drawings: Record<string, Drawing[]>;
  alerts: Alert[];
  calc: { balance: number; risk: number; lev: number; fee: number; entry: number; stop: number; target: number; mmr: number; show: boolean };
  strategy: {
    id: string;
    enabled: boolean;
    autoRun: boolean;
    showIndicators: boolean;
    params: Record<string, Params>;
    rules: CustomRules;
    settings: BacktestSettings;
  };
}

const STORAGE_KEY = 'sidechart:futures:v1';

const DEFAULT_STATE: State = {
  exchange: 'okx',
  symbol: 'BTCUSDT',
  tf: '1h',
  chartType: 'candles',
  bars: 3000,
  sidebar: window.innerWidth > 1100,
  sideTab: 'markets',
  testerCollapsed: false,
  favorites: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
  marketSort: 'volume',
  liqMin: 0,
  liqOnlyCurrent: false,
  indicators: [
    { id: 'ema', params: { length: 21, source: 'close' } },
    { id: 'volume', params: { ma: 20 } },
    { id: 'funding', params: { mode: 'Per periode %' } },
  ],
  drawings: {},
  alerts: [],
  calc: { balance: 1000, risk: 1, lev: 10, fee: 0.05, entry: 0, stop: 0, target: 0, mmr: 0.5, show: true },
  strategy: {
    id: 'supertrend',
    enabled: false,
    autoRun: true,
    showIndicators: true,
    params: {},
    rules: {
      entryLong: 'EMA(9) crosses above EMA(21) AND FUNDING < 0.01',
      exitLong: 'EMA(9) crosses below EMA(21)',
      entryShort: 'EMA(9) crosses below EMA(21) AND FUNDING > 0.01',
      exitShort: 'EMA(9) crosses above EMA(21)',
    },
    settings: { ...DEFAULT_SETTINGS },
  },
};

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const s = JSON.parse(raw) as Partial<State>;
    return {
      ...structuredClone(DEFAULT_STATE),
      ...s,
      calc: { ...DEFAULT_STATE.calc, ...s.calc },
      strategy: {
        ...structuredClone(DEFAULT_STATE.strategy),
        ...s.strategy,
        settings: { ...DEFAULT_SETTINGS, ...s.strategy?.settings },
        rules: { ...DEFAULT_STATE.strategy.rules, ...s.strategy?.rules },
      },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

const state = loadState();
if (!EXCHANGES[state.exchange]) state.exchange = 'okx';

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      state.indicators = chart.indicators
        .filter((i) => !i.fromStrategy)
        .map((i) => ({ id: i.def.id, params: i.params, hidden: i.hidden }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable (private mode) — the app still works */
    }
  }, 200);
}

// ============================================================================
// Helpers
// ============================================================================

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  return a >= 1000
    ? v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : a >= 1
      ? v.toFixed(a >= 100 ? 2 : 4)
      : v.toPrecision(4);
}
const fmtMoney = (v: number) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '∞');
const fmtPct = (v: number, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` : '∞');
function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}
const fmtTime = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

function toast(msg: string, error = false) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), error ? 7000 : 4000);
}

function setStatus(msg: string | null) {
  const el = $('#status');
  el.textContent = msg ?? '';
  el.classList.toggle('show', !!msg);
}

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t = 0;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

const paramLabel = (p: Params) => {
  const v = Object.values(p);
  return v.length ? ` (${v.join(', ')})` : '';
};

// ============================================================================
// Core objects
// ============================================================================

const chart = new ChartView($('#chart'));
const equityChart = new EquityChart($('#equity'));

const ex = () => EXCHANGES[state.exchange];
let contracts: Contract[] = [];
let contract: Contract | null = null;
let candles: Candle[] = [];
let baseCandles: Candle[] = [];
let baseInterval = '1h';
let currentTf: Timeframe = parseTimeframe(state.tf) ?? parseTimeframe('1h')!;
let csvData: { name: string; candles: Candle[]; seconds: number } | null = null;
let unsubscribe: (() => void) | null = null;
let loadToken = 0;
let lastResult: BacktestResult | null = null;
let ext: ExtData = {};
const extLoading = new Set<ExtKind>();
let stats: FuturesStats | null = null;

function updateLegend(html?: string) {
  const name = csvData ? csvData.name : `${state.symbol}.P`;
  const src = csvData ? 'CSV' : ex().name;
  $('#legend').innerHTML = `<div><span class="title">${esc(name)} · ${currentTf.label} · ${src}</span>${html ?? chart.legendText()}</div>`;
}
chart.onCrosshair = (html) => updateLegend(html);

// ============================================================================
// Timeframes
// ============================================================================

const QUICK_TF = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
const nativeLabel = (k: string) => k.replace(/d$/, 'D').replace(/w$/, 'W');

function buildTimeframes() {
  $('#tf-buttons').innerHTML = QUICK_TF.map((t) => `<button class="btn" data-tf="${t}">${t}</button>`).join('');
  $('#tf-buttons').addEventListener('click', (e) => {
    const tf = (e.target as HTMLElement).closest<HTMLElement>('[data-tf]')?.dataset.tf;
    if (tf) setTimeframe(tf);
  });
  $<HTMLSelectElement>('#tf-more').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) setTimeframe(v);
  });
  $<HTMLInputElement>('#tf-custom').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (setTimeframe(input.value)) input.value = '';
  });
  fillTimeframeMenu();
}

function fillTimeframeMenu() {
  const all = Object.keys(ex().intervals).map(nativeLabel);
  const extra = ['2m', '10m', '20m', '45m', '2h', '3h', '8h', '2D', '3D', '2W', '3M'].filter((t) => !all.includes(t));
  $('#tf-more').innerHTML =
    `<option value="">Meer…</option><optgroup label="${ex().name}">${all.map((t) => `<option>${t}</option>`).join('')}</optgroup>` +
    `<optgroup label="Samengesteld">${extra.map((t) => `<option>${t}</option>`).join('')}</optgroup>`;
  markTimeframe();
}

function markTimeframe() {
  for (const b of $$('#tf-buttons .btn')) b.classList.toggle('active', b.dataset.tf === currentTf.label);
  const sel = $<HTMLSelectElement>('#tf-more');
  sel.value = QUICK_TF.includes(currentTf.label) ? '' : currentTf.label;
}

function setTimeframe(label: string): boolean {
  const tf = parseTimeframe(label);
  if (!tf) {
    toast(`Ongeldige timeframe "${label}". Voorbeelden: 1m, 45m, 4h, 2D, 1W, 3M`, true);
    return false;
  }
  if (tf.unit === 's') {
    toast('Seconde-timeframes worden niet aangeboden voor futures op deze exchanges', true);
    return false;
  }
  currentTf = tf;
  state.tf = tf.label;
  save();
  markTimeframe();
  void loadData();
  return true;
}

// ============================================================================
// Data loading & live updates
// ============================================================================

function setLive(on: boolean) {
  $('#live-dot').classList.toggle('on', on);
  $('#live-label').textContent = on ? `LIVE · ${ex().name}` : csvData ? 'CSV DATA' : 'OFFLINE';
}

async function ensureContracts() {
  if (!contracts.length) contracts = await ex().contracts();
  return contracts;
}

async function loadData() {
  const token = ++loadToken;
  unsubscribe?.();
  unsubscribe = null;
  setLive(false);
  markTimeframe();

  if (csvData) {
    contract = null;
    candles = currentTf.seconds > csvData.seconds ? resample(csvData.candles, currentTf) : csvData.candles;
    ext = {};
    afterLoad();
    return;
  }

  try {
    setStatus(`${ex().name} · ${state.symbol} laden…`);
    await ensureContracts();
    const c = contracts.find((x) => x.symbol === state.symbol);
    if (!c) {
      setStatus(null);
      toast(`${state.symbol} bestaat niet als perpetual op ${ex().name}. Terug naar BTCUSDT.`, true);
      state.symbol = 'BTCUSDT';
      $<HTMLInputElement>('#symbol').value = state.symbol;
      return void loadData();
    }
    contract = c;
    const { interval, resample: needsResample } = baseIntervalFor(currentTf, ex().intervals);
    baseInterval = interval;
    const factor = needsResample ? Math.max(1, Math.round(currentTf.seconds / ex().intervals[interval])) : 1;
    const baseBars = Math.min(state.bars * factor, 40000);
    const raw = await ex().klines(c, interval, baseBars, (n) => {
      if (token === loadToken) setStatus(`${state.symbol} laden… ${n.toLocaleString()} bars`);
    });
    if (token !== loadToken) return;
    if (!raw.length) throw new Error('Geen data voor dit contract/timeframe');
    baseCandles = raw;
    candles = needsResample ? resample(raw, currentTf) : raw.slice();
    ext = {};
    extLoading.clear();
    setStatus(null);
    afterLoad();
    unsubscribe = ex().subscribeKlines(c, interval, (k) => onTick(k, needsResample));
    setLive(true);
    void refreshStats();
    void ensureExt();
  } catch (e) {
    if (token !== loadToken) return;
    setStatus(null);
    toast(`${(e as Error).message}`, true);
  }
}

function afterLoad() {
  chart.setCandles(candles, currentTf.seconds);
  chart.setExt(ext);
  chart.fitContent();
  chart.setDrawings(state.drawings[drawingKey()] ?? []);
  refreshAlertLines();
  updateLegend();
  renderMarkets();
  updateCalc();
  if (state.strategy.enabled) runStrategy();
}

let indicatorTimer = 0;
let lastPrice = 0;
function onTick(k: Candle, needsResample: boolean) {
  const lastBase = baseCandles[baseCandles.length - 1];
  if (lastBase && lastBase.time === k.time) baseCandles[baseCandles.length - 1] = k;
  else if (!lastBase || k.time > lastBase.time) baseCandles.push(k);
  else return;

  let bar = k;
  if (needsResample) {
    const start = bucketStart(k.time, currentTf);
    let i = baseCandles.length - 1;
    while (i > 0 && baseCandles[i - 1].time >= start) i--;
    const group = baseCandles.slice(i);
    bar = {
      time: start,
      open: group[0].open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: k.close,
      volume: group.reduce((a, g) => a + g.volume, 0),
    };
  }
  const last = candles[candles.length - 1];
  let newBar = false;
  if (last && last.time === bar.time) candles[candles.length - 1] = bar;
  else {
    candles.push(bar);
    newBar = true;
  }
  chart.updateLast(candles);
  setLastPrice(bar.close);
  checkAlerts(state.exchange, state.symbol, bar.close);

  if (!indicatorTimer) {
    indicatorTimer = window.setTimeout(() => {
      indicatorTimer = 0;
      chart.refreshIndicators();
      updateLegend();
    }, 1000);
  }
  if (newBar && state.strategy.enabled && state.strategy.autoRun) runStrategy();
}

// ---- Futures data series (funding, OI, L/S, taker volume) ----

function neededExt(): ExtKind[] {
  const set = new Set<ExtKind>();
  for (const i of chart.indicators) for (const k of i.def.external ?? []) set.add(k);
  if (state.strategy.enabled) {
    const def = currentStrategy();
    for (const k of def.external ?? []) set.add(k);
    if (def.id === 'custom') for (const k of rulesExternal(state.strategy.rules)) set.add(k);
    if (state.strategy.settings.funding === 'history') set.add('funding');
  }
  // Binance candles already contain taker volume.
  if (ex().candleTakerVolume) {
    set.delete('takerBuy');
    set.delete('takerSell');
  }
  return [...set];
}

async function ensureExt(force = false) {
  const c = contract;
  if (!c || csvData || !candles.length) return;
  const token = loadToken;
  const missing = neededExt().filter((k) => (force || !ext[k]) && !extLoading.has(k));
  if (!missing.length) return;
  for (const k of missing) extLoading.add(k);
  const next: ExtData = {};
  try {
    const jobs: Promise<void>[] = [];
    if (missing.includes('funding')) {
      jobs.push(
        ex()
          .fundingHistory(c, candles[0].time)
          .then((pts) => void (next.funding = pts))
          .catch((e) => toast(`Funding-historie: ${(e as Error).message}`, true)),
      );
    }
    // Open interest / long-short history straight from the exchange when it offers it to browsers.
    const direct = missing.filter((k) => (k === 'oi' || k === 'lsr') && ex().ext.includes(k) && ex().extSeries);
    for (const k of direct) {
      jobs.push(
        ex()
          .extSeries!(c, k, baseInterval)
          .then((pts) => void (next[k] = k === 'oi' && ex().oiInCoins ? coinsToUsd(pts) : pts))
          .catch((e) => toast(`${extName(k)}: ${(e as Error).message}`, true)),
      );
    }
    if (missing.includes('oi') && !direct.includes('oi')) next.oi = openInterestHistory(state.exchange, state.symbol);
    const viaBitget = missing.filter((k) => (k === 'lsr' && !direct.includes('lsr')) || k === 'takerBuy' || k === 'takerSell');
    if (viaBitget.length) {
      jobs.push(
        fetchSentiment(state.symbol, baseInterval)
          .then((sent) => {
            if (!sent.lsr.length && !sent.takerBuy.length) toast(`Geen long/short- of taker-data voor ${state.symbol} bij Bitget`, true);
            for (const k of viaBitget) next[k] = sent[k as keyof typeof sent];
          })
          .catch((e) => toast(`Sentiment-data: ${(e as Error).message}`, true)),
      );
    }
    await Promise.all(jobs);
  } finally {
    for (const k of missing) extLoading.delete(k);
  }
  if (token !== loadToken) return;
  // Mark requested series as loaded (empty if unavailable) so we don't retry in a loop.
  ext = { ...ext, ...Object.fromEntries(missing.map((k) => [k, next[k] ?? ext[k] ?? []])) };
  chart.setExt(ext);
  updateLegend();
  if (state.strategy.enabled) runStrategy();
}

/** Convert a coin-denominated series to USD using the close of the candle it falls in. */
function coinsToUsd(pts: { time: number; value: number }[]) {
  let i = 0;
  return pts.map((p) => {
    while (i + 1 < baseCandles.length && baseCandles[i + 1].time <= p.time) i++;
    return { time: p.time, value: p.value * (baseCandles[i]?.close ?? NaN) };
  });
}

function extName(k: ExtKind) {
  return { funding: 'funding', oi: 'open interest', lsr: 'long/short ratio', takerBuy: 'taker volume', takerSell: 'taker volume' }[k];
}

// ---- HUD ----

function setLastPrice(p: number) {
  if (!Number.isFinite(p)) return;
  const el = $('#hud-last');
  if (lastPrice && p !== lastPrice) {
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth; // restart the flash
    el.classList.add(p > lastPrice ? 'flash-up' : 'flash-down');
    setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 250);
  }
  lastPrice = p;
  el.textContent = fmtPrice(p);
  document.title = `${fmtPrice(p)} · ${state.symbol} · SideChart`;
}

async function refreshStats() {
  const c = contract;
  if (!c || csvData) return;
  try {
    const s = await ex().stats(c);
    if (c !== contract) return;
    stats = s;
    renderHud();
    // Build open-interest history while the app is open (exchanges don't offer it to browsers).
    const oi = recordOpenInterest(state.exchange, state.symbol, s.openInterestUsd);
    if (ext.oi && !ex().ext.includes('oi')) {
      ext = { ...ext, oi };
      chart.setExt(ext);
    }
  } catch {
    /* keep the previous values */
  }
}

function renderHud() {
  $('#hud-symbol').textContent = csvData ? csvData.name : `${state.symbol} · PERP`;
  if (!stats || csvData) {
    for (const id of ['#hud-mark', '#hud-index', '#hud-funding', '#hud-oi', '#hud-change', '#hud-hl', '#hud-vol']) $(id).textContent = '—';
    $('#hud-countdown').textContent = '';
    if (csvData && candles.length) setLastPrice(candles[candles.length - 1].close);
    return;
  }
  const s = stats;
  if (!lastPrice) setLastPrice(s.last);
  $('#hud-mark').textContent = fmtPrice(s.mark);
  $('#hud-index').textContent = fmtPrice(s.index);
  const f = $('#hud-funding');
  f.textContent = `${(s.fundingRate * 100).toFixed(4)}%`;
  f.className = s.fundingRate > 0.0003 ? 'down' : s.fundingRate < 0 ? 'up' : '';
  f.title = `≈ ${(s.fundingRate * 100 * (24 / s.fundingIntervalH) * 365).toFixed(1)}% per jaar · elke ${s.fundingIntervalH}u`;
  $('#hud-oi').textContent = fmtUsd(s.openInterestUsd);
  const ch = $('#hud-change');
  ch.textContent = fmtPct(s.change24hPct);
  ch.className = `hud-value ${cls(s.change24hPct)}`;
  $('#hud-hl').textContent = `${fmtPrice(s.high24h)} / ${fmtPrice(s.low24h)}`;
  $('#hud-vol').textContent = fmtUsd(s.volume24hUsd);
  renderCountdown();
}

function renderCountdown() {
  if (!stats || csvData) return;
  let left = stats.nextFundingTime - Date.now() / 1000;
  if (left < 0) {
    left = 0;
    void refreshStats();
  }
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const sec = Math.floor(left % 60);
  $('#hud-countdown').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ============================================================================
// Exchange & symbol
// ============================================================================

function setExchange(id: Exchange['id']) {
  if (state.exchange === id && contracts.length) return;
  state.exchange = id;
  contracts = [];
  stats = null;
  csvData = null;
  lastPrice = 0;
  markets = [];
  for (const b of $$('#exchange button')) b.classList.toggle('active', b.dataset.ex === id);
  save();
  fillTimeframeMenu();
  void loadSymbolList();
  void pollMarkets();
  startLiquidations();
  void loadData();
}

function setSymbol(sym: string) {
  let s = sym.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return;
  if (!s.endsWith('USDT')) s += 'USDT';
  csvData = null;
  state.symbol = s;
  stats = null;
  lastPrice = 0;
  $<HTMLInputElement>('#symbol').value = s;
  save();
  renderHud();
  void loadData();
}

async function loadSymbolList() {
  try {
    const list = await ensureContracts();
    $('#symbol-list').innerHTML = list
      .slice()
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map((s) => `<option value="${s.symbol}">${s.base} perpetual${s.maxLeverage ? ` · max ${s.maxLeverage}×` : ''}</option>`)
      .join('');
  } catch {
    /* the input still accepts any symbol */
  }
}

// ============================================================================
// Markets screener
// ============================================================================

let markets: MarketTicker[] = [];

async function pollMarkets() {
  const exId = state.exchange;
  try {
    const t = await ex().tickers();
    if (exId !== state.exchange) return;
    markets = t;
    for (const m of t) if (m.symbol !== state.symbol || csvData) checkAlerts(exId, m.symbol, m.last);
    renderMarkets();
  } catch {
    /* retry on the next poll */
  }
}

function renderMarkets() {
  const ul = $('#markets');
  if (!markets.length) {
    ul.innerHTML = '<li class="empty">Markten laden…</li>';
    return;
  }
  const q = $<HTMLInputElement>('#market-search').value.trim().toUpperCase();
  const sort = state.marketSort;
  let list = markets.filter((m) => !q || m.symbol.includes(q));
  const sorters: Record<string, (a: MarketTicker, b: MarketTicker) => number> = {
    volume: (a, b) => b.volumeUsd - a.volumeUsd,
    change: (a, b) => b.changePct - a.changePct,
    losers: (a, b) => a.changePct - b.changePct,
    funding: (a, b) => Math.abs(b.fundingRate ?? 0) - Math.abs(a.fundingRate ?? 0),
    name: (a, b) => a.symbol.localeCompare(b.symbol),
  };
  list.sort(sorters[sort] ?? sorters.volume);
  const favs = list.filter((m) => state.favorites.includes(m.symbol));
  const rest = list.filter((m) => !state.favorites.includes(m.symbol)).slice(0, 150);
  const row = (m: MarketTicker) => {
    const fav = state.favorites.includes(m.symbol);
    const current = !csvData && m.symbol === state.symbol ? ' current' : '';
    const extra = sort === 'funding' && m.fundingRate !== undefined ? `${(m.fundingRate * 100).toFixed(3)}%` : fmtUsd(m.volumeUsd);
    return `<li class="market-row${current}" data-sym="${m.symbol}"><button class="star${fav ? ' on' : ''}" data-fav="${m.symbol}" title="Favoriet">${fav ? '★' : '☆'}</button><span class="sym">${m.symbol.replace(/USDT$/, '')}</span><span class="num">${fmtPrice(m.last)}</span><span class="num ${cls(m.changePct)}">${fmtPct(m.changePct)}</span><span class="muted-num">${extra}</span></li>`;
  };
  ul.innerHTML =
    (favs.length ? `<li class="market-sep">★ Favorieten</li>${favs.map(row).join('')}<li class="market-sep">Alle contracten</li>` : '') +
    (rest.map(row).join('') || '<li class="empty">Niets gevonden</li>');
  if (sort === 'funding' && !markets.some((m) => m.fundingRate !== undefined)) {
    ul.insertAdjacentHTML('afterbegin', '<li class="empty">Funding per contract in deze lijst is niet beschikbaar op OKX</li>');
  }
}

// ============================================================================
// Liquidation feed
// ============================================================================

const liqs: Liquidation[] = [];
let stopLiqs: (() => void) | null = null;
let liqRenderTimer = 0;
let liqSourceOverride = false;

function startLiquidations() {
  stopLiqs?.();
  stopLiqs = null;
  liqs.length = 0;
  const source = ex().hasLiquidations ? ex() : liqSourceOverride ? EXCHANGES.okx : null;
  $('#liq-unavailable').hidden = !!source;
  if (source?.subscribeLiquidations) {
    stopLiqs = source.subscribeLiquidations((l) => {
      liqs.unshift(l);
      if (liqs.length > 2000) liqs.length = 2000;
      if (!liqRenderTimer) liqRenderTimer = window.setTimeout(renderLiqs, 300);
    });
  }
  renderLiqs();
}

function renderLiqs() {
  liqRenderTimer = 0;
  const hourAgo = Date.now() / 1000 - 3600;
  let longUsd = 0;
  let shortUsd = 0;
  for (const l of liqs) {
    if (l.time < hourAgo) break;
    if (state.liqOnlyCurrent && l.symbol !== state.symbol) continue;
    if (l.side === 'long') longUsd += l.usd;
    else shortUsd += l.usd;
  }
  $('#liq-long-total').textContent = fmtUsd(longUsd);
  $('#liq-short-total').textContent = fmtUsd(shortUsd);
  $('#liq-bar-long').style.width = `${longUsd + shortUsd ? (longUsd / (longUsd + shortUsd)) * 100 : 50}%`;
  const list = liqs.filter((l) => l.usd >= state.liqMin && (!state.liqOnlyCurrent || l.symbol === state.symbol)).slice(0, 120);
  $('#liqs').innerHTML = list.length
    ? list
        .map(
          (l) =>
            `<li class="${l.side}${l.usd >= 100000 ? ' big' : ''}" data-sym="${l.symbol}"><span class="hud-dim">${new Date(l.time * 1000).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>` +
            `<span><span class="sym">${l.symbol.replace(/USDT$/, '')}</span> <span class="${l.side === 'long' ? 'down' : 'up'}">${l.side === 'long' ? 'LONG' : 'SHORT'}</span></span>` +
            `<span>${fmtPrice(l.price)}</span><span class="usd">${fmtUsd(l.usd)}</span></li>`,
        )
        .join('')
    : `<li class="empty">${stopLiqs ? 'Wachten op liquidaties…' : 'Geen feed'}</li>`;
}

// ============================================================================
// Position calculator
// ============================================================================

const CALC_FIELDS: [string, keyof State['calc']][] = [
  ['#c-balance', 'balance'],
  ['#c-risk', 'risk'],
  ['#c-lev', 'lev'],
  ['#c-fee', 'fee'],
  ['#c-entry', 'entry'],
  ['#c-stop', 'stop'],
  ['#c-target', 'target'],
  ['#c-mmr', 'mmr'],
];

function setupCalc() {
  for (const [sel, key] of CALC_FIELDS) {
    const el = $<HTMLInputElement>(sel);
    const v = state.calc[key];
    el.value = v ? String(v) : '';
    el.addEventListener('input', () => {
      (state.calc as Record<string, number | boolean>)[key] = parseFloat(el.value) || 0;
      updateCalc();
      save();
    });
  }
  $<HTMLInputElement>('#c-show').checked = state.calc.show;
  $('#c-show').addEventListener('change', (e) => {
    state.calc.show = (e.target as HTMLInputElement).checked;
    updateCalc();
    save();
  });
  $('#c-now').addEventListener('click', () => {
    const p = lastPrice || candles[candles.length - 1]?.close;
    if (!p) return;
    state.calc.entry = +p.toPrecision(8);
    $<HTMLInputElement>('#c-entry').value = String(state.calc.entry);
    updateCalc();
    save();
  });
  let pickTarget = '';
  for (const b of $$('[data-pick]')) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      pickTarget = b.dataset.pick!;
      setTool('pick');
    });
  }
  chart.onPick = (price) => {
    const field = CALC_FIELDS.find(([sel]) => sel === `#${pickTarget}`);
    if (!field) return;
    const v = +price.toPrecision(8);
    $<HTMLInputElement>(field[0]).value = String(v);
    (state.calc as Record<string, number | boolean>)[field[1]] = v;
    updateCalc();
    save();
  };
}

function updateCalc() {
  const c = state.calc;
  const plan = planPosition({
    balance: c.balance,
    riskPct: c.risk,
    entry: c.entry,
    stop: c.stop,
    target: c.target,
    leverage: c.lev,
    takerFeePct: c.fee,
    maintMarginPct: c.mmr,
  });
  const out = $('#calc-out');
  if (!plan) {
    out.innerHTML = '<p class="muted" style="grid-column:1/-1">Vul een entry en stop loss in (of gebruik ⌖ om op de grafiek te klikken).</p>';
    chart.setPositionLines(null);
    return;
  }
  const maxLev = contract?.maxLeverage;
  const card = (k: string, v: string, extraCls = '', wide = false) =>
    `<div class="metric${wide ? ' wide' : ''}"><div class="k">${k}</div><div class="v ${extraCls}">${v}</div></div>`;
  out.innerHTML =
    card('Richting', plan.side === 'long' ? '▲ LONG' : '▼ SHORT', plan.side === 'long' ? 'side-long' : 'side-short', true) +
    card('Positie', `${plan.qty.toPrecision(5)} ${contract?.base ?? ''}`) +
    card('Waarde', fmtUsd(plan.notional)) +
    card('Marge nodig', `${fmtMoney(plan.margin)} USDT`) +
    card('Liquidatie', fmtPrice(plan.liqPrice), 'amber') +
    card('Risico', `-${fmtMoney(plan.riskUsd)}`, 'down') +
    card('Winst bij TP', plan.rewardUsd ? `+${fmtMoney(plan.rewardUsd)}` : '—', 'up') +
    card('Risk : Reward', plan.rr ? `1 : ${plan.rr.toFixed(2)}` : '—', plan.rr >= 2 ? 'up' : '') +
    card('Stop afstand', `${plan.stopDistPct.toFixed(2)}%`) +
    (plan.warnings.length || (maxLev && c.lev > maxLev)
      ? `<ul class="warn-list">${[...plan.warnings, ...(maxLev && c.lev > maxLev ? [`Max leverage voor dit contract is ${maxLev}×.`] : [])].map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
      : '');
  chart.setPositionLines(c.show ? { entry: c.entry, stop: c.stop, target: c.target, liq: plan.liqPrice } : null);
}

// ============================================================================
// Indicators UI
// ============================================================================

function renderIndicatorDialog(filter = '') {
  const f = filter.toLowerCase();
  const groups = new Map<string, typeof INDICATORS>();
  for (const d of INDICATORS) {
    if (f && !d.name.toLowerCase().includes(f) && !d.id.includes(f)) continue;
    if (!groups.has(d.category)) groups.set(d.category, []);
    groups.get(d.category)!.push(d);
  }
  $('#ind-list').innerHTML =
    [...groups]
      .map(
        ([cat, defs]) =>
          `<h4>${cat === 'Futures' ? '⚡ Futures data' : cat}</h4>` +
          defs
            .map((d) => {
              return `<button class="ind-item" data-add="${d.id}"><span>${esc(d.name)}</span><small>${d.overlay ? 'op grafiek' : 'eigen paneel'}</small></button>`;
            })
            .join(''),
      )
      .join('') || '<p class="empty">Niets gevonden</p>';
}

function renderActiveIndicators() {
  const ul = $('#active-indicators');
  if (!chart.indicators.length) {
    ul.innerHTML = '<li class="empty">Geen indicatoren</li>';
    return;
  }
  ul.innerHTML = chart.indicators
    .map(
      (i) =>
        `<li class="${i.hidden ? 'dim' : ''}" data-uid="${i.uid}"><span class="name" title="${esc(i.def.name)}">${i.fromStrategy ? '⚡ ' : ''}${esc(i.def.name.replace(/ \(.*\)$/, ''))}${esc(paramLabel(i.params))}</span>` +
        `<button class="btn icon small" data-act="toggle" title="Tonen/verbergen">${i.hidden ? '◌' : '●'}</button>` +
        (i.def.params.length ? `<button class="btn icon small" data-act="edit" title="Instellingen">⚙</button>` : '') +
        `<button class="x" data-act="remove" title="Verwijderen">✕</button></li>`,
    )
    .join('');
}

function paramFieldsHtml(defs: ParamDef[], values: Params, prefix = 'p') {
  return defs
    .map((d) => {
      const v = values[d.key] ?? d.default;
      if (d.type === 'select') {
        return `<label>${esc(d.label)}<select name="${prefix}-${d.key}">${d.options.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
      }
      return `<label>${esc(d.label)}<input type="number" name="${prefix}-${d.key}" value="${v}" step="${d.step ?? 1}" ${d.min !== undefined ? `min="${d.min}"` : ''} ${d.max !== undefined ? `max="${d.max}"` : ''} required /></label>`;
    })
    .join('');
}

function readParams(root: HTMLElement, defs: ParamDef[], prefix = 'p'): Params {
  const out: Params = {};
  for (const d of defs) {
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${prefix}-${d.key}"]`);
    if (!el) continue;
    if (d.type === 'select') out[d.key] = el.value;
    else {
      const n = parseFloat(el.value);
      out[d.key] = Number.isFinite(n) ? n : d.default;
    }
  }
  return out;
}

function editParams(title: string, defs: ParamDef[], values: Params): Promise<Params | null> {
  const dlg = $<HTMLDialogElement>('#dlg-params');
  $('#params-title').textContent = title;
  $('#params-fields').innerHTML = paramFieldsHtml(defs, values);
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? readParams($('#params-fields'), defs) : null), { once: true });
  });
}

function setupIndicatorUi() {
  const dlg = $<HTMLDialogElement>('#dlg-indicators');
  $('#btn-indicators').addEventListener('click', () => {
    renderIndicatorDialog();
    $<HTMLInputElement>('#ind-search').value = '';
    dlg.showModal();
    $('#ind-search').focus();
  });
  dlg.querySelector('[data-close]')!.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  $('#ind-search').addEventListener('input', (e) => renderIndicatorDialog((e.target as HTMLInputElement).value));
  $('#ind-list').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-add]')?.dataset.add;
    if (!id) return;
    const def = INDICATOR_MAP.get(id)!;
    chart.addIndicator(id, defaultParams(def.params));
    renderActiveIndicators();
    updateLegend();
    save();
    toast(`${def.name} toegevoegd`);
    void ensureExt();
  });

  $('#active-indicators').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-uid]');
    if (btn && row) void indicatorAction(Number(row.dataset.uid), btn.dataset.act!);
  });
  // Buttons in the chart legend. pointerdown instead of click: the legend is re-rendered
  // on live ticks, which could swallow a click between press and release.
  $('#legend').addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-uid]');
    if (!btn || !row) return;
    e.preventDefault();
    e.stopPropagation();
    void indicatorAction(Number(row.dataset.uid), btn.dataset.act!);
  });
}

async function indicatorAction(uid: number, act: string) {
  const ind = chart.indicators.find((i) => i.uid === uid);
  if (!ind) return;
  if (act === 'remove') {
    if (ind.fromStrategy) {
      // Strategy indicators come back on every backtest, so switch them all off instead.
      state.strategy.showIndicators = false;
      $<HTMLInputElement>('#show-ind').checked = false;
      chart.removeStrategyIndicators();
      toast('Strategie-indicatoren verborgen (vink "indicatoren" aan in de Strategy Tester om ze terug te zetten)');
    } else {
      chart.removeIndicator(uid);
    }
  }
  if (act === 'toggle') chart.toggleIndicator(uid);
  if (act === 'edit') {
    const p = await editParams(ind.def.name, ind.def.params, ind.params);
    if (p) chart.updateIndicator(uid, p);
  }
  renderActiveIndicators();
  updateLegend();
  save();
}

// ============================================================================
// Drawing tools & alerts
// ============================================================================

const drawingKey = () => (csvData ? `csv:${csvData.name}` : `${state.exchange}:${state.symbol}`);

const TOOL_HINTS: Record<DrawTool, string> = {
  none: '',
  hline: 'Klik op een prijs voor een horizontale lijn · Esc = annuleren',
  trend: 'Klik op het startpunt en daarna het eindpunt · Esc = annuleren',
  fib: 'Klik op de swing high/low en daarna het andere uiteinde · Esc = annuleren',
  alert: 'Klik op de prijs waarop je een alarm wilt · Esc = annuleren',
  pick: 'Klik op de grafiek om de prijs over te nemen · Esc = annuleren',
};

function setTool(tool: DrawTool) {
  chart.tool = chart.tool === tool ? 'none' : tool;
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === chart.tool);
  const hint = $('#tool-hint');
  hint.hidden = chart.tool === 'none';
  hint.textContent = TOOL_HINTS[chart.tool];
}

function setupTools() {
  for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool as DrawTool));
  chart.onToolDone = () => setTool('none');
  chart.onDrawingsChange = (d) => {
    state.drawings[drawingKey()] = d;
    save();
  };
  chart.onAlertPick = (price) => addAlert(price);
  $('#btn-clear-drawings').addEventListener('click', () => chart.clearDrawings());
  $('#btn-autoscale').addEventListener('click', () => chart.fitContent());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chart.tool !== 'none') setTool('none');
    // "A" = auto-scale (ignored while typing in a field)
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'a') chart.fitContent();
  });
  $('#btn-notify').addEventListener('click', async () => {
    if (!('Notification' in window)) return toast('Je browser ondersteunt geen meldingen', true);
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? 'Meldingen staan aan' : 'Meldingen zijn geweigerd', p !== 'granted');
    updateNotifyButton();
  });
  $('#alerts').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-alert]')?.dataset.alert;
    if (!id) return;
    state.alerts = state.alerts.filter((a) => a.id !== Number(id));
    renderAlerts();
    save();
  });
}

function updateNotifyButton() {
  $('#btn-notify').hidden = 'Notification' in window && Notification.permission === 'granted';
}

function addAlert(price: number) {
  if (csvData) return toast('Alarmen werken alleen met live data', true);
  const last = lastPrice || candles[candles.length - 1]?.close || price;
  state.alerts.push({ id: Date.now(), exchange: state.exchange, symbol: state.symbol, price, above: price > last });
  renderAlerts();
  save();
  toast(`Alarm gezet: ${state.symbol} ${price > last ? '≥' : '≤'} ${fmtPrice(price)}`);
}

function renderAlerts() {
  $('#alerts').innerHTML = state.alerts.length
    ? state.alerts
        .map((a) => `<li><span class="name">${a.symbol} ${a.above ? '≥' : '≤'} ${fmtPrice(a.price)} <span class="hud-dim">${EXCHANGES[a.exchange]?.name ?? ''}</span></span><button class="x" data-alert="${a.id}" title="Verwijderen">✕</button></li>`)
        .join('')
    : '<li class="empty">Geen alarmen — gebruik ⏰ en klik op de grafiek</li>';
  refreshAlertLines();
}

function refreshAlertLines() {
  chart.setAlertLines(csvData ? [] : state.alerts.filter((a) => a.symbol === state.symbol && a.exchange === state.exchange).map((a) => a.price));
}

function checkAlerts(exchange: Exchange['id'], symbol: string, price: number) {
  const hit = state.alerts.filter((a) => a.exchange === exchange && a.symbol === symbol && (a.above ? price >= a.price : price <= a.price));
  if (!hit.length) return;
  for (const a of hit) {
    const msg = `${a.symbol} is ${a.above ? 'gestegen boven' : 'gedaald onder'} ${fmtPrice(a.price)} (nu ${fmtPrice(price)})`;
    toast(`⏰ ${msg}`);
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('SideChart alarm', { body: msg });
      } catch {
        /* some mobile browsers only allow notifications from a service worker */
      }
    }
  }
  state.alerts = state.alerts.filter((a) => !hit.includes(a));
  renderAlerts();
  save();
}

// ============================================================================
// Strategy tester
// ============================================================================

const currentStrategy = () => STRATEGY_MAP.get(state.strategy.id) ?? STRATEGIES[0];

function strategyParams(): Params {
  const def = currentStrategy();
  return { ...defaultParams(def.params), ...state.strategy.params[def.id] };
}

function buildSignals(params: Params): Signals {
  const def = currentStrategy();
  return def.id === 'custom' ? customSignals(candles, state.strategy.rules, ext) : def.signals(candles, params, ext);
}

function renderStrategyForm() {
  const def = currentStrategy();
  $<HTMLSelectElement>('#strategy').value = def.id;
  $('#strategy-desc').textContent = def.description;
  $('#strategy-params').innerHTML = paramFieldsHtml(def.params, strategyParams(), 'sp');
  $('#custom-rules').hidden = def.id !== 'custom';
  renderOptimizerRanges();
}

function syncStrategyIndicators() {
  chart.removeStrategyIndicators();
  const def = currentStrategy();
  if (state.strategy.enabled && state.strategy.showIndicators && def.indicators) {
    for (const ind of def.indicators(strategyParams())) chart.addIndicator(ind.id, ind.params, true);
  }
  renderActiveIndicators();
  updateLegend();
}

function runStrategy() {
  const errEl = $('#strategy-error');
  errEl.hidden = true;
  errEl.className = 'error';
  if (!candles.length) return;
  state.strategy.enabled = true;
  void ensureExt();
  try {
    lastResult = runBacktest(candles, buildSignals(strategyParams()), state.strategy.settings, ext.funding ?? []);
  } catch (e) {
    errEl.textContent = (e as Error).message;
    errEl.hidden = false;
    return;
  }
  chart.setTrades(lastResult.trades);
  syncStrategyIndicators();
  renderResults(lastResult);
  const def = currentStrategy();
  const extNeeded = def.external ?? [];
  const ranges = extNeeded.map((k) => ext[k]).filter((p) => p?.length);
  if (ranges.length && candles.length) {
    const from = Math.max(...ranges.map((p) => p![0].time));
    if (from > candles[0].time + currentTf.seconds * 10) {
      errEl.textContent = `Let op: ${extNeeded.map(extName).join('/')}-historie begint pas op ${fmtTime(from)}. Daarvoor zijn er geen signalen.`;
      errEl.className = 'warning';
      errEl.hidden = false;
    }
  }
  save();
}

function strategyOff() {
  state.strategy.enabled = false;
  lastResult = null;
  chart.clearTrades();
  chart.removeStrategyIndicators();
  renderActiveIndicators();
  updateLegend();
  $('#metrics').innerHTML = '<p class="muted">Kies een strategie en klik op ▶ Backtest. Alle resultaten zijn inclusief leverage, fees, funding en liquidaties.</p>';
  $('#trades').innerHTML = '';
  $('#tester-summary').innerHTML = '';
  equityChart.setData([], [], [], state.strategy.settings.initialCapital);
  save();
}

function metricCards(m: Metrics) {
  const s = state.strategy.settings;
  const cards: [string, string, number?, boolean?][] = [
    ['Netto winst', `${fmtMoney(m.netProfit)} (${fmtPct(m.netProfitPct)})`, m.netProfit],
    ['Buy & hold (1×)', fmtPct(m.buyHoldPct), m.buyHoldPct],
    ['Trades', String(m.totalTrades)],
    ['Win rate', `${m.winRate.toFixed(1)}% (${m.winners}/${m.totalTrades})`],
    ['Profit factor', Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', m.profitFactor - 1],
    ['Max drawdown', `${(-m.maxDrawdownPct).toFixed(2)}%`, -1],
    ['Liquidaties', String(m.liquidations), m.liquidations ? -1 : undefined, m.liquidations > 0],
    ['Funding betaald', fmtMoney(-m.fundingPaid), -m.fundingPaid],
    ['Fees betaald', fmtMoney(-m.totalFees), -1],
    ['Gem. ROE / trade', fmtPct(m.avgTradePct), m.avgTradePct],
    ['Gem. winst / verlies', `${fmtMoney(m.avgWin)} / ${fmtMoney(m.avgLoss)}`],
    ['Grootste winst', fmtMoney(m.largestWin), m.largestWin],
    ['Grootste verlies', fmtMoney(m.largestLoss), m.largestLoss],
    ['Sharpe', m.sharpe.toFixed(2), m.sharpe],
    ['Sortino', m.sortino.toFixed(2), m.sortino],
    ['CAGR', fmtPct(m.cagrPct), m.cagrPct],
    ['In de markt', `${m.exposurePct.toFixed(1)}%`],
    ['Max verliezers op rij', String(m.maxConsecLosses)],
    ['Eindsaldo', `${fmtMoney(s.initialCapital + m.netProfit)} USDT`, m.netProfit],
  ];
  if (m.blownUp) cards.unshift(['⚠ Account', 'LEEG — te weinig saldo voor nieuwe trades', -1, true]);
  return cards
    .map(([k, v, sign, alert]) => `<div class="metric${alert ? ' alert' : ''}"><div class="k">${k}</div><div class="v ${sign !== undefined ? cls(sign) : ''}">${v}</div></div>`)
    .join('');
}

function renderResults(r: BacktestResult) {
  const m = r.metrics;
  const s = state.strategy.settings;
  $('#metrics').innerHTML = metricCards(m);
  $('#tester-summary').innerHTML =
    `${esc(currentStrategy().name)} · ${s.leverage}× · Netto <b class="${cls(m.netProfit)}">${fmtPct(m.netProfitPct)}</b> · ` +
    `${m.totalTrades} trades · win ${m.winRate.toFixed(0)}% · PF ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'} · ` +
    `DD <b class="down">${(-m.maxDrawdownPct).toFixed(1)}%</b>${m.liquidations ? ` · <b class="amber">${m.liquidations} LIQ</b>` : ''}`;
  equityChart.setData(candles, r.equity, r.drawdown, s.initialCapital);
  renderTrades(r);
}

function renderTrades(r: BacktestResult) {
  const rows = r.trades.slice(-2000).reverse();
  const total = r.trades.length;
  $('#trades').innerHTML =
    `<thead><tr><th>#</th><th>Type</th><th>Entry</th><th>Entry prijs</th><th>Exit</th><th>Exit prijs</th><th>Reden</th><th>Marge</th><th>PnL</th><th>ROE</th><th>Koers</th><th>Funding</th><th>Liq. prijs</th><th>Bars</th></tr></thead><tbody>` +
    rows
      .map(
        (t, k) =>
          `<tr class="click${t.liquidated ? ' liq' : ''}" data-time="${t.entryTime}"><td>${total - k}</td><td class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? 'LONG' : 'SHORT'} ${t.leverage}×</td>` +
          `<td>${fmtTime(t.entryTime)}</td><td>${fmtPrice(t.entryPrice)}</td><td>${fmtTime(t.exitTime)}</td><td>${fmtPrice(t.exitPrice)}</td><td class="${t.liquidated ? 'amber' : ''}">${t.exitReason}</td>` +
          `<td>${fmtMoney(t.margin)}</td><td class="${cls(t.pnl)}">${fmtMoney(t.pnl)}</td><td class="${cls(t.pnl)}">${fmtPct(t.pnlPct, 1)}</td><td>${fmtPct(t.movePct)}</td>` +
          `<td class="${cls(-t.funding)}">${fmtMoney(-t.funding)}</td><td>${fmtPrice(t.liqPrice)}</td><td>${t.bars}</td></tr>`,
      )
      .join('') +
    '</tbody>';
  if (!r.trades.length) $('#trades').innerHTML += '<tbody><tr><td colspan="14" class="empty">Geen trades in deze periode</td></tr></tbody>';
}

function exportTrades() {
  if (!lastResult?.trades.length) return toast('Nog geen trades om te exporteren', true);
  const head = 'nr,side,leverage,entry_time,entry_price,exit_time,exit_price,qty,margin,pnl,roe_pct,price_move_pct,fees,funding,liq_price,liquidated,bars,reason';
  const lines = lastResult.trades.map((t, i) =>
    [i + 1, t.side, t.leverage, new Date(t.entryTime * 1000).toISOString(), t.entryPrice, new Date(t.exitTime * 1000).toISOString(), t.exitPrice, t.qty, t.margin.toFixed(2), t.pnl.toFixed(2), t.pnlPct.toFixed(2), t.movePct.toFixed(3), t.fees.toFixed(2), t.funding.toFixed(4), t.liqPrice, t.liquidated, t.bars, t.exitReason].join(','),
  );
  const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.exchange}_${state.symbol}_${currentTf.label}_${state.strategy.id}_trades.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- optimizer ----

function renderOptimizerRanges() {
  const def = currentStrategy();
  const numeric = def.params
    .filter((p): p is Extract<ParamDef, { type: 'number' }> => p.type === 'number')
    .map((p) => ({ key: p.key, label: p.label, step: p.step ?? 1, min: p.min ?? p.step ?? 1, value: Number(strategyParams()[p.key]) }));
  const lev = state.strategy.settings.leverage;
  numeric.push({ key: '__leverage', label: 'Leverage ×', step: 1, min: 1, value: lev });
  $('#opt-ranges').innerHTML =
    '<span></span><small class="muted">van</small><small class="muted">tot</small><small class="muted">stap</small>' +
    numeric
      .map((p, i) => {
        const isLev = p.key === '__leverage';
        const from = isLev ? 1 : Math.max(p.min, +(p.value / 2).toFixed(4));
        const to = isLev ? Math.max(20, lev * 2) : +(p.value * 2).toFixed(4);
        const st = isLev ? Math.max(1, Math.round((to - from) / 10)) : p.step < 1 ? p.step * Math.max(1, Math.round(p.value / p.step / 8)) : Math.max(1, Math.round(p.value / 8));
        return (
          `<label class="check"><input type="checkbox" data-opt="${p.key}" ${i < 2 && !isLev ? 'checked' : ''}/> ${esc(p.label)}</label>` +
          `<input type="number" data-from="${p.key}" value="${from}" step="${p.step}"/>` +
          `<input type="number" data-to="${p.key}" value="${to}" step="${p.step}"/>` +
          `<input type="number" data-step="${p.key}" value="${+st.toFixed(4)}" step="${p.step}"/>`
        );
      })
      .join('');
}

function runOptimizer() {
  const def = currentStrategy();
  if (!candles.length) return;
  const keys = $$<HTMLInputElement>('[data-opt]').filter((c) => c.checked).map((c) => c.dataset.opt!);
  if (!keys.length) return toast('Vink minstens één parameter aan', true);
  if (keys.length > 2) return toast('Kies maximaal 2 parameters', true);
  if (def.id === 'custom' && keys.some((k) => k !== '__leverage')) return toast('Bij eigen regels kun je alleen leverage optimaliseren', true);
  const ranges = keys.map((key) => ({
    key,
    from: parseFloat($<HTMLInputElement>(`[data-from="${key}"]`).value),
    to: parseFloat($<HTMLInputElement>(`[data-to="${key}"]`).value),
    step: parseFloat($<HTMLInputElement>(`[data-step="${key}"]`).value),
  }));
  if (ranges.some((r) => !(r.step > 0) || !(r.to >= r.from))) return toast('Controleer van/tot/stap', true);
  const combos = ranges.reduce((a, r) => a * (Math.floor((r.to - r.from) / r.step + 1e-9) + 1), 1);
  if (combos > 2500) return toast(`${combos} combinaties is te veel (max 2500). Vergroot de stap.`, true);

  const table = $('#opt-results');
  table.innerHTML = `<tbody><tr><td>Bezig met ${combos} backtests…</td></tr></tbody>`;
  setTimeout(() => {
    const base = strategyParams();
    const t0 = performance.now();
    const fixedSignals = def.id === 'custom' ? customSignals(candles, state.strategy.rules, ext) : null;
    const rows = optimize(
      candles,
      (values) => fixedSignals ?? def.signals(candles, { ...base, ...values }, ext),
      ranges,
      state.strategy.settings,
      ext.funding ?? [],
    );
    const sortKey = $<HTMLSelectElement>('#opt-sort').value as keyof Metrics;
    rows.sort((a, b) => (sortKey === 'maxDrawdownPct' ? a.metrics[sortKey] - b.metrics[sortKey] : (b.metrics[sortKey] as number) - (a.metrics[sortKey] as number)));
    const label = (k: string) => (k === '__leverage' ? 'Leverage' : (def.params.find((p) => p.key === k)?.label ?? k));
    table.innerHTML =
      `<thead><tr>${keys.map((k) => `<th>${esc(label(k))}</th>`).join('')}<th>Netto %</th><th>Trades</th><th>Win %</th><th>PF</th><th>Max DD %</th><th>LIQ</th><th>Sharpe</th></tr></thead><tbody>` +
      rows
        .slice(0, 100)
        .map(
          (r) =>
            `<tr class="click" data-values='${JSON.stringify(r.values)}'>${keys.map((k) => `<td>${r.values[k]}</td>`).join('')}` +
            `<td class="${cls(r.metrics.netProfitPct)}">${fmtPct(r.metrics.netProfitPct)}</td><td>${r.metrics.totalTrades}</td><td>${r.metrics.winRate.toFixed(1)}</td>` +
            `<td>${Number.isFinite(r.metrics.profitFactor) ? r.metrics.profitFactor.toFixed(2) : '∞'}</td><td class="down">${(-r.metrics.maxDrawdownPct).toFixed(2)}</td>` +
            `<td class="${r.metrics.liquidations ? 'amber' : ''}">${r.metrics.liquidations}</td><td>${r.metrics.sharpe.toFixed(2)}</td></tr>`,
        )
        .join('') +
      '</tbody>';
    toast(`${rows.length} backtests in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }, 30);
}

const SETTING_INPUTS: [string, keyof BacktestSettings][] = [
  ['#s-capital', 'initialCapital'],
  ['#s-margin', 'marginPct'],
  ['#s-lev', 'leverage'],
  ['#s-fee', 'takerFeePct'],
  ['#s-slip', 'slippagePct'],
  ['#s-mmr', 'maintMarginPct'],
  ['#s-dir', 'direction'],
  ['#s-fill', 'fillOn'],
  ['#s-sl', 'stopLossPct'],
  ['#s-tp', 'takeProfitPct'],
  ['#s-trail', 'trailingPct'],
  ['#s-funding', 'funding'],
  ['#s-ffix', 'fixedFundingPct'],
  ['#s-fint', 'fundingIntervalH'],
];

function setupStrategyUi() {
  $('#strategy').innerHTML =
    `<optgroup label="⚡ Futures">${STRATEGIES.filter((s) => s.external).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>` +
    `<optgroup label="Technisch">${STRATEGIES.filter((s) => !s.external && s.id !== 'custom').map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>` +
    `<optgroup label="Zelf maken"><option value="custom">Eigen regels (no-code)</option></optgroup>`;
  $('#rule-help').textContent = RULE_HELP;

  const s = state.strategy;
  const ruleInputs: [string, keyof CustomRules][] = [
    ['#rule-el', 'entryLong'],
    ['#rule-xl', 'exitLong'],
    ['#rule-es', 'entryShort'],
    ['#rule-xs', 'exitShort'],
  ];
  for (const [sel, key] of ruleInputs) $<HTMLInputElement>(sel).value = s.rules[key];
  for (const [sel, key] of SETTING_INPUTS) $<HTMLInputElement>(sel).value = String(s.settings[key]);
  $<HTMLInputElement>('#auto-run').checked = s.autoRun;
  $<HTMLInputElement>('#show-ind').checked = s.showIndicators;

  const autoRun = debounce(() => {
    save();
    if (s.enabled && s.autoRun) runStrategy();
  }, 350);

  $('#strategy').addEventListener('change', (e) => {
    s.id = (e.target as HTMLSelectElement).value;
    renderStrategyForm();
    $('#opt-results').innerHTML = '';
    autoRun();
  });
  $('#strategy-params').addEventListener('input', () => {
    const def = currentStrategy();
    s.params[def.id] = readParams($('#strategy-params'), def.params, 'sp');
    autoRun();
  });
  for (const [sel, key] of ruleInputs) {
    $(sel).addEventListener('input', (e) => {
      s.rules[key] = (e.target as HTMLInputElement).value;
      autoRun();
    });
  }
  for (const [sel, key] of SETTING_INPUTS) {
    $(sel).addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const settings = s.settings as unknown as Record<string, number | string>;
      if (el.type === 'number') {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        settings[key] = v;
      } else settings[key] = el.value;
      if (key === 'leverage') renderOptimizerRanges();
      autoRun();
    });
  }
  $('#auto-run').addEventListener('change', (e) => {
    s.autoRun = (e.target as HTMLInputElement).checked;
    save();
  });
  $('#show-ind').addEventListener('change', (e) => {
    s.showIndicators = (e.target as HTMLInputElement).checked;
    syncStrategyIndicators();
    save();
  });
  $('#btn-run').addEventListener('click', () => runStrategy());
  $('#btn-strategy-off').addEventListener('click', () => strategyOff());
  $('#btn-export').addEventListener('click', () => exportTrades());
  $('#btn-optimize').addEventListener('click', () => runOptimizer());

  $('#trades').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-time]')?.dataset.time;
    if (t) chart.scrollToTime(Number(t));
  });
  $('#opt-results').addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>('[data-values]')?.dataset.values;
    if (!v) return;
    const def = currentStrategy();
    const values = JSON.parse(v) as Record<string, number>;
    if (values.__leverage !== undefined) {
      s.settings.leverage = values.__leverage;
      $<HTMLInputElement>('#s-lev').value = String(values.__leverage);
      delete values.__leverage;
    }
    s.params[def.id] = { ...strategyParams(), ...values };
    renderStrategyForm();
    runStrategy();
    switchTab('overview');
    toast('Instellingen toegepast');
  });

  for (const tab of $$('.tab')) tab.addEventListener('click', () => switchTab(tab.dataset.tab!));
  $('#btn-tester-toggle').addEventListener('click', () => {
    state.testerCollapsed = !state.testerCollapsed;
    applyLayout();
    save();
  });
  renderStrategyForm();
}

function switchTab(name: string) {
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of $$('.tab-panel')) p.hidden = p.dataset.panel !== name;
  if (state.testerCollapsed) {
    state.testerCollapsed = false;
    applyLayout();
  }
}

function switchSideTab(name: SideTab) {
  state.sideTab = name;
  for (const t of $$('.side-tab')) t.classList.toggle('active', t.dataset.side === name);
  for (const p of $$('.side-panel')) p.hidden = p.dataset.sidepanel !== name;
  save();
}

function applyLayout() {
  $('#tester').classList.toggle('collapsed', state.testerCollapsed);
  $('#btn-tester-toggle').textContent = state.testerCollapsed ? '▴' : '▾';
  $('#sidebar').classList.toggle('hidden', !state.sidebar);
}

// ============================================================================
// Top bar & sidebar wiring
// ============================================================================

function setupTopbar() {
  for (const b of $$('#exchange button')) {
    b.classList.toggle('active', b.dataset.ex === state.exchange);
    b.addEventListener('click', () => setExchange(b.dataset.ex as Exchange['id']));
  }

  const symbolInput = $<HTMLInputElement>('#symbol');
  symbolInput.value = state.symbol;
  symbolInput.addEventListener('change', () => setSymbol(symbolInput.value));
  symbolInput.addEventListener('focus', () => symbolInput.select());

  const typeSel = $<HTMLSelectElement>('#chart-type');
  typeSel.value = state.chartType;
  typeSel.addEventListener('change', () => {
    state.chartType = typeSel.value as ChartType;
    chart.setChartType(state.chartType);
    chart.setTrades(lastResult?.trades ?? []);
    save();
  });

  const barsSel = $<HTMLSelectElement>('#bars');
  barsSel.value = String(state.bars);
  barsSel.addEventListener('change', () => {
    state.bars = Number(barsSel.value);
    save();
    void loadData();
  });

  $('#btn-sidebar').addEventListener('click', () => {
    state.sidebar = !state.sidebar;
    applyLayout();
    save();
  });
  for (const t of $$('.side-tab')) t.addEventListener('click', () => switchSideTab(t.dataset.side as SideTab));

  // markets
  $('#market-search').addEventListener('input', () => renderMarkets());
  const sortSel = $<HTMLSelectElement>('#market-sort');
  sortSel.value = state.marketSort;
  sortSel.addEventListener('change', () => {
    state.marketSort = sortSel.value;
    renderMarkets();
    save();
  });
  $('#markets').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const fav = target.closest<HTMLElement>('[data-fav]')?.dataset.fav;
    if (fav) {
      state.favorites = state.favorites.includes(fav) ? state.favorites.filter((s) => s !== fav) : [...state.favorites, fav];
      renderMarkets();
      save();
      return;
    }
    const sym = target.closest<HTMLElement>('[data-sym]')?.dataset.sym;
    if (sym) {
      setSymbol(sym);
      if (window.innerWidth <= 1100) {
        state.sidebar = false;
        applyLayout();
      }
    }
  });

  // liquidations
  const liqMin = $<HTMLSelectElement>('#liq-min');
  liqMin.value = String(state.liqMin);
  liqMin.addEventListener('change', () => {
    state.liqMin = Number(liqMin.value);
    renderLiqs();
    save();
  });
  const liqOnly = $<HTMLInputElement>('#liq-only');
  liqOnly.checked = state.liqOnlyCurrent;
  liqOnly.addEventListener('change', () => {
    state.liqOnlyCurrent = liqOnly.checked;
    renderLiqs();
    save();
  });
  $('#liqs').addEventListener('click', (e) => {
    const sym = (e.target as HTMLElement).closest<HTMLElement>('[data-sym]')?.dataset.sym;
    if (sym && contracts.some((c) => c.symbol === sym)) setSymbol(sym);
  });
  $('#btn-liq-okx').addEventListener('click', () => {
    liqSourceOverride = true;
    startLiquidations();
  });

  // CSV import
  $<HTMLInputElement>('#csv').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.length < 2) throw new Error('Te weinig rijen in CSV');
      const diffs = parsed.slice(1, 200).map((c, i) => c.time - parsed[i].time).sort((a, b) => a - b);
      const seconds = diffs[Math.floor(diffs.length / 2)] || 86400;
      csvData = { name: file.name.replace(/\.csv$/i, ''), candles: parsed, seconds };
      const unit = Object.entries({ M: 2592000, W: 604800, D: 86400, h: 3600, m: 60 }).find(([, sec]) => seconds % sec === 0 && seconds >= sec) ?? ['m', 60];
      currentTf = parseTimeframe(`${Math.round(seconds / unit[1])}${unit[0]}`) ?? currentTf;
      unsubscribe?.();
      stats = null;
      $<HTMLInputElement>('#symbol').value = '';
      $<HTMLInputElement>('#symbol').placeholder = csvData.name;
      toast(`${parsed.length.toLocaleString()} bars geladen uit ${file.name}`);
      renderHud();
      void loadData();
    } catch (err) {
      toast((err as Error).message, true);
    }
  });
}

// ============================================================================
// Boot
// ============================================================================

function boot() {
  if (window.innerWidth <= 1100) state.sidebar = false;
  chart.setTheme(NEON);
  equityChart.setTheme(NEON);
  buildTimeframes();
  setupTopbar();
  setupIndicatorUi();
  setupTools();
  setupStrategyUi();
  setupCalc();
  applyLayout();
  switchSideTab(state.sideTab);
  chart.setChartType(state.chartType);

  for (const ind of state.indicators) {
    const def = INDICATOR_MAP.get(ind.id);
    if (!def) continue;
    const added = chart.addIndicator(ind.id, { ...defaultParams(def.params), ...ind.params });
    if (added && ind.hidden) chart.toggleIndicator(added.uid);
  }
  renderActiveIndicators();
  renderAlerts();
  updateNotifyButton();
  renderHud();
  if (!state.strategy.enabled) strategyOff();

  void loadSymbolList();
  void loadData();
  void pollMarkets();
  startLiquidations();
  setInterval(() => void pollMarkets(), 10000);
  setInterval(() => void refreshStats(), 5000);
  setInterval(renderCountdown, 1000);
  setInterval(() => {
    if (liqs.length) renderLiqs(); // keep the 1-hour totals rolling
  }, 15000);
  // Refresh Bitget sentiment data every 5 minutes when an indicator uses it.
  setInterval(() => {
    if (neededExt().some((k) => k === 'lsr' || k === 'takerBuy')) void ensureExt(true);
  }, 300000);
}

boot();
