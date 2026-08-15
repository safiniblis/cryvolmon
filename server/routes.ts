import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { getBitunixClient } from "./bitunix";
import {
  managerChat,
  managerChatWithTools,
  agentChat,
  runCouncil,
  tuneStrategy,
  resetManagedParams,
  getAgentSlots,
  setAgentOverrides,
  isAnyAgentConfigured,
  type ChatTurn,
  type AgentPosition,
  type AgentProvider,
} from "./council";
import { startStrategyEngine, stopStrategyEngine, runStrategyCycle, calculateOptimizedGrid, simulateGridStrategy, computeVolatilityScores, placeInitialGridBuy, cancelAllGridOrders, cancelAllTandemOrders, getActiveGridOrders, optimizeGapSettings, optimizeFeeMultiplier, executePairRotation, simulateTandem, getPairPrecision } from "./strategy-engine";
import { priceFeed } from "./ws-price-feed";
import { insertStrategySchema } from "@shared/schema";
import { z } from "zod";
import { resolve, relative, isAbsolute } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { checkResourceManagerHealth, getResourceManagerStatus, setResourceManagerConfig } from "./resource-manager";
import { getFreeModels, pingModel, FREE_MODEL_REGISTRY } from "./free-models";
import { getSlot, AGENT_POSITIONS, selectFallbackModel } from "./council";
const PROJECT_ROOT = resolve(process.cwd());
let latestCryptoStats: any[] = [];
const COUNCIL_TUNE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const councilTuneLocks = new Set<number>();

