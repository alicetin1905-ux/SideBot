# SideChart · Futures Terminal

A futuristic chart-and-backtest terminal for **crypto perpetual futures** (USDT-margined),
running entirely in the browser. It uses live data from **OKX** and **Bitget**: no account, API key or server needed.

> SideChart is a self-built app and has nothing to do with TradingView. The chart itself is drawn
> with the open-source library [Lightweight Charts™](https://github.com/tradingview/lightweight-charts) (Apache 2.0).

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd sidechart
npm install
npm run dev        # open http://localhost:5173
```

```bash
npm run build      # static files in sidechart/dist/ (GitHub Pages, Netlify, Vercel, …)
npm test           # 91 unit tests (indicators, strategies, futures backtester, calculator)
```

## Features

**Futures data (live)**
- All USDT perpetuals on OKX (500+) and Bitget (800+); switch exchange at the top left.
- HUD bar: last price (flashes green/red), mark price, index price, **funding rate with countdown**,
  open interest, 24h change, high/low and volume.
- **Markets screener:** all contracts, sortable by volume, gainers, losers and funding, with favorites.
- **Liquidation feed** (OKX, live): every liquidation, with a long/short total for the last hour
  and large liquidations highlighted.

**Futures indicators**

| Indicator | Source | Note |
|---|---|---|
| Funding Rate (per period or annualized) | exchange | ~3 months of real history, usable in backtests |
| Open Interest + OI Delta | recorded live | builds up while the app is open (stored in your browser) |
| Long/Short Ratio (accounts) | Bitget | latest ~30 periods, grows over time |
| Taker Buy/Sell Delta + CVD | Bitget | latest ~30 periods, grows over time |

Exchanges don't offer deep open-interest and long/short history to browsers. That's why
those indicators are for live analysis and are not used in backtests.

There are also 44 technical indicators: RSI, MACD, Bollinger, Ichimoku, SuperTrend, VWAP, ADX, ATR, OBV and more.

**Timeframes:** 1m up to 1M, plus **any custom timeframe** (`10m`, `45m`, `3h`, `8h`, `2D`, `2W`, …),
which is built from smaller candles, live as well.

**Position calculator:** enter balance, risk %, leverage, entry, stop loss and take profit (or click the
chart with ⌖). You get position size, required margin, **liquidation price**, risk/reward and warnings, for
example when your liquidation price lies before your stop. Entry, SL, TP and LIQ are drawn as lines on the chart.

**Futures backtester**
- Starting balance, margin % per trade, **leverage**, taker fee, slippage, maintenance margin.
- **Liquidations** are simulated (isolated margin: you lose the margin of that position).
- **Funding costs** from the real funding history (with a fixed rate where history is missing).
- Long, short or both; stop loss, take profit, trailing stop.
- Results: net profit, ROE per trade, number of liquidations, funding and fees paid, drawdown, Sharpe,
  equity curve and trade list (CSV export).
- **Optimizer:** grid search over strategy parameters **and leverage**.

**Strategies:** ⚡ Funding Contrarian (adaptive z-score on the real funding) · SuperTrend · MA Crossover ·
Golden Cross · RSI · MACD · Bollinger (mean reversion and breakout) · Donchian/Turtle · Stochastic ·
Parabolic SAR · Ichimoku · ADX/DI · Trend + RSI pullback · **Custom rules (no-code)**, for example:

```
Short entry:  FUNDING > 0.03 AND close < EMA(50)
Short exit:   FUNDING < 0.01
```

**Other:** drawing tools (line, trendline, Fibonacci), price alarms with browser notifications, CSV import,
works on mobile.

## Important

- Leverage magnifies both profit and loss. In the test (SuperTrend on BTC, 1h), the result at 50× was
  **−75% with 20 liquidations**, against −10% at 10×.
- A good backtest is **no guarantee** of future results, and the optimizer can cause overfitting.
- The backtester holds one position at a time and uses the mark of the last bar as its price. In reality,
  exchanges liquidate on the mark price, and fees and maintenance margin depend on your tier.
- In some countries (including parts of the EU), exchanges don't allow retail customers to trade derivatives.
  Market data still works.
- This is an analysis tool, not financial advice. It places no orders.

## Project structure

```
sidechart/src/
  main.ts            app logic and user interface
  chart.ts           chart, panes, drawings, position lines
  exchanges/         OKX and Bitget (contracts, candles, live stream, funding, liquidations)
  sentiment.ts       open-interest recorder + Bitget long/short & taker data
  futures.ts         position calculator
  backtest.ts        futures backtester (leverage, liquidation, funding) + optimizer
  ta.ts              indicator math
  indicators.ts      indicator list (including futures data)
  strategies.ts      strategies and the language for custom rules
  data.ts            timeframes, resampling, CSV
```
