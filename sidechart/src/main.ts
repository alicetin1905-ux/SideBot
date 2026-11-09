import './style.css';
import type { Candle, ParamDef, Params } from './types';
import {
  NATIVE_INTERVALS,
  baseIntervalFor,
  bucketStart,
  fetchKlines,
  fetchSymbols,
  fetchTickers,
  parseCsv,
  parseTimeframe,
  resample,
  subscribeKlines,
  type Timeframe,
} from './data';
import { ChartView, EquityChart, THEMES, type ChartType, type Drawing, type DrawTool } from './chart';
import { INDICATORS, INDICATOR_MAP, defaultParams } from './indicators';
import { RULE_HELP, STRATEGIES, STRATEGY_MAP, customSignals, type CustomRules, type Signals } from './strategies';
import { DEFAULT_SETTINGS, optimize, runBacktest, type BacktestResult, type BacktestSettings, type Metrics } from './backtest';

// ============================================================================
// State (persisted in localStorage)
// ============================================================================

interface Alert {
  id: number;
  symbol: string;
  price: number;
  above: boolean;
}

interface State {
  symbol: string;
  tf: string;
  chartType: ChartType;
  bars: number;
  theme: 'dark' | 'light';
  sidebar: boolean;
  testerCollapsed: boolean;
  watchlist: string[];
  indicators: { id: string; params: Params; hidden?: boolean }[];
  drawings: Record<string, Drawing[]>;
  alerts: Alert[];
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

const STORAGE_KEY = 'sidechart:v1';

const DEFAULT_STATE: State = {
  symbol: 'BTCUSDT',
  tf: '1h',
  chartType: 'candles',
  bars: 5000,
  theme: window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  sidebar: window.innerWidth > 1000,
  testerCollapsed: false,
  watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT'],
  indicators: [{ id: 'volume', params: { ma: 20 } }],
  drawings: {},
  alerts: [],
  strategy: {
    id: 'ma_cross',
    enabled: false,
    autoRun: true,
    showIndicators: true,
    params: {},
    rules: {
      entryLong: 'EMA(9) crosses above EMA(21) AND RSI(14) > 50',
      exitLong: 'EMA(9) crosses below EMA(21)',
      entryShort: '',
      exitShort: '',
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
  return a >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : a >= 1 ? v.toFixed(4) : v.toPrecision(5);
}
const fmtMoney = (v: number) => (Number.isFinite(v) ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '∞');
const fmtPct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '∞');
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

function paramLabel(p: Params) {
  const v = Object.values(p);
  return v.length ? ` (${v.join(', ')})` : '';
}

// ============================================================================
// Chart setup
// ============================================================================

const chart = new ChartView($('#chart'));
const equityChart = new EquityChart($('#equity'));

let candles: Candle[] = [];
let baseCandles: Candle[] = [];
let currentTf: Timeframe = parseTimeframe(state.tf) ?? parseTimeframe('1h')!;
let csvData: { name: string; candles: Candle[]; seconds: number } | null = null;
let unsubscribe: (() => void) | null = null;
let loadToken = 0;
let lastResult: BacktestResult | null = null;

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const t = THEMES[state.theme];
  chart.setTheme(t);
  equityChart.setTheme(t);
}

function updateLegend(html?: string) {
  const name = csvData ? csvData.name : state.symbol;
  const src = csvData ? 'CSV' : 'Binance';
  $('#legend').innerHTML = `<div><span class="title">${esc(name)} · ${currentTf.label} · ${src}</span>${html ?? chart.legendText()}</div>`;
}
chart.onCrosshair = (html) => updateLegend(html);

// ============================================================================
// Timeframes
// ============================================================================

const QUICK_TF = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

function nativeLabel(k: string) {
  return k.replace(/d$/, 'D').replace(/w$/, 'W');
}

function buildTimeframes() {
  $('#tf-buttons').innerHTML = QUICK_TF.map((t) => `<button class="btn" data-tf="${t}">${t}</button>`).join('');
  const all = Object.keys(NATIVE_INTERVALS).map(nativeLabel);
  const extra = ['2m', '10m', '20m', '45m', '3h', '2D', '2W', '3M', '6M', '12M'];
  $('#tf-more').innerHTML =
    `<option value="">Meer…</option><optgroup label="Exchange">${all.map((t) => `<option>${t}</option>`).join('')}</optgroup>` +
    `<optgroup label="Samengesteld">${extra.map((t) => `<option>${t}</option>`).join('')}</optgroup>`;
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
}

function markTimeframe() {
  for (const b of $$('#tf-buttons .btn')) b.classList.toggle('active', b.dataset.tf === currentTf.label);
  const sel = $<HTMLSelectElement>('#tf-more');
  sel.value = QUICK_TF.includes(currentTf.label) ? '' : currentTf.label;
  if (sel.value !== currentTf.label && !QUICK_TF.includes(currentTf.label)) sel.value = '';
}

function setTimeframe(label: string): boolean {
  const tf = parseTimeframe(label);
  if (!tf) {
    toast(`Ongeldige timeframe "${label}". Voorbeelden: 1m, 45m, 4h, 2D, 1W, 3M`, true);
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

async function loadData() {
  const token = ++loadToken;
  unsubscribe?.();
  unsubscribe = null;
  markTimeframe();

  if (csvData) {
    const tf = currentTf;
    candles = tf.seconds > csvData.seconds ? resample(csvData.candles, tf) : csvData.candles;
    if (tf.seconds < csvData.seconds) toast(`CSV-data is ${Math.round(csvData.seconds / 60)} min per bar; kleinere timeframes kunnen niet.`);
    afterLoad();
    return;
  }

  const { interval, resample: needsResample } = baseIntervalFor(currentTf);
  const factor = needsResample ? Math.max(1, Math.round(currentTf.seconds / NATIVE_INTERVALS[interval])) : 1;
  const baseBars = Math.min(state.bars * factor, 60000);
  setStatus(`${state.symbol} laden…`);
  try {
    const raw = await fetchKlines(state.symbol, interval, baseBars, (n) => {
      if (token === loadToken) setStatus(`${state.symbol} laden… ${n.toLocaleString()} bars`);
    });
    if (token !== loadToken) return;
    if (!raw.length) throw new Error('Geen data voor dit symbool/timeframe');
    baseCandles = raw;
    candles = needsResample ? resample(raw, currentTf) : raw.slice();
    setStatus(null);
    afterLoad();
    unsubscribe = subscribeKlines(state.symbol, interval, (k) => onTick(k, needsResample));
  } catch (e) {
    if (token !== loadToken) return;
    setStatus(null);
    toast(`${(e as Error).message}`, true);
  }
}

function afterLoad() {
  chart.setCandles(candles, currentTf.seconds);
  chart.fitContent();
  chart.setDrawings(state.drawings[drawingKey()] ?? []);
  refreshAlertLines();
  updateLegend();
  renderWatchlist();
  if (state.strategy.enabled) runStrategy();
}

let indicatorTimer = 0;
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
  checkAlerts(state.symbol, bar.close);

  if (!indicatorTimer) {
    indicatorTimer = window.setTimeout(() => {
      indicatorTimer = 0;
      chart.refreshIndicators();
      updateLegend();
    }, 1000);
  }
  if (newBar && state.strategy.enabled && state.strategy.autoRun) runStrategy();
}

// ============================================================================
// Symbol & watchlist
// ============================================================================

function setSymbol(sym: string) {
  const s = sym.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return;
  csvData = null;
  state.symbol = s;
  $<HTMLInputElement>('#symbol').value = s;
  save();
  void loadData();
}

async function loadSymbolList() {
  try {
    const list = await fetchSymbols();
    const preferred = ['USDT', 'USDC', 'FDUSD', 'EUR', 'BTC'];
    list.sort((a, b) => {
      const pa = preferred.indexOf(a.quote);
      const pb = preferred.indexOf(b.quote);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || a.symbol.localeCompare(b.symbol);
    });
    $('#symbol-list').innerHTML = list.map((s) => `<option value="${s.symbol}">${s.base}/${s.quote}</option>`).join('');
  } catch {
    /* the input still accepts any symbol */
  }
}

const tickerCache = new Map<string, { last: number; changePct: number }>();

function renderWatchlist() {
  const ul = $('#watchlist');
  if (!state.watchlist.length) {
    ul.innerHTML = '<li class="empty">Leeg — klik op + om toe te voegen</li>';
    return;
  }
  ul.innerHTML = state.watchlist
    .map((s) => {
      const t = tickerCache.get(s);
      const current = !csvData && s === state.symbol ? ' current' : '';
      return `<li data-sym="${s}" class="${current}"><span class="sym">${s}</span><span>${t ? fmtPrice(t.last) : '…'}</span><span class="chg ${t ? cls(t.changePct) : ''}">${t ? fmtPct(t.changePct) : ''}</span><button class="x" data-remove="${s}" title="Verwijderen">✕</button></li>`;
    })
    .join('');
}

async function pollTickers() {
  const tickers = await fetchTickers(state.watchlist).catch(() => []);
  for (const t of tickers) {
    tickerCache.set(t.symbol, t);
    if (t.symbol !== state.symbol || csvData) checkAlerts(t.symbol, t.last);
  }
  renderWatchlist();
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
          `<h4>${cat}</h4>` +
          defs.map((d) => `<button class="ind-item" data-add="${d.id}"><span>${esc(d.name)}</span><small>${d.overlay ? 'op grafiek' : 'eigen paneel'}</small></button>`).join(''),
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
        `<button class="btn icon" data-act="toggle" title="Tonen/verbergen">${i.hidden ? '◌' : '●'}</button>` +
        (i.def.params.length ? `<button class="btn icon" data-act="edit" title="Instellingen">⚙</button>` : '') +
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
    dlg.addEventListener(
      'close',
      () => resolve(dlg.returnValue === 'ok' ? readParams($('#params-fields'), defs) : null),
      { once: true },
    );
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
  });

