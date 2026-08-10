---
name: Exchange API Rules
description: Bitunix and Bitrue API auth, endpoints, and order mechanics — keep these strictly separated, never mix them up.
---

# Exchange API Rules

## Bitunix (futures only — all crypto pairs)

**Base URL:** `https://fapi.bitunix.com`

**Auth scheme:**
- All signed requests: `GET/POST` params include `nonce` (random string), `timestamp` (Unix ms)
- `sign = SHA256(apiKey + timestamp + nonce + queryString)` for GET
- `sign = SHA256(apiKey + timestamp + nonce + body)` for POST (body = JSON string)
- Headers: `api-key: <BITUNIX_API_KEY>`, `sign: <computed>`, `Content-Type: application/json`
- Env vars: `BITUNIX_API_KEY`, `BITUNIX_SECRET_KEY`

**Key endpoints:**
- `GET /api/v1/futures/position` — open positions
- `POST /api/v1/futures/order/create` — place order (`{symbol, qty, side, tradeSide, orderType, price?, effect?}`)
- `POST /api/v1/futures/order/cancel` — cancel by orderId
- `POST /api/v1/futures/order/cancel_all` — cancel all for symbol
- `GET /api/v1/futures/order/open_orders` — open orders
- `POST /api/v1/futures/position/flash_close` — market-close entire position
- `GET /api/v1/futures/account` — account balance
- `GET /api/v1/futures/tick` — ticker price
- `POST /api/v1/futures/position/change_margin_mode` — isolated/cross
- `POST /api/v1/futures/position/change_leverage` — set leverage

**Order fields:**
- `side`: `"BUY"` or `"SELL"`
- `tradeSide`: `"OPEN"` (enter position) or `"CLOSE"` (exit position)
- `orderType`: `"MARKET"` or `"LIMIT"`
- `effect`: `"GTC"`, `"IOC"`, `"FOK"`, `"POST_ONLY"`

**Known blocked pairs (API error 710002):**
- `XAUUSDT`, `XAGUSDT`, `XPTUSDT`, `SPXUSDT` — precious metals + synthetic indices are API-blocked even if they appear in the UI

**Client file:** `server/bitunix.ts` — export `getBitunixClient()`

---

## Bitrue (spot + futures — used for XAUT gold strategy)

**Spot Base URL:** `https://www.bitrue.com`  
**Futures Base URL:** `https://fapi.bitrue.com`

**Auth scheme (same for both spot and futures):**
- For GET: `payload = raw query string` (everything after `?`)
- For POST/DELETE: `payload = JSON.stringify(body)`
- `X-CH-SIGN = HMAC-SHA256(BITRUE_SECRET_KEY, payload)`
- Headers: `X-CH-APIKEY: <key>`, `X-CH-SIGN: <sig>`, `X-CH-TS: <Unix ms>`, `Content-Type: application/json`
- Signature does NOT include a timestamp param in the payload — timestamp goes in the `X-CH-TS` header only
- Env vars: `BITRUE_API_KEY`, `BITRUE_SECRET_KEY`

**Key futures endpoints (fapi.bitrue.com):**
- `GET /fapi/v1/exchangeInfo` — public; list all pairs and precision
- `GET /fapi/v1/ticker/price?symbol=XAUTUSDT` — public; current price
- `GET /fapi/v1/account` — account balance (signed)
- `GET /fapi/v1/positionRisk` — open positions (signed)
- `POST /fapi/v1/leverage` — set leverage `{symbol, leverage}` (signed)
- `POST /fapi/v1/order` — place order (signed)
- `DELETE /fapi/v1/order` — cancel order by orderId (signed)
- `DELETE /fapi/v1/allOpenOrders` — cancel all for symbol (signed)
- `GET /fapi/v1/openOrders` — open orders (signed)

**Order fields (futures):**
- `symbol`, `side` (`"BUY"` / `"SELL"`), `type` (`"MARKET"` / `"LIMIT"`), `quantity`
- `price` — required for LIMIT orders
- `positionSide`: `"LONG"` / `"SHORT"` / `"BOTH"` — use `"LONG"` for Gold Long strategy
- `timeInForce`: `"GTC"` for resting limit orders
- `reduceOnly`: `true` when closing a position

**XAUT symbol note:**
- Futures symbol is likely `XAUTUSDT` (same as spot) — confirm from `/fapi/v1/exchangeInfo` on first run
- `BitrueClient.probeFutures()` logs available XAU pairs at startup
- Quantity precision: 4 dp (0.0001 XAUT min) — verify from exchangeInfo `stepSize`
- Price precision: 2 dp ($0.01) — verify from exchangeInfo `tickSize`

**Quantity sizing for futures (margin × leverage semantics):**
- `baseCapital` = margin in USDT (what the user puts up)
- `notional = baseCapital × leverage`
- `qty = (notional × allocationPct) / price`
- Example: $100 margin × 10x = $1000 notional; 30% entry at $3300/oz = 0.0909 XAUT

**Client file:** `server/bitrue.ts` — export `getBitrueClient()`

---

## Quick reference: DO NOT MIX

| Property | Bitunix | Bitrue |
|---|---|---|
| Client file | `server/bitunix.ts` | `server/bitrue.ts` |
| Base URL | `fapi.bitunix.com` | `fapi.bitrue.com` (futures) |
| Auth header | `api-key` + `sign` | `X-CH-APIKEY` + `X-CH-SIGN` + `X-CH-TS` |
| Sig input | `apiKey+ts+nonce+params` | `HMAC-SHA256(secret, queryString or body)` |
| Cancel all | `/api/v1/futures/order/cancel_all` | `DELETE /fapi/v1/allOpenOrders` |
| Flash close | `POST /api/v1/futures/position/flash_close` | `POST /fapi/v1/order` with `reduceOnly:true` |
| Env vars | `BITUNIX_API_KEY/SECRET_KEY` | `BITRUE_API_KEY/SECRET_KEY` |
| Strategy types | grid, dca, momentum, tandem, hedge_pair | gold_long |
