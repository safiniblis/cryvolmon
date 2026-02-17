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
  const gridRatio = 1 + targetProfitFeeRatio * roundTripFee;

  const lowerPrice = currentPrice * 0.90;
  const liquidationPrice = currentPrice * 0.88;

  const leverage = Math.floor(currentPrice / (currentPrice - liquidationPrice));
  const safeLeverage = Math.min(Math.max(leverage, 2), 125);

  const gridsBelow = Math.floor(Math.log(currentPrice / lowerPrice) / Math.log(gridRatio));
  const gridsAbove = gridsBelow;
  const gridCount = gridsBelow + gridsAbove;
  const upperPrice = currentPrice * Math.pow(gridRatio, gridsAbove);

  const profitPerGrid = gridRatio - 1;
  const feePerGrid = roundTripFee;
  const netProfitPerGrid = profitPerGrid - feePerGrid;

  return {
    upperPrice,
    lowerPrice,
    liquidationPrice: liquidationPrice,
    leverage: safeLeverage,
    gridCount,
    gridRatio,
    profitPerGrid,
    feePerGrid,
    netProfitPerGrid,
    profitToFeeRatio: profitPerGrid / feePerGrid,
    gridsAbove,
    gridsBelow,
    startPrice: currentPrice,
    geometric: true,
  };
}

function getGeometricGridLevels(lower: number, upper: number, gridRatio: number): number[] {
  const levels: number[] = [];
  let price = lower;
  while (price <= upper * 1.0001) {
    levels.push(price);
    price *= gridRatio;
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

export interface GridConfig {
  upperPrice: number;
  lowerPrice: number;
  liquidationPrice: number;
  gridCount: number;
  amountPerGrid: number;
  leverage: number;
  geometric: boolean;
  gridRatio: number;
  startPrice: number;
  gridsAbove: number;
  gridsBelow: number;
  extensionsBelow: number;
  extensionsAbove: number;
}

async function executeGridStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as GridConfig;

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) throw new Error(`Cannot get price for ${strategy.symbol}`);

  const currentPrice = ticker.lastPrice;
  const levels = getGeometricGridLevels(config.lowerPrice, config.upperPrice, config.gridRatio);
  const nearest = findNearestGeometricGrids(currentPrice, levels);

  if (!nearest.below || !nearest.above) return;

  const nearestBelow = nearest.below;
  const nearestAbove = nearest.above;
  const gridSpan = nearestAbove - nearestBelow;
  const threshold = gridSpan * 0.1;

  const distToBelow = currentPrice - nearestBelow;
  const distToAbove = nearestAbove - currentPrice;
  const isBelowStart = currentPrice < config.startPrice;
  const isAboveStart = currentPrice > config.startPrice;

  let tradeLog: InsertTradeLog | null = null;
  let shouldExtend = false;
  let extendDirection: "below" | "above" | null = null;

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

      if (isBelowStart && result?.code === "0") {
        shouldExtend = true;
        extendDirection = "below";
      }
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

      if (isAboveStart && result?.code === "0") {
        shouldExtend = true;
        extendDirection = "above";
      }
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

  if (shouldExtend && extendDirection) {
    const updatedConfig = { ...config };

    if (extendDirection === "below") {
      const newLower = config.lowerPrice / config.gridRatio;
      const liqRatio = config.startPrice > 0 ? config.liquidationPrice / config.lowerPrice : 0.98;
      const newLiquidation = newLower * liqRatio;
      const newLeverage = Math.floor(config.startPrice / (config.startPrice - newLiquidation));
      updatedConfig.lowerPrice = newLower;
      updatedConfig.liquidationPrice = newLiquidation;
      updatedConfig.leverage = Math.min(Math.max(newLeverage, 2), 125);
      updatedConfig.gridCount = updatedConfig.gridCount + 1;
      updatedConfig.gridsBelow = (updatedConfig.gridsBelow || 0) + 1;
      updatedConfig.extensionsBelow = (updatedConfig.extensionsBelow || 0) + 1;
      console.log(`[Grid ${strategy.id}] Extended lower: ${config.lowerPrice.toFixed(2)} → ${newLower.toFixed(2)}, liq: ${newLiquidation.toFixed(2)}, leverage: ${updatedConfig.leverage}x`);
    } else {
      const newUpper = config.upperPrice * config.gridRatio;
      updatedConfig.upperPrice = newUpper;
      updatedConfig.gridCount = updatedConfig.gridCount + 1;
      updatedConfig.gridsAbove = (updatedConfig.gridsAbove || 0) + 1;
      updatedConfig.extensionsAbove = (updatedConfig.extensionsAbove || 0) + 1;
      console.log(`[Grid ${strategy.id}] Extended upper: ${config.upperPrice.toFixed(2)} → ${newUpper.toFixed(2)}`);
    }

    await storage.updateStrategy(strategy.id, { config: updatedConfig });
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
