# Crypto Volatility Radar & Trading Agent

## Overview
A full-stack cryptocurrency trading platform with two main features:
1. **Volatility Dashboard** - Tracks hourly price swings for top 20 crypto assets using CoinGecko API
2. **Trading Agent** - Automated Bitunix futures trading with strategy management (Grid, DCA, Momentum)

## Architecture
- **Frontend**: React + Vite + TailwindCSS + shadcn/ui + Framer Motion + Recharts
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Drizzle ORM)
- **Exchange API**: Bitunix Futures API with HMAC SHA-256 authentication

## Project Structure
- `client/src/pages/dashboard.tsx` - Volatility radar dashboard
- `client/src/pages/trading.tsx` - Trading agent interface
- `client/src/hooks/use-crypto-stats.ts` - CoinGecko data hooks
- `client/src/hooks/use-trading.ts` - Trading/strategy hooks
- `server/routes.ts` - API routes
- `server/bitunix.ts` - Bitunix API client with signature auth
- `server/strategy-engine.ts` - Strategy execution engine (Grid, DCA, Momentum)
- `server/storage.ts` - Database storage interface
- `shared/schema.ts` - Drizzle schema (crypto_cache, strategies, trade_log, positions, account_balance)

## Key Routes
- `GET /api/stats` - Crypto volatility data
- `POST /api/stats/refresh` - Refresh from CoinGecko
- `GET /api/connection` - Bitunix API connection status
- `GET /api/account` - Account balances & positions
- `GET/POST /api/strategies` - Strategy CRUD
- `POST /api/strategies/:id/start` - Start strategy
- `POST /api/strategies/:id/stop` - Stop strategy
- `GET /api/trades` - Trade history
- `POST /api/trade` - Manual trade
- `POST /api/grid/simulate` - Run grid strategy backtest on cached price history
- `GET /api/volatility/scores` - Volatility scores (1-5% swings, risk gauge)
- `GET /api/bitunix/pairs` - Available Bitunix USDT trading pairs

## Required Secrets
- `BITUNIX_API_KEY` - Bitunix API key for futures trading
- `BITUNIX_SECRET_KEY` - Bitunix API secret key

## Grid Strategy Design
- **Lower bound**: -10% from current price (fixed)
- **Upper bound**: +2% from current price (fixed initial range)
- **Liquidation**: -12% from current price (2% buffer below lower)
- **Leverage**: Maximized (~8x), derived from liquidation distance
- **Grid ratio**: 1 + 2.5 * roundTripFee (geometric spacing, 2.5x fee profit per grid)
- **Asymmetric spacing**: Below grids grow wider (1.07x per step), above grids shrink tighter (0.96x per step)
- **Dynamic extension**: Lower bound extends when bot hits grids below start price (adjusts liquidation/leverage); upper extends when hitting grids above start price
- **GridConfig interface**: Tracks startPrice, extensionsBelow, extensionsAbove, gapGrowthBelow, gapShrinkAbove for live range management

## Pair Rotation Logic
- Only count 1-5% hourly price swings as volatility score
- Track >5% swings separately: up vs down as risk gauge
- If current pair's score drops 2x below another pair AND risk gauge doesn't favor staying (i.e., more large drops than pumps), close grid and switch
- Rotation check runs every 5 minutes during strategy cycle
- Enable via `rotationEnabled: true` in strategy config

## Bitunix API Endpoints (Verified)
- Place order: `POST /api/v1/futures/trade/place_order` (qty in base coin, not USDT)
- Cancel orders: `POST /api/v1/futures/trade/cancel_orders` (body: `{symbol, orderList: [{orderId}]}`)
- Cancel all orders: `POST /api/v1/futures/trade/cancel_all_orders` (body: `{symbol}`)
- Open orders: `GET /api/v1/futures/trade/get_pending_orders`
- Order history: `GET /api/v1/futures/trade/get_history_orders`
- Flash close: `POST /api/v1/futures/trade/flash_close_position` (body: `{positionId}`)
- Set leverage: `POST /api/v1/futures/account/change_leverage`
- Set margin mode: `POST /api/v1/futures/account/change_margin_mode`
- Account: `GET /api/v1/futures/account` (needs marginCoin=USDT)
- Positions: `GET /api/v1/futures/position/get_pending_positions`
- **TP/SL place**: `POST /api/v1/futures/tpsl/place_order` (body: `{symbol, positionId, tpPrice, tpStopType, tpOrderType, tpQty}`)
- **TP/SL pending**: `GET /api/v1/futures/tpsl/get_pending_orders` (query: symbol, limit)
- **TP/SL cancel**: `POST /api/v1/futures/tpsl/cancel_order` (body: `{symbol, orderId}`)
- **TP/SL modify position**: `POST /api/v1/futures/tpsl/position/modify_order`
- Leverage/margin must be set via separate endpoints before placing orders

## Grid Strategy - Sell Side (TP/SL approach)
- Grid sell levels are NOT separate SELL CLOSE limit orders (those fail with "Insufficient amount")
- Instead, sell levels use the TP/SL API: `place_tpsl_order` with `tpPrice`, `tpQty`, `tpStopType: "LAST_PRICE"`, `tpOrderType: "MARKET"`
- Each TP order is attached to the position via `positionId`
- Position qty is split equally across all TP levels within the ±1% band
- On strategy stop, both limit orders AND TP/SL orders are cancelled

## Initial Buy Logic
- On grid strategy start, places a market BUY for maximum affordable position
- Calculation: available_balance * leverage * 0.95 (5% safety buffer)
- Sets isolated margin mode and leverage before the buy
- Tracks `initialBuyDone` flag in config to avoid double-buying on restart
- Strategy engine checks this flag each cycle and auto-places initial buy if missed

## Key Routes (continued)
- `POST /api/strategies/:id/add-margin` - Place additional buy orders within ±1% band
- `POST /api/strategies/:id/remove-margin` - Cancel bottom buy orders >1% below price

## Margin Adjustment Controls
- **Add Margin**: Places additional BUY limit orders at uncovered grid levels within the ±1% band of current price, without cancelling existing orders (avoids fees). Splits provided USDT amount across available levels.
- **Remove Margin**: Cancels the lowest N buy orders that are >1% below current price. Only cancels orders matching grid levels. Reports freed margin estimate.
- Controls visible in expanded strategy card for running grid strategies only.

## Recent Changes
- 2026-02-17: Added margin adjustment controls (add/remove margin) for grid strategies
- 2026-02-17: Initial buy on grid start: max affordable position given leverage & liquidation
- 2026-02-17: Fixed Bitunix API: correct order endpoint, qty in base coin, leverage via separate endpoint
- 2026-02-17: Strategy engine auto-starts on server boot for running strategies
- 2026-02-17: Low balance warnings in trading UI
- 2026-02-17: Added grid simulation/backtest engine using CoinGecko cached 25h price history
- 2026-02-17: Added volatility scoring: 1-5% swing counter, >5% risk gauge (up/down ratio)
- 2026-02-17: Added pair rotation controller: auto-switch when score drops 2x, considering risk
- 2026-02-17: Dynamic Bitunix pairs fetching via /api/bitunix/pairs
- 2026-02-17: Frontend: simulation panel, volatility scores panel, rotation toggle
- 2026-02-17: Grid strategy: -10% to +2% range, 2.5x fee ratio, max leverage, dynamic extension
- 2026-02-17: Built full trading agent with Bitunix integration, strategy engine, and trading dashboard