  $('#active-indicators').addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-uid]');
    if (!btn || !li) return;
    const uid = Number(li.dataset.uid);
    const ind = chart.indicators.find((i) => i.uid === uid);
    if (!ind) return;
    if (btn.dataset.act === 'remove') chart.removeIndicator(uid);
    if (btn.dataset.act === 'toggle') chart.toggleIndicator(uid);
    if (btn.dataset.act === 'edit') {
      const p = await editParams(ind.def.name, ind.def.params, ind.params);
      if (p) chart.updateIndicator(uid, p);
    }
    renderActiveIndicators();
    updateLegend();
    save();
  });
}

// ============================================================================
// Drawing tools & alerts
// ============================================================================

function drawingKey() {
  return csvData ? `csv:${csvData.name}` : state.symbol;
}

const TOOL_HINTS: Record<DrawTool, string> = {
  none: '',
  hline: 'Klik op een prijs voor een horizontale lijn (Esc = annuleren)',
  trend: 'Klik op het startpunt en daarna het eindpunt (Esc = annuleren)',
  fib: 'Klik op de swing high/low en daarna het andere uiteinde (Esc = annuleren)',
  alert: 'Klik op de prijs waarop je een alarm wilt (Esc = annuleren)',
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chart.tool !== 'none') setTool('none');
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
  const granted = 'Notification' in window && Notification.permission === 'granted';
  $('#btn-notify').hidden = granted;
}

