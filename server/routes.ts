import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { getBitunixClient } from "./bitunix";
import { startStrategyEngine, stopStrategyEngine, runStrategyCycle, calculateOptimizedGrid, simulateGridStrategy, computeVolatilityScores, placeInitialGridBuy, cancelAllGridOrders, cancelAllTandemOrders, getActiveGridOrders, optimizeGapSettings, optimizeFeeMultiplier, executePairRotation, simulateTandem } from "./strategy-engine";
import { priceFeed } from "./ws-price-feed";
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
      const allPrices: number[] = coin.sparkline_in_7d?.price || [];
      const now = Date.now();
      const priceHistory = allPrices.map((price, index) => {
        const hoursAgo = allPrices.length - 1 - index;
        return { timestamp: now - (hoursAgo * 60 * 60 * 1000), price };
      });

      const recentPrices = allPrices.slice(-25);
      let swings = 0;
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
    const filtered = strats.filter(s => {
      const cfg = s.config as any;
      return !cfg?.parentTandemId;
    });
    res.json(filtered);
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
      if (updates.config) {
        const existing = await storage.getStrategy(id);
        if (!existing) return res.status(404).json({ message: "Strategy not found" });
        updates.config = { ...(existing.config as Record<string, any> || {}), ...updates.config };
      }
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
    const strategy = await storage.getStrategy(id);

    if (strategy) {
      const client = getBitunixClient();
      if (client) {
        try {
          if (strategy.type === "tandem") {
            await cancelAllTandemOrders(id, strategy.symbol);
          } else {
            await cancelAllGridOrders(id, strategy.symbol);
          }
        } catch (e: any) {
          console.error(`[Delete ${id}] Cancel orders error:`, e.message);
        }

        try {
          const closeRes = await client.flashClose(strategy.symbol);
          console.log(`[Delete ${id}] Flash close positions for ${strategy.symbol}: code=${closeRes?.code}, msg=${closeRes?.msg}`);
        } catch (e: any) {
          console.error(`[Delete ${id}] Close position error:`, e.message);
        }
      }
    }

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

    let initialBuy = null;
    const config = strategy.config as any;
    if (strategy.type === "grid" && !config?.initialBuyDone) {
      initialBuy = await placeInitialGridBuy({ ...strategy, status: "running" });
    }

    if (strategy.type === "tandem") {
      priceFeed.subscribe(strategy.symbol);
    }

    startStrategyEngine();

    res.json({ ...updated, initialBuy });
  });

  app.post("/api/strategies/:id/stop", async (req, res) => {
    const id = parseInt(req.params.id);
    const strategy = await storage.getStrategy(id);
    if (!strategy) return res.status(404).json({ message: "Strategy not found" });

    if (strategy.type === "grid") {
      await cancelAllGridOrders(id, strategy.symbol);
    } else if (strategy.type === "tandem") {
      await cancelAllTandemOrders(id, strategy.symbol);
    }

    const updated = await storage.updateStrategy(id, { status: "stopped" });
    const running = await storage.getStrategiesByStatus("running");
    if (running.length === 0) stopStrategyEngine();
    res.json(updated);
  });

  app.post("/api/cancel-all-orders", async (req, res) => {
    const client = getBitunixClient();
    if (!client) return res.status(400).json({ message: "API keys not configured" });

    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ message: "Symbol required" });

    try {
      const pendingRes = await client.get("/api/v1/futures/trade/get_pending_orders", {
        symbol,
        pageNum: 1,
        pageSize: 100,
      });

      const cancelRes = await client.cancelAllOrders(symbol);
      const count = pendingRes?.data?.orderList?.length || 0;
      if (cancelRes?.code === 0) {
        res.json({ cancelled: count, message: `Cancelled all ${count} pending orders for ${symbol}` });
      } else {
        res.json({ cancelled: 0, total: count, message: `Cancel failed`, cancelResult: cancelRes });
      }
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
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

  app.post("/api/flash-close", async (req, res) => {
    const client = getBitunixClient();
    if (!client) return res.status(400).json({ message: "API keys not configured" });
    try {
      const { symbol, positionId } = req.body;
      const result = await client.flashClose(symbol, positionId);
      res.json(result);
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
      const { amount = 100, symbol: requestedSymbol } = req.body;
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

      if (requestedSymbol) {
        bestPair = scores.find(s => s.bitunixSymbol === requestedSymbol) || null;
        if (!bestPair) {
          const matchedScore = scores.find(s => s.symbol.toLowerCase() === requestedSymbol.replace("USDT", "").toLowerCase());
          bestPair = matchedScore || null;
        }
        if (!bestPair) {
          return res.status(400).json({ message: `Pair ${requestedSymbol} not found in volatility data.` });
        }
        if (availablePairs.size > 0 && !availablePairs.has(bestPair.bitunixSymbol)) {
          return res.status(400).json({ message: `Pair ${requestedSymbol} not available on Bitunix.` });
        }
      } else {
        for (const s of scores) {
          if (availablePairs.size > 0 && !availablePairs.has(s.bitunixSymbol)) continue;
          if (s.riskGauge < 0.5 && s.largeSwingsDown > s.largeSwingsUp) continue;
          bestPair = s;
          break;
        }

        if (!bestPair) {
          bestPair = scores[0] || null;
        }
      }

      if (!bestPair) {
        return res.status(400).json({ message: "No volatility data available. Refresh the dashboard first." });
      }

      const symbol = bestPair.bitunixSymbol;
      const feeRate = 0.0006;
      const grid = calculateOptimizedGrid(bestPair.currentPrice, feeRate);

      const amountPerGrid = usdtAmount / (grid.gridCount + 1);

      if (usdtAmount < 10) {
        return res.status(400).json({ message: "Minimum amount is 10 USDT." });
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
          allocatedBudget: usdtAmount,
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

  app.get("/api/grid/leverage-analysis", async (_req, res) => {
    const feeRate = 0.0006;
    const roundTripFee = 2 * feeRate;
    const leverages = [10, 15, 20, 25, 30, 33, 40, 50, 60, 75, 100];
    const feeMultipliers = [3.0, 3.5, 4.0];

    const results = feeMultipliers.map(fm => {
      const gridGap = fm * roundTripFee;
      const netPerGrid = gridGap - roundTripFee;
      return {
        feeMultiplier: fm,
        gridGapPct: +(gridGap * 100).toFixed(3),
        netPerGridPct: +(netPerGrid * 100).toFixed(3),
        leverages: leverages.map(lev => {
          const liqDist = 1 / lev;
          const gridRange = liqDist * 0.85;
          const gridCount = Math.floor(gridRange / gridGap);
          const roiPerOscillation = +(gridCount * netPerGrid * lev * 100).toFixed(1);
          const roiPerGridOnMargin = +(netPerGrid * lev * 100).toFixed(2);
          return {
            leverage: lev,
            liqDistPct: +(liqDist * 100).toFixed(2),
            gridRangePct: +(gridRange * 100).toFixed(2),
            gridCount,
            roiPerGridOnMargin,
            roiPerOscillation,
            recommended: gridCount >= 4 && gridCount <= 12,
          };
        }),
      };
    });

    res.json(results);
  });

  app.post("/api/strategies/tandem-start", async (req, res) => {
    try {
      const schema = z.object({
        symbol: z.string().min(1),
        totalCapital: z.number().min(10).default(100),
        leverage: z.number().min(2).max(125).default(33),
        rotationEnabled: z.boolean().default(false),
        longWeight: z.number().min(1).max(10).default(4),
        shortWeight: z.number().min(1).max(10).default(3),
      });
      const { symbol, totalCapital, leverage, rotationEnabled, longWeight, shortWeight } = schema.parse(req.body);

      const client = getBitunixClient();
      if (!client) return res.status(400).json({ message: "API keys not configured" });

      const strategy = await storage.createStrategy({
        name: `Tandem ${symbol}`,
        type: "tandem",
        symbol: symbol.toUpperCase(),
        side: "BOTH",
        status: "running",
        config: {
          leverage,
          totalCapital,
          feeMultiplier: 3.5,
          longWeight,
          shortWeight,
          phase: "entry",
          entryPrice: 0,
          longGridId: null,
          shortGridId: null,
          longPositionId: null,
          shortPositionId: null,
          longEntryQty: 0,
          shortEntryQty: 0,
          liquidatedSide: null,
          liquidationPrice: 0,
          cascadeStep: 0,
          tpOrderIds: [],
          highWatermark: 0,
          remainingQty: 0,
          survivingSide: null,
          survivingPositionId: null,
          cycleCount: 0,
          totalPnl: 0,
          lastActionAt: 0,
          rotationEnabled,
        },
      });

      priceFeed.subscribe(symbol.toUpperCase());
      startStrategyEngine();
      setTimeout(() => runStrategyCycle(), 2000);

      res.status(201).json(strategy);
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ message: e.errors[0].message });
      }
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/strategies/hedge-pair-start", async (req, res) => {
    try {
      const schema = z.object({
        symbol: z.string().min(1),
        capitalPerSide: z.number().min(1).max(50).default(5),
        leverage: z.number().min(10).max(125).default(100),
        cascadeTargetsPct: z.array(z.number()).default([0.005, 0.01, 0.02, 0.03]),
        cascadePortions: z.array(z.number()).default([0.3, 0.3, 0.25, 0.15]),
        slBufferPct: z.number().min(0.001).max(0.05).default(0.002),
        autoRestart: z.boolean().default(true),
      });
      const params = schema.parse(req.body);

      const client = getBitunixClient();
      if (!client) return res.status(400).json({ message: "API keys not configured" });

      const strategy = await storage.createStrategy({
        name: `Hedge ${params.symbol}`,
        type: "hedge_pair",
        symbol: params.symbol.toUpperCase(),
        side: "BOTH",
        status: "running",
        config: {
          leverage: params.leverage,
          capitalPerSide: params.capitalPerSide,
          phase: "entry",
          entryPrice: 0,
          longPositionId: null,
          shortPositionId: null,
          longQty: 0,
          shortQty: 0,
          liquidatedSide: null,
          liquidationPrice: 0,
          survivingSide: null,
          survivingQty: 0,
          slOrderId: null,
          tpOrderIds: [],
          cascadeTargetsPct: params.cascadeTargetsPct,
          cascadePortions: params.cascadePortions,
          slBufferPct: params.slBufferPct,
          cycleCount: 0,
          totalPnl: 0,
          lastActionAt: 0,
          autoRestart: params.autoRestart,
          cyclePnl: 0,
        },
      });

      priceFeed.subscribe(params.symbol.toUpperCase());
      startStrategyEngine();
      setTimeout(() => runStrategyCycle(), 2000);

      res.status(201).json(strategy);
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ message: e.errors[0].message });
      }
      res.status(500).json({ message: e.message });
    }
  });

  // === Simulation ===
  app.post("/api/grid/optimize-fees", async (req, res) => {
    try {
      const stats = await storage.getCryptoStats();
      const { symbol, feeRate = 0.0006, amountPerGrid = 10 } = req.body;

      const targetSymbols = symbol
        ? [symbol.replace("USDT", "").toUpperCase()]
        : stats
            .filter(s => s.priceHistory && (s.priceHistory as any).length >= 5)
            .filter(s => !["USDT", "USDC", "USDS", "USDE"].includes(s.symbol?.toUpperCase() || ""))
            .sort((a, b) => (b.hourlySwings || 0) - (a.hourlySwings || 0))
            .slice(0, 5)
            .map(s => s.symbol?.toUpperCase() || "");

      const allResults: Record<string, any[]> = {};
      for (const sym of targetSymbols) {
        const coin = stats.find(s => s.symbol?.toUpperCase() === sym);
        if (!coin?.priceHistory) continue;
        const results = optimizeFeeMultiplier(coin.priceHistory as any, feeRate, amountPerGrid);
        allResults[sym + "USDT"] = results;
      }

      res.json(allResults);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/grid/optimize-gaps", async (req, res) => {
    try {
      const stats = await storage.getCryptoStats();
      const { symbol, feeRate = 0.0006, amountPerGrid = 10 } = req.body;

      const targetSymbols = symbol
        ? [symbol.replace("USDT", "").toUpperCase()]
        : stats
            .filter(s => s.priceHistory && (s.priceHistory as any).length >= 5)
            .filter(s => !["USDT", "USDC", "USDS", "USDE"].includes(s.symbol?.toUpperCase() || ""))
            .sort((a, b) => (b.hourlySwings || 0) - (a.hourlySwings || 0))
            .slice(0, 5)
            .map(s => s.symbol?.toUpperCase() || "");

      const allResults: Record<string, any[]> = {};
      for (const sym of targetSymbols) {
        const coin = stats.find(s => s.symbol?.toUpperCase() === sym);
        if (!coin?.priceHistory) continue;
        const results = optimizeGapSettings(coin.priceHistory as any, feeRate, amountPerGrid);
        allResults[sym + "USDT"] = results;
      }

      res.json(allResults);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/grid/simulate", async (req, res) => {
    try {
      const stats = await storage.getCryptoStats();
      const { symbol, feeRate = 0.0006, amountPerGrid = 10, days = 1 } = req.body;
      const hoursWindow = Math.min(days * 24, 168);

      const slicePH = (ph: any[]) => ph ? ph.slice(-hoursWindow) : ph;

      if (symbol) {
        const coin = stats.find(s => s.symbol?.toUpperCase() === symbol.replace("USDT", "").toUpperCase());
        if (!coin || !coin.priceHistory) {
          return res.status(404).json({ message: `No price history for ${symbol}` });
        }
        const ph = slicePH(coin.priceHistory as any);
        const result = simulateGridStrategy(ph, feeRate, amountPerGrid);
        if (!result) return res.status(400).json({ message: "Not enough data to simulate" });
        result.symbol = symbol;
        return res.json(result);
      }

      const results = [];
      for (const coin of stats) {
        const ph = slicePH(coin.priceHistory as any);
        if (!ph || ph.length < 3) continue;
        const result = simulateGridStrategy(ph, feeRate, amountPerGrid);
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

  app.post("/api/tandem/simulate", async (req, res) => {
    try {
      const stats = await storage.getCryptoStats();
      const { symbol, feeRate = 0.0006, totalCapital = 100, leverage = 100, feeMultiplier = 4.0, days = 7 } = req.body;
      const capitalPerSide = (totalCapital || 100) / 2;
      const hoursWindow = Math.min(days * 24, 168);

      const slicePriceHistory = (ph: any[]) => {
        if (!ph) return ph;
        return ph.slice(-hoursWindow);
      };

      if (symbol) {
        const coin = stats.find(s => s.symbol?.toUpperCase() === symbol.replace("USDT", "").toUpperCase());
        if (!coin || !coin.priceHistory) {
          return res.status(404).json({ message: `No price history for ${symbol}` });
        }
        const ph = slicePriceHistory(coin.priceHistory as any);
        const result = simulateTandem(ph, feeRate, capitalPerSide, leverage, feeMultiplier);
        if (!result) return res.status(400).json({ message: "Not enough data to simulate" });
        result.symbol = symbol;
        return res.json(result);
      }

      const results = [];
      for (const coin of stats) {
        const ph = slicePriceHistory(coin.priceHistory as any);
        if (!ph || ph.length < 10) continue;
        const result = simulateTandem(ph, feeRate, capitalPerSide, leverage, feeMultiplier);
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

  // === Manual Pair Rotation ===
  const rotateSchema = z.object({ newSymbol: z.string().min(1).max(20) });
  app.post("/api/strategies/:id/rotate", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const parsed = rotateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "newSymbol required (string)" });
      const { newSymbol } = parsed.data;

      const strategy = await storage.getStrategy(id);
      if (!strategy) return res.status(404).json({ message: "Strategy not found" });
      if (strategy.status !== "running") return res.status(400).json({ message: "Strategy must be running to rotate" });

      await executePairRotation(strategy, newSymbol, `Manual rotation to ${newSymbol}`);
      res.json({ success: true, message: `Rotating to ${newSymbol}` });
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

  app.get("/api/strategies/:id/margin-info", async (req, res) => {
    const id = parseInt(req.params.id);
    const strategy = await storage.getStrategy(id);
    if (!strategy) return res.status(404).json({ message: "Strategy not found" });
    if (strategy.type !== "grid") return res.status(400).json({ message: "Only grid strategies" });

    const client = getBitunixClient();
    if (!client) return res.status(400).json({ message: "API keys not configured" });

    try {
      const { getMarginInfo } = await import("./strategy-engine");
      const result = await getMarginInfo(strategy);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/strategies/:id/extend-orders", async (req, res) => {
    const id = parseInt(req.params.id);
    const strategy = await storage.getStrategy(id);
    if (!strategy) return res.status(404).json({ message: "Strategy not found" });
    if (strategy.status !== "running") return res.status(400).json({ message: "Strategy must be running" });
    if (strategy.type !== "grid") return res.status(400).json({ message: "Only grid strategies" });

    const client = getBitunixClient();
    if (!client) return res.status(400).json({ message: "API keys not configured" });

    try {
      const { extendOrdersToLowerBand } = await import("./strategy-engine");
      const result = await extendOrdersToLowerBand(strategy);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/strategies/:id/add-margin", async (req, res) => {
    const id = parseInt(req.params.id);
    const schema = z.object({ amount: z.number().positive() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Amount must be a positive number" });

    const strategy = await storage.getStrategy(id);
    if (!strategy) return res.status(404).json({ message: "Strategy not found" });
    if (strategy.status !== "running") return res.status(400).json({ message: "Strategy must be running" });
    if (strategy.type !== "grid") return res.status(400).json({ message: "Only grid strategies support margin adjustment" });

    const client = getBitunixClient();
    if (!client) return res.status(400).json({ message: "API keys not configured" });

    try {
      const { addMarginToGrid } = await import("./strategy-engine");
      const result = await addMarginToGrid(strategy, parsed.data.amount);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/strategies/:id/remove-margin", async (req, res) => {
    const id = parseInt(req.params.id);
    const schema = z.object({ count: z.number().int().min(1).default(1) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ message: "Count must be a positive integer" });

    const strategy = await storage.getStrategy(id);
    if (!strategy) return res.status(404).json({ message: "Strategy not found" });
    if (strategy.status !== "running") return res.status(400).json({ message: "Strategy must be running" });
    if (strategy.type !== "grid") return res.status(400).json({ message: "Only grid strategies support margin adjustment" });

    const client = getBitunixClient();
    if (!client) return res.status(400).json({ message: "API keys not configured" });

    try {
      const { removeMarginFromGrid } = await import("./strategy-engine");
      const result = await removeMarginFromGrid(strategy, parsed.data.count);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  return httpServer;
}
