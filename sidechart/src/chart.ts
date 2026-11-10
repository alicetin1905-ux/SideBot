import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, Params } from './types';
import { INDICATOR_MAP, resolveOffset, type ExtData, type IndicatorDef } from './indicators';
import { heikinAshi } from './ta';
import type { Trade } from './backtest';

export type ChartType = 'candles' | 'hollow' | 'bars' | 'line' | 'area' | 'baseline' | 'heikin';

export interface Theme {
  bg: string;
  text: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  accent: string;
}

/** Neon "terminal" theme. The chart is transparent so the page's grid backdrop shows through. */
export const NEON: Theme = {
  bg: 'rgba(0,0,0,0)',
  text: '#8fa3c0',
  grid: 'rgba(0,229,255,0.055)',
  border: 'rgba(0,229,255,0.18)',
  up: '#00ffa3',
  down: '#ff3b6b',
  accent: '#00e5ff',
};

export interface PositionLines {
  entry: number;
  stop: number;
  target: number;
  liq: number;
}

export interface ActiveIndicator {
  uid: number;
  def: IndicatorDef;
  params: Params;
  series: ISeriesApi<SeriesType>[];
  levels: IPriceLine[];
  /** Latest computed values, for the legend */
  values: Record<string, number[]>;
  hidden: boolean;
  /** Added automatically by the active strategy */
  fromStrategy: boolean;
}

export type DrawTool = 'none' | 'hline' | 'trend' | 'fib' | 'alert' | 'pick';

export interface Drawing {
  kind: 'hline' | 'trend' | 'fib';
  points: { time: number; price: number }[];
}

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ['#8fa3c0', '#ff3b6b', '#ffb800', '#00ffa3', '#1de9b6', '#00e5ff', '#8fa3c0'];

const ts = (t: number) => t as UTCTimestamp;

