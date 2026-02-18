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
- **Tandem L/S Live Strategy:** A dual-grid bot system for simultaneous LONG and SHORT positions, each receiving 50% of total capital. It operates through a 5-phase state machine (entry, waiting_liquidation, cascade, trailing, complete, restart) with built-in liquidation recovery, reversal bail-out logic, and high-water mark trailing stops.
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
- **Entry**: Creates 2 child grid strategies (LONG grid + SHORT grid), each with 50% of totalCapital
- **Child grids**: Run as independent grid bots via the normal strategy cycle engine
- **Waiting**: Polls getPositions every 15s; detects liquidation when one side's position disappears
- **Cascade**: Stops liquidated child grid; step 0: immediate market-close 3/7 (recover liq cost), step 1: close 2/7 at +1%, step 2: close 1/7 at +2%
- **Reversal bail-out**: If price crosses back past liquidation point after any cascade step (trend broke), immediately closes remaining position and restarts cycle with fresh grids. Applies in both cascade and trailing phases. Simulation uses percent=-3 marker for bail-out exits.
- **Trailing**: Tracks high watermark, closes remaining 1/7 on 0.3% pullback (tight since recovery already secured)
- **Complete**: Cleans up orders/positions, optionally rotates pair, resets to entry for next cycle
- **Config**: Stored in strategy.config JSON (TandemConfig interface) — totalCapital, longGridId, shortGridId
- **API route**: `POST /api/strategies/tandem-start` (symbol, totalCapital, leverage, rotationEnabled)
- **UI panel**: Shows live phase, cycle count, entry price, unrealized PnL, child grid IDs, liquidated/survivor sides, cascade progress, HWM, total PnL
- **Rebalancing**: Dynamic position rebalancing during waiting_liquidation phase. Trims larger side when positions diverge >10% (or >5% if liq is close). Escalating cooldown (2→4→8→15min), partial trims (50% or 75% if urgent), price velocity gate (>0.5% move skips).

## Grid Strategy Details
- Grid ratio: 1 + feeMultiplier * roundTripFee (default fm=3.5, gap ~0.42%)
- Leverage-derived ranges: lower = price * (1 - 0.85/leverage), upper = price * (1 + 0.85/leverage)
- Symmetric spacing: 1.05x growth per step
- TP channel: geometrically spaced sell TPs up to 3% above current price
- Budget cap: allocatedBudget tracks capital per strategy, adjusts with PnL for standalone grids
- Sweet spot: 25-40x leverage → 5-8 grids, each netting ~7-12% of margin per trade

## Recent Changes
- 2026-02-18: Reversal bail-out: if price crosses back past liquidation point after any cascade step, close remaining and restart fresh grids immediately. Prevents double-liquidation by catching trend breaks early.
- 2026-02-18: Cascade redesign: 3/7 immediate at liq, 2/7 at +1%, 1/7 at +2%, trail 1/7 at 0.3% pullback. Simulation updated.
- 2026-02-18: Dynamic rebalancing: tandem trims larger side when positions diverge >10% (or >5% if liq is close), escalating cooldown (2→4→8→15min), 50% partial trim (75% if urgent), price velocity gate
- 2026-02-18: Fixed grid order sizing: uses config.amountPerGrid consistently, not remaining budget / missing levels
- 2026-02-18: Leverage optimization: tandem fee multiplier 4.0x→3.5x (gap 0.42%), grid stats preview in UI
- 2026-02-18: Tandem grid ranges derived from leverage (85% of 1/L) instead of hardcoded 10%/2%
- 2026-02-18: Redesigned tandem to use dual grid bots (LONG grid + SHORT grid) instead of simple positions