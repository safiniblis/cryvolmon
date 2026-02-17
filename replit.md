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

## Recent Changes
- 2026-02-17: Grid strategy: -10% to +2% range, 2.5x fee ratio, max leverage, dynamic extension
- 2026-02-17: Built full trading agent with Bitunix integration, strategy engine, and trading dashboard
