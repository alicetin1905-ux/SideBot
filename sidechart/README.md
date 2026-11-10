# SideChart · Futures Terminal

A futuristic chart-and-backtest terminal for **crypto perpetual futures** (USDT-margined),
running entirely in the browser. It uses live data from **Binance**, **Bybit**, **OKX** and **Bitget**: no account, API key or server needed.

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
npm test           # 119 unit tests (indicators, strategies, futures backtester, calculator, exchange adapters)
```

## Features

**Futures data (live)**
- All USDT perpetuals on Binance (USDⓈ-M), Bybit (linear), OKX and Bitget; switch exchange at the top left.
- HUD bar: last price (flashes green/red), mark price, index price, **funding rate with countdown**,
  open interest, 24h change, high/low and volume.
- **Markets screener:** all contracts, sortable by volume, gainers, losers and funding, with favorites.
- **Live liquidation feed** (Binance: all contracts, OKX: all contracts, Bybit: the 100 largest contracts),
  with a long/short total for the last hour and large liquidations highlighted. Bitget has no public feed.

**Futures indicators**

What each exchange provides:

| Data | Binance | Bybit | OKX | Bitget |
|---|---|---|---|---|
| Funding history (backtestable) | ✅ | ✅ | ✅ ~3 months | ✅ |
| Open interest history | ✅ ~30 days | ✅ (converted to USD) | recorded live | recorded live |
| Long/short ratio (accounts) | ✅ ~30 days | ✅ | via Bitget (recent) | ✅ recent |
| Taker buy/sell + **CVD** | ✅ **full history** (from the candles) | via Bitget (recent) | via Bitget (recent) | ✅ recent |
| Liquidations | ✅ | ✅ top 100 | ✅ | — |
| Max leverage per contract | — (requires a login) | ✅ | ✅ | ✅ |

"Recorded live" means the app records open interest itself while it's open (stored in your browser).

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

**Strategies (24 built-in + your own):**
- ⚡ Futures: Funding Contrarian (adaptive z-score on the real funding)
- Trend: SuperTrend · Chandelier Exit · Hull MA Trend · EMA Ribbon (8/21/55) · MA Crossover · Golden Cross ·
  Ichimoku · ADX/DI · Parabolic SAR · Heikin Ashi Trend
- Breakout: Squeeze (BB in Keltner) · Keltner Breakout · Bollinger Breakout · Donchian/Turtle · Opening Range Breakout
- Mean reversion: Z-score · Bollinger Mean Reversion · RSI · Stochastic
- Momentum: MACD · MACD + RSI Combo · Trend + RSI pullback · VWAP Trend (intraday)

**Custom strategies (no-code):** write rules, or load one of the ready-made examples, and save them under a
name. They appear under "★ My strategies", changes are saved automatically, and you can make a copy or
delete them. Example:

```
Short entry:  FUNDING > 0.03 AND close < EMA(50)
Short exit:   FUNDING < 0.01
Long entry:   close > HIGHEST(20) AND volume > VOLSMA(20)
```

**Other:** drawing tools (line, trendline, Fibonacci), price alarms with browser notifications, CSV import,
works on mobile.

## Important

- Leverage magnifies both profit and loss. In the test (SuperTrend on BTC, 1h), the result at 50× was
  **−75% with 20 liquidations**, against −10% at 10×.
- A good backtest is **no guarantee** of future results, and the optimizer can cause overfitting.
- The backtester holds one position at a time and uses the mark of the last bar as its price. In reality,
  exchanges liquidate on the mark price, and fees and maintenance margin depend on your tier.
- **Binance and Bybit block some regions** (including the US, and for Bybit also some EU countries). If so, the app
  shows a clear message ("blocks requests from your location") and you can use OKX or Bitget instead.
  I couldn't fetch Binance and Bybit live from the build server (blocked region): their integration is built
  from the official API documentation and tested with simulated responses in exactly that format.
- In some countries (including parts of the EU), exchanges don't allow retail customers to trade derivatives.
  Market data still works.
- This is an analysis tool, not financial advice. It places no orders.

## Project structure

```
sidechart/src/
  main.ts            app logic and user interface
  chart.ts           chart, panes, drawings, position lines
  exchanges/         Binance, Bybit, OKX and Bitget (contracts, candles, live stream, funding, OI, liquidations)
  sentiment.ts       open-interest recorder + Bitget long/short & taker data
  futures.ts         position calculator
  backtest.ts        futures backtester (leverage, liquidation, funding) + optimizer
  ta.ts              indicator math
  indicators.ts      indicator list (including futures data)
  strategies.ts      strategies and the language for custom rules
  data.ts            timeframes, resampling, CSV
```