function addAlert(price: number) {
  if (csvData) return toast('Alarmen werken alleen met live data', true);
  const last = candles[candles.length - 1]?.close ?? price;
  state.alerts.push({ id: Date.now(), symbol: state.symbol, price, above: price > last });
  renderAlerts();
  save();
  toast(`Alarm gezet: ${state.symbol} ${price > last ? '≥' : '≤'} ${fmtPrice(price)}`);
}

function renderAlerts() {
  const ul = $('#alerts');
  ul.innerHTML = state.alerts.length
    ? state.alerts
        .map((a) => `<li><span class="name">${a.symbol} ${a.above ? '≥' : '≤'} ${fmtPrice(a.price)}</span><button class="x" data-alert="${a.id}" title="Verwijderen">✕</button></li>`)
        .join('')
    : '<li class="empty">Geen alarmen — gebruik 🔔 en klik op de grafiek</li>';
  refreshAlertLines();
}

function refreshAlertLines() {
  chart.setAlertLines(csvData ? [] : state.alerts.filter((a) => a.symbol === state.symbol).map((a) => a.price));
}

function checkAlerts(symbol: string, price: number) {
  const hit = state.alerts.filter((a) => a.symbol === symbol && (a.above ? price >= a.price : price <= a.price));
  if (!hit.length) return;
  for (const a of hit) {
    const msg = `${a.symbol} is ${a.above ? 'gestegen boven' : 'gedaald onder'} ${fmtPrice(a.price)} (nu ${fmtPrice(price)})`;
    toast(`🔔 ${msg}`);
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

function currentStrategy() {
  return STRATEGY_MAP.get(state.strategy.id) ?? STRATEGIES[0];
}

function strategyParams(): Params {
  const def = currentStrategy();
  return { ...defaultParams(def.params), ...state.strategy.params[def.id] };
}

function buildSignals(params: Params): Signals {
  const def = currentStrategy();
  return def.id === 'custom' ? customSignals(candles, state.strategy.rules) : def.signals(candles, params);
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
  if (!candles.length) return;
  state.strategy.enabled = true;
  try {
    const sig = buildSignals(strategyParams());
    lastResult = runBacktest(candles, sig, state.strategy.settings);
  } catch (e) {
    errEl.textContent = (e as Error).message;
    errEl.hidden = false;
    return;
  }
  chart.setTrades(lastResult.trades);
  syncStrategyIndicators();
  renderResults(lastResult);
  save();
}

function strategyOff() {
  state.strategy.enabled = false;
  lastResult = null;
  chart.clearTrades();
  chart.removeStrategyIndicators();
  renderActiveIndicators();
  updateLegend();
  $('#metrics').innerHTML = '<p class="muted">Kies een strategie en klik op ▶ Backtest.</p>';
  $('#trades').innerHTML = '';
  $('#tester-summary').innerHTML = '';
  equityChart.setData([], [], [], state.strategy.settings.initialCapital);
  save();
}

function metricCards(m: Metrics) {
  const s = state.strategy.settings;
  const cards: [string, string, number?][] = [
    ['Netto winst', `${fmtMoney(m.netProfit)} (${fmtPct(m.netProfitPct)})`, m.netProfit],
    ['Buy & hold', fmtPct(m.buyHoldPct), m.buyHoldPct],
    ['Aantal trades', String(m.totalTrades)],
    ['Win rate', `${m.winRate.toFixed(1)}% (${m.winners}/${m.totalTrades})`],
    ['Profit factor', Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', m.profitFactor - 1],
    ['Max drawdown', `${fmtMoney(-m.maxDrawdown)} (${(-m.maxDrawdownPct).toFixed(2)}%)`, -1],
    ['Gem. trade', `${fmtMoney(m.avgTrade)} (${fmtPct(m.avgTradePct)})`, m.avgTrade],
    ['Gem. winst / verlies', `${fmtMoney(m.avgWin)} / ${fmtMoney(m.avgLoss)}`],
    ['Ratio winst/verlies', m.ratioWinLoss.toFixed(2)],
    ['Grootste winst', fmtMoney(m.largestWin), m.largestWin],
    ['Grootste verlies', fmtMoney(m.largestLoss), m.largestLoss],
    ['Bruto winst / verlies', `${fmtMoney(m.grossProfit)} / ${fmtMoney(-m.grossLoss)}`],
    ['Sharpe ratio', m.sharpe.toFixed(2), m.sharpe],
    ['Sortino ratio', m.sortino.toFixed(2), m.sortino],
    ['CAGR', fmtPct(m.cagrPct), m.cagrPct],
    ['In de markt', `${m.exposurePct.toFixed(1)}%`],
    ['Gem. bars per trade', m.avgBars.toFixed(1)],
    ['Max verliezers op rij', String(m.maxConsecLosses)],
    ['Betaalde kosten', fmtMoney(m.totalFees)],
    ['Eindkapitaal', fmtMoney(s.initialCapital + m.netProfit)],
  ];
  return cards
    .map(([k, v, sign]) => `<div class="metric"><div class="k">${k}</div><div class="v ${sign !== undefined ? cls(sign) : ''}">${v}</div></div>`)
    .join('');
}

function renderResults(r: BacktestResult) {
  const m = r.metrics;
  $('#metrics').innerHTML = metricCards(m);
  $('#tester-summary').innerHTML =
    `${esc(currentStrategy().name)} · Netto <b class="${cls(m.netProfit)}">${fmtPct(m.netProfitPct)}</b> · ` +
    `${m.totalTrades} trades · win ${m.winRate.toFixed(0)}% · PF ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'} · ` +
    `DD <b class="down">${(-m.maxDrawdownPct).toFixed(1)}%</b> · B&H ${fmtPct(m.buyHoldPct)}`;
  equityChart.setData(candles, r.equity, r.drawdown, state.strategy.settings.initialCapital);
  renderTrades(r);
}

function renderTrades(r: BacktestResult) {
  const rows = r.trades.slice(-2000).reverse();
  const offset = r.trades.length;
  $('#trades').innerHTML =
    `<thead><tr><th>#</th><th>Type</th><th>Entry</th><th>Entry prijs</th><th>Exit</th><th>Exit prijs</th><th>Reden</th><th>Winst</th><th>Winst %</th><th>Run-up</th><th>Drawdown</th><th>Bars</th></tr></thead><tbody>` +
    rows
      .map(
        (t, k) =>
          `<tr class="click" data-time="${t.entryTime}"><td>${offset - k}</td><td class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? 'Long' : 'Short'}</td>` +
          `<td>${fmtTime(t.entryTime)}</td><td>${fmtPrice(t.entryPrice)}</td><td>${fmtTime(t.exitTime)}</td><td>${fmtPrice(t.exitPrice)}</td><td>${t.exitReason}</td>` +
          `<td class="${cls(t.pnl)}">${fmtMoney(t.pnl)}</td><td class="${cls(t.pnl)}">${fmtPct(t.pnlPct)}</td><td>${t.runUpPct.toFixed(2)}%</td><td>${t.drawdownPct.toFixed(2)}%</td><td>${t.bars}</td></tr>`,
      )
      .join('') +
    '</tbody>';
  if (!r.trades.length) $('#trades').innerHTML += '<tbody><tr><td colspan="12" class="empty">Geen trades in deze periode</td></tr></tbody>';
}

function exportTrades() {
  if (!lastResult?.trades.length) return toast('Nog geen trades om te exporteren', true);
  const head = 'nr,side,entry_time,entry_price,exit_time,exit_price,qty,pnl,pnl_pct,fees,bars,reason';
  const lines = lastResult.trades.map((t, i) =>
    [i + 1, t.side, new Date(t.entryTime * 1000).toISOString(), t.entryPrice, new Date(t.exitTime * 1000).toISOString(), t.exitPrice, t.qty, t.pnl.toFixed(2), t.pnlPct.toFixed(3), t.fees.toFixed(2), t.bars, t.exitReason].join(','),
  );
  const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.symbol}_${currentTf.label}_${state.strategy.id}_trades.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- optimizer ----

function renderOptimizerRanges() {
  const def = currentStrategy();
  const numeric = def.params.filter((p) => p.type === 'number');
  const el = $('#opt-ranges');
  if (!numeric.length) {
    el.innerHTML = '<p class="muted" style="grid-column:1/-1">Deze strategie heeft geen getal-parameters om te optimaliseren.</p>';
    return;
  }
  const cur = strategyParams();
  el.innerHTML =
    '<span></span><small class="muted">van</small><small class="muted">tot</small><small class="muted">stap</small>' +
    numeric
      .map((p, i) => {
        const v = Number(cur[p.key]);
        const step = p.type === 'number' ? (p.step ?? 1) : 1;
        const from = Math.max(p.type === 'number' ? (p.min ?? step) : step, +(v / 2).toFixed(4));
        const to = +(v * 2).toFixed(4);
        const st = step < 1 ? step * Math.max(1, Math.round(v / step / 8)) : Math.max(1, Math.round(v / 8));
        return (
          `<label class="check"><input type="checkbox" data-opt="${p.key}" ${i < 2 ? 'checked' : ''}/> ${esc(p.label)}</label>` +
          `<input type="number" data-from="${p.key}" value="${from}" step="${step}"/>` +
          `<input type="number" data-to="${p.key}" value="${to}" step="${step}"/>` +
          `<input type="number" data-step="${p.key}" value="${+st.toFixed(4)}" step="${step}"/>`
        );
      })
      .join('');
}

function runOptimizer() {
  const def = currentStrategy();
  if (def.id === 'custom') return toast('De optimizer werkt met de ingebouwde strategieën', true);
  if (!candles.length) return;
  const keys = $$<HTMLInputElement>('[data-opt]')
    .filter((c) => c.checked)
    .map((c) => c.dataset.opt!);
  if (!keys.length) return toast('Vink minstens één parameter aan', true);
  if (keys.length > 2) return toast('Kies maximaal 2 parameters', true);
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
    const rows = optimize(candles, (values) => def.signals(candles, { ...base, ...values }), ranges, state.strategy.settings);
    const sortKey = $<HTMLSelectElement>('#opt-sort').value as keyof Metrics;
    rows.sort((a, b) => (sortKey === 'maxDrawdownPct' ? a.metrics[sortKey] - b.metrics[sortKey] : (b.metrics[sortKey] as number) - (a.metrics[sortKey] as number)));
    const labels = keys.map((k) => def.params.find((p) => p.key === k)!.label);
    table.innerHTML =
      `<thead><tr>${labels.map((l) => `<th>${esc(l)}</th>`).join('')}<th>Netto %</th><th>Trades</th><th>Win %</th><th>PF</th><th>Max DD %</th><th>Sharpe</th></tr></thead><tbody>` +
      rows
        .slice(0, 100)
        .map(
          (r) =>
            `<tr class="click" data-values='${JSON.stringify(r.values)}'>${keys.map((k) => `<td>${r.values[k]}</td>`).join('')}` +
            `<td class="${cls(r.metrics.netProfitPct)}">${fmtPct(r.metrics.netProfitPct)}</td><td>${r.metrics.totalTrades}</td><td>${r.metrics.winRate.toFixed(1)}</td>` +
            `<td>${Number.isFinite(r.metrics.profitFactor) ? r.metrics.profitFactor.toFixed(2) : '∞'}</td><td class="down">${(-r.metrics.maxDrawdownPct).toFixed(2)}</td><td>${r.metrics.sharpe.toFixed(2)}</td></tr>`,
        )
        .join('') +
      '</tbody>';
    toast(`${rows.length} backtests in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }, 30);
}

function setupStrategyUi() {
  $('#strategy').innerHTML = STRATEGIES.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#rule-help').textContent = RULE_HELP;

  const s = state.strategy;
  const ruleInputs: [string, keyof CustomRules][] = [
    ['#rule-el', 'entryLong'],
    ['#rule-xl', 'exitLong'],
    ['#rule-es', 'entryShort'],
    ['#rule-xs', 'exitShort'],
  ];
  const settingInputs: [string, keyof BacktestSettings][] = [
    ['#s-capital', 'initialCapital'],
    ['#s-size', 'positionPct'],
    ['#s-comm', 'commissionPct'],
    ['#s-slip', 'slippagePct'],
    ['#s-dir', 'direction'],
    ['#s-fill', 'fillOn'],
    ['#s-sl', 'stopLossPct'],
    ['#s-tp', 'takeProfitPct'],
    ['#s-trail', 'trailingPct'],
  ];
  for (const [sel, key] of ruleInputs) $<HTMLInputElement>(sel).value = s.rules[key];
  for (const [sel, key] of settingInputs) $<HTMLInputElement>(sel).value = String(s.settings[key]);
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
  for (const [sel, key] of settingInputs) {
    $(sel).addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const settings = s.settings as unknown as Record<string, number | string>;
      if (el.type === 'number') {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        settings[key] = v;
      } else settings[key] = el.value;
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
    s.params[def.id] = { ...strategyParams(), ...JSON.parse(v) };
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

function applyLayout() {
  $('#tester').classList.toggle('collapsed', state.testerCollapsed);
  $('#btn-tester-toggle').textContent = state.testerCollapsed ? '▴' : '▾';
  $('#sidebar').classList.toggle('hidden', !state.sidebar);
}

// ============================================================================
// Top bar
// ============================================================================

function setupTopbar() {
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

  $('#btn-theme').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    chart.setTrades(lastResult?.trades ?? []);
    save();
  });
  $('#btn-sidebar').addEventListener('click', () => {
    state.sidebar = !state.sidebar;
    applyLayout();
    save();
  });

  $('#watchlist').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const remove = target.closest<HTMLElement>('[data-remove]')?.dataset.remove;
    if (remove) {
      state.watchlist = state.watchlist.filter((s) => s !== remove);
      renderWatchlist();
      save();
      return;
    }
    const sym = target.closest<HTMLElement>('[data-sym]')?.dataset.sym;
    if (sym) setSymbol(sym);
  });
  $('#btn-watch-add').addEventListener('click', () => {
    if (csvData) return toast('CSV-data kan niet in de watchlist', true);
    if (!state.watchlist.includes(state.symbol)) state.watchlist.push(state.symbol);
    renderWatchlist();
    void pollTickers();
    save();
  });

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
      const tf = Object.entries({ M: 2592000, W: 604800, D: 86400, h: 3600, m: 60, s: 1 }).find(([, sec]) => seconds % sec === 0 && seconds >= sec)!;
      currentTf = parseTimeframe(`${seconds / tf[1]}${tf[0]}`) ?? currentTf;
      unsubscribe?.();
      $<HTMLInputElement>('#symbol').value = '';
      $<HTMLInputElement>('#symbol').placeholder = csvData.name;
      toast(`${parsed.length.toLocaleString()} bars geladen uit ${file.name}`);
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
  // On small screens the sidebar covers the chart, so start with it closed.
  if (window.innerWidth <= 1000) state.sidebar = false;
  buildTimeframes();
  setupTopbar();
  setupIndicatorUi();
  setupTools();
  setupStrategyUi();
  applyLayout();
  applyTheme();
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
  if (!state.strategy.enabled) strategyOff();

  void loadSymbolList();
  void loadData();
  void pollTickers();
  setInterval(() => void pollTickers(), 15000);
}

boot();
