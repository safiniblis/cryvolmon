/**
 * Bitrue Futures Client — fapi.bitrue.com
 *
 * COMPLETELY SEPARATE from server/bitunix.ts — different exchange, different API shape.
 * Do not mix Bitrue and Bitunix types, endpoints, signing, or field names.
 *
 * Auth:
 *   GET  → X-CH-SIGN = HMAC-SHA256(secret, ts + "GET"  + path + "?" + queryString)
 *   POST → X-CH-SIGN = HMAC-SHA256(secret, ts + "POST" + path + jsonBody)
 *   Headers: X-CH-APIKEY, X-CH-SIGN, X-CH-TS (unix ms)
 *
 * Contract field: "contractName" (NOT "symbol"). Bitrue symbol format: "E-XAUT-USDT".
 *
 * Order quantity:
 *   MARKET orders → "amount"  (USDT notional value, min $5)
 *   LIMIT orders  → "volume"  (integer contracts; 1 contract = multiplier × underlying)
 *   CLOSE orders  → "volume"  (integer contracts to close)
 *
 * positionType: 1 = long, 2 = short  (account must be in one-way mode)
 * open:         "OPEN" = open new position, "CLOSE" = reduce/close position
 *
 * Cancel: POST /fapi/v1/cancel  (DELETE is not supported)
 */

import crypto from "crypto";

const FUTURES_BASE = "https://fapi.bitrue.com";