function localTickFormatter(time: Time, type: number): string {
  const d = new Date((time as number) * 1000);
  switch (type) {
    case 0:
      return String(d.getFullYear());
    case 1:
      return d.toLocaleDateString(undefined, { month: 'short' });
    case 2:
      return String(d.getDate());
    case 4:
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    default:
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
}

export class ChartView {
  readonly chart: IChartApi;
  private main!: ISeriesApi<SeriesType>;
  private markers: ISeriesMarkersPluginApi<Time> | null = null;
  private candles: Candle[] = [];
  private chartType: ChartType = 'candles';
  private theme: Theme = NEON;
  private ext: ExtData = {};
  private positionLines: PositionLines | null = null;
  private nextUid = 1;
  private barSeconds = 60;
  indicators: ActiveIndicator[] = [];

  // Drawings
  tool: DrawTool = 'none';
  private drawings: Drawing[] = [];
  private drawingObjects: { lines: IPriceLine[]; series: ISeriesApi<SeriesType>[] }[] = [];
  private pendingPoint: { time: number; price: number } | null = null;
  private alertPrices: number[] = [];
  onDrawingsChange?: (d: Drawing[]) => void;
  onToolDone?: () => void;
  onAlertPick?: (price: number) => void;
  /** Price picked with the 'pick' tool (used by the position calculator) */
  onPick?: (price: number) => void;
  onCrosshair?: (text: string) => void;

  constructor(container: HTMLElement) {
    this.chart = createChart(container, {
      autoSize: true,
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(0,229,255,0.45)', labelBackgroundColor: '#0a3a4a' },
        horzLine: { color: 'rgba(0,229,255,0.45)', labelBackgroundColor: '#0a3a4a' },
      },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 8, tickMarkFormatter: localTickFormatter },
      localization: { timeFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleString() },
      layout: {
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
        panes: { separatorColor: 'rgba(0,229,255,0.18)', separatorHoverColor: 'rgba(0,229,255,0.35)', enableResize: true },
      },
    });
    // Keep the price pane alive while the main series is swapped (chart type / theme change).
    this.chart.panes()[0].setPreserveEmptyPane(true);
    this.createMainSeries();
    // Use native DOM clicks for drawing tools: the chart's own click event swallows a
    // second click that follows within 500 ms, which breaks quick 2-point placement.
    container.addEventListener('click', (e) => {
      const r = container.getBoundingClientRect();
      this.handleClick(e.clientX - r.left, e.clientY - r.top);
    });
    this.chart.subscribeCrosshairMove((p) => this.handleCrosshair(p));
  }

  // ---------------------------------------------------------------- theme
  setTheme(t: Theme) {
    this.theme = t;
    this.chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: t.bg },
        textColor: t.text,
        panes: { separatorColor: t.border },
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
    this.createMainSeries();
    this.renderMain();
  }

  // ---------------------------------------------------------------- main series
  private createMainSeries() {
    const keepMarkers = this.markers ? [...this.markers.markers()] : [];
    if (this.main) {
      this.markers?.detach();
      this.chart.removeSeries(this.main);
    }
    const t = this.theme;
    const fmt = { priceFormat: { type: 'price' as const, precision: 2, minMove: 0.01 } };
    switch (this.chartType) {
      case 'bars':
        this.main = this.chart.addSeries(BarSeries, { upColor: t.up, downColor: t.down, ...fmt }, 0);
        break;
      case 'line':
        this.main = this.chart.addSeries(LineSeries, { color: t.accent, lineWidth: 2, ...fmt }, 0);
        break;
      case 'area':
        this.main = this.chart.addSeries(
          AreaSeries,
          { lineColor: t.accent, topColor: 'rgba(0,229,255,0.35)', bottomColor: 'rgba(0,229,255,0)', ...fmt },
          0,
        );
        break;
      case 'baseline':
        this.main = this.chart.addSeries(
          BaselineSeries,
          { topLineColor: t.up, bottomLineColor: t.down, topFillColor1: 'rgba(0,255,163,0.25)', topFillColor2: 'rgba(0,255,163,0)', bottomFillColor1: 'rgba(255,59,107,0)', bottomFillColor2: 'rgba(255,59,107,0.25)', ...fmt },
          0,
        );
        break;
      case 'hollow':
        this.main = this.chart.addSeries(
          CandlestickSeries,
          { upColor: 'rgba(0,0,0,0)', downColor: t.down, borderUpColor: t.up, borderDownColor: t.down, wickUpColor: t.up, wickDownColor: t.down, ...fmt },
          0,
        );
        break;
      default:
        this.main = this.chart.addSeries(
          CandlestickSeries,
          { upColor: t.up, downColor: t.down, borderVisible: false, wickUpColor: 'rgba(0,255,163,0.7)', wickDownColor: 'rgba(255,59,107,0.7)', ...fmt },
          0,
        );
    }
    this.markers = createSeriesMarkers(this.main, keepMarkers);
    // Price lines of drawings belong to the main series; recreate them.
    this.redrawDrawings();
  }

  setChartType(type: ChartType) {
    this.chartType = type;
    this.createMainSeries();
    this.renderMain();
  }

  private displayCandles(): Candle[] {
    return this.chartType === 'heikin' ? heikinAshi(this.candles) : this.candles;
  }

  private toSeriesData(c: Candle) {
    if (this.chartType === 'line' || this.chartType === 'area' || this.chartType === 'baseline') {
      return { time: ts(c.time), value: c.close };
    }
    return { time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
  }

  private renderMain() {
    const data = this.displayCandles().map((c) => this.toSeriesData(c));
    this.main.setData(data);
    if (this.chartType === 'baseline' && this.candles.length) {
      const first = this.candles[Math.max(0, this.candles.length - 200)].close;
      this.main.applyOptions({ baseValue: { type: 'price', price: first } });
    }
  }

  /** Pick a price precision from the price level (e.g. 0.00001234 needs 8 decimals). */
  private applyPrecision() {
    const last = this.candles[this.candles.length - 1]?.close ?? 1;
    const precision = last >= 1000 ? 2 : last >= 1 ? Math.max(2, 4 - Math.floor(Math.log10(last))) : Math.min(10, 2 - Math.floor(Math.log10(last)) + 2);
    this.main.applyOptions({ priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision } });
  }

  /**
   * Turn auto-scaling back on for every pane. Dragging or zooming a price axis switches it off,
   * which would otherwise keep the previous coin's price range after switching symbols.
   */
  resetScales() {
    for (const pane of this.chart.panes()) pane.priceScale('right').applyOptions({ autoScale: true });
  }

  setCandles(candles: Candle[], barSeconds: number) {
    this.candles = candles;
    this.barSeconds = barSeconds;
    this.applyPrecision();
    this.renderMain();
    this.refreshIndicators();
    this.resetScales();
    this.chart.timeScale().applyOptions({ secondsVisible: barSeconds < 60 });
    this.chart.timeScale().scrollToRealTime();
  }

  /** Live update of the last bar (or a new bar). */
  updateLast(candles: Candle[]) {
    this.candles = candles;
    const display = this.displayCandles();
    const last = display[display.length - 1];
    if (last) this.main.update(this.toSeriesData(last));
  }

  fitContent() {
    const n = this.candles.length;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 8 });
    this.resetScales();
  }

  // ---------------------------------------------------------------- indicators
  addIndicator(id: string, params: Params, fromStrategy = false): ActiveIndicator | null {
    const def = INDICATOR_MAP.get(id);
    if (!def) return null;
    const ind: ActiveIndicator = { uid: this.nextUid++, def, params: { ...params }, series: [], levels: [], values: {}, hidden: false, fromStrategy };
    this.indicators.push(ind);
    this.createIndicatorSeries(ind);
    this.renderIndicator(ind);
    return ind;
  }

  private createIndicatorSeries(ind: ActiveIndicator) {
    const pane = ind.def.overlay ? 0 : this.chart.panes().length;
    for (const o of ind.def.outputs) {
      const common = { priceLineVisible: false, lastValueVisible: true, title: '' };
      const s =
        o.type === 'histogram'
          ? this.chart.addSeries(HistogramSeries, { ...common, color: o.color }, pane)
          : this.chart.addSeries(
              LineSeries,
              {
                ...common,
                color: o.color,
                lineWidth: (o.lineWidth ?? 1) as 1 | 2 | 3 | 4,
                lineStyle: o.dashed ? LineStyle.Dashed : LineStyle.Solid,
                crosshairMarkerVisible: false,
              },
              pane,
            );
      ind.series.push(s);
    }
    if (!ind.def.overlay) {
      const p = this.chart.panes()[pane];
      p?.setStretchFactor(0.35);
    }
    for (const lvl of ind.def.levels ?? []) {
      ind.levels.push(
        ind.series[ind.series.length - 1].createPriceLine({
          price: lvl,
          color: 'rgba(143,163,192,0.45)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
        }),
      );
    }
  }

  private renderIndicator(ind: ActiveIndicator) {
    const c = this.candles;
    const n = c.length;
    if (!n) return;
    let values: Record<string, number[]>;
    try {
      values = ind.def.compute(c, ind.params, this.ext);
    } catch (e) {
      console.error(e);
      return;
    }
    ind.values = values;
    const timeAt = (j: number) => (j < n ? c[j].time : c[n - 1].time + (j - n + 1) * this.barSeconds);
    ind.def.outputs.forEach((o, k) => {
      const arr = values[o.key] ?? [];
      const off = resolveOffset(o, ind.params);
      const data: ({ time: UTCTimestamp; value: number; color?: string } | { time: UTCTimestamp })[] = [];
      for (let i = 0; i < arr.length; i++) {
        const j = i + off;
        if (j < 0) continue;
        const v = arr[i];
        const time = ts(timeAt(j));
        if (!Number.isFinite(v)) {
          data.push({ time });
          continue;
        }
        if (o.colorBy === 'candle') {
          data.push({ time, value: v, color: c[i].close >= c[i].open ? 'rgba(0,255,163,0.45)' : 'rgba(255,59,107,0.45)' });
        } else if (o.colorBy === 'sign') {
          const prev = arr[i - 1];
          const rising = Number.isFinite(prev) ? v >= prev : true;
          data.push({ time, value: v, color: v >= 0 ? (rising ? '#00ffa3' : 'rgba(0,255,163,0.45)') : rising ? 'rgba(255,59,107,0.45)' : '#ff3b6b' });
        } else {
          data.push({ time, value: v });
        }
      }
      ind.series[k].setData(data);
      ind.series[k].applyOptions({ visible: !ind.hidden });
    });
  }

  /** Futures data (funding, OI, …) used by indicators that need it. */
  setExt(ext: ExtData) {
    this.ext = ext;
    this.refreshIndicators();
  }

  refreshIndicators() {
    for (const ind of this.indicators) this.renderIndicator(ind);
  }

  updateIndicator(uid: number, params: Params) {
    const ind = this.indicators.find((i) => i.uid === uid);
    if (!ind) return;
    ind.params = { ...params };
    this.renderIndicator(ind);
  }

  toggleIndicator(uid: number) {
    const ind = this.indicators.find((i) => i.uid === uid);
    if (!ind) return;
    ind.hidden = !ind.hidden;
    for (const s of ind.series) s.applyOptions({ visible: !ind.hidden });
  }

  removeIndicator(uid: number) {
    const ind = this.indicators.find((i) => i.uid === uid);
    if (!ind) return;
    for (const s of ind.series) this.chart.removeSeries(s);
    this.indicators = this.indicators.filter((i) => i !== ind);
  }

  removeStrategyIndicators() {
    for (const ind of this.indicators.filter((i) => i.fromStrategy)) this.removeIndicator(ind.uid);
  }

  // ---------------------------------------------------------------- strategy markers
  setTrades(trades: Trade[]) {
    const m: SeriesMarker<Time>[] = [];
    for (const t of trades) {
      const long = t.side === 'long';
      m.push({
        time: ts(t.entryTime),
        position: long ? 'belowBar' : 'aboveBar',
        color: long ? '#00e5ff' : '#ff2bd6',
        shape: long ? 'arrowUp' : 'arrowDown',
        text: long ? 'Long' : 'Short',
      });
      m.push({
        time: ts(t.exitTime),
        position: long ? 'aboveBar' : 'belowBar',
        color: t.liquidated ? '#ffb800' : t.pnl >= 0 ? '#00ffa3' : '#ff3b6b',
        shape: t.liquidated ? 'square' : 'circle',
        text: t.liquidated ? 'LIQ' : `${t.pnl >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`,
      });
    }
    m.sort((a, b) => (a.time as number) - (b.time as number));
    this.markers?.setMarkers(m);
  }

  clearTrades() {
    this.markers?.setMarkers([]);
  }

  scrollToTime(time: number) {
    const idx = this.candles.findIndex((c) => c.time >= time);
    if (idx < 0) return;
    this.chart.timeScale().setVisibleLogicalRange({ from: idx - 60, to: idx + 60 });
  }

  // ---------------------------------------------------------------- drawings
  setDrawings(d: Drawing[]) {
    this.drawings = d.map((x) => ({ ...x, points: [...x.points] }));
    this.redrawDrawings();
  }

  setPositionLines(p: PositionLines | null) {
    this.positionLines = p;
    this.redrawDrawings();
  }

  setAlertLines(prices: number[]) {
    this.alertPrices = prices;
    this.redrawDrawings();
  }

  clearDrawings() {
    this.drawings = [];
    this.redrawDrawings();
    this.onDrawingsChange?.(this.drawings);
  }

  private redrawDrawings() {
    for (const o of this.drawingObjects) {
      for (const l of o.lines) {
        try {
          this.main.removePriceLine(l);
        } catch {
          /* series was recreated */
        }
      }
      for (const s of o.series) this.chart.removeSeries(s);
    }
    this.drawingObjects = [];
    if (!this.main) return;
    const alerts = { lines: [] as IPriceLine[], series: [] as ISeriesApi<SeriesType>[] };
    for (const price of this.alertPrices) {
      alerts.lines.push(this.main.createPriceLine({ price, color: '#ffb800', lineWidth: 1, lineStyle: LineStyle.LargeDashed, axisLabelVisible: true, title: 'ALERT' }));
    }
    if (this.positionLines) {
      const p = this.positionLines;
      const line = (price: number, color: string, title: string, style = LineStyle.Solid) =>
        price > 0 && alerts.lines.push(this.main.createPriceLine({ price, color, lineWidth: 2, lineStyle: style, axisLabelVisible: true, title }));
      line(p.entry, '#00e5ff', 'ENTRY');
      line(p.stop, '#ff3b6b', 'SL');
      line(p.target, '#00ffa3', 'TP');
      line(p.liq, '#ffb800', 'LIQ', LineStyle.Dashed);
    }
    this.drawingObjects.push(alerts);
    for (const d of this.drawings) {
      const obj = { lines: [] as IPriceLine[], series: [] as ISeriesApi<SeriesType>[] };
      if (d.kind === 'hline') {
        obj.lines.push(this.main.createPriceLine({ price: d.points[0].price, color: '#00e5ff', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true }));
      } else if (d.kind === 'trend') {
        const [a, b] = [...d.points].sort((x, y) => x.time - y.time);
        if (a.time !== b.time) {
          const s = this.chart.addSeries(
            LineSeries,
            { color: '#ff2bd6', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: true },
            0,
          );
          s.setData([
            { time: ts(a.time), value: a.price },
            { time: ts(b.time), value: b.price },
          ]);
          obj.series.push(s);
        }
      } else if (d.kind === 'fib') {
        const [a, b] = d.points;
        FIB_LEVELS.forEach((lvl, k) => {
          obj.lines.push(
            this.main.createPriceLine({
              price: b.price + (a.price - b.price) * lvl,
              color: FIB_COLORS[k],
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: `Fib ${lvl}`,
            }),
          );
        });
      }
      this.drawingObjects.push(obj);
    }
  }

  private handleClick(x: number, y: number) {
    if (this.tool === 'none') return;
    // Only the price pane (pane 0, at the top) accepts drawings.
    const pane = this.chart.panes()[0];
    if (y < 0 || y > pane.getHeight() || x > this.chart.timeScale().width()) return;
    const price = this.main.coordinateToPrice(y);
    const logical = this.chart.timeScale().coordinateToLogical(x);
    const n = this.candles.length;
    if (price === null || logical === null || !n) return;
    const idx = Math.round(logical);
    const time = idx < n ? this.candles[Math.max(0, idx)].time : this.candles[n - 1].time + (idx - n + 1) * this.barSeconds;
    const pt = { time, price };
    if (this.tool === 'alert' || this.tool === 'pick') {
      if (this.tool === 'alert') this.onAlertPick?.(price);
      else this.onPick?.(price);
      this.finishTool();
      return;
    }
    if (this.tool === 'hline') {
      this.drawings.push({ kind: 'hline', points: [pt] });
      this.finishTool();
      return;
    }
    if (!this.pendingPoint) {
      this.pendingPoint = pt;
      return;
    }
    this.drawings.push({ kind: this.tool, points: [this.pendingPoint, pt] });
    this.finishTool();
  }

  private finishTool() {
    this.pendingPoint = null;
    this.tool = 'none';
    this.redrawDrawings();
    this.onDrawingsChange?.(this.drawings);
    this.onToolDone?.();
  }

  // ---------------------------------------------------------------- legend
  private handleCrosshair(p: MouseEventParams<Time>) {
    if (!this.onCrosshair) return;
    const n = this.candles.length;
    if (!n) return;
    let idx = n - 1;
    if (p.time !== undefined) {
      const t = p.time as number;
      // Binary search for the bar with this time.
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.candles[mid].time < t) lo = mid + 1;
        else hi = mid;
      }
      if (this.candles[lo].time === t) idx = lo;
    }
    this.onCrosshair(this.legendText(idx));
  }

  legendText(idx = this.candles.length - 1): string {
    const c = this.candles[idx];
    if (!c) return '';
    const prev = this.candles[idx - 1];
    const chg = prev ? ((c.close - prev.close) / prev.close) * 100 : 0;
    const f = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(5));
    const cls = c.close >= c.open ? 'up' : 'down';
    let html = `<span class="${cls}">O <b>${f(c.open)}</b> H <b>${f(c.high)}</b> L <b>${f(c.low)}</b> C <b>${f(c.close)}</b> <b>${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b></span>`;
    for (const ind of this.indicators) {
      if (ind.hidden) continue;
      const vals = ind.def.outputs
        .map((o) => {
          const off = resolveOffset(o, ind.params);
          const v = ind.values[o.key]?.[idx - off];
          return Number.isFinite(v) ? `<span style="color:${o.color}">${f(v as number)}</span>` : '';
        })
        .filter(Boolean)
        .join(' ');
      const p = Object.values(ind.params).join(', ');
      html += `<div class="legend-ind">${ind.def.id.toUpperCase()}${p ? ` (${p})` : ''} ${vals}</div>`;
    }
    return html;
  }
}

