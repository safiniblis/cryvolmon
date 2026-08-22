# Bitrue USDT-M Futures API - Full Reference

## Overview
- Base URL: `https://fapi.bitrue.com` (REST)
- WS base: `wss://fapiws.bitrue.com` (market data), `https://fapiws-auth.bitrue.com` (user stream listenKey)
- Content-Type: `application/json` on all requests
- API keys: passed via `X-CH-APIKEY` header (case sensitive)
- Timestamp: passed via `X-CH-TS` header (unix ms)
- Signature: passed via `X-CH-SIGN` header (case insensitive)
- V2 docs: `https://github.com/Bitrue-exchange/USDT-M-Future-open-api-docs/tree/main/v2`

## Authentication (HMAC-SHA256)

Signing algorithm:
```
sign_string = timestamp + METHOD + requestPath + body
signature = HMAC-SHA256(sign_string, apiSecret)
```
- METHOD is uppercase: GET or POST
- body is the raw request body string (POST only, empty string for GET)
- signature is not case sensitive

Timing security:
- recvWindow defaults to 5000ms
- Rejected if timestamp > serverTime + 1000
- Rejected if serverTime - timestamp > recvWindow
- Recommended: recvWindow of 5000 or less

## HTTP Error Codes
| Code | Meaning |
|------|---------|
| 4XX | Malformed request |
| 429 | Rate limit exceeded |
| 418 | IP auto-banned |
| 5XX | Internal server error |
| 504 | Timeout - status UNKNOWN (may have succeeded) |

## Rate Limits
| Endpoint | Limit |
|----------|-------|
| POST /fapi/v1/cancel | 20 per 2s |
| GET /fapi/v1/account | 20 per 2s |
| GET /fapi/v2/account | 20 per 2s (assumed) |
| All others | Global 429 applies |

## Symbol Format
- Field name: `contractName` (not `symbol` for order endpoints)
- Format: `E-{BASE}-USDT` (e.g. E-BTC-USDT, E-XAUT-USDT)
- contractSymbol (e.g. BTC-USDT) appears in account responses

## Market Data (No auth)

### GET /fapi/v1/ping
Returns `{}`

### GET /fapi/v1/time
Returns `{ serverTime, timezone }`

### GET /fapi/v1/contracts
Returns array with: symbol, status (0/1), type (E=perpetual, S=test, H=mixed), multiplier, multiplierCoin, pricePrecision, minOrderVolume, minOrderMoney, maxMarketVolume, maxMarketMoney, maxLimitVolume, maxLimitMoney, maxValidOrder

### GET /fapi/v1/depth
Params: contractName (req), limit (default 100, max 100)
Returns `{ bids: [[price,qty]], asks: [[price,qty]], time }`

### GET /fapi/v1/ticker
Params: contractName (req)
Returns `{ high, vol, last, low, rose, time }`

### GET /fapi/v1/klines
Params: contractName (req), interval (1min/5min/15min/30min/1h/60min/2h/4h/1day/1week/1month), limit (default 100, max 300)
Returns `[{ idx, high, low, close, open, vol }]`

## Trading Endpoints (TRADE auth)

### POST /fapi/v2/order - New Order
Body params:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| contractName | string | YES | E-BTC-USDT etc. |
| clientOrderId | string | no | Max 32 chars |
| side | string | YES | BUY or SELL |
| type | string | YES | LIMIT, MARKET, IOC, FOK, POST_ONLY |
| positionType | int | YES | 1=crossed, 2=isolated |
| open | string | YES | OPEN or CLOSE |
| volume | bigdecimal | YES | Order quantity (contracts for LIMIT) |
| amount | bigdecimal | YES | Order amount (USDT notional for MARKET) |
| price | bigdecimal | YES | Order price |
| leverage | bigdecimal | YES | 1-125 |

Optional trigger/condition order params:
| triggerOrderType | int | 0=NORMAL, 1=LIMIT, 2=MARKET, 3=POSITION |
| triggerType | int | 1=stop loss, 2=take profit |
| triggerPriceType | int | 1=latest trade, 2=mark price |
| triggerPrice | bigdecimal | trigger price |
| conditionOrder | bool | true/false |
| positionId | int | position id |
| triggerOrderCreateParams | array | child trigger orders |

Response: `{ code, msg, data: { orderId } }`

### POST /fapi/v2/cancel - Cancel Order
Body params:
| contractName | string | YES |
| clientOrderId | string | no (either this or orderId) |
| orderId | long | no (either this or clientOrderId) |
| conditionOrder | bool | no |

Response: `{ code, msg, data: { orderId } }`

### GET /fapi/v2/openOrders - Current Open Orders
Query: contractName (req)
Response: `{ code, msg, data: [{ orderId, clientOrderId, price, origQty, origAmount, executedQty, avgPrice, status, type, side, action, transactTime, triggerPrice, triggerType, triggerOrderType, conditionOrder, childOrders }] }`

### GET /fapi/v2/order - Query Order
Query: contractName (req), clientOrderId or orderId (req)
Response: similar to openOrders item

### GET /fapi/v2/myTrades - Account Trade List
Query: contractName (req), fromId, limit (default 100, max 1000), startTime, endTime

### POST /fapi/v2/allOpenOrders - Cancel All
Query: contractName (req)

