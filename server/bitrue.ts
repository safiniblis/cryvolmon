import crypto from "crypto";

const FUTURES_BASE = "https://fapi.bitrue.com";
const SPOT_BASE = "https://www.bitrue.com";

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

  // Auth headers — payload is the raw query string (GET) or JSON body string (POST/DELETE)
  private authHeaders(payload: string): Record<string, string> {
    return {
      "X-CH-APIKEY": this.apiKey,
      "X-CH-SIGN": hmacSha256(this.secretKey, payload),
      "X-CH-TS": String(Date.now()),
      "Content-Type": "application/json",
    };
  }

  private async futuresGet(path: string, params: Record<string, any> = {}): Promise<any> {
    const qs = Object.keys(params).length
      ? "?" + new URLSearchParams(params as any).toString()
      : "";
    const payload = qs.slice(1); // strip leading "?"
    const res = await fetch(`${FUTURES_BASE}${path}${qs}`, {
      headers: this.authHeaders(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitrue GET ${path} ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  private async futuresPost(path: string, body: Record<string, any> = {}): Promise<any> {
    const bodyStr = JSON.stringify(body);
    const res = await fetch(`${FUTURES_BASE}${path}`, {
      method: "POST",
      headers: this.authHeaders(bodyStr),
      body: bodyStr,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitrue POST ${path} ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  private async futuresDelete(path: string, params: Record<string, any> = {}): Promise<any> {
    const qs = Object.keys(params).length
      ? "?" + new URLSearchParams(params as any).toString()
      : "";
    const payload = qs.slice(1);
    const res = await fetch(`${FUTURES_BASE}${path}${qs}`, {
      method: "DELETE",
      headers: this.authHeaders(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitrue DELETE ${path} ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  async exchangeInfo(): Promise<any> {
    const res = await fetch(`${FUTURES_BASE}/fapi/v1/exchangeInfo`);
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitrue exchangeInfo ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  async getTicker(symbol: string): Promise<any> {
    const res = await fetch(`${FUTURES_BASE}/fapi/v1/ticker/price?symbol=${symbol}`);
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitrue ticker ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  async getSpotTicker(symbol: string): Promise<any> {
    // Fallback: spot ticker if futures ticker fails
    const res = await fetch(`${SPOT_BASE}/api/v1/ticker/price?symbol=${symbol}`);
    const text = await res.text();
    if (!res.ok) throw new Error(`Bitrue spot ticker ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  async getAccount(): Promise<any> {
    return this.futuresGet("/fapi/v1/account");
  }

  async getPositions(symbol?: string): Promise<any> {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol;
    return this.futuresGet("/fapi/v1/positionRisk", params);
  }

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    return this.futuresPost("/fapi/v1/leverage", { symbol, leverage });
  }

  async placeOrder(params: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    quantity: string;
    price?: string;
    positionSide?: "LONG" | "SHORT" | "BOTH";
    timeInForce?: string;
    reduceOnly?: boolean;
    newClientOrderId?: string;
  }): Promise<any> {
    const body: Record<string, any> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
    };
    if (params.price !== undefined) body.price = params.price;
    if (params.positionSide) body.positionSide = params.positionSide;
    if (params.timeInForce) body.timeInForce = params.timeInForce;
    if (params.reduceOnly !== undefined) body.reduceOnly = params.reduceOnly;
    if (params.newClientOrderId) body.newClientOrderId = params.newClientOrderId;
    return this.futuresPost("/fapi/v1/order", body);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<any> {
    return this.futuresDelete("/fapi/v1/order", { symbol, orderId });
  }

  async cancelAllOrders(symbol: string): Promise<any> {
    return this.futuresDelete("/fapi/v1/allOpenOrders", { symbol });
  }

  async getOpenOrders(symbol?: string): Promise<any> {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol;
    return this.futuresGet("/fapi/v1/openOrders", params);
  }

  async getOrder(symbol: string, orderId: string): Promise<any> {
    return this.futuresGet("/fapi/v1/order", { symbol, orderId });
  }

  // Probe futures exchange for XAU pairs — fire-and-forget on startup
  async probeFutures(): Promise<string[]> {
    try {
      const info = await this.exchangeInfo();
      const symbols: string[] = (info?.symbols || [])
        .filter((s: any) =>
          (s.baseAsset || "").includes("XAU") ||
          (s.symbol || "").includes("XAU")
        )
        .map((s: any) => s.symbol);
      if (symbols.length) {
        console.log(`[Bitrue Futures] XAU pairs available: ${symbols.join(", ")}`);
      } else {
        console.log("[Bitrue Futures] No XAU pairs found in exchangeInfo");
      }
      return symbols;
    } catch (e: any) {
      console.log(`[Bitrue Futures] Probe failed (may need auth on exchangeInfo): ${e.message}`);
      return [];
    }
  }
}

let clientInstance: BitrueClient | null = null;

export function getBitrueClient(): BitrueClient | null {
  if (clientInstance) return clientInstance;
  const apiKey = process.env.BITRUE_API_KEY;
  const secretKey = process.env.BITRUE_SECRET_KEY;
  if (!apiKey || !secretKey) return null;
  clientInstance = new BitrueClient(apiKey, secretKey);
  return clientInstance;
}

export function resetBitrueClient() {
  clientInstance = null;
}