/** Small separate chart for the equity curve in the strategy tester. */
export class EquityChart {
  private chart: IChartApi;
  private equity: ISeriesApi<'Baseline'>;
  private dd: ISeriesApi<'Histogram'>;

  constructor(container: HTMLElement) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: { fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10 },
      timeScale: { timeVisible: true },
      rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.25 } },
      localization: { timeFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleString() },
    });
    this.equity = this.chart.addSeries(BaselineSeries, {
      lineWidth: 2,
      priceLineVisible: false,
      topLineColor: '#00ffa3',
      bottomLineColor: '#ff3b6b',
      topFillColor1: 'rgba(0,255,163,0.28)',
      topFillColor2: 'rgba(0,255,163,0.02)',
      bottomFillColor1: 'rgba(255,59,107,0.02)',
      bottomFillColor2: 'rgba(255,59,107,0.28)',
    });
    this.dd = this.chart.addSeries(HistogramSeries, { color: 'rgba(255,59,107,0.35)', priceScaleId: 'dd', priceLineVisible: false, lastValueVisible: false });
    this.chart.priceScale('dd').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }

  setTheme(t: Theme) {
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
  }

  setData(candles: Candle[], equity: number[], drawdown: number[], initial: number) {
    this.equity.applyOptions({ baseValue: { type: 'price', price: initial } });
    this.equity.setData(candles.map((c, i) => ({ time: ts(c.time), value: equity[i] })));
    this.dd.setData(candles.map((c, i) => ({ time: ts(c.time), value: drawdown[i] })));
    this.chart.timeScale().fitContent();
  }
}
