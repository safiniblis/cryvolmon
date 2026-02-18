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
- **Symmetric spacing**: Both below and above grids grow wider (1.05x per step) — optimized via backtest simulation
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
- TP range: from entry * (1 + minProfitableGap) up to currentPrice * 1.03 (3% above current price)
- TP spacing: geometric progression with minProfitableGap (2.5x round-trip fee, ~0.3%) — each level is 0.3% above the previous
- TP count: limited only by position qty / minTradeVolume — packs in as many small TPs as the exchange allows
- If price is below entry, tpUpperLimit is at least minTpPrice * 1.005 to ensure some TPs always exist
- TP reserve: 10% of position qty held back from TP orders for larger price spikes (configurable via tpReservePct)
- Remaining 90% of position qty split equally across all TP levels (last level gets remainder)
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

## Budget Cap System
- `allocatedBudget` in strategy config tracks the maximum USDT the bot can use
- Set automatically at strategy start to the available balance at that time
- Increased by manual "Add Margin" (user explicitly assigns more funds)
- Decreased by manual "Remove Margin" (user withdraws funds from strategy)
- **Standalone grids**: PnL adjustments each cycle — reads position `realizedPNL + fee + funding` from Bitunix, tracks delta via `lastTrackedPnl`, adjusts budget up (profits) or down (losses/fees/funding)
- **Tandem child grids**: Budget is FIXED at initial 50% of totalCapital — NO PnL adjustments. Grid ROI is saved as liquidation buffer, not reinvested into bigger positions
- `lastTrackedPositionId` handles position changes/closures — resets PnL tracking when position ID changes
- Bot spending capped at `min(accountAvailable, allocatedBudget)` — new deposits won't be spent unless user explicitly adds margin
- Budget Cap shown in strategy card params

## Grid Side Support
- Grid engine is side-aware via `gridSide?: "LONG" | "SHORT"` in GridConfig
- LONG (default): Initial market BUY, BUY grid orders below price, SELL TPs above entry
- SHORT: Initial market SELL, SELL grid orders above price, BUY TPs below entry
- `parentTandemId?: number` links child grids to their tandem parent
- Child grids (with parentTandemId) are filtered from the strategies API response

## Tandem L/S Live Strategy (Dual Grid Bots)
- **State machine**: entry → waiting_liquidation → cascade → trailing → complete → restart
- **Entry**: Creates 2 child grid strategies (LONG grid + SHORT grid), each with 50% of totalCapital
- **Child grids**: Run as independent grid bots via the normal strategy cycle engine
- **Waiting**: Polls getPositions every 15s; detects liquidation when one side's position disappears
- **Cascade**: Stops liquidated child grid; market-closes 2/7 of survivor qty at 1%, 2%, 3% beyond liquidation price
- **Trailing**: Tracks high watermark, closes remaining 1/7 on 0.5% pullback
- **Complete**: Cleans up orders/positions, optionally rotates pair, resets to entry for next cycle
- **Config**: Stored in strategy.config JSON (TandemConfig interface) — totalCapital, longGridId, shortGridId
- **API route**: `POST /api/strategies/tandem-start` (symbol, totalCapital, leverage, rotationEnabled)
- **UI panel**: Shows live phase, cycle count, entry price, unrealized PnL, child grid IDs, liquidated/survivor sides, cascade progress, HWM, total PnL
- **Stop cleanup**: cancelAllTandemOrders deletes child grid strategies, cancels all limit orders, TP/SL orders, and flash-closes positions

## Leverage/Grid Optimization Math
- Fee: 0.06% per trade on notional (qty × price), round-trip = 0.12%
- Leverage does NOT change fee % — it's always on notional
- Grid gap = feeMultiplier × roundTripFee (e.g., 3.5 × 0.12% = 0.42%)
- Tandem child grids: gridRange = 85% of 1/leverage, tpRange = 50% of 1/leverage
- Uniform spacing (gapGrowth=1.0) for concentrated grids within tight range
- Sweet spot: 25-40x leverage → 5-8 grids, each netting ~7-12% of margin per trade
- Endpoint: GET /api/grid/leverage-analysis — full table of leverage vs grids vs ROI

## Recent Changes
- 2026-02-18: Leverage optimization: tandem fee multiplier 4.0x→3.5x (gap 0.42%), grid stats preview in UI, leverage analysis endpoint
- 2026-02-18: Tandem grid ranges derived from leverage (85% of 1/L) instead of hardcoded 10%/2%
- 2026-02-18: Redesigned tandem to use dual grid bots (LONG grid + SHORT grid) instead of simple positions
- 2026-02-18: Added SHORT-side grid support: initial sell, sell grid orders above price, buy TPs below entry
- 2026-02-18: Tandem uses totalCapital (split 50/50) instead of capitalPerSide
- 2026-02-18: Live tandem L/S executor with 5-phase state machine, cascade TP, trailing stop, auto-restart cycles
- 2026-02-18: Tandem start panel with live bot status display (phase, PnL, positions, cascade progress)
- 2026-02-18: UI cleanup: minimal Quick Start ($ + Start), PNL on running bot, 4h vol scores, 24h% change, manual rotation buttons, mobile-friendly tables
- 2026-02-18: Fee multiplier changed from 2.5x to 4.0x (grid gap 0.48% vs 0.30%) — fewer but more profitable trades
- 2026-02-18: Added manual pair rotation endpoint (POST /api/strategies/:id/rotate)
- 2026-02-18: Optimized gap settings via backtest: symmetric 1.05x growth both directions, 10% TP reserve for spikes
- 2026-02-18: Added gap optimization engine (/api/grid/optimize-gaps) testing 12 configs × 4 reserve levels across top coins
- 2026-02-18: Extended TP range to +3% above current price with geometric spacing, unlimited TP count (limited only by position qty / minTradeVolume)
- 2026-02-18: Budget cap system with PnL-based adjustments (profits increase cap, losses decrease it)
- 2026-02-18: Fixed add-margin 500 error with defensive validation
- 2026-02-18: Editable gap modifiers (gapGrowthBelow/gapShrinkAbove) while bot is running
- 2026-02-18: Tandem L/S simulation engine: long+short at 100x+, grid income while waiting for liquidation, cascade TP (2/7, 2/7, 2/7, 1/7 trailing 0.5%)
- 2026-02-18: TP replanting fix: TPs now rebuild when some are consumed (not just when all are gone)
- 2026-02-18: PNL gauge side mapping fix (LONG→BUY, SHORT→SELL for Bitunix)
- 2026-02-17: Fixed buy order sizing to use fixed amountPerGrid (uniform orders)
- 2026-02-17: Widened TP channel: sell/TP levels cover all grid levels above price up to upperPrice (not just +1%)
- 2026-02-17: Added margin info endpoint, extend-to-1% button, MAX remove, withdrawable margin display
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
