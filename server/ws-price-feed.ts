import WebSocket from "ws";
import crypto from "crypto";

const WS_URL = "wss://openapi.bitunix.com:443/ws-api/v1";

type PriceCallback = (symbol: string, price: number, timestamp: number) => void;

interface TickerMessage {
  ch: string;
  symbol: string;
  data: {
    lastPrice?: string;
    markPrice?: string;
    ts?: number;
  };
}

class BitunixPriceFeed {
  private ws: WebSocket | null = null;
  private symbols: Set<string> = new Set();
  private callbacks: PriceCallback[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 50;
  private lastPrices: Map<string, number> = new Map();

  onPrice(cb: PriceCallback) {
    this.callbacks.push(cb);
  }

  getLastPrice(symbol: string): number | undefined {
    return this.lastPrices.get(symbol);
  }

  subscribe(symbol: string) {
    this.symbols.add(symbol);
    if (this.connected && this.ws) {
      this.sendSubscription(symbol);
    }
  }

  unsubscribe(symbol: string) {
    this.symbols.delete(symbol);
    if (this.connected && this.ws) {
      try {
        this.ws.send(JSON.stringify({
          op: "unsubscribe",
          args: [{ symbol, ch: "market_tickers" }],
        }));
      } catch {}
    }
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    console.log(`[WS] Connecting to Bitunix WebSocket...`);
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log(`[WS] Connected. Subscribing to ${this.symbols.size} symbols...`);

      for (const symbol of this.symbols) {
        this.sendSubscription(symbol);
      }

      this.startPing();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const raw = data.toString();
        if (raw === "pong") return;

        const msg = JSON.parse(raw);

        if (msg.ch === "market_tickers" && msg.data) {
          const symbol = msg.symbol || msg.data?.symbol;
          const lastPrice = parseFloat(msg.data.lastPrice || msg.data.last || "0");
          if (symbol && lastPrice > 0) {
            this.lastPrices.set(symbol, lastPrice);
            const ts = msg.data.ts || Date.now();
            for (const cb of this.callbacks) {
              try {
                cb(symbol, lastPrice, ts);
              } catch (e) {
                console.error("[WS] Callback error:", e);
              }
            }
          }
        }
      } catch {}
    });

    this.ws.on("error", (err) => {
      console.error("[WS] Error:", err.message);
    });

    this.ws.on("close", (code, reason) => {
      this.connected = false;
      this.stopPing();
      console.log(`[WS] Disconnected (code=${code}). Will reconnect...`);
      this.scheduleReconnect();
    });
  }

  private sendSubscription(symbol: string) {
    if (!this.ws || !this.connected) return;
    try {
      this.ws.send(JSON.stringify({
        op: "subscribe",
        args: [{ symbol, ch: "market_tickers" }],
      }));
    } catch (e: any) {
      console.error(`[WS] Subscribe error for ${symbol}:`, e.message);
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.connected) {
        try {
          this.ws.send("ping");
        } catch {}
      }
    }, 15_000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[WS] Max reconnect attempts reached. Stopping.");
      return;
    }

    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    console.log(`[WS] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  disconnect() {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSubscribedSymbols(): string[] {
    return Array.from(this.symbols);
  }
}

export const priceFeed = new BitunixPriceFeed();
