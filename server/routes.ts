import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { getBitunixClient } from "./bitunix";
import { startStrategyEngine, stopStrategyEngine, runStrategyCycle, calculateOptimizedGrid, simulateGridStrategy, computeVolatilityScores, placeInitialGridBuy, cancelAllGridOrders, getActiveGridOrders } from "./strategy-engine";
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
    console.log("[Bitunix] Account response:", JSON.stringify(accountRes));
    if (accountRes?.code === 0 && accountRes?.data) {
      const balances = Array.isArray(accountRes.data) ? accountRes.data : [accountRes.data];
      const mapped = balances.map((b: any) => ({
        currency: b.marginCoin || b.coin || "USDT",
        available: parseFloat(b.available || "0"),
        frozen: parseFloat(b.frozen || "0"),
        total: parseFloat(b.available || "0") + parseFloat(b.frozen || "0") + parseFloat(b.margin || "0"),
      }));
      await storage.updateAccountBalances(mapped);
    } else if (accountRes?.code !== 0) {
      console.error("[Bitunix] Account error:", accountRes?.msg);
    }
  } catch (e) {
    console.error("Failed to sync account:", e);
  }

  try {
    const posRes = await client.getPositions();
    console.log("[Bitunix] Positions response:", JSON.stringify(posRes));
    if (posRes?.code === 0 && posRes?.data) {
      const posList = Array.isArray(posRes.data) ? posRes.data : [];
      const mapped = posList.map((p: any) => ({
        symbol: p.symbol,
        side: p.side || "LONG",
        quantity: Math.abs(parseFloat(p.qty || "0")),
        entryPrice: parseFloat(p.avgOpenPrice || "0"),
        markPrice: parseFloat(p.markPrice || "0"),
        unrealizedPnl: parseFloat(p.unrealizedPNL || p.unrealizedPnl || "0"),
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

  // === Auto-start strategy engine if there are running strategies ===
  storage.getStrategiesByStatus("running").then((running) => {
    if (running.length > 0) {
      console.log(`[Boot] Found ${running.length} running strategies, starting engine...`);
      startStrategyEngine();
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
    const strategy = await storage.getStrategy(id);
    if (!strategy) return res.status(404).json({ message: "Strategy not found" });

    const updated = await storage.updateStrategy(id, { status: "running" });
    startStrategyEngine();

    let initialBuy = null;
    const config = strategy.config as any;
    if (strategy.type === "grid" && !config?.initialBuyDone) {
      initialBuy = await placeInitialGridBuy({ ...strategy, status: "running" });
    }

    res.json({ ...updated, initialBuy });
  });

  app.post("/api/strategies/:id/stop", async (req, res) => {
    const id = parseInt(req.params.id);
    const strategy = await storage.getStrategy(id);
    if (!strategy) return res.status(404).json({ message: "Strategy not found" });

    if (strategy.type === "grid") {
      await cancelAllGridOrders(id, strategy.symbol);
    }

    const updated = await storage.updateStrategy(id, { status: "stopped" });
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

      try {
        await client.setMarginMode(symbol, "ISOLATION");
      } catch (e: any) { /* may already be set */ }
      try {
        await client.setLeverage(symbol, leverage || 1);
      } catch (e: any) { /* may already be set */ }

      const result = await client.placeOrder({
        symbol,
        qty: String(quantity),
        side,
        tradeSide: "OPEN",
        orderType: orderType || "MARKET",
        price: price ? String(price) : undefined,
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

  // === Grid Calculator ===
  app.post("/api/grid/calculate", async (req, res) => {
    const calcSchema = z.object({
      symbol: z.string().min(1),
      feeRate: z.number().positive().default(0.0006),
    });
    try {
      const { symbol, feeRate } = calcSchema.parse(req.body);

      const client = getBitunixClient();
      let currentPrice: number | null = null;

      if (client) {
        try {
          const result = await client.getTickers(symbol);
          if (result?.data && result.data.length > 0) {
            currentPrice = parseFloat(result.data[0].lastPrice || result.data[0].last || "0");
          }
        } catch (e) {}
      }

      if (!currentPrice) {
        const stats = await storage.getCryptoStats();
        const match = stats.find(s => s.symbol?.toUpperCase() === symbol.replace("USDT", "").toUpperCase());
        if (match) currentPrice = match.currentPrice || 0;
      }

      if (!currentPrice || currentPrice <= 0) {
        return res.status(400).json({ message: `Cannot determine price for ${symbol}` });
      }

      const grid = calculateOptimizedGrid(currentPrice, feeRate);
      res.json({ currentPrice, ...grid });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ message: e.errors[0].message });
      }
      res.status(500).json({ message: "Calculation failed" });
    }
  });

  // === Quick Start (auto-select best pair + create + start) ===
  app.post("/api/strategies/quickstart", async (req, res) => {
    try {
      const { amount = 100 } = req.body;
      const usdtAmount = parseFloat(amount);
      if (isNaN(usdtAmount) || usdtAmount <= 0) {
        return res.status(400).json({ message: "Invalid USDT amount" });
      }

      const client = getBitunixClient();
      if (!client) {
        return res.status(400).json({ message: "API keys not configured. Add your Bitunix API Key and Secret Key first." });
      }

      const stats = await storage.getCryptoStats();
      const scores = computeVolatilityScores(
        stats.map(s => ({
          symbol: s.symbol,
          name: s.name,
          currentPrice: s.currentPrice || 0,
          priceHistory: s.priceHistory as any,
        }))
      );

      let availablePairs = new Set<string>();
      try {
        const pairsRes = await client.getTradingPairs();
        if (pairsRes?.data && Array.isArray(pairsRes.data)) {
          for (const p of pairsRes.data) {
            availablePairs.add(p.symbol || p.pair || "");
          }
        }
      } catch {}

      let bestPair: typeof scores[0] | null = null;
      for (const s of scores) {
        if (availablePairs.size > 0 && !availablePairs.has(s.bitunixSymbol)) continue;
        if (s.riskGauge < 0.5 && s.largeSwingsDown > s.largeSwingsUp) continue;
        bestPair = s;
        break;
      }

      if (!bestPair) {
        bestPair = scores[0] || null;
      }
      if (!bestPair) {
        return res.status(400).json({ message: "No volatility data available. Refresh the dashboard first." });
      }

      const symbol = bestPair.bitunixSymbol;
      const feeRate = 0.0006;
      const grid = calculateOptimizedGrid(bestPair.currentPrice, feeRate);

      const amountPerGrid = Math.max(5, Math.floor(usdtAmount / grid.gridCount));

      if (usdtAmount < 10) {
        return res.status(400).json({ message: "Minimum amount is 10 USDT. Most exchanges require at least $5 per order." });
      }

      const strategy = await storage.createStrategy({
        name: `Auto Grid ${symbol}`,
        type: "grid",
        symbol,
        side: "LONG",
        status: "running",
        config: {
          upperPrice: grid.upperPrice,
          lowerPrice: grid.lowerPrice,
          liquidationPrice: grid.liquidationPrice,
          gridCount: grid.gridCount,
          amountPerGrid,
          leverage: grid.leverage,
          geometric: true,
          gridRatio: grid.gridRatio,
          gapGrowthBelow: grid.gapGrowthBelow,
          gapShrinkAbove: grid.gapShrinkAbove,
          startPrice: grid.startPrice,
          gridsAbove: grid.gridsAbove,
          gridsBelow: grid.gridsBelow,
          extensionsBelow: 0,
          extensionsAbove: 0,
          rotationEnabled: true,
        },
      });

      startStrategyEngine();

      const initialBuy = await placeInitialGridBuy(strategy);
      console.log(`[QuickStart] Initial buy result:`, JSON.stringify(initialBuy));

      setTimeout(() => runStrategyCycle(), 2000);

      res.status(201).json({
        strategy,
        initialBuy,
        selectedPair: symbol,
        pairName: bestPair.name,
        volatilityScore: bestPair.score,
        riskGauge: bestPair.riskGauge,
        gridInfo: {
          gridCount: grid.gridCount,
          leverage: grid.leverage,
          amountPerGrid,
          priceRange: `${grid.lowerPrice.toFixed(2)} - ${grid.upperPrice.toFixed(2)}`,
        },
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // === Simulation ===
  app.post("/api/grid/simulate", async (req, res) => {
    try {
      const stats = await storage.getCryptoStats();
      const { symbol, feeRate = 0.0006, amountPerGrid = 10 } = req.body;

      if (symbol) {
        const coin = stats.find(s => s.symbol?.toUpperCase() === symbol.replace("USDT", "").toUpperCase());
        if (!coin || !coin.priceHistory) {
          return res.status(404).json({ message: `No price history for ${symbol}` });
        }
        const result = simulateGridStrategy(coin.priceHistory as any, feeRate, amountPerGrid);
        if (!result) return res.status(400).json({ message: "Not enough data to simulate" });
        result.symbol = symbol;
        return res.json(result);
      }

      const results = [];
      for (const coin of stats) {
        if (!coin.priceHistory || (coin.priceHistory as any).length < 3) continue;
        const result = simulateGridStrategy(coin.priceHistory as any, feeRate, amountPerGrid);
        if (result) {
          result.symbol = (coin.symbol?.toUpperCase() || "") + "USDT";
          results.push(result);
        }
      }
      results.sort((a, b) => b.totalPnl - a.totalPnl);
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // === Volatility Scores ===
  app.get("/api/volatility/scores", async (_req, res) => {
    try {
      const stats = await storage.getCryptoStats();
      const scores = computeVolatilityScores(
        stats.map(s => ({
          symbol: s.symbol,
          name: s.name,
          currentPrice: s.currentPrice || 0,
          priceHistory: s.priceHistory as any,
        }))
      );
      res.json(scores);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // === Bitunix Trading Pairs ===
  app.get("/api/bitunix/pairs", async (_req, res) => {
    const client = getBitunixClient();
    if (!client) {
      return res.json({ pairs: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT", "BCHUSDT"], source: "fallback" });
    }
    try {
      const result = await client.getTradingPairs();
      if (result?.data && Array.isArray(result.data)) {
        const pairs = result.data
          .map((p: any) => p.symbol || p.pair || "")
          .filter((s: string) => s.endsWith("USDT"))
          .sort();
        res.json({ pairs, source: "bitunix" });
      } else {
        res.json({ pairs: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"], source: "fallback" });
      }
    } catch (e: any) {
      res.json({ pairs: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"], source: "fallback" });
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

  app.get("/api/strategies/:id/orders", async (req, res) => {
    const id = parseInt(req.params.id);
    const orders = getActiveGridOrders(id);
    res.json(orders);
  });

  return httpServer;
}
