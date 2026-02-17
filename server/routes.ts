import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { getBitunixClient } from "./bitunix";
import { startStrategyEngine, stopStrategyEngine, runStrategyCycle } from "./strategy-engine";
import { insertStrategySchema } from "@shared/schema";
import { z } from "zod";

async function fetchTop20CryptoData() {
  try {
    const marketsResponse = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=true"
    );

    if (!marketsResponse.ok) {
      if (marketsResponse.status === 429) {
        console.warn("CoinGecko rate limit hit. Using cached data if available.");
        return [];
      }
      throw new Error(`CoinGecko API error: ${marketsResponse.statusText}`);
    }

    const markets = await marketsResponse.json();
    const results = [];

    for (const coin of markets) {
      const prices: number[] = coin.sparkline_in_7d?.price || [];
      let swings = 0;
      const recentPrices = prices.slice(-25);
      const now = Date.now();
      const priceHistory = recentPrices.map((price, index) => {
        const hoursAgo = recentPrices.length - 1 - index;
        return { timestamp: now - (hoursAgo * 60 * 60 * 1000), price };
      });

      for (let i = 1; i < recentPrices.length; i++) {
        const prevPrice = recentPrices[i - 1];
        const currPrice = recentPrices[i];
        if (!prevPrice) continue;
        const change = Math.abs((currPrice - prevPrice) / prevPrice);
        if (change >= 0.01) swings++;
      }

      results.push({
        slug: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        marketCap: coin.market_cap,
        currentPrice: coin.current_price,
        hourlySwings: swings,
        priceHistory,
      });
    }
    return results;
  } catch (error) {
    console.error("Error fetching crypto data:", error);
    throw error;
  }
}

