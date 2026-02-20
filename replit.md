# Crypto Volatility Radar & Trading Agent

## Overview
This project is a full-stack cryptocurrency trading platform designed to help users identify trading opportunities and automate their trading strategies. It features a Volatility Dashboard for tracking significant price movements of top crypto assets and a sophisticated Trading Agent for automated futures trading on Bitunix, supporting various strategies like Grid, DCA, and Momentum. The platform aims to provide tools for both market analysis and strategic execution in the volatile cryptocurrency market.

## User Preferences
The user prefers clear and concise explanations. The user wants the agent to ask for confirmation before making any major changes or deploying new strategies. The user also prefers an iterative development approach, with frequent updates and opportunities to provide feedback. The user wants to avoid any changes to the core trading logic unless explicitly approved, focusing instead on UI/UX improvements and new feature additions.

## System Architecture
The application is built as a full-stack solution. The frontend is developed with React, Vite, TailwindCSS, shadcn/ui, Framer Motion, and Recharts, providing a modern and interactive user interface. The backend uses Express.js with TypeScript for robust API services. PostgreSQL, accessed via Drizzle ORM, serves as the primary data store. Integration with the Bitunix Futures API handles all trading operations, secured with HMAC SHA-256 authentication.

**Key Features and Design:**
- **Volatility Radar:** Tracks hourly price swings for the top 20 crypto assets using CoinGecko data. Volatility scores (1-5% swings) and risk gauges (>5% swings) are provided.
- **Trading Agent:** Supports automated Grid, DCA, and Momentum strategies.
- **Grid Strategy:**
    - Features dynamic lower (-10%) and upper (+2%) price bounds with symmetric spacing (1.05x growth per step).
    - Leverage is maximized based on liquidation distance.
    - Employs a geometric grid ratio (1 + 2.5 * roundTripFee) for profitability.
    - Includes dynamic extension of grid bounds as prices move.
    - Sell-side utilizes Bitunix's TP/SL API for Take Profit orders, geometrically spaced up to 3% above current price, with a configurable TP reserve.
    - Initial market buy logic calculates maximum affordable position with a 5% safety buffer.
- **Tandem L/S Live Strategy:** A dual-grid bot system for simultaneous LONG and SHORT positions with equal 50/50 capital split (configurable via longWeight/shortWeight). It operates through a 5-phase state machine (entry, waiting_liquidation, cascade, trailing, complete, restart) with built-in liquidation recovery, reversal bail-out logic, and high-water mark trailing stops.
- **Budget Cap System:** Each strategy has an `allocatedBudget` for capital management, adjustable through manual 'Add Margin'/'Remove Margin' controls. Budget adjusts with PnL for standalone grids but is fixed for tandem child grids.
- **Margin Adjustment Controls:** Allows users to add margin by placing new buy orders at uncovered grid levels or remove margin by canceling lowest-performing buy orders.
- **Pair Rotation Logic:** Automatically switches trading pairs based on volatility scores and risk gauges, checking every 5 minutes.
- **UI/UX:** The interface is designed with TailwindCSS and shadcn/ui for a clean, responsive aesthetic, incorporating Framer Motion for smooth animations and Recharts for data visualization.
- **Strategy Engine:** Manages strategy lifecycle, order placement, position tracking, and PnL calculation.

## External Dependencies
- **CoinGecko API:** Used for fetching real-time cryptocurrency price data and volatility metrics.
- **Bitunix Futures API:** Integrated for all automated trading operations, including placing orders, managing positions, setting leverage, and handling Take Profit/Stop Loss.
- **PostgreSQL:** The relational database used for persistent storage of user data, strategy configurations, trade logs, positions, and account balances.
- **Drizzle ORM:** Used for interacting with the PostgreSQL database.

## Tandem L/S Strategy Details
- **State machine**: entry → waiting_liquidation → cascade → trailing → complete → restart
- **Entry**: Creates 2 child grid strategies (LONG grid + SHORT grid) with equal 50/50 split (configurable via longWeight/shortWeight)
- **Child grids**: Run as independent grid bots via the normal strategy cycle engine
- **Waiting**: Polls getPositions every 15s; detects liquidation when one side's position disappears
- **Cascade**: Stops liquidated child grid; step 0: immediate market-close 1/2 (recover liq cost), step 1: close 1/4 at +1%, step 2: close 1/4 at +2%
- **Reversal bail-out**: If price crosses back past liquidation point after any cascade step (trend broke), immediately closes remaining position and restarts cycle with fresh grids. Applies in both cascade and trailing phases. Simulation uses percent=-3 marker for bail-out exits.
- **Trailing**: Tracks high watermark, closes remaining 1/4 on 0.3% pullback (tight since recovery already secured)
- **Complete**: Cleans up orders/positions, optionally rotates pair, resets to entry for next cycle
- **Config**: Stored in strategy.config JSON (TandemConfig interface) — totalCapital, longGridId, shortGridId
- **API route**: `POST /api/strategies/tandem-start` (symbol, totalCapital, leverage, rotationEnabled)
- **UI panel**: Shows live phase, cycle count, entry price, unrealized PnL, child grid IDs, liquidated/survivor sides, cascade progress, HWM, total PnL
- **Rebalancing**: Dynamic position rebalancing during waiting_liquidation phase. Trims larger side when positions diverge >10% (or >5% if liq is close). Escalating cooldown (2→4→8→15min), partial trims (50% or 75% if urgent), price velocity gate (>0.5% move skips).
- **Order sizing bias**: Soft rebalancing via gridSizeMultiplier — larger side gets smaller grid orders, smaller side gets larger orders, naturally converging positions toward target weight ratio.
- **Grid order window**: Tandem child grids cap active orders to 6 closest to current price, preventing order accumulation at range extremes.

