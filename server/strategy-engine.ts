import { getBitunixClient } from "./bitunix";
import { storage } from "./storage";
import type { Strategy, InsertTradeLog } from "@shared/schema";

interface TickerData {
  symbol: string;
  lastPrice: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
}

async function getTickerPrice(symbol: string): Promise<TickerData | null> {
  const client = getBitunixClient();
  if (!client) return null;

  try {
    const result = await client.getTickers(symbol);
    if (result?.data && result.data.length > 0) {
      const t = result.data[0];
      return {
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice || t.last || "0"),
        high24h: parseFloat(t.high24h || t.high || "0"),
        low24h: parseFloat(t.low24h || t.low || "0"),
        volume24h: parseFloat(t.volume24h || t.volume || "0"),
        change24h: parseFloat(t.change24h || t.priceChangePercent || "0"),
      };
    }
  } catch (e) {
    console.error(`Failed to get ticker for ${symbol}:`, e);
  }
  return null;
}

async function executeGridStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as {
    upperPrice: number;
    lowerPrice: number;
    gridCount: number;
    amountPerGrid: number;
    leverage: number;
  };

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) throw new Error(`Cannot get price for ${strategy.symbol}`);

  const currentPrice = ticker.lastPrice;
  const gridSize = (config.upperPrice - config.lowerPrice) / config.gridCount;

  const nearestGridBelow = config.lowerPrice + Math.floor((currentPrice - config.lowerPrice) / gridSize) * gridSize;
  const nearestGridAbove = nearestGridBelow + gridSize;

  const distToBelow = currentPrice - nearestGridBelow;
  const distToAbove = nearestGridAbove - currentPrice;
  const threshold = gridSize * 0.1;

  let tradeLog: InsertTradeLog | null = null;

  if (distToBelow < threshold && currentPrice > config.lowerPrice) {
    try {
      const result = await client.placeOrder({
        symbol: strategy.symbol,
        qty: String(config.amountPerGrid),
        side: "BUY",
        tradeSide: "OPEN",
        orderType: "MARKET",
        leverage: config.leverage || 1,
        positionType: 2,
      });

      tradeLog = {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        side: "BUY",
        orderType: "MARKET",
        quantity: config.amountPerGrid,
        price: currentPrice,
        status: result?.code === "0" ? "filled" : "error",
        orderId: result?.data?.orderId || null,
        pnl: null,
        errorMsg: result?.code !== "0" ? (result?.msg || "Unknown error") : null,
      };
    } catch (e: any) {
      tradeLog = {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        side: "BUY",
        orderType: "MARKET",
        quantity: config.amountPerGrid,
        price: currentPrice,
        status: "error",
        orderId: null,
        pnl: null,
        errorMsg: e.message,
      };
    }
  } else if (distToAbove < threshold && currentPrice < config.upperPrice) {
    try {
      const result = await client.placeOrder({
        symbol: strategy.symbol,
        qty: String(config.amountPerGrid),
        side: "SELL",
        tradeSide: "CLOSE",
        orderType: "MARKET",
        leverage: config.leverage || 1,
        positionType: 2,
      });

      tradeLog = {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        side: "SELL",
        orderType: "MARKET",
        quantity: config.amountPerGrid,
        price: currentPrice,
        status: result?.code === "0" ? "filled" : "error",
        orderId: result?.data?.orderId || null,
        pnl: null,
        errorMsg: result?.code !== "0" ? (result?.msg || "Unknown error") : null,
      };
    } catch (e: any) {
      tradeLog = {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        side: "SELL",
        orderType: "MARKET",
        quantity: config.amountPerGrid,
        price: currentPrice,
        status: "error",
        orderId: null,
        pnl: null,
        errorMsg: e.message,
      };
    }
  }

  if (tradeLog) {
    await storage.createTradeLog(tradeLog);
  }
}