async function syncBitunixAccount() {
  const client = getBitunixClient();
  if (!client) return;

  try {
    const accountRes = await client.getAccount();
    if (accountRes?.data) {
      const balances = Array.isArray(accountRes.data) ? accountRes.data : [accountRes.data];
      const mapped = balances.map((b: any) => ({
        currency: b.coin || b.currency || "USDT",
        available: parseFloat(b.available || b.equity || "0"),
        frozen: parseFloat(b.frozen || b.locked || "0"),
        total: parseFloat(b.total || b.equity || "0"),
      }));
      await storage.updateAccountBalances(mapped);
    }
  } catch (e) {
    console.error("Failed to sync account:", e);
  }

  try {
    const posRes = await client.getPositions();
    if (posRes?.data) {
      const posList = Array.isArray(posRes.data) ? posRes.data : [];
      const mapped = posList.map((p: any) => ({
        symbol: p.symbol,
        side: p.side || (parseFloat(p.qty || "0") > 0 ? "LONG" : "SHORT"),
        quantity: Math.abs(parseFloat(p.qty || p.positionSize || "0")),
        entryPrice: parseFloat(p.avgOpenPrice || p.entryPrice || "0"),
        markPrice: parseFloat(p.markPrice || "0"),
        unrealizedPnl: parseFloat(p.unrealizedPnl || p.pnl || "0"),
        leverage: parseInt(p.leverage || "1"),
      }));
      await storage.updatePositions(mapped);
    }
  } catch (e) {
    console.error("Failed to sync positions:", e);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // === Volatility Dashboard ===
  fetchTop20CryptoData().then(async (data) => {
    if (data.length > 0) {
      console.log(`Fetched data for ${data.length} coins`);
      await storage.updateCryptoStats(data);
    }
  }).catch(console.error);

  app.get("/api/stats", async (req, res) => {
    const stats = await storage.getCryptoStats();
    res.json(stats.sort((a, b) => (b.hourlySwings || 0) - (a.hourlySwings || 0)));
  });

  app.post("/api/stats/refresh", async (req, res) => {
    try {
      const data = await fetchTop20CryptoData();
      if (data.length > 0) {
        await storage.updateCryptoStats(data);
        res.json({ message: "Data refreshed successfully" });
      } else {
        res.status(429).json({ message: "Rate limit hit, please try again later" });
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to refresh data" });
    }
  });

  // === API Connection Status ===
  app.get("/api/connection", async (req, res) => {
    const client = getBitunixClient();
    if (!client) {
      return res.json({ connected: false, message: "API keys not configured" });
    }
    try {
      const result = await client.getTickers("BTCUSDT");
      res.json({ connected: true, message: "Connected to Bitunix" });
    } catch (e: any) {
      res.json({ connected: false, message: e.message });
    }
  });

  // === Account & Positions ===
  app.get("/api/account", async (req, res) => {
    const client = getBitunixClient();
    if (!client) {
      return res.json({ balances: [], positions: [], connected: false });
    }
    await syncBitunixAccount();
    const balances = await storage.getAccountBalances();
    const pos = await storage.getPositions();
    res.json({ balances, positions: pos, connected: true });
  });

  // === Strategies ===
  app.get("/api/strategies", async (req, res) => {
    const strats = await storage.getStrategies();
    res.json(strats);
  });

  app.post("/api/strategies", async (req, res) => {
    try {
      const input = insertStrategySchema.parse(req.body);
      const created = await storage.createStrategy(input);
      res.status(201).json(created);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ message: e.errors[0].message });
      }
      res.status(500).json({ message: "Failed to create strategy" });
    }
  });

  app.patch("/api/strategies/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const patchSchema = z.object({
      name: z.string().optional(),
      status: z.enum(["running", "stopped", "error"]).optional(),
      config: z.record(z.any()).optional(),
      side: z.enum(["LONG", "SHORT", "BOTH"]).optional(),
    });
    try {
      const updates = patchSchema.parse(req.body);
      const updated = await storage.updateStrategy(id, updates);
      if (!updated) return res.status(404).json({ message: "Strategy not found" });
      res.json(updated);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ message: e.errors[0].message });
      }
      res.status(500).json({ message: "Failed to update strategy" });
    }
  });

  app.delete("/api/strategies/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    await storage.deleteStrategy(id);
    res.status(204).send();
  });

  app.post("/api/strategies/:id/start", async (req, res) => {
    const id = parseInt(req.params.id);
    const client = getBitunixClient();
    if (!client) {
      return res.status(400).json({ message: "API keys not configured. Add your Bitunix API Key and Secret Key first." });
    }
    const updated = await storage.updateStrategy(id, { status: "running" });
    if (!updated) return res.status(404).json({ message: "Strategy not found" });
    startStrategyEngine();
    res.json(updated);
  });

  app.post("/api/strategies/:id/stop", async (req, res) => {
    const id = parseInt(req.params.id);
    const updated = await storage.updateStrategy(id, { status: "stopped" });
    if (!updated) return res.status(404).json({ message: "Strategy not found" });

    const running = await storage.getStrategiesByStatus("running");
    if (running.length === 0) stopStrategyEngine();
    res.json(updated);
  });

  // === Trade Logs ===
  app.get("/api/trades", async (req, res) => {
    const strategyId = req.query.strategyId ? parseInt(req.query.strategyId as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const logs = await storage.getTradeLogs(strategyId, limit);
    res.json(logs);
  });

  // === Manual Trade ===
  app.post("/api/trade", async (req, res) => {
    const client = getBitunixClient();
    if (!client) {
      return res.status(400).json({ message: "API keys not configured" });
    }
    const tradeSchema = z.object({
      symbol: z.string().min(1),
      side: z.enum(["BUY", "SELL"]),
      quantity: z.number().positive(),
      orderType: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
      price: z.number().positive().optional(),
      leverage: z.number().int().min(1).max(125).default(1),
    });
    try {
      const { symbol, side, quantity, orderType, price, leverage } = tradeSchema.parse(req.body);
      const result = await client.placeOrder({
        symbol,
        qty: String(quantity),
        side,
        tradeSide: "OPEN",
        orderType: orderType || "MARKET",
        price: price ? String(price) : undefined,
        leverage: leverage || 1,
        positionType: 2,
      });

      const log = await storage.createTradeLog({
        symbol,
        side,
        orderType: orderType || "MARKET",
        quantity,
        price: price || null,
        status: result?.code === "0" ? "filled" : "error",
        orderId: result?.data?.orderId || null,
        pnl: null,
        errorMsg: result?.code !== "0" ? (result?.msg || "Unknown error") : null,
      });

      res.json({ order: result, trade: log });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // === Market Data (live from Bitunix) ===
  app.get("/api/market/:symbol", async (req, res) => {
    const client = getBitunixClient();
    if (!client) {
      return res.status(400).json({ message: "API keys not configured" });
    }
    try {
      const ticker = await client.getTickers(req.params.symbol);
      res.json(ticker?.data || []);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  return httpServer;
}
