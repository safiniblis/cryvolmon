import crypto from "crypto";

const BASE_URL = "https://fapi.bitunix.com";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function sign(
  nonce: string,
  timestamp: string,
  apiKey: string,
  secretKey: string,
  queryParams: string,
  body: string
): string {
  const digestInput = nonce + timestamp + apiKey + queryParams + body;
  const digest = sha256Hex(digestInput);
  return sha256Hex(digest + secretKey);
}

function buildQueryParamString(params: Record<string, any>): string {
  const sorted = Object.keys(params).sort();
  return sorted.map((k) => k + String(params[k])).join("");
}

export class BitunixClient {
  private apiKey: string;
  private secretKey: string;

  constructor(apiKey: string, secretKey: string) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  private getHeaders(queryParams: string, body: string) {
    const nonce = generateNonce();
    const timestamp = String(Date.now());
    const signature = sign(nonce, timestamp, this.apiKey, this.secretKey, queryParams, body);

    return {
      "api-key": this.apiKey,
      nonce,
      timestamp,
      sign: signature,
      "Content-Type": "application/json",
    };
  }

  async get(path: string, params: Record<string, any> = {}): Promise<any> {
    const queryParamString = buildQueryParamString(params);
    const queryString = Object.keys(params).length > 0
      ? "?" + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
      : "";

    const headers = this.getHeaders(queryParamString, "");
    const url = `${BASE_URL}${path}${queryString}`;

    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bitunix GET ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async post(path: string, body: Record<string, any> = {}): Promise<any> {
    const bodyStr = JSON.stringify(body);
    const headers = this.getHeaders("", bodyStr);
    const url = `${BASE_URL}${path}`;

    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bitunix POST ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  // === Market Data (Public) ===
  async getTickers(symbols?: string) {
    const params: Record<string, any> = {};
    if (symbols) params.symbols = symbols;
    return this.get("/api/v1/futures/market/tickers", params);
  }

  async getTradingPairs(symbols?: string) {
    const params: Record<string, any> = {};
    if (symbols) params.symbols = symbols;
    return this.get("/api/v1/futures/market/trading_pairs", params);
  }

  async getDepth(symbol: string, level: number = 5) {
    return this.get("/api/v1/futures/market/depth", { symbol, level: String(level) });
  }

  async getKlines(symbol: string, interval: string = "60", limit: number = 100) {
    return this.get("/api/v1/futures/market/kline", { symbol, interval, limit: String(limit) });
  }

  // === Account (Private) ===
  async getAccount(marginCoin: string = "USDT") {
    return this.get("/api/v1/futures/account", { marginCoin });
  }

  // === Positions (Private) ===
  async getPositions(symbol?: string) {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol;
    return this.get("/api/v1/futures/position/get_pending_positions", params);
  }

  async getHistoryPositions(symbol?: string, startTime?: number) {
    const params: Record<string, any> = { limit: 100 };
    if (symbol) params.symbol = symbol;
    if (startTime) params.startTime = startTime;
    return this.get("/api/v1/futures/position/get_history_positions", params);
  }

  // === Leverage & Margin Mode (Private) ===
  async setLeverage(symbol: string, leverage: number, marginCoin: string = "USDT") {
    return this.post("/api/v1/futures/account/change_leverage", { symbol, leverage, marginCoin });
  }

  async setMarginMode(symbol: string, marginMode: "ISOLATION" | "CROSS", marginCoin: string = "USDT") {
    return this.post("/api/v1/futures/account/change_margin_mode", { marginMode, symbol, marginCoin });
  }

  async getLeverageMarginMode(symbol: string, marginCoin: string = "USDT") {
    return this.get("/api/v1/futures/account/get_leverage_margin_mode", { symbol, marginCoin });
  }

  // === Orders (Private) ===
  async placeOrder(params: {
    symbol: string;
    qty: string;
    side: "BUY" | "SELL";
    tradeSide: "OPEN" | "CLOSE";
    orderType: "MARKET" | "LIMIT";
    price?: string;
    effect?: string;
    clientId?: string;
    positionId?: string;
    reduceOnly?: boolean;
  }) {
    const body: Record<string, any> = {
      symbol: params.symbol,
      qty: params.qty,
      side: params.side,
      tradeSide: params.tradeSide,
      orderType: params.orderType,
    };
    if (params.price) body.price = params.price;
    if (params.effect) body.effect = params.effect;
    if (params.clientId) body.clientId = params.clientId;
    if (params.positionId) body.positionId = params.positionId;
    if (params.reduceOnly !== undefined) body.reduceOnly = params.reduceOnly;

    return this.post("/api/v1/futures/trade/place_order", body);
  }

  async cancelOrder(orderId: string, symbol: string) {
    return this.post("/api/v1/futures/trade/cancel_orders", { symbol, orderList: [{ orderId }] });
  }

  async cancelAllOrders(symbol: string) {
    return this.post("/api/v1/futures/trade/cancel_all_orders", { symbol });
  }

  async getOpenOrders(symbol?: string) {
    const params: Record<string, any> = { pageNum: 1, pageSize: 100 };
    if (symbol) params.symbol = symbol;
    return this.get("/api/v1/futures/trade/get_pending_orders", params);
  }

  async getOrderHistory(symbol?: string) {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol;
    return this.get("/api/v1/futures/trade/get_history_orders", params);
  }

  async placeTpslOrder(params: {
    symbol: string;
    positionId: string;
    tpPrice?: string;
    tpStopType?: string;
    tpOrderType?: string;
    tpOrderPrice?: string;
    tpQty?: string;
    slPrice?: string;
    slStopType?: string;
    slOrderType?: string;
    slOrderPrice?: string;
    slQty?: string;
  }) {
    return this.post("/api/v1/futures/tpsl/place_order", params);
  }

  async getPendingTpslOrders(symbol?: string) {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol;
    params.limit = "100";
    return this.get("/api/v1/futures/tpsl/get_pending_orders", params);
  }

  async placePositionTpsl(params: {
    symbol: string;
    positionId: string;
    tpPrice?: string;
    tpStopType?: string;
    slPrice?: string;
    slStopType?: string;
  }) {
    return this.post("/api/v1/futures/tpsl/position/place_order", params);
  }

  async cancelTpslOrder(symbol: string, orderId: string) {
    return this.post("/api/v1/futures/tpsl/cancel_order", { symbol, orderId });
  }

  async flashClose(symbol: string, positionId?: string) {
    if (positionId) {
      return this.post("/api/v1/futures/trade/flash_close_position", { positionId });
    }
    const posRes = await this.getPositions(symbol);
    if (posRes?.code === 0 && Array.isArray(posRes.data)) {
      const results = [];
      for (const pos of posRes.data) {
        const r = await this.post("/api/v1/futures/trade/flash_close_position", { positionId: pos.positionId });
        results.push(r);
      }
      return { code: 0, data: results, msg: `Closed ${results.length} positions` };
    }
    return { code: -1, data: null, msg: "No positions found" };
  }
}

let clientInstance: BitunixClient | null = null;

export function getBitunixClient(): BitunixClient | null {
  if (clientInstance) return clientInstance;

  const apiKey = process.env.BITUNIX_API_KEY;
  const secretKey = process.env.BITUNIX_SECRET_KEY;

  if (!apiKey || !secretKey) {
    return null;
  }

  clientInstance = new BitunixClient(apiKey, secretKey);
  return clientInstance;
}

export function resetBitunixClient() {
  clientInstance = null;
}
