# SideChart

Een eigen chart- en backtest-app in de browser: live grafieken, 44 indicatoren,
elke timeframe, tekentools, prijsalarmen en een ingebouwde **strategy tester met optimizer**.

> SideChart is een zelfgebouwde app en heeft niets te maken met TradingView.
> Voor het tekenen van de grafiek gebruikt hij de open-source bibliotheek
> [Lightweight Charts™](https://github.com/tradingview/lightweight-charts) (Apache 2.0).

## Starten

Je hebt [Node.js](https://nodejs.org) 20 of nieuwer nodig.

```bash
cd sidechart
npm install
npm run dev        # open http://localhost:5173
```

Een versie bouwen om online te zetten (bijvoorbeeld GitHub Pages, Netlify of Vercel):

```bash
npm run build      # resultaat in sidechart/dist/ — gewoon statische bestanden
npm test           # 76 unit tests voor indicatoren, strategieën en backtester
```

## Wat zit erin

**Markten en data**
- Alle spot-paren van Binance (BTCUSDT, ETHUSDT, …), live via WebSocket, zonder API-key.
- **Eigen data via CSV** (aandelen, forex, wat je maar wilt): kolommen `date/time, open, high, low, close, volume`.
- Tot 50.000 bars historie, voor lange backtests.

**Timeframes**
- Alle exchange-timeframes: 1s, 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1D, 3D, 1W, 1M.
- **Elke eigen timeframe**: typ bijvoorbeeld `10m`, `45m`, `3h`, `2D`, `2W`, `3M` in het vakje "eigen". De app bouwt die zelf uit kleinere candles (ook live).

**Grafiek**
- Candles, hollow candles, Heikin Ashi, OHLC-bars, lijn, area en baseline.
- Tekentools: horizontale lijn, trendlijn en Fibonacci retracement (worden per symbool bewaard).
- Prijsalarmen (🔔 en dan klikken op de grafiek), met browsermelding.
- Watchlist met live prijzen, licht/donker thema, werkt ook op je telefoon.

**Indicatoren (44)**

| Categorie | Indicatoren |
|---|---|
| Gemiddelden | SMA, EMA, WMA, HMA, SMMA/RMA, DEMA, TEMA, VWMA, LSMA, MA Cross, VWAP |
| Banden en kanalen | Bollinger Bands, Keltner, Donchian, Envelope |
| Trend | Ichimoku, Parabolic SAR, SuperTrend, ADX/DMI, Aroon, Choppiness |
| Oscillatoren | RSI, MACD, Stochastic, Stoch RSI, CCI, Williams %R, ROC, Momentum, Awesome Osc., TRIX, Ultimate Osc., CMO, DPO |
| Volume | Volume, OBV, MFI, CMF, Accumulation/Distribution, Elder Force Index |
| Volatiliteit | ATR, Standard Deviation, Bollinger BandWidth, Historical Volatility |

Alle parameters zijn aan te passen (⚙ in de zijbalk).

**Strategieën (13 + eigen regels)**
MA Crossover · Golden/Death Cross · RSI Overbought/Oversold · MACD Signal Cross ·
Bollinger Mean Reversion · Bollinger Breakout · SuperTrend · Donchian/Turtle Breakout ·
Stochastic Cross · Parabolic SAR · Ichimoku Cloud Breakout · ADX + DI Cross ·
Trendfilter + RSI Pullback · **Eigen regels (no-code)**

Met "Eigen regels" maak je zelf strategieën zonder te programmeren, bijvoorbeeld:

```
Long entry:  EMA(9) crosses above EMA(21) AND RSI(14) > 50
Long exit:   EMA(9) crosses below EMA(21) OR close < LOWEST(10)
```

**Backtester**
- Startkapitaal, positiegrootte, commissie, slippage.
- Long, short of allebei; stop loss, take profit en trailing stop.
- Uitvoering op de open van de volgende bar (realistisch, zonder vooruitkijken) of op de slotkoers.
- Resultaten: netto winst, buy & hold, win rate, profit factor, max drawdown, Sharpe, Sortino, CAGR,
  tijd in de markt, kosten en meer. Daarnaast een equity curve met drawdown, een tradelijst (klik = naar die trade
  op de grafiek) en export naar CSV.
- **Optimizer**: test alle combinaties van 1–2 parameters en sorteer op het beste resultaat.

## Belangrijk

- Een goede backtest is **geen garantie** voor de toekomst. Pas op met overfitting: test de "beste"
  instellingen ook op een andere periode of markt.
- De backtester gaat uit van één positie tegelijk. Als stop loss en take profit in dezelfde candle worden
  geraakt, rekent hij met de stop (voorzichtig).
- Dit is een analyse- en leertool, geen financieel advies.

## Projectstructuur

```
sidechart/
  index.html          opbouw van de pagina
  src/main.ts         app-logica en gebruikersinterface
  src/chart.ts        grafiek, panelen, tekeningen, markers
  src/data.ts         Binance-data, live stream, resampling, CSV
  src/ta.ts           wiskunde van de indicatoren
  src/indicators.ts   lijst met indicatoren en hun instellingen
  src/strategies.ts   strategieën en de taal voor eigen regels
  src/backtest.ts     backtest-engine, statistieken en optimizer
  src/core.test.ts    unit tests
```

Een indicator of strategie toevoegen gaat door één object toe te voegen aan `INDICATORS` of `STRATEGIES`.
