/**
 * Exchange abstraction layer.
 *
 * Instead of a fully normalised adapter (which would require rewriting
 * every response-parse in strategy-engine.ts), this module exports
 * `resolveClient(exchange)` which returns an object whose method
 * signatures AND response shapes match BitunixClient.
 *
 * For Bitunix the real client is returned as-is.
 * For Bitrue a thin wrapper translates call/response to the
 * Bitunix envelope shape `{ code: 0, data: …, msg: "" }`.
 *
 * This lets strategy-engine.ts switch `getBitunixClient()` →
 * `resolveClient(strategyExchange)` with zero other changes.
 */
import { getBitunixClient } from "./bitunix";

export type ExchangeName = "bitunix" | "bitrue";

/** Resolve the exchange client for the given name. */
export function resolveClient(exchange?: ExchangeName): any {
  const name = exchange || "bitunix";
  if (name === "bitrue") return getBitrueAsBitunix();
  return getBitunixClient();
}

// ─── Bitrue → Bitunix adapter ──────────────────────────────────────────────

let _bitrueProxy: any = null;

function getBitrueAsBitunix(): any {
  if (_bitrueProxy) return _bitrueProxy;

  // Lazy-import so bitunix.ts isn't loaded when only Bitrue is needed.
  const { getBitrueClient } = require("./bitrue") as typeof import("./bitrue");
  const real = getBitrueClient();
  if (!real) return null;

  _bitrueProxy = {
    _real: real,

    // ── Market data ────────────────────────────────────────────────────────
    async getTickers(symbol?: string) {
      if (!symbol) return { code: 0, data: [] };
      const contractName = toBitrue(symbol);
      const res = await real.getTicker(contractName);
      const t = res?.data || res;
      if (!t) return { code: 0, data: [] };
      return {
        code: 0,
        data: [{
          symbol,
          lastPrice: String(t.lastPrice || t.last || t.price || "0"),
          high24h: String(t.high24h || t.high || "0"),
          low24h: String(t.low24h || t.low || "0"),
          volume24h: String(t.volume24h || t.volume || t.turnover || "0"),
          change24h: String(t.change24h || t.priceChangePercent || t.changePercent || "0"),
        }],
      };
    },

    async getTradingPairs(_symbol?: string) {
      const contracts = await real.getContracts();
      const pairs = (Array.isArray(contracts) ? contracts : [])
        .filter((c: any) => (c.contractName || "").includes("USDT"))
        .map((c: any) => ({ symbol: fromBitrue(c.contractName) }));
      return { code: 0, data: pairs };
    },

    async getDepth(_symbol: string, _level?: number) {
      return { code: 0, data: { bids: [], asks: [] } };
    },

    // ── Account ────────────────────────────────────────────────────────────
    async getAccount(_marginCoin?: string) {
      const res = await real.getAccount();
      const d = res?.data || res || {};
      return {
        code: 0,
        data: {
          available: String(d.accountNormal ?? d.available ?? d.balance ?? "0"),
          frozen: String(d.accountLock ?? d.frozen ?? d.lock ?? "0"),
          margin: String(d.accountNormal ?? d.available ?? d.balance ?? "0"),
        },
      };
    },

    async getPositions(symbol?: string) {
      const contractName = symbol ? toBitrue(symbol) : "";
      const res = await real.getPositions(contractName);
      const list = (real.constructor as any).extractPositions(res);
      const mapped = list.map((p: any) => ({
        symbol: fromBitrue(p.contractName || contractName || ""),
        side: p.positionType === 1 ? "BUY" : "SELL",
        qty: String(p.volume || p.holdVol || p.qty || p.openVol || "0"),
        avgOpenPrice: String(p.avgOpenPrice || p.avgPrice || p.openPrice || "0"),
        entryPrice: String(p.avgOpenPrice || p.avgPrice || p.openPrice || "0"),
        avgPrice: String(p.avgOpenPrice || p.avgPrice || p.openPrice || "0"),
        markPrice: String(p.markPrice || p.indexPrice || "0"),
        unrealizedPNL: String(p.unrealizedPNL || "0"),
        leverage: String(p.leverage || "1"),
        positionId: String(p.positionId || ""),
        positionType: p.positionType,
      }));
      return { code: 0, data: mapped };
    },

    // ── Leverage / Margin ──────────────────────────────────────────────────
    async setLeverage(contractNameOrSymbol: string, leverage: number) {
      const cn = toBitrue(contractNameOrSymbol);
      await real.setLeverage(cn, leverage);
      return { code: 0, msg: "ok" };
    },

    async setMarginMode(symbol: string, _mode: string) {
      const cn = toBitrue(symbol);
      await real.setMarginType(cn);
      return { code: 0, msg: "ok" };
    },

    async getLeverageMarginMode(symbol: string) {
      return { code: 0, data: { leverage: "10", marginMode: "ISOLATION" } };
    },

    // ── Orders ─────────────────────────────────────────────────────────────
    async placeOrder(params: {
      symbol: string;
      qty: string;
      side: "BUY" | "SELL";
      tradeSide: "OPEN" | "CLOSE";
      orderType: "MARKET" | "LIMIT";
      price?: string;
      effect?: string;
      positionId?: string;
      reduceOnly?: boolean;
    }) {
      const cn = toBitrue(params.symbol);
      const positionType: 1 | 2 = params.side === "BUY" ? 1 : 2;
      const leverage = 10; // default; caller should setLeverage first

      if (params.orderType === "MARKET") {
        const amount = parseFloat(params.qty); // treat as USDT notional
        const res = await real.placeMarketOrder({
          contractName: cn, side: params.side, positionType,
          open: (params.tradeSide === "OPEN" ? "OPEN" : "CLOSE") as "OPEN",
          amount, leverage,
        });
        return { code: 0, data: { orderId: String(res?.data?.orderId || res?.orderId || "") }, msg: "" };
      } else {
        const volume = Math.max(1, Math.round(parseFloat(params.qty))); // integer contracts
        const res = await real.placeLimitOrder({
          contractName: cn, side: params.side, positionType,
          open: params.tradeSide === "OPEN" ? "OPEN" : "CLOSE",
          volume, price: params.price || "0", leverage,
        });
        return { code: 0, data: { orderId: String(res?.data?.orderId || res?.orderId || "") }, msg: "" };
      }
    },

    async cancelOrder(orderId: string, symbol: string) {
      const cn = toBitrue(symbol);
      await real.cancelOrder(cn, orderId);
      return { code: 0 };
    },

    async cancelAllOrders(symbol: string) {
      const cn = toBitrue(symbol);
      const openRes = await _bitrueProxy.getOpenOrders(symbol);
      const orders = openRes?.data || [];
      if (orders.length > 0) {
        await real.cancelOrders(cn, orders.map((o: any) => o.orderId));
      }
      return { code: 0 };
    },

    async getOpenOrders(symbol?: string) {
      const cn = symbol ? toBitrue(symbol) : undefined;
      const res = cn ? await real.getOpenOrders(cn) : { data: [] };
      const list = res?.data || res || [];
      const mapped = (Array.isArray(list) ? list : []).map((o: any) => ({
        orderId: String(o.orderId || o.id || ""),
        symbol: fromBitrue(o.contractName || cn || ""),
        side: o.side || "",
        price: String(o.price || "0"),
        qty: String(o.volume || o.qty || "0"),
        orderType: o.type || "",
        type: o.type || "",
        status: o.status || "",
        tradeSide: o.open || "",
        updateTime: o.updateTime || o.ctime,
      }));
      return { code: 0, data: mapped };
    },

    async getOrderHistory(symbol?: string) {
      return { code: 0, data: [] };
    },

    // ── TP/SL (Bitrue has none — stub) ────────────────────────────────────
    async getPendingTpslOrders(_symbol: string) {
      return { code: 0, data: { orderList: [] } };
    },

    async placeTpslOrder(_params: any) {
      console.warn("[Bitrue] TP/SL not supported natively; use limit orders");
      return { code: -1, msg: "TP/SL not supported on Bitrue" };
    },

    async cancelTpslOrder(_symbol: string, _orderId: string) {
      return { code: 0 };
    },

    // ── Flash close ────────────────────────────────────────────────────────
    async flashClose(symbol: string, positionId?: string) {
      const cn = toBitrue(symbol);
      const posRes = await _bitrueProxy.getPositions(symbol);
      const positions = posRes?.data || [];
      for (const pos of positions) {
        if (parseFloat(pos.qty || "0") > 0 && (!positionId || pos.positionId === positionId)) {
          const positionType: 1 | 2 = pos.side === "BUY" ? 1 : 2;
          const volume = Math.ceil(parseFloat(pos.qty));
          try {
            await real.closePosition({ contractName: cn, positionType, volume, leverage: parseInt(pos.leverage || "10") });
          } catch (e: any) {
            console.error(`[Bitrue] flashClose error:`, e.message);
          }
        }
      }
      return { code: 0 };
    },
  };

  return _bitrueProxy;
}

// ─── Symbol conversion helpers ──────────────────────────────────────────────

/** `BTCUSDT` → `E-BTC-USDT` (Bitrue native) */
function toBitrue(symbol: string): string {
  const base = symbol.replace(/USDT$/i, "");
  return `E-${base}-USDT`;
}

/** `E-BTC-USDT` → `BTCUSDT` (engine convention) */
function fromBitrue(contractName: string): string {
  const m = contractName.match(/^E-(.+)-USDT$/i);
  return m ? `${m[1]}USDT` : contractName;
}
