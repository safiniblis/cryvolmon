---
name: Exchange API Rules
description: Bitunix vs Bitrue auth, endpoints, order fields, and known gotchas — never mix the two clients
---

## Bitunix (ADAUSDT and other non-gold strategies)
- Uses `server/bitunix.ts`
- Symbol field: `symbol`
- Auth: HMAC-SHA256 over `ts + nonce + accessKey + queryString` (GET) or body (POST)
- Order endpoint: `/api/v1/futures/trade/open_order`
- Cancel: POST `/api/v1/futures/trade/cancel_orders` — supports batch cancel
- Position: `/api/v1/futures/position/get_single_position`

## Bitrue (E-XAUT-USDT gold strategies)
- Uses `server/bitrue.ts` — completely separate from Bitunix, never mix
- Symbol field: `contractName` (not `symbol`)
- Base URL: `https://fapi.bitrue.com`
- Auth: HMAC-SHA256 over `ts + METHOD + path + body` (all four parts concatenated)
- Order endpoint: POST `/fapi/v1/contract_order`
  - MARKET orders: use `amount` (USDT notional, min $5) — NOT `volume`
  - LIMIT  orders: use `volume` (integer contracts)
  - `leverage` is per-order (no separate leverage endpoint on Bitrue futures)
- Cancel: POST `/fapi/v1/cancel` — DELETE method NOT supported on Bitrue futures
  - Batch cancel: POST `/fapi/v1/batchCancel`
- Position: GET `/fapi/v1/getPosition?contractName=E-XAUT-USDT`
  - Liq price field: `liqPrice` or `liquidationPrice` or `forceClosePrice` or `blastPrice` (try all, use first non-zero)
  - Formula fallback (if all liq price fields are zero): `avgPrice × (1 − 1/leverage)`
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