async function archiveCouncilMessage(message: {
  sessionId: string;
  mode: string;
  position: string;
  role: string;
  provider?: string | null;
  model?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try { await storage.createCouncilMessage({ ...message, metadata: message.metadata || {} }); } catch (e: any) {
    console.warn(`[CouncilArchive] ${e.message}`);
  }
}

async function runDueCouncilTunes(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const running = await storage.getStrategiesByStatus("running");
  for (const strategy of running) {
    const config = (strategy.config || {}) as Record<string, any>;
    if ((strategy.type !== "grid" && strategy.type !== "tandem") || config.parentTandemId || config.councilAutoTune !== true) continue;
    const lastTuneAt = Number(config.lastCouncilTuneAt || 0);
    if (Date.now() - lastTuneAt < COUNCIL_TUNE_INTERVAL_MS || councilTuneLocks.has(strategy.id)) continue;

    councilTuneLocks.add(strategy.id);
    try {
      console.log(`[Council] Automatic four-hour debate starting for strategy #${strategy.id}`);
      await tuneStrategy(strategy.id);
      const updated = await storage.getStrategy(strategy.id);
      if (updated) {
        await storage.updateStrategy(strategy.id, {
          config: { ...(updated.config || {}), councilAutoTune: true, lastCouncilTuneAt: Date.now() },
        });
      }
    } catch (e: any) {
      console.error(`[Council] Automatic debate failed for strategy #${strategy.id}: ${e.message}`);
    } finally {
      councilTuneLocks.delete(strategy.id);
    }
  }
}

async function fetchTop20CryptoData() {
  try {
    const marketsResponse = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=true",
      { headers: { accept: "application/json", "user-agent": "cryvolmon/1.0" } },
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
    latestCryptoStats = results;
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
      try { await storage.updateCryptoStats(data); } catch (e: any) {
        console.warn(`[Stats] Database unavailable; keeping in-memory CoinGecko cache: ${e.message}`);
      }
    }
  }).catch(console.error);

  // === Auto-start strategy engine if there are running strategies ===
  storage.getStrategiesByStatus("running").then((running) => {
    if (running.length > 0) {
      console.log(`[Boot] Found ${running.length} running strategies, starting engine...`);
      startStrategyEngine();
    }
  }).catch(console.error);
  const councilScheduler = setInterval(() => runDueCouncilTunes().catch((e) => console.error(`[Council] Scheduler error: ${e.message}`)), 5 * 60 * 1000);
  councilScheduler.unref();

  app.get("/api/stats", async (_req, res) => {
    try {
      const stats = await storage.getCryptoStats();
      if (stats.length > 0) latestCryptoStats = stats;
      res.json((stats.length > 0 ? stats : latestCryptoStats).sort((a, b) => (b.hourlySwings || 0) - (a.hourlySwings || 0)));
    } catch {
      res.json([...latestCryptoStats].sort((a, b) => (b.hourlySwings || 0) - (a.hourlySwings || 0)));
    }
  });

  app.post("/api/stats/refresh", async (req, res) => {
    try {
      const data = await fetchTop20CryptoData();
      if (data.length > 0) {
        try { await storage.updateCryptoStats(data); } catch (e: any) {
          console.warn(`[Stats] Database unavailable; serving in-memory CoinGecko data: ${e.message}`);
        }
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
  // Bitunix account (ADAUSDT / grid strategies)
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

  // Bitrue account (E-XAUT-USDT gold strategies)
  app.get("/api/bitrue-account", async (req, res) => {
    try {
      const { getBitrueClient } = await import("./bitrue");
      const client = getBitrueClient();
      if (!client) return res.json({ available: 0, total: 0, connected: false });

      const raw  = await client.getAccount();
      const list: any[] = Array.isArray(raw?.account)       ? raw.account
                         : Array.isArray(raw?.data?.account) ? raw.data.account
                         : Array.isArray(raw?.data)          ? raw.data
                         : [];
      const acct = list.find((a: any) =>
        (a.marginCoin || a.asset || "").toUpperCase() === "USDT"
      ) || list[0] || {};

      const available = parseFloat(acct.accountNormal ?? acct.available ?? acct.balance ?? acct.avail ?? "0");
      const frozen    = parseFloat(acct.accountLock   ?? acct.frozen    ?? acct.lock    ?? "0");

      // Pull liqPrice + unrealizedPnl from live position if any
      const posRes  = await client.getPositions("E-XAUT-USDT");
      const { BitrueClient } = await import("./bitrue");
      const posList: any[] = BitrueClient.extractPositions(posRes);
      const positions = posList
        .filter((p: any) => parseFloat(p.volume || p.holdVol || p.qty || p.openVol || "0") > 0)
        .map((p: any) => ({
          symbol:        "E-XAUT-USDT",
          side:          p.side === "BUY" || p.positionType === 1 ? "LONG" : "SHORT",
          quantity:      parseFloat(p.volume || p.holdVol || p.qty || "0"),
          entryPrice:    parseFloat(p.avgOpenPrice || p.avgPrice || p.openPrice || "0"),
          liqPrice:      parseFloat(p.liqPrice || p.liquidationPrice || "0"),
          unrealizedPnl: parseFloat(p.unrealizedPNL || p.unrealizedPnl || "0"),
          leverage:      parseFloat(p.leverage || "0"),
          marginMode:    p.marginMode || p.openType === 1 ? "ISOLATION" : "CROSS",
        }));

      res.json({ available, frozen, total: available + frozen, positions, connected: true });
    } catch (e: any) {
      console.error(`[Bitrue Account] ${e.message}`);
      res.json({ available: 0, total: 0, positions: [], connected: false, error: e.message });
    }
  });

  // === Work Log: strategy decision events (ledger of what was decided/done) ===
  app.get("/api/decisions", async (req, res) => {
    try {
      const strategyId = req.query.strategyId ? parseInt(String(req.query.strategyId)) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100;
      const events = await storage.getStrategyDecisionEvents(strategyId, limit);
      res.json(events);
    } catch (e) {
      res.json([]);
    }
  });

  // === Strategies ===
  app.get("/api/strategies", async (_req, res) => {
    try {
      const strats = await storage.getStrategies();
      const filtered = strats.filter(s => {
        const cfg = s.config as any;
        return !cfg?.parentTandemId;
      });
      res.json(filtered);
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") return res.json([]);
      throw e;
    }
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
      // Gold Long uses Bitrue futures — cancel supports and close position
      if (strategy.type === "gold_long") {
        // Gold Long is exclusively on Bitrue futures (fapi.bitrue.com)
        // contractName is always E-XAUT-USDT regardless of strategy.symbol legacy value
        const GOLD_CONTRACT = "E-XAUT-USDT";
        const { getBitrueClient } = await import("./bitrue");
        const bitrueClient = getBitrueClient();
        if (bitrueClient) {
          const cfg = (strategy.config || {}) as any;
          // Cancel all tracked Bitrue futures orders (floor slots + seed TPs + legacy)
          const orderIds: string[] = [];
          for (const slot of (cfg.floorSlots || [])) {
            if (slot.outerOrderId && !slot.outerFilled) orderIds.push(String(slot.outerOrderId));
            if (slot.innerOrderId && !slot.innerFilled) orderIds.push(String(slot.innerOrderId));
            if (slot.tpOrderId    && !slot.tpFilled)    orderIds.push(String(slot.tpOrderId));
          }
          for (const stp of (cfg.seedTpSlots || [])) {
            if (stp.tpOrderId)      orderIds.push(String(stp.tpOrderId));
            if (stp.buybackOrderId) orderIds.push(String(stp.buybackOrderId));
          }
          for (const o of (cfg.supportOrders || [])) {
            if (o.id) orderIds.push(String(o.id));
          }
          if (orderIds.length > 0) {
            try {
              await bitrueClient.cancelOrders(GOLD_CONTRACT, orderIds);
              console.log(`[Delete ${id}] Cancelled ${orderIds.length} Bitrue orders`);
            } catch (e: any) {
              console.warn(`[Delete ${id}] Batch cancel failed: ${e.message}`);
            }
          }
          // Close any open long position — use live contracts from exchange, not stale config
          try {
            const posRes  = await bitrueClient.getPositions(GOLD_CONTRACT);
            const posList: any[] = posRes?.positions || [];
            const longPos = posList.find((p: any) => {
              const qty = parseFloat(p.volume || p.holdVol || p.qty || "0");
              return qty > 0 && (p.positionType === 1 || !p.positionType);
            });
            const liveContracts = Math.floor(parseFloat(longPos?.volume || longPos?.holdVol || longPos?.qty || "0"));
            const leverage      = cfg.leverage || 10;
            if (liveContracts > 0) {
              await bitrueClient.closePosition({ contractName: GOLD_CONTRACT, positionType: 1, volume: liveContracts, leverage });
              console.log(`[Delete ${id}] Closed Bitrue long position: ${liveContracts} contracts`);
            } else {
              console.log(`[Delete ${id}] No open Bitrue long position found — skipping close`);
            }
          } catch (e: any) {
            console.warn(`[Delete ${id}] Close position failed: ${e.message}`);
          }
        }
      }

      const client = getBitunixClient();
      if (client) {
        try {
          if (strategy.type === "tandem") {
            await cancelAllTandemOrders(id, strategy.symbol);
            const config = strategy.config as any;
            const childIds = [config?.longGridId, config?.shortGridId].filter(Boolean) as number[];
            for (const childId of childIds) {
              try {
                const child = await storage.getStrategy(childId);
                if (child) {
                  await cancelAllGridOrders(childId, child.symbol);
                  await storage.deleteStrategy(childId);
                  console.log(`[Delete ${id}] Deleted child grid #${childId}`);
                }
              } catch (ce: any) {
                console.error(`[Delete ${id}] Child #${childId} cleanup error:`, ce.message);
              }
            }
          } else {
            await cancelAllGridOrders(id, strategy.symbol);
          }
        } catch (e: any) {
          console.error(`[Delete ${id}] Cancel orders error:`, e.message);
        }

        try {
          await client.cancelAllOrders(strategy.symbol);
          console.log(`[Delete ${id}] Cancelled all orders for ${strategy.symbol}`);
        } catch (e: any) {
          console.error(`[Delete ${id}] Cancel all orders error:`, e.message);
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
    } else if (strategy.type === "gold_long") {
      // Cancel all tracked Bitrue futures orders (floor slots + seed TPs)
      // DELETE is not supported on Bitrue futures — cancel uses POST
      const GOLD_CONTRACT = "E-XAUT-USDT";
      const { getBitrueClient } = await import("./bitrue");
      const bitrueClient = getBitrueClient();
      if (bitrueClient) {
        const cfg = (strategy.config || {}) as any;
        const orderIds: string[] = [];
        // Floor slot orders (outer / inner / tp per slot)
        for (const slot of (cfg.floorSlots || [])) {
          if (slot.outerOrderId && !slot.outerFilled) orderIds.push(String(slot.outerOrderId));
          if (slot.innerOrderId && !slot.innerFilled) orderIds.push(String(slot.innerOrderId));
          if (slot.tpOrderId    && !slot.tpFilled)    orderIds.push(String(slot.tpOrderId));
        }
        // Seed TP and buyback orders
        for (const stp of (cfg.seedTpSlots || [])) {
          if (stp.tpOrderId)      orderIds.push(String(stp.tpOrderId));
          if (stp.buybackOrderId) orderIds.push(String(stp.buybackOrderId));
        }
        // Legacy field — support old running strategies during transition
        for (const o of (cfg.supportOrders || [])) {
          if (o.id) orderIds.push(String(o.id));
        }
        if (orderIds.length > 0) {
          try {
            await bitrueClient.cancelOrders(GOLD_CONTRACT, orderIds);
            console.log(`[Stop ${id}] Cancelled ${orderIds.length} Bitrue orders`);
          } catch (e: any) {
            console.warn(`[Stop ${id}] Batch cancel failed: ${e.message}`);
          }
        }
      }
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

  app.post("/api/emergency-stop", async (req, res) => {
    const client = getBitunixClient();
    console.log("[Emergency Stop] Triggered");

    stopStrategyEngine();

    const allStrategies = await storage.getStrategies();
    const running = allStrategies.filter(s => s.status === "running");
    for (const s of running) {
      try {
        await storage.updateStrategy(s.id, { status: "stopped" });
        console.log(`[Emergency Stop] Stopped strategy #${s.id} (${s.type} ${s.symbol})`);
      } catch (e: any) {
        console.error(`[Emergency Stop] Failed to stop strategy #${s.id}:`, e.message);
      }
    }

    const cancelledSymbols: string[] = [];
    if (client) {
      try {
        const openRes = await client.getOpenOrders();
        if (openRes?.code === 0) {
          const orders = openRes.data?.orderList || openRes.data || [];
          const symbolsWithOrders = [...new Set(
            (Array.isArray(orders) ? orders : []).map((o: any) => o.symbol).filter(Boolean)
          )] as string[];

          const dbSymbols = [...new Set(allStrategies.map(s => s.symbol))];
          const allSymbols = [...new Set([...symbolsWithOrders, ...dbSymbols])];

          for (const symbol of allSymbols) {
            try {
              await client.cancelAllOrders(symbol);
              cancelledSymbols.push(symbol);
              console.log(`[Emergency Stop] Cancelled all orders for ${symbol}`);
            } catch (e: any) {
              console.error(`[Emergency Stop] Cancel orders for ${symbol} failed:`, e.message);
            }
          }
        }
      } catch (e: any) {
        console.error(`[Emergency Stop] Failed to fetch open orders:`, e.message);
        const dbSymbols = [...new Set(allStrategies.map(s => s.symbol))];
        for (const symbol of dbSymbols) {
          try {
            await client.cancelAllOrders(symbol);
            cancelledSymbols.push(symbol);
          } catch {}
        }
      }
    }

    res.json({
      stopped: running.length,
      cancelledSymbols,
      message: `Emergency stop: ${running.length} strategies stopped, orders cancelled for ${cancelledSymbols.length} symbols`
    });
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
      const { amount = 100, symbol: requestedSymbol, twinMode = false, twinGapPct = 0.006 } = req.body;
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
      const twinFeeMultiplier = twinMode ? (twinGapPct / 2) / (2 * feeRate) : undefined;
      const grid = calculateOptimizedGrid(bestPair.currentPrice, feeRate, twinFeeMultiplier);

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
          ...(twinMode ? { twinMode: true, twinGapPct, feeMultiplier: twinFeeMultiplier } : {}),
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
        longWeight: z.number().min(1).max(10).default(1),
        shortWeight: z.number().min(1).max(10).default(1),
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
          initialCapital: totalCapital,
          exchangeRealizedPnl: 0,
          capitalTrackingStartedAt: Date.now(),
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

  app.post("/api/strategies/gold-long-start", async (req, res) => {
    try {
      const schema = z.object({
        baseCapital: z.number().min(10).max(100000),
        leverage: z.number().min(1).max(100).default(20),
      });
      const params = schema.parse(req.body);

      const { getBitrueClient } = await import("./bitrue");
      const client = getBitrueClient();
      if (!client) return res.status(400).json({ message: "BITRUE_API_KEY and BITRUE_SECRET_KEY must be set" });

      const strategy = await storage.createStrategy({
        name: `Gold Long E-XAUT-USDT`,
        type: "gold_long",
        symbol: "E-XAUT-USDT",
        side: "BUY",
        status: "running",
        config: {
          baseCapital: params.baseCapital,
          leverage: params.leverage,
          phase: "entry",
          // populated after entry fills:
          seedContracts: 0,
          seedEntryPrice: 0,
          liqPrice: 0,
          floorSlots: [],
          activeSlotIndex: 0,
          seedTpSlots: [],
          fundingRate: 0,
          fundingCheckedAt: 0,
          fundingReductionAt: null,
          lastRefreshAt: 0,
          lastActionAt: 0,
          lastError: null,
        },
      });

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

  app.get("/api/pair-info/:symbol", async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const precision = await getPairPrecision(symbol);
      res.json({
        symbol,
        maxLeverage: precision.maxLeverage,
        basePrecision: precision.basePrecision,
        quotePrecision: precision.quotePrecision,
        minTradeVolume: precision.minTradeVolume,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/strategies/hedge-pair-start", async (req, res) => {
    try {
      const schema = z.object({
        symbol: z.string().min(1),
        capitalPerSide: z.number().min(0.5).max(50).default(5),
        leverage: z.number().min(10).max(125).default(100),
        trailingPct: z.number().min(0.001).max(0.05).default(0.0033),
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
          trailingPct: params.trailingPct,
          trailingHwm: 0,
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

  app.get("/api/bitrue/contracts", async (_req, res) => {
    const fallback = ["E-XAUT-USDT"];
    try {
      const { getBitrueClient } = await import("./bitrue");
      const client = getBitrueClient();
      if (!client) return res.json({ pairs: fallback, source: "fallback", connected: false });
      const contracts = await client.getContracts();
      const pairs = contracts
        .map((contract: any) => contract.contractName || contract.symbol || contract.name || "")
        .filter((symbol: string) => symbol.includes("USDT"))
        .sort();
      res.json({ pairs: pairs.length > 0 ? pairs : fallback, source: pairs.length > 0 ? "bitrue" : "fallback", connected: true });
    } catch (e: any) {
      res.json({ pairs: fallback, source: "fallback", connected: false, error: e.message });
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

  // === AI Council & Manager (5-slot agent system) ===
  app.get("/api/council/status", async (_req, res) => {
    res.json({ configured: isAnyAgentConfigured(), slots: getAgentSlots() });
  });

  const positionEnum = z.enum(["manager", "critic", "architect", "auditor", "strategist", "resource_manager"]);
  const providerEnum = z.enum(["opencode", "abacus", "deepseek", "groq", "cerebras", "openrouter", "hyperbolic", "nemotron", "nvidia", "sambanova", "mistral", "hf", "gemini", "ovh"]);

  app.post("/api/council/agents", async (req, res) => {
    const schema = z.object({
      slots: z
        .array(
          z.object({
            position: positionEnum,
            provider: providerEnum.optional(),
            baseUrl: z.string().url().optional(),
            model: z.string().min(1).optional(),
            apiKey: z.string().max(512).optional(),
          }),
        )
        .max(5),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "Invalid agent config." });
    setAgentOverrides(parsed.data.slots as { position: AgentPosition; provider?: AgentProvider; baseUrl?: string; model?: string; apiKey?: string }[]);
    res.json({ slots: getAgentSlots() });
  });

  app.post("/api/council/chat", async (req, res) => {
    const schema = z.object({
      message: z.string().min(1).max(8000),
      mode: z.enum(["manager", "council", "agent"]).default("manager"),
      position: positionEnum.optional(),
      history: z
        .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
        .max(40)
        .default([]),
      toolsToken: z.string().max(512).optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message || "Invalid request";
      const path = parsed.error.issues[0]?.path?.join(".") || "body";
      return res.status(400).json({ message: `${detail} (at ${path})` });
    }

    const { message, mode, position, history, toolsToken } = parsed.data;
    const turns: ChatTurn[] = [...history, { role: "user", content: message }];
    const sessionId = req.header("x-council-session") || "default";
    await archiveCouncilMessage({ sessionId, mode, position: position || "manager", role: "user", content: message });
    try {
      if (mode === "manager") {
        const reply = await managerChatWithTools(turns, toolsToken);
        if (reply.content) await archiveCouncilMessage({ sessionId, mode, position: "manager", role: "assistant", provider: reply.provider, model: reply.model, content: reply.content });
        res.json({ mode: "manager", configured: isAnyAgentConfigured(), slots: getAgentSlots(), reply });
      } else if (mode === "agent") {
        if (!position) return res.status(400).json({ message: "An agent position is required." });
        const reply = await agentChat(position, turns);
        if (reply.content) await archiveCouncilMessage({ sessionId, mode, position, role: "assistant", provider: reply.provider, model: reply.model, content: reply.content });
        res.json({ mode: "agent", position, configured: isAnyAgentConfigured(), slots: getAgentSlots(), reply });
      } else {
        const result = await runCouncil(turns);
        for (const member of result.members || []) {
          if (member.content) await archiveCouncilMessage({ sessionId, mode: "council", position: member.position, role: "assistant", provider: member.provider, model: member.model, content: member.content, metadata: { phase: "cross_talk" } });
        }
        if (result.synthesis?.content) await archiveCouncilMessage({ sessionId, mode: "council", position: "manager", role: "assistant", provider: result.synthesis.provider, model: result.synthesis.model, content: result.synthesis.content, metadata: { phase: "synthesis" } });
        res.json(result);
      }
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/resource-manager/status", async (_req, res) => {
    res.json({ ...getResourceManagerStatus(), health: await checkResourceManagerHealth() });
  });

  app.post("/api/resource-manager/config", async (req, res) => {
    const parsed = z.object({ baseUrl: z.string().url(), apiKey: z.string().max(512).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "A valid base URL and API key are required." });
    setResourceManagerConfig(parsed.data.baseUrl, parsed.data.apiKey);
    res.json({ ...getResourceManagerStatus(), health: await checkResourceManagerHealth() });
  });

  app.get("/api/council/archive", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "200"), 10) || 200, 500);
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
      res.json(await storage.getCouncilMessages(limit, sessionId));
    } catch {
      res.json([]);
    }
  });

  // === Append operator-provided context into the council archive (token-guarded) ===
  app.post("/api/council/context", async (req, res) => {
    const configuredToken = process.env.COUNCIL_WRITE_TOKEN;
    const suppliedToken = req.header("x-council-write-token") || "";
    if (!configuredToken) {
      return res.status(503).json({ message: "Council context writes are disabled. Set COUNCIL_WRITE_TOKEN first." });
    }
    const expected = Buffer.from(configuredToken);
    const supplied = Buffer.from(suppliedToken);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return res.status(403).json({ message: "Invalid Council write approval token." });
    }
    const parsed = z
      .object({
        content: z.string().min(1).max(20000),
        position: z.string().default("manager"),
        metadata: z.record(z.string(), z.unknown()).default({}),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "A non-empty content string is required." });
    await archiveCouncilMessage({
      sessionId: "operator-context",
      mode: "context",
      position: parsed.data.position,
      role: "user",
      content: parsed.data.content,
      metadata: { ...parsed.data.metadata, injectedBy: "operator" },
    });
    res.json({ ok: true, archived: true });
  });

  // === Free-model registry & auto-heal ===
  app.get("/api/council/models", (_req, res) => {
    const assignments = AGENT_POSITIONS.map((p) => ({ position: p, model: getSlot(p).model, provider: getSlot(p).provider }));
    res.json({ models: getFreeModels(), assignments });
  });

  app.post("/api/council/models/recheck", async (_req, res) => {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) return res.status(503).json({ message: "OPENROUTER_API_KEY not set — cannot recheck." });
    const results = [];
    for (const model of FREE_MODEL_REGISTRY) {
      const r = await pingModel(model.id, openrouterKey);
      results.push({ id: model.id, ok: r.ok, ms: r.ms, error: r.error ?? null });
    }
    res.json({ models: getFreeModels(), results });
  });

  app.post("/api/council/heal", async (req, res) => {
    if (process.env.COUNCIL_AUTO_HEAL !== "1") {
      return res.status(403).json({
        message: "Auto-heal is disabled. Set COUNCIL_AUTO_HEAL=1 to allow model rescue swaps. Manager is never auto-healed.",
        slots: getAgentSlots(),
      });
    }
    const parsed = z.object({ position: positionEnum }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "A valid position is required." });
    const position = parsed.data.position;
    if (position === "manager" || position === "resource_manager") {
      return res.status(403).json({ message: `Refusing to auto-heal ${position} — operator lock.`, slots: getAgentSlots() });
    }
    const current = getSlot(position);
    const pick = await selectFallbackModel(position, current.model);
    if (!pick) {
      return res.status(503).json({ message: "No working fallback model found — every free model is down or rate-limited.", slots: getAgentSlots() });
    }
    res.json({ healed: true, from: current.model, to: pick.model, slots: getAgentSlots() });
  });

  app.post("/api/strategies/:id/council-tune", async (req, res) => {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid strategy id" });
    try {
      const result = await tuneStrategy(id);
      const strategy = await storage.getStrategy(id);
      if (strategy) {
        await storage.updateStrategy(id, {
          config: {
            ...(strategy.config || {}),
            councilAutoTune: true,
            lastCouncilTuneAt: Date.now(),
          },
        });
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/strategies/:id/council-reset", async (req, res) => {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid strategy id" });
    try {
      const result = await resetManagedParams(id);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // === File access for council context injection ===
  const READONLY_EXTERNAL_ROOTS = ["/home/safin/gridbot"];
  const isWithinRoot = (target: string, root: string): boolean => {
    const rel = target === root ? "" : relative(root, target);
    return rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel);
  };
  const resolveReadablePath = (p: string): string | null => {
    const candidateRoots = [PROJECT_ROOT, ...READONLY_EXTERNAL_ROOTS];
    for (const root of candidateRoots) {
      const target = resolve(root, p);
      if (isWithinRoot(target, root)) return target;
    }
    return null;
  };
  app.get("/api/council/file", async (req, res) => {
    const p = req.query.path;
    if (typeof p !== "string" || !p) return res.status(400).json({ message: "path query required" });
    const safe = resolveReadablePath(p);
    if (!safe) {
      return res.status(403).json({ message: "Path outside project" });
    }
    try {
      const content = readFileSync(safe, "utf-8");
      res.json({ path: p, content });
    } catch {
      res.status(404).json({ message: "File not readable" });
    }
  });

  app.post("/api/council/file", async (req, res) => {
    const configuredToken = process.env.COUNCIL_WRITE_TOKEN;
    const suppliedToken = req.header("x-council-write-token") || "";
    if (!configuredToken) {
      return res.status(503).json({ message: "Council file writes are disabled. Set COUNCIL_WRITE_TOKEN first." });
    }
    const expected = Buffer.from(configuredToken);
    const supplied = Buffer.from(suppliedToken);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return res.status(403).json({ message: "Invalid Council write approval token." });
    }

    const schema = z.object({ path: z.string().min(1), content: z.string() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "path and content required" });
    const { path: relPath, content } = parsed.data;
    if (relPath.startsWith(".env") || relPath.endsWith("auth.json") || relPath.includes("node_modules")) {
      return res.status(403).json({ message: "Sensitive or dependency files cannot be edited." });
    }
    const safe = resolve(PROJECT_ROOT, relPath);
    if (!safe.startsWith(PROJECT_ROOT + "\\") && safe !== PROJECT_ROOT) {
      return res.status(403).json({ message: "Path outside project" });
    }
    try {
      writeFileSync(safe, content, "utf-8");
      res.json({ path: relPath, ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  return httpServer;
}
