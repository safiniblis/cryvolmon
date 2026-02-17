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
  async getAccount() {
    return this.get("/api/v1/futures/account");
  }

  // === Positions (Private) ===
  async getPositions(symbol?: string) {
    const body: Record<string, any> = {};
    if (symbol) body.symbol = symbol;
    return this.post("/api/v1/futures/position/get_pending_positions", body);
  }

  // === Orders (Private) ===
  async placeOrder(params: {
    symbol: string;
    qty: string;
    side: "BUY" | "SELL";
    tradeSide: "OPEN" | "CLOSE";
    orderType: "MARKET" | "LIMIT";
    price?: string;
    positionType?: number; // 1=cross, 2=isolated
    leverage?: number;
    effect?: string;
    clientId?: string;
  }) {
    const body: Record<string, any> = {
      symbol: params.symbol,
      qty: params.qty,
      side: params.side,
      tradeSide: params.tradeSide,
      orderType: params.orderType,
    };
    if (params.price) body.price = params.price;
    if (params.positionType) body.positionType = params.positionType;
    if (params.leverage) body.leverage = params.leverage;
    if (params.clientId) body.clientId = params.clientId;

    return this.post("/api/v1/futures/order/create", body);
  }

  async cancelOrder(orderId: string, symbol: string) {
    return this.post("/api/v1/futures/order/cancel", { orderId, symbol });
  }

  async getOpenOrders(symbol?: string) {
    const body: Record<string, any> = {};
    if (symbol) body.symbol = symbol;
    return this.post("/api/v1/futures/order/get_pending_orders", body);
  }

  async getOrderHistory(symbol?: string) {
    const body: Record<string, any> = {};
    if (symbol) body.symbol = symbol;
    return this.post("/api/v1/futures/order/get_history_orders", body);
  }

  // === Flash Close (close entire position) ===
  async flashClose(symbol: string, positionId?: string) {
    const body: Record<string, any> = { symbol };
    if (positionId) body.positionId = positionId;
    return this.post("/api/v1/futures/order/flash_close", body);
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