## Grid Strategy Details
- Grid ratio: 1 + feeMultiplier * roundTripFee (default fm=3.5, gap ~0.42%)
- Leverage-derived ranges: lower = price * (1 - 0.85/leverage), upper = price * (1 + 0.85/leverage)
- Symmetric spacing: 1.05x growth per step
- TP channel: geometrically spaced sell TPs up to 3% above current price
- Full-position TP rebuild: when all TPs consumed, rebuilds for the entire position after 2-min cooldown (not just growth delta)
- Trailing TP: tracks high watermark per grid, places/updates a trailing TP order on the reserve portion (default 0.5% pullback from HWM). Cancels and replaces when HWM advances. Only triggers when trail price is profitable vs entry.
- Budget cap: allocatedBudget tracks capital per strategy, adjusts with PnL for standalone grids
- Sweet spot: 25-40x leverage → 5-8 grids, each netting ~7-12% of margin per trade

## Hedge Pair Strategy Details
- **Concept**: Static long + short positions at very high leverage (75-125x), tiny capital ($0.5-$50/side), one side liquidates quickly while survivor profits
- **State machine**: entry → monitoring → trailing → done (→ restart if autoRestart)
- **Entry**: Opens simultaneous LONG and SHORT market orders at same price, sets leverage via API. No TPs or SLs placed at entry.
- **Monitoring**: Polls positions every 15s, detects when one side is liquidated (position disappears)
- **Trailing**: Software-based trailing SL on survivor. Tracks high water mark (HWM), places/updates SL at HWM ± trailingPct (default 0.33%). SL is cancelled and re-placed whenever HWM advances. Bitunix API doesn't support native trailing stops, so this is implemented via polling.
- **Done**: Cleans up, logs PnL, optionally restarts with fresh cycle
- **Config**: leverage, capitalPerSide, trailingPct (default 0.33%), autoRestart
- **API route**: `POST /api/strategies/hedge-pair-start` (symbol, capitalPerSide, leverage, trailingPct, autoRestart)
- **UI panel**: Shows phase, leverage, capital, entry price, liquidated/survivor sides, trailing HWM/%, cycle/total PnL
- **Math**: At 100x leverage, liq distance ~1%, max loss = 2x capitalPerSide, survivor profits = ~100% of its margin at liq point

## Recent Changes
- 2026-02-20: Modularized strategy engine: extracted tandem code into server/tandem-engine.ts (~1360 lines) and hedge pair code into server/hedge-pair-engine.ts (~432 lines). strategy-engine.ts reduced from 4031 to ~2340 lines. Re-exports maintain backward compatibility.
- 2026-02-20: Fixed grid budget cap bug: standalone grids now subtract position margin from allocatedBudget to compute effective available balance, preventing grids from consuming entire account when budget is set.
- 2026-02-20: Fixed grid order cascade bug: added 2x grid gap minimum distance filter for grid orders during both initial buy and ongoing cycles, preventing orders from being placed close enough to fill instantly and cascade.
- 2026-02-20: Tandem rebalanced to 50/50 default (was 4/7 long, 3/7 short). Cascade portions updated to 1/2, 1/4, 1/4.
- 2026-02-20: Hedge Pair strategy rewritten: removed cascade TP scheme, replaced with software-based trailing SL (0.33% default). No TPs/SLs at entry — after one side liquidates, trailing SL tracks HWM on survivor, updating every 15s poll cycle.
- 2026-02-19: Hedge Pair strategy: full implementation with API route, state machine engine (entry/monitoring/cascade/done), UI panel with start form and running state, strategy card integration with phase badge and params
- 2026-02-19: Tandem TP reserve raised from 10% to 65% — ensures enough position survives for cascade to offset twin liquidation loss. Simulation updated to reflect reserve-aware cascade qty.
- 2026-02-19: Trailing TP: reserve portion now gets a trailing TP order that follows the high watermark (0.5% pullback default). Updates when price makes new highs, only triggers when profitable vs entry.
- 2026-02-19: Full-position TP rebuild: when all TPs consumed, rebuilds TPs for the entire position (not just growth delta) after 2-min cooldown. Eliminates the gap where most of the position had zero TP coverage.
- 2026-02-19: Configurable capital split: tandem now supports longWeight/shortWeight (default 4/7 long, 3/7 short) for asymmetric allocation matching crypto's upward bias
- 2026-02-19: Grid order window: tandem child grids cap active orders to 6 closest to current price, preventing order accumulation at range extremes
- 2026-02-19: Order sizing bias: soft rebalancing via gridSizeMultiplier — larger side gets smaller grid orders, smaller side gets larger orders, naturally converging positions toward target weight ratio
- 2026-02-18: Reversal bail-out: if price crosses back past liquidation point after any cascade step, close remaining and restart fresh grids immediately. Prevents double-liquidation by catching trend breaks early.
- 2026-02-18: Cascade redesign: 3/7 immediate at liq, 2/7 at +1%, 1/7 at +2%, trail 1/7 at 0.3% pullback. Simulation updated.
- 2026-02-18: Dynamic rebalancing: tandem trims larger side when positions diverge >10% (or >5% if liq is close), escalating cooldown (2→4→8→15min), 50% partial trim (75% if urgent), price velocity gate
- 2026-02-18: Fixed grid order sizing: uses config.amountPerGrid consistently, not remaining budget / missing levels
- 2026-02-18: Leverage optimization: tandem fee multiplier 4.0x→3.5x (gap 0.42%), grid stats preview in UI
- 2026-02-18: Tandem grid ranges derived from leverage (85% of 1/L) instead of hardcoded 10%/2%
- 2026-02-18: Redesigned tandem to use dual grid bots (LONG grid + SHORT grid) instead of simple positions