### POST /fapi/v2/level_edit - Change Leverage
Body: contractName (req), leverage (req, 1-125)

### POST /fapi/v2/positionMargin - Modify Isolated Margin
Body: contractName (req), amount (req)

## Account Endpoints (USER_DATA auth)

### GET /fapi/v2/account - Account Info
Returns full account with positions. Key fields:
- accountNormal: balance
- accountLock: frozen margin
- totalEquity: total equity
- unrealizedAmount: unrealized PnL
- positionVos[].positions[]: position details including:
  - id, side (BUY/SELL), volume, openPrice, avgPrice, leverageLevel
  - holdAmount (margin), realizedAmount, historyRealizedAmount
  - tradeFee, capitalFee, closeProfit
  - marginRate, reducePrice, returnRate
  - unRealizedAmount, positionBalance, indexPrice
  - keepRate (min kept margin rate), maxFeeRate
  - freezeLock: 0=normal, 1=liq freeze, 2=delivery freeze
  - status: 0=ineffective, 1=effective
  - forceLiquidationVolume, forceLiquidationPrice

### GET /fapi/v2/leverageBracket - Notional/Leverage Brackets
Query: contractName (req)
Returns brackets with: bracket, initialLeverage, maxPositionValue, minPositionValue, maintMarginRatio

### GET /fapi/v2/commissionRate - Fee Rates
Query: contractName (req)
Returns: openTakerFeeRate, openMakerFeeRate, closeTakerFeeRate, closeMakerFeeRate

### POST /fapi/v2/futures_transfer - Wallet/Futures Transfer
Body: coinSymbol (req), amount (req), transferType (req: wallet_to_contract / contract_to_wallet), unionId (opt)

### GET /fapi/v2/futures_transfer_history - Transfer History
Query: transferType (req), coinSymbol, beginTime, endTime, page, limit (default 10, max 200)

### GET /fapi/v2/forceOrdersHistory - Liquidation/ADL History
Query: contractName (req), beginTime, endTime, autoCloseType (LIQUIDATION/ADL), page, limit (default 10, max 200)

## Error Codes (API response)
| Code | Description |
|------|-------------|
| 0 | Success |
| -1000 | Unknown error |
| -1001 | Internal error |
| -1002 | Missing API key |
| -1003 | Rate limit exceeded |
| -1004 | User does not exist |
| -1006 | Order status unknown |
| -1007 | Backend timeout |
| -1014 | Unsupported order combo |
| -1015 | Too many orders |
| -1021 | Invalid timestamp |
| -1022 | Invalid signature |
| -1025 | Futures not activated |
| -1121 | Invalid contract |
| -1136 | Qty below minimum |
| -1137 | Qty exceeds maximum |
| -1138 | Price out of range |
| -1139 | No market orders for pair |
| -1140 | Max position exceeded |
| -1146 | Contract untradeable |
| -1149 | Isolated position not found |
| -1150 | Too many decimal places |
| -1155 | Price deviates from market |
| -1156 | Close qty exceeds position |
| -1157 | Position frozen |
| -1163 | Cannot change leverage (open orders) |
| -2013 | Order not found |
| -2014 | Invalid API key format |
| -2015 | Invalid key/IP/permission |
| -2016 | Trading frozen |
| -2017 | Insufficient balance |
| -2100 | Parameter issue |
| -2101 | IP country banned |
| -2102 | IP soft-banned |

## WebSocket

### Market Data
- Base: `wss://fapiws.bitrue.com`
- Subscribe to depth: `{ "event": "sub", "params": { "channel": "depth", "symbol": "E-BTC-USDT" } }`
- Subscribe to trade: `{ "event": "sub", "params": { "channel": "trade", "symbol": "E-BTC-USDT" } }`
- Subscribe to kline: `{ "event": "sub", "params": { "channel": "kline_1m", "symbol": "E-BTC-USDT" } }`
- Subscribe to ticker: `{ "event": "sub", "params": { "channel": "ticker", "symbol": "E-BTC-USDT" } }`

### User Data Stream
- ListenKey base: `https://fapiws-auth.bitrue.com`
- Create: `POST /user_stream/api/v1/listenKey` (returns listenKey, valid 60 min)
- Keep-alive: `PUT /user_stream/api/v1/listenKey/{listenKey}` (extends 60 min)
- Close: `DELETE /user_stream/api/v1/listenKey/{listenKey}`
- Connect: `wss://fapiws.bitrue.com/stream?streams={listenKey}`
- Subscribe: `{ "event": "sub", "params": { "channel": "user_account_update" } }`
- Must respond to ping with pong: `{ "event": "pong", "ts": "..." }`

### User Stream Payloads

Order event (ORDER_TRADE_UPDATE):
```
{ e, E, o: { s, c, S, o, q, p, ap, x, X, i, l, z, L, N, n, T, t, m, R, ps, rp } }
```
- x execution types: NEW, CANCELED, TRADE, LIQUIDATION, ADL
- X status: NEW, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED
- ps: LONG/SHORT position direction

Account event (ACCOUNT_UPDATE):
```
{ e, E, T, a: { m, B: [{ a, cw, lb, iw, bc }], P: [{ s, pa, ep, lp, cr, up, mt, iw, ps }] } }
```
- m: event trigger reason
- B: balance changes
- P: position changes (pa=position amount, ep=entry price, up=unrealized PnL)
