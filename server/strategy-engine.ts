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

export function calculateOptimizedGrid(currentPrice: number, feeRate: number = 0.0006) {
  const roundTripFee = 2 * feeRate;
  const targetProfitFeeRatio = 3;
  const minGridRatio = 1 + targetProfitFeeRatio * roundTripFee;

  const upperPrice = currentPrice * 1.10;
  const lowerPrice = currentPrice / 1.10;

  const leverage = Math.floor(currentPrice / (currentPrice - lowerPrice));
  const safeLeverage = Math.min(Math.max(leverage, 1), 125);
  const actualLowerPrice = currentPrice * (1 - 1 / safeLeverage);

  const priceRange = upperPrice / actualLowerPrice;
  const gridCount = Math.floor(Math.log(priceRange) / Math.log(minGridRatio));

  const safeGridCount = Math.max(gridCount, 1);
  const actualGridRatio = Math.pow(priceRange, 1 / safeGridCount);
  const profitPerGrid = actualGridRatio - 1;
  const feePerGrid = roundTripFee;
  const netProfitPerGrid = profitPerGrid - feePerGrid;

  const gridsAbove = Math.floor(Math.log(upperPrice / currentPrice) / Math.log(actualGridRatio));
  const gridsBelow = safeGridCount - gridsAbove;

  return {
    upperPrice,
    lowerPrice: actualLowerPrice,
    leverage: safeLeverage,
    gridCount: safeGridCount,
    gridRatio: actualGridRatio,
    profitPerGrid,
    feePerGrid,
    netProfitPerGrid,
    profitToFeeRatio: profitPerGrid / feePerGrid,
    gridsAbove,
    gridsBelow,
    geometric: true,
  };
}

function getGeometricGridLevels(lower: number, upper: number, count: number): number[] {
  const levels: number[] = [];
  const ratio = Math.pow(upper / lower, 1 / count);
  for (let i = 0; i <= count; i++) {
    levels.push(lower * Math.pow(ratio, i));
  }
  return levels;
}

function findNearestGeometricGrids(price: number, levels: number[]): { below: number | null; above: number | null; index: number } {
  let below: number | null = null;
  let above: number | null = null;
  let index = -1;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] <= price) {
      below = levels[i];
      index = i;
    }
    if (levels[i] > price && above === null) {
      above = levels[i];
    }
  }
  return { below, above, index };
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
    geometric?: boolean;
    gridRatio?: number;
  };

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) throw new Error(`Cannot get price for ${strategy.symbol}`);

  const currentPrice = ticker.lastPrice;
  const isGeometric = config.geometric !== false;

  let nearestBelow: number;
  let nearestAbove: number;
  let threshold: number;

  if (isGeometric) {
    const levels = getGeometricGridLevels(config.lowerPrice, config.upperPrice, config.gridCount);
    const nearest = findNearestGeometricGrids(currentPrice, levels);
    if (!nearest.below || !nearest.above) return;
    nearestBelow = nearest.below;
    nearestAbove = nearest.above;
    threshold = (nearestAbove - nearestBelow) * 0.1;
  } else {
    const gridSize = (config.upperPrice - config.lowerPrice) / config.gridCount;
    nearestBelow = config.lowerPrice + Math.floor((currentPrice - config.lowerPrice) / gridSize) * gridSize;
    nearestAbove = nearestBelow + gridSize;
    threshold = gridSize * 0.1;
  }

  const distToBelow = currentPrice - nearestBelow;
  const distToAbove = nearestAbove - currentPrice;

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
      lastGridTrades.set(strategy.id, { price: currentPrice, time: Date.now() });
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
      lastGridTrades.set(strategy.id, { price: currentPrice, time: Date.now() });
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