function hmacSha256(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

export class BitrueClient {
  private apiKey: string;
  private secretKey: string;

  constructor(apiKey: string, secretKey: string) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  // ── Signing ─────────────────────────────────────────────────────────────────

  private getHeaders(method: "GET" | "POST", path: string, payload: string): Record<string, string> {
    const ts = String(Date.now());
    const signMsg = `${ts}${method}${path}${payload}`;
    return {
      "X-CH-APIKEY": this.apiKey,
      "X-CH-SIGN":   hmacSha256(this.secretKey, signMsg),
      "X-CH-TS":     ts,
      "Content-Type": "application/json",
    };
  }

  // ── Transport ────────────────────────────────────────────────────────────────

  private async get(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const qs = Object.keys(params).length
      ? "?" + new URLSearchParams(params as Record<string, string>).toString()
      : "";
    const headers = this.getHeaders("GET", path, qs); // qs includes "?" prefix
    const res = await fetch(`${FUTURES_BASE}${path}${qs}`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitrue GET ${path} HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  private async post(path: string, body: Record<string, any> = {}): Promise<any> {
    const bodyStr = JSON.stringify(body);
    const headers = this.getHeaders("POST", path, bodyStr);
    const res = await fetch(`${FUTURES_BASE}${path}`, {
      method: "POST",
      headers,
      body: bodyStr,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitrue POST ${path} HTTP ${res.status}: ${text}`);
    const parsed = JSON.parse(text);
    // Bitrue often returns HTTP 200 with code != 0 for business-logic errors.
    // Check the code field on all POST responses.
    if (parsed?.code !== undefined && parsed.code !== 0) {
      throw new Error(`Bitrue POST ${path} code=${parsed.code}: ${parsed.msg || text}`);
    }
    return parsed;
  }

  // ── Market data (authenticated) ──────────────────────────────────────────────

  /** Last traded price for a contract. Response: { last, high, low, buy, sell, ... } */
  async getTicker(contractName: string): Promise<any> {
    return this.get("/fapi/v1/ticker", { contractName });
  }

  /** Mark/tag price and funding rate. Response: { tagPrice, indexPrice, currentFundRate, ... } */
  async getMarkPrice(contractName: string): Promise<any> {
    return this.get("/fapi/v1/index", { contractName });
  }

  /** List all available contracts and their specs. */
  async getContracts(): Promise<any[]> {
    const res = await this.get("/fapi/v1/contracts");
    return Array.isArray(res) ? res : (res?.data || []);
  }

  // ── Account ──────────────────────────────────────────────────────────────────

  /** Account balances. Response: { account: [{ marginCoin, accountNormal, ... }] } */
  async getAccount(): Promise<any> {
    return this.get("/fapi/v1/account");
  }

  // ── Positions ────────────────────────────────────────────────────────────────

  /**
   * Open positions for a contract.
   * Bitrue may return { positions: [...] } or { data: { positions: [...] } } or { data: [...] }
   * depending on API version — caller should use extractPositions() helper.
   */
  async getPositions(contractName: string): Promise<any> {
    return this.get("/fapi/v1/positions", { contractName });
  }

  /** Normalise getPositions() response into a flat array regardless of nesting shape. */
  static extractPositions(res: any): any[] {
    if (Array.isArray(res))                    return res;
    if (Array.isArray(res?.positions))         return res.positions;
    if (Array.isArray(res?.data?.positions))   return res.data.positions;
    if (Array.isArray(res?.data))              return res.data;
    return [];
  }

  // ── Orders ───────────────────────────────────────────────────────────────────

  /**
   * Place a MARKET order (buy/sell by USDT notional value).
   * amount = USDT to spend (minimum $5).
   * open = "OPEN" to enter, "CLOSE" is NOT used for market — see closePosition().
   */
  async placeMarketOrder(params: {
    contractName: string;
    side: "BUY" | "SELL";
    positionType: 1 | 2;   // 1=long, 2=short
    open: "OPEN";
    amount: number;         // USDT notional value
    leverage: number;
  }): Promise<any> {
    return this.post("/fapi/v2/order", {
      contractName: params.contractName,
      side:         params.side,
      type:         "MARKET",
      open:         params.open,
      positionType: params.positionType,
      amount:       params.amount,
      leverage:     params.leverage,
    });
  }

  /**
   * Place a LIMIT order (buy/sell by integer contract volume).
   * volume = integer number of contracts.
   */
  async placeLimitOrder(params: {
    contractName: string;
    side: "BUY" | "SELL";
    positionType: 1 | 2;
    open: "OPEN" | "CLOSE";
    volume: number;         // integer contracts
    price: string;          // string price
    leverage: number;
  }): Promise<any> {
    return this.post("/fapi/v2/order", {
      contractName: params.contractName,
      side:         params.side,
      type:         "LIMIT",
      open:         params.open,
      positionType: params.positionType,
      volume:       params.volume,
      price:        params.price,
      leverage:     params.leverage,
    });
  }

  /**
   * Close a long position by selling a specific number of contracts at market.
   * Uses volume (contracts) since this is a reduce operation, not an open.
   */
  async closePosition(params: {
    contractName: string;
    positionType: 1 | 2;
    volume: number;         // integer contracts to close
    leverage: number;
  }): Promise<any> {
    return this.post("/fapi/v2/order", {
      contractName: params.contractName,
      side:         "SELL",
      type:         "MARKET",
      open:         "CLOSE",
      positionType: params.positionType,
      volume:       params.volume,
      leverage:     params.leverage,
    });
  }

  /**
   * Cancel a single order by orderId.
   * Note: DELETE method is not supported on Bitrue futures — cancel uses POST.
   */
  async cancelOrder(contractName: string, orderId: string): Promise<any> {
    return this.post("/fapi/v1/cancel", { contractName, orderId });
  }

  /**
   * Cancel multiple orders by orderId list.
   * Response: { cancelIds: [...], ids: [...], ... }
   */
  async cancelOrders(contractName: string, orderIds: string[]): Promise<any> {
    return this.post("/fapi/v1/batchCancel", { contractName, ids: orderIds });
  }

  /**
   * Set the account leverage for a contract before placing orders.
   * Bitrue requires the order leverage to match the account's configured leverage.
   * Must be called before placeMarketOrder / placeLimitOrder.
   */
  async setLeverage(contractName: string, leverage: number): Promise<any> {
    return this.post("/fapi/v1/leverage", { contractName, leverage });
  }

  /**
   * Switch the margin mode for a contract to ISOLATION (isolated margin).
   * openType: 1 = isolated, 2 = cross.
   * Call before placing any orders — returns without throwing if already isolated.
   */
  async setMarginType(contractName: string): Promise<void> {
    try {
      await this.post("/fapi/v1/modifyIsolation", { contractName, openType: 1 });
    } catch (e: any) {
      // "already in isolation mode" or similar is not a fatal error
      if (/already|same|isolation/i.test(e.message)) return;
      console.warn(`[Bitrue] setMarginType isolation failed (continuing): ${e.message}`);
    }
  }

  /**
   * Return available USDT balance for futures trading.
   * Tries several field paths Bitrue uses across API versions.
   */
  async getAvailableUsdt(): Promise<number> {
    const res  = await this.getAccount();
    const list: any[] = Array.isArray(res?.account) ? res.account
                       : Array.isArray(res?.data?.account) ? res.data.account
                       : Array.isArray(res?.data) ? res.data : [];
    const acct = list.find((a: any) =>
      (a.marginCoin || a.asset || "").toUpperCase() === "USDT"
    ) || list[0] || {};
    return parseFloat(
      acct.accountNormal ?? acct.available ?? acct.balance ?? acct.avail ?? "0"
    );
  }

  /** All open orders for a contract. Response: { code, msg, data: [...] } */
  async getOpenOrders(contractName: string): Promise<any> {
    return this.get("/fapi/v2/openOrders", { contractName });
  }

  /** Single order status. Response: { code, msg, data: { orderId, status, ... } } */
  async getOrder(contractName: string, orderId: string): Promise<any> {
    return this.get("/fapi/v2/order", { contractName, orderId });
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let clientInstance: BitrueClient | null = null;

export function getBitrueClient(): BitrueClient | null {
  if (clientInstance) return clientInstance;
  const apiKey    = process.env.BITRUE_API_KEY;
  const secretKey = process.env.BITRUE_SECRET_KEY;
  if (!apiKey || !secretKey) return null;
  clientInstance = new BitrueClient(apiKey, secretKey);
  return clientInstance;
}

export function resetBitrueClient(): void {
  clientInstance = null;
}