async function executeDCAStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as {
    buyAmount: number;
    intervalMinutes: number;
    maxBuys: number;
    leverage: number;
  };

  const lastRun = strategy.lastRunAt;
  const now = new Date();
  const intervalMs = (config.intervalMinutes || 60) * 60 * 1000;

  if (lastRun && (now.getTime() - new Date(lastRun).getTime()) < intervalMs) {
    return;
  }

  if (config.maxBuys && (strategy.totalTrades || 0) >= config.maxBuys) {
    await storage.updateStrategy(strategy.id, { status: "stopped" });
    return;
  }

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) throw new Error(`Cannot get price for ${strategy.symbol}`);

  let tradeLog: InsertTradeLog;
  try {
    const side = strategy.side === "SHORT" ? "SELL" : "BUY";
    const tradeSide = "OPEN";

    const result = await client.placeOrder({
      symbol: strategy.symbol,
      qty: String(config.buyAmount),
      side,
      tradeSide,
      orderType: "MARKET",
      leverage: config.leverage || 1,
      positionType: 2,
    });

    tradeLog = {
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side,
      orderType: "MARKET",
      quantity: config.buyAmount,
      price: ticker.lastPrice,
      status: result?.code === "0" ? "filled" : "error",
      orderId: result?.data?.orderId || null,
      pnl: null,
      errorMsg: result?.code !== "0" ? (result?.msg || "Unknown error") : null,
    };
  } catch (e: any) {
    tradeLog = {
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: strategy.side === "SHORT" ? "SELL" : "BUY",
      orderType: "MARKET",
      quantity: config.buyAmount,
      price: ticker.lastPrice,
      status: "error",
      orderId: null,
      pnl: null,
      errorMsg: e.message,
    };
  }

  await storage.createTradeLog(tradeLog);
  await storage.updateStrategy(strategy.id, {
    lastRunAt: now,
    totalTrades: (strategy.totalTrades || 0) + 1,
  });
}

async function executeMomentumStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as {
    threshold: number; // % change to trigger
    amount: number;
    leverage: number;
    cooldownMinutes: number;
  };

  const lastRun = strategy.lastRunAt;
  const now = new Date();
  const cooldown = (config.cooldownMinutes || 15) * 60 * 1000;

  if (lastRun && (now.getTime() - new Date(lastRun).getTime()) < cooldown) {
    return;
  }

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return;

  const changePercent = Math.abs(ticker.change24h);
  if (changePercent < (config.threshold || 2)) {
    return;
  }

  const side = ticker.change24h > 0 ? "BUY" : "SELL";
  const tradeSide = "OPEN";

  let tradeLog: InsertTradeLog;
  try {
    const result = await client.placeOrder({
      symbol: strategy.symbol,
      qty: String(config.amount),
      side,
      tradeSide,
      orderType: "MARKET",
      leverage: config.leverage || 1,
      positionType: 2,
    });

    tradeLog = {
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side,
      orderType: "MARKET",
      quantity: config.amount,
      price: ticker.lastPrice,
      status: result?.code === "0" ? "filled" : "error",
      orderId: result?.data?.orderId || null,
      pnl: null,
      errorMsg: result?.code !== "0" ? (result?.msg || "Unknown error") : null,
    };
  } catch (e: any) {
    tradeLog = {
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side,
      orderType: "MARKET",
      quantity: config.amount,
      price: ticker.lastPrice,
      status: "error",
      orderId: null,
      pnl: null,
      errorMsg: e.message,
    };
  }

  await storage.createTradeLog(tradeLog);
  await storage.updateStrategy(strategy.id, {
    lastRunAt: now,
    totalTrades: (strategy.totalTrades || 0) + 1,
  });
}

const lastGridTrades = new Map<number, { price: number; time: number }>();

async function guardedExecuteGridStrategy(strategy: Strategy) {
  const last = lastGridTrades.get(strategy.id);
  const now = Date.now();
  if (last && (now - last.time) < 60_000) {
    return;
  }
  await executeGridStrategy(strategy);
}

const strategyExecutors: Record<string, (strategy: Strategy) => Promise<void>> = {
  grid: guardedExecuteGridStrategy,
  dca: executeDCAStrategy,
  momentum: executeMomentumStrategy,
};

let intervalId: NodeJS.Timeout | null = null;

export async function runStrategyCycle() {
  const activeStrategies = await storage.getStrategiesByStatus("running");

  for (const strategy of activeStrategies) {
    const executor = strategyExecutors[strategy.type];
    if (!executor) {
      console.error(`Unknown strategy type: ${strategy.type}`);
      continue;
    }

    try {
      await executor(strategy);
    } catch (e: any) {
      console.error(`Error executing strategy ${strategy.id} (${strategy.name}):`, e.message);
      await storage.updateStrategy(strategy.id, { status: "error" });
      await storage.createTradeLog({
        strategyId: strategy.id,
        symbol: strategy.symbol,
        side: "BUY",
        orderType: "MARKET",
        quantity: 0,
        price: null,
        status: "error",
        orderId: null,
        pnl: null,
        errorMsg: e.message,
      });
    }
  }
}

export function startStrategyEngine() {
  if (intervalId) return;
  console.log("Strategy engine started (30s cycle)");
  intervalId = setInterval(runStrategyCycle, 30_000);
  runStrategyCycle();
}

export function stopStrategyEngine() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("Strategy engine stopped");
  }
}
