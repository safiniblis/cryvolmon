---
name: Exchange API Rules
description: Bitunix vs Bitrue auth, endpoints, order fields, and known gotchas — never mix the two clients
---

## Full Bitrue API Reference
See `.agents/memory/bitrue-api-reference.md` for complete endpoint docs, error codes, rate limits, WS payloads, and leverage brackets.

## Bitunix (ADAUSDT and other non-gold strategies)
- Uses `server/bitunix.ts`
- Symbol field: `symbol`
- Auth: HMAC-SHA256 over `ts + nonce + accessKey + queryString` (GET) or body (POST)
- Order endpoint: `/api/v1/futures/trade/open_order`
- Cancel: POST `/api/v1/futures/trade/cancel_orders` — supports batch cancel
- Position: `/api/v1/futures/position/get_single_position`
- Pending positions: GET `/api/v1/futures/position/get_pending_positions`
- Historical positions: GET `/api/v1/futures/position/get_history_positions`
  - Use `symbol`, `startTime`, and `limit` (maximum 100) to scope the query.
  - Each closed position includes `side`, `entryPrice`, `closePrice`, `maxQty`, `fee`, `funding`, `realizedPNL`, `ctime`, and `mtime`.
  - `realizedPNL` excludes fees and funding; do not recalculate it from internal trade logs.
- Historical orders: GET `/api/v1/futures/trade/get_history_orders`
  - Filled orders include `tradeQty`, `price`, `fee`, `realizedPNL`, `ctime`, and `mtime`.
  - Rate limit documented by Bitunix: **10 requests/sec per UID**.
- WebSocket price/order/position channels should provide live updates; REST polling is for reconciliation and authoritative historical accounting.

### Tandem accounting rules
- `initialCapital` is immutable starting capital supplied by the user.
- `capitalTrackingStartedAt` scopes exchange history to the current strategy accounting period.
- Tandem `totalCapital` is `initialCapital + sum(realizedPNL)` from Bitunix's currently open, symbol-matched LONG and SHORT positions only.
- Historical closed-position PnL is for analysis and must never inflate the active Tandem budget.
- Do not use internal PnL estimates or browser values to increase Tandem budget.
- Position notional may exceed capital because of leverage; the parent margin cap must not exceed `totalCapital`.
- API call budgeting for one Tandem pair at the 15-second engine cycle is approximately 10–12 REST calls per cycle before order/cancel bursts; keep below the documented 10 req/sec/UID limit and prefer WebSockets for prices.

## Platform Separation Matrix

| Platform | Client | Current products | Symbol field | Primary quantity semantics | PnL/accounting source |
|---|---|---|---|---|---|
| Bitunix | `server/bitunix.ts` | Crypto perpetuals, Grid, Tandem, Hedge Pair | `symbol` | Base-asset `qty`; leverage is account/order configuration | Bitunix positions/history positions/orders |
| Bitrue | `server/bitrue.ts` | E-XAUT-USDT Gold Long | `contractName` | MARKET uses USDT `amount`; LIMIT/CLOSE uses integer contract `volume` | Bitrue positions/order status; contract multiplier applies |

### Non-negotiable adapter boundary
- Never use Bitunix signing, headers, endpoints, field names, quantity units, or response parsers for Bitrue.
- Never use Bitrue `contractName`, `amount`, `volume`, HMAC format, or POST-cancel behavior for Bitunix.
- Every future exchange gets a separate client module and a separate strategy/execution adapter before it is exposed in the UI.
- A new platform must document, independently: authentication, base URL, symbol format, market metadata, quantity units, precision/minimums, leverage/margin setup, open orders, positions, historical fills, realized PnL, cancel semantics, and rate limits.
- Shared strategy logic may consume normalized internal values only after the platform adapter has converted them. Raw exchange payloads must not cross adapter boundaries.
- UI exchange selectors must use the platform's own available-symbol endpoint; never assume that a Bitunix pair is valid on Bitrue or on a future exchange.

## AI Provider Separation
- Model-provider API keys and endpoints are also separate from trading-exchange credentials.
- OpenCode/Abacus/Groq/Cerebras/OpenRouter keys must never be used in exchange clients.
- Trading API keys must never be sent to Council/model providers.

## Bitrue (E-XAUT-USDT gold strategies)
- Uses `server/bitrue.ts` — completely separate from Bitunix, never mix
- Symbol field: `contractName` (not `symbol`)
- Base URL: `https://fapi.bitrue.com`
- Auth: HMAC-SHA256 over `ts + METHOD + path + body` (all four parts concatenated)
- V2 endpoints (preferred): POST `/fapi/v2/order`, POST `/fapi/v2/cancel`, GET `/fapi/v2/openOrders`, GET `/fapi/v2/account`
- V1 endpoints (fallback): POST `/fapi/v1/contract_order`, POST `/fapi/v1/cancel`, POST `/fapi/v1/batchCancel`
- Order types: LIMIT, MARKET, IOC, FOK, POST_ONLY (V2 only)
- positionType: 1=crossed, 2=isolated
- Leverage: per-order via `leverage` param (1-125), also `POST /fapi/v2/level_edit`
- MARKET orders: use `amount` (USDT notional, min $5)
- LIMIT orders: use `volume` (integer contracts) + `price`
- Trigger/TP/SL orders: V2 supports `triggerOrderType`, `triggerType`, `triggerPrice`, `conditionOrder`, `triggerOrderCreateParams` directly on new order
- Position: GET `/fapi/v1/positions?contractName=E-XAUT-USDT`
  - Response shape is inconsistent — use `BitrueClient.extractPositions(res)` static helper which handles `{ positions }`, `{ data: { positions } }`, `{ data: [] }`, or bare `[]`
  - Volume field: `volume` or `holdVol` or `qty` or `openVol` (try all)
  - Liq price field: `liqPrice` or `liquidationPrice` or `liqP` or `forceClosePrice` or `blastPrice` (try all, use first non-zero)
  - CRITICAL: validate liq price is BELOW avgPrice for a long. If exchange returns liq > avg (happens with stale/zero positions), reject it and use formula.
  - Formula fallback: `avgPrice × (1 − 1/leverage)`
- Open orders: GET `/fapi/v1/openOrders?contractName=E-XAUT-USDT`
- Order status: GET `/fapi/v1/order?contractName=E-XAUT-USDT&orderId=...`
  - Filled statuses: `FILLED`, `COMPLETE`, `DONE`, `COMPLETED`, `"2"`, `"3"`
  - Fill volume field: `dealVolume` or `executedQty` or `volume`

## E-XAUT-USDT Contract Specs
- multiplier: `0.0001` (1 contract = 0.0001 XAUT)
- pricePrecision: 1 decimal place (`roundPrice` rounds to 1dp)
- quantity unit: **integer contracts** for LIMIT orders
- MARKET orders use USDT notional (`amount`), min $5
- positionType: `1` = long (one-way mode)

**Why:** E-XAUT has very different minimums and contract sizes vs ADAUSDT. Mixing clients causes silent auth failures. DELETE cancel silently returns 200 on Bitrue but does nothing — must use POST.

## Blocked pairs on Bitrue futures
- Only E-XAUT-USDT is used. No other pairs confirmed as working.
