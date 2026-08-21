import { getBitunixClient } from "./bitunix";
import { storage } from "./storage";
import type { Strategy, InsertTradeLog } from "@shared/schema";
import { priceFeed } from "./ws-price-feed";
import { managedParam } from "./managed-params";
import { tandemCellFor, tandemGridRatio, isTandemCellReservedNear, hasPendingCloseAtPrice } from "./order-coordinator";

interface TickerData {
  symbol: string;
  lastPrice: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
}

export interface PairPrecision {
  basePrecision: number;
  quotePrecision: number;
  minTradeVolume: number;
  maxLeverage: number;
}

const precisionCache: Map<string, PairPrecision> = new Map();

export async function getPairPrecision(symbol: string): Promise<PairPrecision> {
  const cached = precisionCache.get(symbol);
  if (cached) return cached;

  const client = getBitunixClient();
  if (!client) return { basePrecision: 2, quotePrecision: 3, minTradeVolume: 0.1, maxLeverage: 75 };

  try {
    const res = await client.getTradingPairs(symbol);
    if (res?.code === 0 && res.data?.[0]) {
      const p = res.data[0];
      const precision: PairPrecision = {
        basePrecision: parseInt(p.basePrecision || "2"),
        quotePrecision: parseInt(p.quotePrecision || "3"),
        minTradeVolume: parseFloat(p.minTradeVolume || "0.1"),
        maxLeverage: parseInt(p.maxLeverage || "75"),
      };
      precisionCache.set(symbol, precision);
      return precision;
    }
  } catch (e: any) {
    console.error(`[Precision] Failed to fetch for ${symbol}:`, e.message);
  }
  return { basePrecision: 2, quotePrecision: 3, minTradeVolume: 0.1, maxLeverage: 75 };
}

function roundQty(qty: number, precision: number): string {
  return qty.toFixed(precision);
}

function roundPrice(price: number, precision: number): string {
  return price.toFixed(precision);
}

const activeGridOrders: Map<number, Map<string, { orderId: string; price: number; side: "BUY" | "SELL"; level: number }>> = new Map();
const initialBuyLocks: Set<number> = new Set();

async function getTickerPrice(symbol: string): Promise<TickerData | null> {
  const wsPrice = priceFeed.getLastPrice(symbol);
  if (wsPrice && wsPrice > 0) {
    return {
      symbol,
      lastPrice: wsPrice,
      high24h: 0,
      low24h: 0,
      volume24h: 0,
      change24h: 0,
    };
  }

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

export function calculateOptimizedGrid(currentPrice: number, feeRate: number = 0.0006, overrideFeeMultiplier?: number) {
  const roundTripFee = 2 * feeRate;
  const targetProfitFeeRatio = overrideFeeMultiplier ?? 4.0;
  const baseGridRatio = 1 + targetProfitFeeRatio * roundTripFee;

  const gapGrowthBelow = 1.05;
  const gapShrinkAbove = 1.05;

  const lowerTarget = currentPrice * 0.90;
  const upperTarget = currentPrice * 1.02;

  const belowLevels = generateAsymmetricLevels(currentPrice, lowerTarget, baseGridRatio, gapGrowthBelow, "below");
  const aboveLevels = generateAsymmetricLevels(currentPrice, upperTarget, baseGridRatio, gapShrinkAbove, "above");

  const lowerPrice = belowLevels.length > 0 ? belowLevels[belowLevels.length - 1] : lowerTarget;
  const upperPrice = aboveLevels.length > 0 ? aboveLevels[aboveLevels.length - 1] : upperTarget;
  const gridsBelow = belowLevels.length;
  const gridsAbove = aboveLevels.length;
  const gridCount = gridsBelow + gridsAbove;

  const liquidationPrice = lowerPrice * 0.98;
  const leverage = Math.floor(currentPrice / (currentPrice - liquidationPrice));
  const safeLeverage = Math.min(Math.max(leverage, 2), 125);

  const profitPerGrid = baseGridRatio - 1;
  const feePerGrid = roundTripFee;
  const netProfitPerGrid = profitPerGrid - feePerGrid;

  return {
    upperPrice,
    lowerPrice,
    liquidationPrice,
    leverage: safeLeverage,
    gridCount,
    baseGridRatio,
    gridRatio: baseGridRatio,
    gapGrowthBelow,
    gapShrinkAbove,
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

function generateAsymmetricLevels(
  startPrice: number,
  targetBound: number,
  baseRatio: number,
  scalingFactor: number,
  direction: "above" | "below"
): number[] {
  const levels: number[] = [];
  const baseGap = baseRatio - 1;
  let price = startPrice;
  let step = 0;

  if (direction === "below") {
    while (price > targetBound) {
      const gap = baseGap * Math.pow(scalingFactor, step);
      price = price / (1 + gap);
      if (price >= targetBound * 0.999) {
        levels.push(price);
      }
      step++;
      if (step > 500) break;
    }
  } else {
    while (price < targetBound) {
      const gap = baseGap * Math.pow(scalingFactor, step);
      price = price * (1 + gap);
      if (price <= targetBound * 1.001) {
        levels.push(price);
      }
      step++;
      if (step > 500) break;
    }
  }
  return levels;
}

function getAsymmetricGridLevels(config: GridConfig): number[] {
  const baseGap = config.gridRatio - 1;
  const gapGrowth = config.gapGrowthBelow || 1.05;
  const gapShrink = config.gapShrinkAbove || 1.05;

  const belowLevels: number[] = [];
  let price = config.startPrice;
  let step = 0;
  while (price > config.lowerPrice * 0.999) {
    const gap = baseGap * Math.pow(gapGrowth, step);
    price = price / (1 + gap);
    if (price >= config.lowerPrice * 0.999) {
      belowLevels.push(price);
    }
    step++;
    if (step > 500) break;
  }

  const aboveLevels: number[] = [];
  price = config.startPrice;
  step = 0;
  while (price < config.upperPrice * 1.001) {
    const gap = baseGap * Math.pow(gapShrink, step);
    price = price * (1 + gap);
    if (price <= config.upperPrice * 1.001) {
      aboveLevels.push(price);
    }
    step++;
    if (step > 500) break;
  }

  const allLevels = [...belowLevels.reverse(), config.startPrice, ...aboveLevels];
  return allLevels;
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
  gapGrowthBelow: number;
  gapShrinkAbove: number;
  startPrice: number;
  gridsAbove: number;
  gridsBelow: number;
  extensionsBelow: number;
  extensionsAbove: number;
  allocatedBudget?: number;
  lastTrackedPnl?: number;
  lastTrackedPositionId?: string | null;
  lastTpEntryPrice?: number;
  lastTpPositionQty?: number;
  lastTpPlacedAt?: number;
  lastTpCount?: number;
  tpReservePct?: number;
  tpConsumedAtQty?: number;
  trailingTpEnabled?: boolean;
  trailingTpHwm?: number;
  trailingTpOrderId?: string;
  trailingTpPct?: number;
  feeMultiplier?: number;
  gridSide?: "LONG" | "SHORT";
  parentTandemId?: number;
  twinMode?: boolean;
  twinGapPct?: number;
}

export async function placeInitialGridBuy(strategy: Strategy): Promise<{ success: boolean; message: string; orderId?: string }> {
  const client = getBitunixClient();
  if (!client) return { success: false, message: "Bitunix client not configured" };

  const config = strategy.config as GridConfig & { initialBuyDone?: boolean };
  const isShort = config.gridSide === "SHORT";
  const posSide = isShort ? "SELL" : "BUY";
  const label = isShort ? "InitialSell" : "InitialBuy";
  const precision = await getPairPrecision(strategy.symbol);
  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return { success: false, message: `Cannot get price for ${strategy.symbol}` };

  const currentPrice = ticker.lastPrice;
  const leverage = config.leverage || 8;
  const bandPct = 0.01;

  try {
    const accountRes = await client.getAccount();
    if (accountRes?.code !== 0 || !accountRes?.data) {
      return { success: false, message: "Cannot fetch account balance" };
    }
    const accountAvailable = parseFloat(accountRes.data.available || "0");
    if (accountAvailable < 1) {
      return { success: false, message: `Insufficient balance: ${accountAvailable.toFixed(2)} USDT. Need at least 1 USDT.` };
    }

    const isTandemChild = !!(config as any).parentTandemId;
    const budget = config.allocatedBudget && config.allocatedBudget > 0
      ? (isTandemChild ? config.allocatedBudget : Math.min(config.allocatedBudget, accountAvailable))
      : accountAvailable;
    console.log(`[${label} ${strategy.id}] Account available=${accountAvailable.toFixed(2)}, allocatedBudget=${config.allocatedBudget || 'none'}, tandemChild=${isTandemChild}, using budget=${budget.toFixed(2)} USDT`);

    try {
      const tpRes = await client.getPendingTpslOrders(strategy.symbol);
      if (tpRes?.code === 0) {
        let tpList = tpRes.data;
        if (tpList && !Array.isArray(tpList) && Array.isArray(tpList.orderList)) {
          tpList = tpList.orderList;
        }
        if (Array.isArray(tpList) && tpList.length > 0) {
          let cancelled = 0;
          for (const tp of tpList) {
            const tpId = tp.id || tp.orderId;
            if (!tpId) continue;
            try { await client.cancelTpslOrder(strategy.symbol, tpId); cancelled++; } catch {}
          }
          console.log(`[${label} ${strategy.id}] Cleaned up ${cancelled}/${tpList.length} leftover TP/SL orders for ${strategy.symbol}`);
        }
      }
    } catch (e: any) {
      console.log(`[${label} ${strategy.id}] TP cleanup note:`, e.message);
    }

    try {
      await client.setMarginMode(strategy.symbol, "ISOLATION");
    } catch (e: any) {
      console.log(`[${label} ${strategy.id}] Margin mode note:`, e.message);
    }
    try {
      await client.setLeverage(strategy.symbol, leverage);
    } catch (e: any) {
      console.log(`[${label} ${strategy.id}] Leverage note:`, e.message);
    }

    const allLevels = getAsymmetricGridLevels(config);
    const gridLevels = isShort
      ? allLevels.filter(l => l > currentPrice)
      : allLevels.filter(l => l < currentPrice);
    const totalGridCount = gridLevels.length;

    if (!config.lowerPrice) config.lowerPrice = currentPrice * (isShort ? 0.98 : 0.90);
    if (!config.upperPrice) config.upperPrice = currentPrice * (isShort ? 1.10 : 1.02);
    if (!config.liquidationPrice) config.liquidationPrice = currentPrice * (isShort ? 1.12 : 0.88);

    const fixedInitialQty = (config as any).fixedInitialQty;
    const fixedInitialShare = (config as any).fixedInitialShare;
    const minTpCount = 5;
    const tpReserve = managedParam(config, "tpReservePct", 0.10);
    const minInitialQty = (minTpCount * precision.minTradeVolume) / (1 - tpReserve);
    const minInitialMargin = (minInitialQty * currentPrice) / (leverage * 0.95);
    const initialSharePct = managedParam(config, "initialSharePct", 0.25);
    const initialShare = fixedInitialShare || Math.max(minInitialMargin, budget * initialSharePct);
    const remainingForGrids = budget - initialShare;
    const marginPerGrid = totalGridCount > 0 ? remainingForGrids / totalGridCount : remainingForGrids;
    config.amountPerGrid = marginPerGrid;

    const initialNotional = initialShare * leverage * 0.95;
    const baseQty = Math.max(initialNotional / currentPrice, minInitialQty);
    const qtyStr = fixedInitialQty || roundQty(baseQty, precision.basePrecision);

    console.log(`[${label} ${strategy.id}] Budget=${budget.toFixed(2)} USDT, leverage=${leverage}x, side=${posSide}, totalGridLevels=${totalGridCount}, initialShare=${initialShare.toFixed(2)}, marginPerGrid=${marginPerGrid.toFixed(4)}, initialNotional=${initialNotional.toFixed(2)}, qty=${qtyStr}${fixedInitialQty ? ' (fixed)' : ''} @ ${currentPrice}, range=[${config.lowerPrice.toFixed(2)}-${config.upperPrice.toFixed(2)}]`);

    let gridInitCount = 0;
    const result = await client.placeOrder({
      symbol: strategy.symbol,
      qty: qtyStr,
      side: posSide,
      tradeSide: "OPEN",
      orderType: "MARKET",
    });

    console.log(`[${label} ${strategy.id}] Order result:`, JSON.stringify(result));

    const success = result?.code === 0;
    const orderId = result?.data?.orderId;

    if (success) {
      await new Promise(r => setTimeout(r, 1500));

      let fillPrice = currentPrice;
      try {
        const posRes = await client.getPositions(strategy.symbol);
        if (posRes?.code === 0 && Array.isArray(posRes.data)) {
          const pos = posRes.data.find((p: any) => String(p.symbol || "").toUpperCase() === strategy.symbol.toUpperCase() && p.side === posSide && parseFloat(p.qty || "0") > 0);
          if (pos) {
            const ep = parseFloat(pos.entryPrice || pos.avgPrice || "0");
            if (ep > 0) fillPrice = ep;
          }
        }
      } catch {}
      console.log(`[${label} ${strategy.id}] Fill price: ${fillPrice.toFixed(precision.quotePrecision)} (ticker was ${currentPrice.toFixed(precision.quotePrecision)})`);

      config.startPrice = fillPrice;
      const postLevels = getAsymmetricGridLevels({ ...config, startPrice: fillPrice });
      const postGridLevels = isShort
        ? postLevels.filter(l => l > fillPrice && l <= config.upperPrice)
        : postLevels.filter(l => l < fillPrice && l >= config.lowerPrice);
      const gridLevelsIn1Pct = isShort
        ? postGridLevels.filter(l => l <= fillPrice * (1 + bandPct))
        : postGridLevels.filter(l => l >= fillPrice * (1 - bandPct));
      gridInitCount = gridLevelsIn1Pct.length;

      try {
        await storage.createTradeLog({
          strategyId: strategy.id,
          symbol: strategy.symbol,
          side: posSide,
          orderType: "MARKET",
          quantity: fixedInitialQty ? parseFloat(fixedInitialQty) : baseQty,
          price: fillPrice,
          status: "filled",
          orderId: orderId || null,
          pnl: null,
          errorMsg: null,
        });
      } catch (e: any) {
        console.warn(`[${label} ${strategy.id}] Fill log failed after exchange success; continuing state update: ${e.message}`);
      }

      config.allocatedBudget = budget;
      config.lastTrackedPnl = 0;
      console.log(`[${label} ${strategy.id}] Set allocatedBudget=${budget.toFixed(2)} USDT`);
      await storage.updateStrategy(strategy.id, {
        totalTrades: (strategy.totalTrades || 0) + 1,
        config: { ...config, initialBuyDone: true, startPrice: fillPrice, lowerPrice: config.lowerPrice, upperPrice: config.upperPrice, liquidationPrice: config.liquidationPrice, amountPerGrid: config.amountPerGrid, allocatedBudget: config.allocatedBudget, lastTrackedPnl: 0 },
      });

      if (isTandemChild) {
        console.log(`[${label} ${strategy.id}] Tandem child: skipping grid limit orders during initial buy (grid cycle will handle them)`);
      } else {
        let remainingBalance = 0;
        try {
          const postAccount = await client.getAccount();
          if (postAccount?.code === 0 && postAccount?.data) {
            remainingBalance = parseFloat(postAccount.data.available || "0");
          }
        } catch {}

        const remainingBudget = Math.min(remainingBalance, budget - initialShare);
        const gridMarginEach = gridInitCount > 0 ? Math.max(0, remainingBudget) / gridInitCount : marginPerGrid;
        const gridOrderSide = isShort ? "SELL" : "BUY";
        console.log(`[${label} ${strategy.id}] Now placing ${gridInitCount} limit ${gridOrderSide} orders within 1% of fill price ${fillPrice.toFixed(precision.quotePrecision)}... (remainingBudget=${remainingBudget.toFixed(2)}, marginEach=${gridMarginEach.toFixed(4)} USDT)`);
        let placed = 0;
        const minExchangeMargin = (precision.minTradeVolume * fillPrice) / (leverage * 0.95);
        for (const level of gridLevelsIn1Pct) {
          if (remainingBalance < minExchangeMargin * 0.9) {
            console.log(`[${label} ${strategy.id}] Stopping grid orders: insufficient remaining balance (${remainingBalance.toFixed(2)} USDT)`);
            break;
          }
          const gridNotional = Math.max(gridMarginEach, minExchangeMargin) * leverage * 0.95;
          const gridQty = Math.max(gridNotional / level, precision.minTradeVolume);
          const gridQtyStr = roundQty(gridQty, precision.basePrecision);
          const priceStr = roundPrice(level, precision.quotePrecision);

          try {
            const gridResult = await client.placeOrder({
              symbol: strategy.symbol,
              qty: gridQtyStr,
              side: gridOrderSide,
              tradeSide: "OPEN",
              orderType: "LIMIT",
              price: priceStr,
              effect: "GTC",
            });

            if (gridResult?.code === 0 && gridResult.data?.orderId) {
              const orders = activeGridOrders.get(strategy.id) || new Map();
              orders.set(`${gridOrderSide}_${priceStr}`, {
                orderId: gridResult.data.orderId,
                price: level,
                side: gridOrderSide,
                level,
              });
              activeGridOrders.set(strategy.id, orders);
              placed++;
              console.log(`[${label} ${strategy.id}] Placed ${gridOrderSide} ${gridQtyStr} @ ${priceStr}`);
            } else {
              console.error(`[${label} ${strategy.id}] Grid ${gridOrderSide} failed @ ${priceStr}: ${gridResult?.msg}`);
            }
          } catch (e: any) {
            console.error(`[${label} ${strategy.id}] Grid ${gridOrderSide} error @ ${priceStr}:`, e.message);
          }
        }
        console.log(`[${label} ${strategy.id}] Placed ${placed}/${gridInitCount} grid ${gridOrderSide} orders`);
      }
    } else {
      await storage.createTradeLog({
        strategyId: strategy.id,
        symbol: strategy.symbol,
        side: posSide,
        orderType: "MARKET",
        quantity: fixedInitialQty ? parseFloat(fixedInitialQty) : baseQty,
        price: currentPrice,
        status: "error",
        orderId: orderId || null,
        pnl: null,
        errorMsg: result?.msg || "Order failed",
      });
    }

    return {
      success,
      message: success
        ? `${isShort ? "Sold" : "Bought"} ${qtyStr} ${strategy.symbol} at ~$${currentPrice.toFixed(2)} (${initialNotional.toFixed(2)} USDT notional, ${leverage}x, ${gridInitCount} grid orders reserved)`
        : (result?.msg || "Order placement failed"),
      orderId,
    };
  } catch (e: any) {
    console.error(`[${label} ${strategy.id}] Error:`, e);
    return { success: false, message: e.message };
  }
}

async function executeGridStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as GridConfig & { initialBuyDone?: boolean };
  const isShort = config.gridSide === "SHORT";
  const posSide = isShort ? "SELL" : "BUY";
  const gridOrderSide = isShort ? "SELL" : "BUY";
  const oppositeSide = isShort ? "BUY" : "SELL";
  const tag = isShort ? `GridS ${strategy.id}` : `Grid ${strategy.id}`;

  if (!config.startPrice || !config.lowerPrice || !config.upperPrice) {
    const ticker = await getTickerPrice(strategy.symbol);
    if (ticker) {
      const cp = ticker.lastPrice;
      if (!config.startPrice) config.startPrice = cp;
      if (!config.lowerPrice) config.lowerPrice = cp * (isShort ? 0.98 : 0.90);
      if (!config.upperPrice) config.upperPrice = cp * (isShort ? 1.10 : 1.02);
      if (!config.liquidationPrice) config.liquidationPrice = cp * (isShort ? 1.12 : 0.88);
      if (!config.amountPerGrid) config.amountPerGrid = 2;
      await storage.updateStrategy(strategy.id, { config });
    }
  }

  if (!config.initialBuyDone) {
    try {
      const positionRes = await client.getPositions(strategy.symbol);
      const existingPosition = Array.isArray(positionRes?.data)
        ? positionRes.data.find((position: any) =>
            String(position.symbol || "").toUpperCase() === strategy.symbol.toUpperCase()
            && position.side === posSide
            && parseFloat(position.qty || "0") > 0,
          )
        : null;
      if (existingPosition) {
        const existingPrice = parseFloat(existingPosition.avgOpenPrice || existingPosition.entryPrice || existingPosition.avgPrice || "0");
        await storage.updateStrategy(strategy.id, {
          config: {
            ...config,
            initialBuyDone: true,
            ...(existingPrice > 0 ? { startPrice: existingPrice } : {}),
          },
        });
        console.log(`[${tag}] Existing exchange position detected (${existingPosition.qty}); marked initial entry complete without another market order.`);
        return;
      }
    } catch (e: any) {
      console.warn(`[${tag}] Existing position check failed before initial entry: ${e.message}`);
    }
    if (initialBuyLocks.has(strategy.id)) {
      console.log(`[${tag}] Initial position already in progress, skipping...`);
      return;
    }
    initialBuyLocks.add(strategy.id);
    try {
      console.log(`[${tag}] No initial position yet, placing...`);
      const result = await placeInitialGridBuy(strategy);
      console.log(`[${tag}] Initial position result: ${result.message}`);
      if (!result.success) {
        console.error(`[${tag}] Initial position failed: ${result.message}`);
      }
    } finally {
      initialBuyLocks.delete(strategy.id);
    }
    return;
  }

  const precision = await getPairPrecision(strategy.symbol);

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) throw new Error(`Cannot get price for ${strategy.symbol}`);

  const currentPrice = ticker.lastPrice;

  const isTandemChildEarly = !!(config as any).parentTandemId;
  if (isTandemChildEarly) {
    const leverage = config.leverage || 33;
    const liqDist = 1 / leverage;
    const gridRange = liqDist * 0.85;
    const newLower = isShort ? currentPrice * (1 - liqDist * 0.5) : currentPrice * (1 - gridRange);
    const newUpper = isShort ? currentPrice * (1 + gridRange) : currentPrice * (1 + liqDist * 0.5);
    if (config.lowerPrice && config.upperPrice) {
      const oldMid = (config.lowerPrice + config.upperPrice) / 2;
      const drift = Math.abs(currentPrice - oldMid) / oldMid;
      const lastRangeShift = (config as any).lastRangeShiftAt || 0;
      const rangeShiftCooldown = 120_000;
      const timeSinceShift = Date.now() - lastRangeShift;
      const driftThreshold = 0.008;

      if (drift > driftThreshold && timeSinceShift >= rangeShiftCooldown) {
        const lastShiftPrice = (config as any).lastRangeShiftPrice || oldMid;
        const priceVelocity = Math.abs(currentPrice - lastShiftPrice) / lastShiftPrice;
        if (priceVelocity > 0.005 && timeSinceShift < rangeShiftCooldown * 3) {
          (config as any).lastRangeShiftPrice = currentPrice;
          await storage.updateStrategy(strategy.id, { config });
        } else {
          config.startPrice = currentPrice;
          config.lowerPrice = newLower;
          config.upperPrice = newUpper;
          config.liquidationPrice = isShort ? currentPrice * (1 + liqDist) : currentPrice * (1 - liqDist);
          (config as any).lastRangeShiftAt = Date.now();
          (config as any).lastRangeShiftPrice = currentPrice;
          await storage.updateStrategy(strategy.id, { config });
        }
      }
    }
  }

  const levels = getAsymmetricGridLevels(config);

  const lowerBound = config.lowerPrice || currentPrice * (isShort ? 0.98 : 0.90);
  const upperBound = config.upperPrice || currentPrice * (isShort ? 1.10 : 1.02);

  const feeRate = 0.0006;
  const roundTripFee = 2 * feeRate;
  const cfgFeeMultiplier = managedParam(config, "feeMultiplier", 3.5);
  const twinMode = config.twinMode === true;
  const twinGapPct = config.twinGapPct || 0.006;
  const minProfitableGap = twinMode ? twinGapPct / 2 : roundTripFee * cfgFeeMultiplier;
  const tpStartGap = twinMode ? twinGapPct : minProfitableGap;

  const gridLevels = isShort
    ? levels.filter(l => l >= currentPrice * (1 + minProfitableGap) && l <= upperBound)
    : levels.filter(l => l <= currentPrice * (1 - minProfitableGap) && l >= lowerBound).reverse();

  let openOrders: any[] = [];
  try {
    const res = await client.getOpenOrders(strategy.symbol);
    if (res?.code === 0) {
      if (Array.isArray(res.data)) {
        openOrders = res.data;
      } else if (res.data?.orderList && Array.isArray(res.data.orderList)) {
        openOrders = res.data.orderList;
      }
      console.log(`[${tag}] Open orders on exchange: ${openOrders.length} (sides: ${openOrders.map((o: any) => `${o.side}@${o.price}`).join(', ')})`);
    }
  } catch (e: any) {
    console.error(`[${tag}] Failed to fetch open orders:`, e.message);
  }

  let positionId: string | null = null;
  let positionQty = 0;
  let positionEntryPrice = 0;
  let posRealizedPnl = 0;
  let posFee = 0;
  let posFunding = 0;
  let positionActualMargin = 0;
  try {
    const posRes = await client.getPositions(strategy.symbol);
    if (posRes?.code === 0 && Array.isArray(posRes.data) && posRes.data.length > 0) {
      const pos = posRes.data.find((p: any) => String(p.symbol || "").toUpperCase() === strategy.symbol.toUpperCase() && p.side === posSide);
      if (pos) {
        positionId = pos.positionId;
        positionQty = parseFloat(pos.qty || "0");
        positionEntryPrice = parseFloat(pos.entryPrice || pos.avgPrice || "0");
        posRealizedPnl = parseFloat(pos.realizedPNL || "0");
        posFee = parseFloat(pos.fee || "0");
        posFunding = parseFloat(pos.funding || "0");
        positionActualMargin = parseFloat(pos.margin || "0");
      }
    }
  } catch (e: any) {
    console.error(`[${tag}] Failed to fetch positions:`, e.message);
  }

  const isTandemChild = !!(config as any).parentTandemId;

  // Tandem children share one parent's order-coordination cells. Read the
  // parent config once so cell keys match the parent's close reservations.
  let tandemParentId = 0;
  let tandemAnchor = 0;
  let tandemRatio = 1;
  let inventoryRecoveryMultiplier = 1;
  let inventoryRecoveryReservePct = managedParam(config, "tpReservePct", 0.10);
  if (isTandemChild) {
    const rawParentId = Number((config as any).parentTandemId);
    if (Number.isInteger(rawParentId) && rawParentId > 0) {
      try {
        const parent = await storage.getStrategy(rawParentId);
        const parentCfg = (parent?.config || {}) as any;
        tandemParentId = rawParentId;
        const parentEntry = Number(parentCfg.entryPrice || 0);
        tandemAnchor = parentEntry > 0 ? parentEntry : 0;
        tandemRatio = tandemGridRatio(parentCfg);
        const targetQty = Number(parentCfg.initialPositionTargetQty || 0);
        const tolerance = Math.max(0.02, Math.min(0.5, Number(parentCfg.inventoryTolerancePct ?? 0.10)));
        const recoveryMax = Math.max(1, Math.min(1.5, Number(parentCfg.inventoryRecoveryMaxMultiplier ?? 1.5)));
        if (parentCfg.inventoryTargetEnabled !== false && targetQty > 0) {
          if (positionQty < targetQty * (1 - tolerance)) {
            const gap = (targetQty - positionQty) / targetQty;
            inventoryRecoveryMultiplier = 1 + Math.min(recoveryMax - 1, gap);
            inventoryRecoveryReservePct = Math.min(0.5, Math.max(inventoryRecoveryReservePct, gap * 0.5));
          } else if (positionQty > targetQty * (1 + tolerance)) {
            inventoryRecoveryMultiplier = Math.max(0.5, 1 - Math.min(0.5, (positionQty - targetQty) / targetQty));
          }
          console.log(`[${tag}] Inventory target ${targetQty.toFixed(2)}; current ${positionQty.toFixed(2)}; open sizing x${inventoryRecoveryMultiplier.toFixed(2)}; TP reserve ${(inventoryRecoveryReservePct * 100).toFixed(0)}%`);
        }
      } catch (e: any) {
        console.warn(`[${tag}] Tandem parent fetch failed: ${e.message}`);
      }
    }
  }

  const maxGridWindow = isTandemChild ? 6 : gridLevels.length;
  const windowedGridLevels = gridLevels
    .map(l => ({ level: l, dist: Math.abs(l - currentPrice) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, maxGridWindow)
    .map(g => g.level);
  const desiredGridPrices = new Set(windowedGridLevels.map(l => roundPrice(l, precision.quotePrecision)));
  const ordersToCancel: string[] = [];
  const coveredGridPrices = new Set<string>();

  for (const order of openOrders) {
    const orderPrice = roundPrice(parseFloat(order.price || "0"), precision.quotePrecision);
    const orderSide = order.side;

    if (orderSide === oppositeSide) {
      if (!isTandemChild) {
        ordersToCancel.push(order.orderId);
      }
      continue;
    }

    if (orderSide === gridOrderSide && desiredGridPrices.has(orderPrice)) {
      if (coveredGridPrices.has(orderPrice)) {
        ordersToCancel.push(order.orderId);
      } else {
        coveredGridPrices.add(orderPrice);
      }
    } else if (orderSide === gridOrderSide) {
      ordersToCancel.push(order.orderId);
    }
  }

  if (ordersToCancel.length > 0) {
    try {
      await client.post("/api/v1/futures/trade/cancel_orders", {
        symbol: strategy.symbol,
        orderList: ordersToCancel.map(id => ({ orderId: id })),
      });
      console.log(`[${tag}] Cancelled ${ordersToCancel.length} unwanted orders`);
    } catch (e: any) {
      console.error(`[${tag}] Cancel error:`, e.message);
    }
  }

  let accountAvailable = 0;
  try {
    const accountRes = await client.getAccount();
    if (accountRes?.code === 0 && accountRes?.data) {
      accountAvailable = parseFloat(accountRes.data.available || "0");
    }
  } catch {}

  let allocatedBudget = config.allocatedBudget || 0;
  const isTandemChildBudget = !!(config as any).parentTandemId;

  if (allocatedBudget > 0 && !isTandemChildBudget) {
    const lastTrackedPnl = config.lastTrackedPnl ?? 0;
    const lastTrackedPositionId = config.lastTrackedPositionId || null;

    if (positionId) {
      const netPnl = posRealizedPnl + posFee + posFunding;

      if (lastTrackedPositionId && lastTrackedPositionId !== positionId) {
        config.lastTrackedPnl = 0;
        config.lastTrackedPositionId = positionId;
        console.log(`[${tag}] Position changed (${lastTrackedPositionId} -> ${positionId}), reset PnL tracking`);
      }

      const trackBase = (lastTrackedPositionId === positionId) ? lastTrackedPnl : 0;
      const pnlDelta = netPnl - trackBase;

      if (Math.abs(pnlDelta) > 0.001) {
        allocatedBudget += pnlDelta;
        config.allocatedBudget = Math.max(0, allocatedBudget);
        config.lastTrackedPnl = netPnl;
        config.lastTrackedPositionId = positionId;
        console.log(`[${tag}] PnL adjustment: delta=${pnlDelta > 0 ? "+" : ""}${pnlDelta.toFixed(4)} -> budget=${config.allocatedBudget.toFixed(2)}`);
        await storage.updateStrategy(strategy.id, { config });
      }
    } else if (lastTrackedPositionId) {
      config.lastTrackedPnl = 0;
      config.lastTrackedPositionId = null;
      console.log(`[${tag}] Position closed, reset PnL tracking. Budget remains at ${allocatedBudget.toFixed(2)}`);
      await storage.updateStrategy(strategy.id, { config });
    }
  }

  const positionMargin = positionActualMargin > 0
    ? positionActualMargin
    : (positionQty > 0 && positionEntryPrice > 0
      ? (positionQty * positionEntryPrice) / (config.leverage || 8)
      : 0);
  const effectiveAllocated = allocatedBudget > 0
    ? Math.max(0, allocatedBudget - positionMargin)
    : 0;
  let availableBalance = allocatedBudget > 0 ? Math.min(accountAvailable, effectiveAllocated) : accountAvailable;

  // Tandem children share one fixed parent budget. Cap combined margin so
  // profitable cycles cannot silently increase the capital available to either side.
  if (isTandemChildBudget) {
    const parentId = Number((config as any).parentTandemId);
    const parent = Number.isInteger(parentId) ? await storage.getStrategy(parentId) : undefined;
    const parentCapital = Number((parent?.config as any)?.totalCapital || 0);
    if (parentCapital > 0) {
      let combinedMargin = 0;
      try {
        const positionsRes = await client.getPositions(strategy.symbol);
        const positions = (Array.isArray(positionsRes?.data) ? positionsRes.data : [])
          .filter((position: any) => String(position.symbol || "").toUpperCase() === strategy.symbol.toUpperCase());
        combinedMargin = positions.reduce((sum: number, position: any) => {
          const qty = Math.abs(parseFloat(position.qty || position.volume || position.quantity || "0"));
          if (qty <= 0) return sum;
          const explicitMargin = parseFloat(position.margin || position.positionMargin || position.isolatedMargin || "0");
          if (explicitMargin > 0) return sum + explicitMargin;
          const entry = parseFloat(position.avgOpenPrice || position.entryPrice || position.avgPrice || "0");
          const positionLeverage = parseFloat(position.leverage || config.leverage || "1");
          return sum + (entry > 0 && positionLeverage > 0 ? (qty * entry) / positionLeverage : 0);
        }, 0);
      } catch (e: any) {
        console.warn(`[${tag}] Tandem budget position check unavailable: ${e.message}`);
      }
      const parentRemaining = Math.max(0, parentCapital - combinedMargin);
      availableBalance = Math.min(availableBalance, parentRemaining);
      console.log(`[${tag}] Tandem parent cap: total=${parentCapital.toFixed(2)}, combinedMargin=${combinedMargin.toFixed(2)}, remaining=${parentRemaining.toFixed(2)}`);
    }
  }

  if (allocatedBudget > 0) {
    console.log(`[${tag}] Budget cap: account=${accountAvailable.toFixed(2)}, allocated=${allocatedBudget.toFixed(2)}, posMargin=${positionMargin.toFixed(2)}, effective=${effectiveAllocated.toFixed(2)}, capped to ${availableBalance.toFixed(2)}`);
  }

  const lastTpPosQty = config.lastTpPositionQty || 0;
  const tpWasHit = lastTpPosQty > 0 && positionQty < lastTpPosQty * 0.98;
  if (tpWasHit) {
    const qtyFreed = lastTpPosQty - positionQty;
    console.log(`[${tag}] TP hit detected: position ${lastTpPosQty} -> ${positionQty} (freed ${qtyFreed.toFixed(precision.basePrecision)} qty).`);
  }

  const activeGridLevels = isTandemChild ? windowedGridLevels : gridLevels;
  const missingGridLevels = activeGridLevels.filter(l => !coveredGridPrices.has(roundPrice(l, precision.quotePrecision)));
  const leverage = config.leverage || 8;
  const minMarginPerOrder = (precision.minTradeVolume * currentPrice) / (leverage * 0.95);
  const storedAmountPerGrid = config.amountPerGrid || 0;
  const marginPerOrder = storedAmountPerGrid > minMarginPerOrder
    ? storedAmountPerGrid
    : (missingGridLevels.length > 0
      ? Math.max(minMarginPerOrder, (availableBalance - 0.1) / Math.max(missingGridLevels.length, gridLevels.length))
      : minMarginPerOrder);
  const usableBalance = availableBalance - 0.1;

  const levelsToFill = usableBalance >= minMarginPerOrder
    ? missingGridLevels.length
    : 0;
  const gridSlice = missingGridLevels.slice(0, levelsToFill);

  if (missingGridLevels.length > 0 && levelsToFill === 0 && coveredGridPrices.size === 0) {
    console.log(`[${tag}] No balance for grid orders: ${availableBalance.toFixed(2)} USDT (need ${minMarginPerOrder.toFixed(2)} min per grid)`);
  }

  const gridSizeMultiplier = Math.max(0.5, Math.min(1.5, managedParam(config, "gridSizeMultiplier", 1)));

  let placedGrids = 0;
  for (const level of gridSlice) {
    // A tandem parent may have a close/reduce pending in this cell (or a CLOSE
    // order resting near this price). Skip the open so it does not churn fees
    // by offsetting the parent's close at the same grid level.
    if (tandemParentId > 0 && tandemAnchor > 0) {
      const cell = tandemCellFor(level, tandemAnchor, tandemRatio);
      if (isTandemCellReservedNear(tandemParentId, tandemAnchor, tandemRatio, level, 1) || hasPendingCloseAtPrice(openOrders, level)) {
        console.log(`[${tag}] Skipping ${gridOrderSide} open @ ${roundPrice(level, precision.quotePrecision)}: tandem close pending near cell ${cell}`);
        continue;
      }
    }
    const rawMargin = Math.min(marginPerOrder, (availableBalance - 0.1) * 0.95);
    const effectiveMargin = Math.min(rawMargin * gridSizeMultiplier * inventoryRecoveryMultiplier, (availableBalance - 0.1) * 0.95);
    if (effectiveMargin < minMarginPerOrder * 0.9) break;
    const notional = effectiveMargin * leverage * 0.95;
    const qtyBase = notional / level;
    const qty = Math.max(qtyBase, precision.minTradeVolume);
    const qtyStr = roundQty(qty, precision.basePrecision);
    const priceStr = roundPrice(level, precision.quotePrecision);

    try {
      const result = await client.placeOrder({
        symbol: strategy.symbol,
        qty: qtyStr,
        side: gridOrderSide,
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: priceStr,
        effect: "GTC",
      });

      if (result?.code === 0 && result.data?.orderId) {
        placedGrids++;
        availableBalance -= effectiveMargin;
      } else {
        console.error(`[${tag}] ${gridOrderSide} failed @ ${priceStr}: ${result?.msg}`);
      }
    } catch (e: any) {
      console.error(`[${tag}] ${gridOrderSide} error @ ${priceStr}:`, e.message);
    }
  }

  let placedTps = 0;
  let cancelledTps = 0;

  const tpRefPrice = positionEntryPrice > 0 ? positionEntryPrice : config.startPrice;
  const tpLevels: number[] = [];

  if (isShort) {
    const maxTpPrice = tpRefPrice * (1 - tpStartGap);
    const tpLowerLimit = Math.min(currentPrice * 0.97, maxTpPrice * 0.995);
    let tp = maxTpPrice;
    while (tp >= tpLowerLimit) {
      tpLevels.push(tp);
      tp /= (1 + minProfitableGap);
    }
  } else {
    const minTpPrice = tpRefPrice * (1 + tpStartGap);
    const tpUpperLimit = Math.max(currentPrice * 1.03, minTpPrice * 1.005);
    let tp = minTpPrice;
    while (tp <= tpUpperLimit) {
      tpLevels.push(tp);
      tp *= (1 + minProfitableGap);
    }
  }

  const maxTpLevels = Math.max(
    Math.floor(positionQty / precision.minTradeVolume),
    1
  );
  const activeTpLevels = tpLevels.slice(0, maxTpLevels);

  console.log(`[${tag}] Price: ${currentPrice.toFixed(4)} | Entry: ${tpRefPrice.toFixed(4)} | TP levels: ${activeTpLevels.length}/${tpLevels.length} | Grid levels: ${gridLevels.length}`);

  if (positionId && positionQty > 0 && activeTpLevels.length > 0) {
    const lastTpEntry = config.lastTpEntryPrice || 0;
    const lastTpPosQty = config.lastTpPositionQty || 0;
    const lastTpTime = config.lastTpPlacedAt || 0;
    const lastTpCount = config.lastTpCount || 0;
    const now = Date.now();

    let liveTpCount = 0;
    let liveTpOrders: any[] = [];
    try {
      const tpRes = await client.getPendingTpslOrders(strategy.symbol);
      if (tpRes?.code === 0) {
        let rawData = tpRes.data;
        if (rawData && !Array.isArray(rawData) && Array.isArray(rawData.orderList)) {
          rawData = rawData.orderList;
        }
        if (Array.isArray(rawData)) {
          liveTpOrders = rawData.filter((t: any) => t.positionId === positionId);
          liveTpCount = liveTpOrders.length;
        }
      }
    } catch (e: any) {
      console.error(`[${tag}] Check live TPs error:`, e.message);
    }

    const hasTpsPlaced = lastTpCount > 0 && lastTpTime > 0;
    const tpsMissing = hasTpsPlaced && liveTpCount === 0;
    const hasDuplicates = hasTpsPlaced && liveTpCount > lastTpCount + 2;
    const tpsPartiallyConsumed = hasTpsPlaced && liveTpCount < lastTpCount && liveTpCount > 0;
    const cooldownOk = (now - lastTpTime) > 120000;

    const entryDrifted = hasTpsPlaced && lastTpEntry > 0 && Math.abs(tpRefPrice - lastTpEntry) / lastTpEntry > minProfitableGap * 0.5;

    let staleTpCount = 0;
    if (liveTpCount > 0 && positionEntryPrice > 0) {
      const minSafeTp = isShort
        ? positionEntryPrice * (1 - tpStartGap)
        : positionEntryPrice * (1 + tpStartGap);
      for (const tp of liveTpOrders) {
        const tpTrigger = parseFloat(tp.tpPrice || tp.triggerPrice || tp.price || "0");
        if (tpTrigger > 0) {
          const isStale = isShort ? tpTrigger > minSafeTp : tpTrigger < minSafeTp;
          if (isStale) staleTpCount++;
        }
      }
    }

    const needsRebuild = !hasTpsPlaced || hasDuplicates || entryDrifted || staleTpCount > 0;
    const needsFullRebuild = tpsMissing && cooldownOk;

    if (tpsMissing && !cooldownOk) {
      config.lastTpCount = 0;
      await storage.updateStrategy(strategy.id, { config });
      console.log(`[${tag}] All TPs consumed — cooldown active, will rebuild full position TPs after 2min`);
    } else if (tpsPartiallyConsumed && !needsRebuild && !needsFullRebuild) {
      config.lastTpCount = liveTpCount;
      config.lastTpPositionQty = positionQty;
      await storage.updateStrategy(strategy.id, { config });
      console.log(`[${tag}] TPs partially filled: ${liveTpCount}/${lastTpCount} remain — keeping existing, updated count`);
    } else if (!needsRebuild && !needsFullRebuild) {
      console.log(`[${tag}] TPs stable: ${liveTpCount} live on exchange (saved=${lastTpCount}) at entry ${lastTpEntry.toFixed(4)} for qty ${lastTpPosQty} — no changes`);
    } else {
      const tpQtyBasis = positionQty;
      let reason: string;

      if (needsFullRebuild) {
        reason = `all TPs consumed — rebuilding for full position (${positionQty.toFixed(precision.basePrecision)})`;
      } else if (staleTpCount > 0) {
        reason = `${staleTpCount} stale TPs below safe distance from entry ${tpRefPrice.toFixed(4)} (gap=${(minProfitableGap * 100).toFixed(3)}%)`;
      } else if (entryDrifted) {
        reason = `entry drifted: was ${lastTpEntry.toFixed(4)} now ${tpRefPrice.toFixed(4)} (>${(minProfitableGap * 50).toFixed(2)}%)`;
      } else if (!hasTpsPlaced) {
        reason = "first TP placement";
      } else if (hasDuplicates) {
        reason = `duplicates (saved=${lastTpCount}, live=${liveTpCount})`;
      } else {
        reason = "rebuild";
      }

      console.log(`[${tag}] TP action: ${reason}`);

      if (needsRebuild || hasDuplicates || needsFullRebuild) {
        for (const tp of liveTpOrders) {
          const tpId = tp.id || tp.orderId;
          if (tpId) {
            try {
              await client.cancelTpslOrder(strategy.symbol, tpId);
              cancelledTps++;
            } catch (e: any) {
              console.error(`[${tag}] Cancel TP ${tpId} error:`, e.message);
            }
          }
        }
        if (liveTpOrders.length > 0) {
          console.log(`[${tag}] Cancelled ${cancelledTps}/${liveTpOrders.length} existing TPs`);
        }
      }

      const tpReservePct = Math.min(Math.max(inventoryRecoveryReservePct, 0), 0.5);
      const sellableQty = tpQtyBasis * (1 - tpReservePct);

      const basePrecisionMultiplier = Math.pow(10, precision.basePrecision);

      const maxTpFromQty = Math.max(Math.floor(sellableQty / precision.minTradeVolume), 1);
      const cappedTpLevels = activeTpLevels.slice(0, Math.min(activeTpLevels.length, maxTpFromQty));

      const tpQtyPerLevel = Math.max(
        Math.floor((sellableQty / cappedTpLevels.length) * basePrecisionMultiplier) / basePrecisionMultiplier,
        precision.minTradeVolume
      );

      let levelsToPlace = cappedTpLevels;
      if (tpQtyPerLevel * cappedTpLevels.length > sellableQty * 1.02) {
        const maxLevels = Math.floor(sellableQty / tpQtyPerLevel);
        levelsToPlace = cappedTpLevels.slice(0, Math.max(maxLevels, 1));
      }

      if (sellableQty < precision.minTradeVolume) {
        console.log(`[${tag}] Sellable qty too small for TPs (${sellableQty.toFixed(precision.basePrecision)} < minVol ${precision.minTradeVolume}) — skipping`);
        await storage.updateStrategy(strategy.id, { config });
      } else {
        const lastLevelQty = Math.max(
          Math.round((sellableQty - tpQtyPerLevel * (levelsToPlace.length - 1)) * basePrecisionMultiplier) / basePrecisionMultiplier,
          precision.minTradeVolume
        );

        console.log(`[${tag}] Placing ${levelsToPlace.length} TP orders, ${tpQtyPerLevel.toFixed(precision.basePrecision)} each (basis: ${tpQtyBasis.toFixed(precision.basePrecision)}, sellable: ${sellableQty.toFixed(precision.basePrecision)}, entry: ${tpRefPrice.toFixed(4)})`);

        for (let i = 0; i < levelsToPlace.length; i++) {
          const level = levelsToPlace[i];
          const isLast = i === levelsToPlace.length - 1;
          const qty = isLast ? lastLevelQty : tpQtyPerLevel;
          const qtyStr = qty.toFixed(precision.basePrecision);
          const priceStr = roundPrice(level, precision.quotePrecision);
          try {
            const result = await client.placeTpslOrder({
              symbol: strategy.symbol,
              positionId,
              tpPrice: priceStr,
              tpStopType: "LAST_PRICE",
              tpOrderType: "LIMIT",
              tpOrderPrice: priceStr,
              tpQty: qtyStr,
            });
            if (result?.code === 0) {
              placedTps++;
            } else {
              console.error(`[${tag}] TP failed @ ${priceStr} qty=${qtyStr}: ${result?.msg}`);
            }
          } catch (e: any) {
            console.error(`[${tag}] TP error @ ${priceStr}:`, e.message);
          }
        }

        config.lastTpEntryPrice = tpRefPrice;
        config.lastTpPositionQty = positionQty;
        config.lastTpPlacedAt = now;
        config.lastTpCount = placedTps;
        config.tpConsumedAtQty = 0;
        await storage.updateStrategy(strategy.id, { config });
        console.log(`[${tag}] TP state saved: entry=${tpRefPrice.toFixed(4)} qty=${positionQty} placed=${placedTps}/${levelsToPlace.length} total_live=${config.lastTpCount}`);
      }
    }

    const trailingTpPct = managedParam(config, "trailingTpPct", 0.005);
    const trailingEnabled = config.trailingTpEnabled !== false;
    if (trailingEnabled && positionId && positionQty > 0) {
      const reserveQty = positionQty * managedParam(config, "tpReservePct", 0.10);
      const trailingQty = Math.max(
        Math.floor(reserveQty * Math.pow(10, precision.basePrecision)) / Math.pow(10, precision.basePrecision),
        precision.minTradeVolume
      );

      if (trailingQty >= precision.minTradeVolume) {
        let hwm = config.trailingTpHwm || 0;
        let existingOrderId = config.trailingTpOrderId || "";
        let needsUpdate = false;

        if (isShort) {
          if (hwm === 0 || currentPrice < hwm) {
            hwm = currentPrice;
            needsUpdate = true;
          }
        } else {
          if (hwm === 0 || currentPrice > hwm) {
            hwm = currentPrice;
            needsUpdate = true;
          }
        }

        let trailingStillLive = false;
        if (existingOrderId) {
          trailingStillLive = liveTpOrders.some((t: any) => (t.id || t.orderId) === existingOrderId);
          if (!trailingStillLive) {
            console.log(`[${tag}] Trailing TP ${existingOrderId} no longer live (filled or cancelled externally)`);
            existingOrderId = "";
            config.trailingTpOrderId = "";
            needsUpdate = true;
          }
        }

        const trailingTpPrice = isShort
          ? hwm * (1 + trailingTpPct)
          : hwm * (1 - trailingTpPct);

        const shouldBeProfitable = isShort
          ? trailingTpPrice < tpRefPrice
          : trailingTpPrice > tpRefPrice;

        if (!shouldBeProfitable && existingOrderId) {
          try {
            await client.cancelTpslOrder(strategy.symbol, existingOrderId);
            console.log(`[${tag}] Cancelled trailing TP ${existingOrderId} — no longer profitable`);
          } catch (e: any) {
            console.log(`[${tag}] Trailing TP cancel note:`, e.message);
          }
          config.trailingTpOrderId = "";
          config.trailingTpHwm = 0;
          await storage.updateStrategy(strategy.id, { config });
        } else if (shouldBeProfitable && (needsUpdate || !existingOrderId)) {
          if (existingOrderId) {
            try {
              await client.cancelTpslOrder(strategy.symbol, existingOrderId);
              console.log(`[${tag}] Cancelled old trailing TP ${existingOrderId}`);
            } catch (e: any) {
              console.log(`[${tag}] Old trailing TP cancel note:`, e.message);
            }
          }

          const trailingPriceStr = roundPrice(trailingTpPrice, precision.quotePrecision);
          const trailingQtyStr = trailingQty.toFixed(precision.basePrecision);
          try {
            const result = await client.placeTpslOrder({
              symbol: strategy.symbol,
              positionId,
              tpPrice: trailingPriceStr,
              tpStopType: "LAST_PRICE",
              tpOrderType: "MARKET",
              tpQty: trailingQtyStr,
            });
            if (result?.code === 0) {
              config.trailingTpHwm = hwm;
              config.trailingTpOrderId = result.data?.orderId || "";
              await storage.updateStrategy(strategy.id, { config });
              console.log(`[${tag}] Trailing TP: price=${trailingPriceStr} qty=${trailingQtyStr} hwm=${hwm.toFixed(4)} pct=${(trailingTpPct * 100).toFixed(2)}%`);
            } else {
              console.error(`[${tag}] Trailing TP place failed:`, result?.msg);
            }
          } catch (e: any) {
            console.error(`[${tag}] Trailing TP error:`, e.message);
          }
        } else if (!shouldBeProfitable) {
          config.trailingTpHwm = 0;
          await storage.updateStrategy(strategy.id, { config });
          console.log(`[${tag}] Trailing TP: hwm=${hwm.toFixed(4)} but trail price ${trailingTpPrice.toFixed(4)} not profitable vs entry ${tpRefPrice.toFixed(4)} — skipping`);
        } else {
          console.log(`[${tag}] Trailing TP: stable at hwm=${hwm.toFixed(4)} trail=${trailingTpPrice.toFixed(4)} orderId=${existingOrderId}`);
        }
      }
    } else if (config.trailingTpOrderId) {
      try {
        await client.cancelTpslOrder(strategy.symbol, config.trailingTpOrderId);
        console.log(`[${tag}] Cleaned up trailing TP ${config.trailingTpOrderId} (no position/disabled)`);
      } catch (e: any) {
        console.log(`[${tag}] Trailing TP cleanup note:`, e.message);
      }
      config.trailingTpOrderId = "";
      config.trailingTpHwm = 0;
      await storage.updateStrategy(strategy.id, { config });
    }
  }

  const budgetInfo = config.allocatedBudget ? ` | Budget=${config.allocatedBudget.toFixed(2)}` : "";
  console.log(`[${tag}] Price=${currentPrice.toFixed(precision.quotePrecision)} | Side=${posSide} | GridOrders=${gridLevels.length}(live=${coveredGridPrices.size}+${placedGrids}) TPs=${activeTpLevels.length}/${tpLevels.length}(+${placedTps}/-${cancelledTps}) | Cancelled=${ordersToCancel.length} | PosQty=${positionQty} | Avail=${availableBalance.toFixed(2)}${budgetInfo}`);

  await storage.updateStrategy(strategy.id, { lastRunAt: new Date() });
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

export interface SimulationResult {
  symbol: string;
  startPrice: number;
  endPrice: number;
  totalTrades: number;
  buys: number;
  sells: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  maxDrawdown: number;
  leverage: number;
  gridCount: number;
  gridsBelow: number;
  gridsAbove: number;
  priceRange: string;
  trades: { time: number; side: string; price: number; gridLevel: number; pnl: number }[];
}

export function simulateGridStrategy(
  priceHistory: { timestamp: number; price: number }[],
  feeRate: number = 0.0006,
  marginPerGrid: number = 10
): SimulationResult | null {
  if (!priceHistory || priceHistory.length < 3) return null;

  const startPrice = priceHistory[0].price;
  const grid = calculateOptimizedGrid(startPrice, feeRate);
  const levels = generateAllLevels(startPrice, grid.lowerPrice, grid.upperPrice, grid.gridRatio, grid.gapGrowthBelow, grid.gapShrinkAbove);

  if (levels.length < 2) return null;

  const leverage = grid.leverage;
  let position = 0;
  let realizedPnl = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;
  let buys = 0;
  let sells = 0;
  const trades: SimulationResult["trades"] = [];

  const levelLots = new Map<number, { qty: number; price: number }>();

  let lastGridIndex = findGridIndex(startPrice, levels);

  for (let i = 1; i < priceHistory.length; i++) {
    const price = priceHistory[i].price;
    const time = priceHistory[i].timestamp;
    const currentGridIndex = findGridIndex(price, levels);

    if (currentGridIndex === lastGridIndex || currentGridIndex < 0) continue;

    if (currentGridIndex < lastGridIndex) {
      for (let gi = lastGridIndex - 1; gi >= currentGridIndex; gi--) {
        if (gi < 0 || gi >= levels.length) continue;
        if (levelLots.has(gi)) continue;
        const buyPrice = levels[gi];
        const notional = marginPerGrid * leverage;
        const qty = notional / buyPrice;
        const fee = notional * feeRate;
        position += qty;
        realizedPnl -= fee;
        buys++;
        levelLots.set(gi, { qty, price: buyPrice });
        trades.push({ time, side: "BUY", price: buyPrice, gridLevel: gi, pnl: -fee });
      }
    } else if (currentGridIndex > lastGridIndex) {
      for (let gi = lastGridIndex + 1; gi <= currentGridIndex; gi++) {
        if (gi < 0 || gi >= levels.length) continue;
        if (position <= 0) break;

        const sellPrice = levels[gi];
        let soldQty = 0;
        let soldCost = 0;

        const belowLevels = Array.from(levelLots.keys()).filter(k => k < gi).sort((a, b) => b - a);
        if (belowLevels.length === 0) continue;

        const lotKey = belowLevels[0];
        const lot = levelLots.get(lotKey)!;
        soldQty = lot.qty;
        soldCost = lot.qty * lot.price;
        levelLots.delete(lotKey);

        const revenue = soldQty * sellPrice;
        const fee = revenue * feeRate;
        const pnl = (revenue - soldCost) - fee;
        position -= soldQty;
        realizedPnl += pnl;
        sells++;
        trades.push({ time, side: "SELL", price: sellPrice, gridLevel: gi, pnl });
      }
    }

    lastGridIndex = currentGridIndex;

    let totalCost = 0;
    for (const lot of levelLots.values()) {
      totalCost += lot.qty * lot.price;
    }
    const avgEntry = position > 0 ? totalCost / position : 0;
    const equity = realizedPnl + (position * (price - avgEntry));
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
  }

  const endPrice = priceHistory[priceHistory.length - 1].price;
  let totalCostEnd = 0;
  for (const lot of levelLots.values()) {
    totalCostEnd += lot.qty * lot.price;
  }
  const avgEntryEnd = position > 0 ? totalCostEnd / position : endPrice;
  const unrealizedPnl = position * (endPrice - avgEntryEnd);

  return {
    symbol: "",
    startPrice,
    endPrice,
    totalTrades: buys + sells,
    buys,
    sells,
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    maxDrawdown,
    leverage,
    gridCount: grid.gridCount,
    gridsBelow: grid.gridsBelow,
    gridsAbove: grid.gridsAbove,
    priceRange: `${grid.lowerPrice.toFixed(2)} - ${grid.upperPrice.toFixed(2)}`,
    trades,
  };
}

function generateAllLevels(
  startPrice: number, lowerPrice: number, upperPrice: number,
  gridRatio: number, gapGrowthBelow: number, gapShrinkAbove: number
): number[] {
  const baseGap = gridRatio - 1;
  const belowLevels: number[] = [];
  let price = startPrice;
  let step = 0;
  while (price > lowerPrice * 0.999) {
    const gap = baseGap * Math.pow(gapGrowthBelow, step);
    price = price / (1 + gap);
    if (price >= lowerPrice * 0.999) belowLevels.push(price);
    step++;
    if (step > 500) break;
  }

  const aboveLevels: number[] = [];
  price = startPrice;
  step = 0;
  while (price < upperPrice * 1.001) {
    const gap = baseGap * Math.pow(gapShrinkAbove, step);
    price = price * (1 + gap);
    if (price <= upperPrice * 1.001) aboveLevels.push(price);
    step++;
    if (step > 500) break;
  }

  return [...belowLevels.reverse(), startPrice, ...aboveLevels];
}

function findGridIndex(price: number, levels: number[]): number {
  for (let i = 0; i < levels.length - 1; i++) {
    if (price >= levels[i] && price < levels[i + 1]) return i;
  }
  if (price >= levels[levels.length - 1]) return levels.length - 1;
  return 0;
}

export function simulateGridWithGaps(
  priceHistory: { timestamp: number; price: number }[],
  feeRate: number,
  marginPerGrid: number,
  gapGrowthBelow: number,
  gapShrinkAbove: number,
  tpReservePct: number = 0,
  feeMultiplier: number = 2.5
): SimulationResult | null {
  if (!priceHistory || priceHistory.length < 3) return null;

  const startPrice = priceHistory[0].price;
  const roundTripFee = 2 * feeRate;
  const gridRatio = 1 + feeMultiplier * roundTripFee;
  const lowerTarget = startPrice * 0.90;
  const upperTarget = startPrice * 1.02;

  const belowLevels = generateAsymmetricLevels(startPrice, lowerTarget, gridRatio, gapGrowthBelow, "below");
  const aboveLevels = generateAsymmetricLevels(startPrice, upperTarget, gridRatio, gapShrinkAbove, "above");

  const lowerPrice = belowLevels.length > 0 ? belowLevels[belowLevels.length - 1] : lowerTarget;
  const upperPrice = aboveLevels.length > 0 ? aboveLevels[aboveLevels.length - 1] : upperTarget;
  const gridsBelow = belowLevels.length;
  const gridsAbove = aboveLevels.length;

  const liquidationPrice = lowerPrice * 0.98;
  const leverage = Math.min(Math.max(Math.floor(startPrice / (startPrice - liquidationPrice)), 2), 125);

  const levels = generateAllLevels(startPrice, lowerPrice, upperPrice, gridRatio, gapGrowthBelow, gapShrinkAbove);
  if (levels.length < 2) return null;

  let position = 0;
  let realizedPnl = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;
  let buys = 0;
  let sells = 0;
  const trades: SimulationResult["trades"] = [];
  const levelLots = new Map<number, { qty: number; price: number }>();
  let lastGridIndex = findGridIndex(startPrice, levels);

  for (let i = 1; i < priceHistory.length; i++) {
    const price = priceHistory[i].price;
    const time = priceHistory[i].timestamp;
    const currentGridIndex = findGridIndex(price, levels);
    if (currentGridIndex === lastGridIndex || currentGridIndex < 0) continue;

    if (currentGridIndex < lastGridIndex) {
      for (let gi = lastGridIndex - 1; gi >= currentGridIndex; gi--) {
        if (gi < 0 || gi >= levels.length) continue;
        if (levelLots.has(gi)) continue;
        const buyPrice = levels[gi];
        const notional = marginPerGrid * leverage;
        const qty = notional / buyPrice;
        const fee = notional * feeRate;
        position += qty;
        realizedPnl -= fee;
        buys++;
        levelLots.set(gi, { qty, price: buyPrice });
        trades.push({ time, side: "BUY", price: buyPrice, gridLevel: gi, pnl: -fee });
      }
    } else if (currentGridIndex > lastGridIndex) {
      for (let gi = lastGridIndex + 1; gi <= currentGridIndex; gi++) {
        if (gi < 0 || gi >= levels.length) continue;
        if (position <= 0) break;

        const sellPrice = levels[gi];
        const belowKeys = Array.from(levelLots.keys()).filter(k => k < gi).sort((a, b) => b - a);
        if (belowKeys.length === 0) continue;

        const lotKey = belowKeys[0];
        const lot = levelLots.get(lotKey)!;
        const sellQty = lot.qty * (1 - tpReservePct);
        const soldCost = sellQty * lot.price;
        const revenue = sellQty * sellPrice;
        const fee = revenue * feeRate;
        const pnl = (revenue - soldCost) - fee;
        position -= sellQty;
        realizedPnl += pnl;
        sells++;

        if (tpReservePct > 0) {
          const remaining = lot.qty * tpReservePct;
          levelLots.set(lotKey, { qty: remaining, price: lot.price });
        } else {
          levelLots.delete(lotKey);
        }

        trades.push({ time, side: "SELL", price: sellPrice, gridLevel: gi, pnl });
      }
    }

    lastGridIndex = currentGridIndex;
    let totalCost = 0;
    for (const lot of levelLots.values()) totalCost += lot.qty * lot.price;
    const avgEntry = position > 0 ? totalCost / position : 0;
    const equity = realizedPnl + (position * (price - avgEntry));
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
  }

  const endPrice = priceHistory[priceHistory.length - 1].price;
  let totalCostEnd = 0;
  for (const lot of levelLots.values()) totalCostEnd += lot.qty * lot.price;
  const avgEntryEnd = position > 0 ? totalCostEnd / position : endPrice;
  const unrealizedPnl = position * (endPrice - avgEntryEnd);

  return {
    symbol: "",
    startPrice,
    endPrice,
    totalTrades: buys + sells,
    buys,
    sells,
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    maxDrawdown,
    leverage,
    gridCount: gridsBelow + gridsAbove,
    gridsBelow,
    gridsAbove,
    priceRange: `${lowerPrice.toFixed(2)} - ${upperPrice.toFixed(2)}`,
    trades,
  };
}

export function optimizeGapSettings(
  priceHistory: { timestamp: number; price: number }[],
  feeRate: number = 0.0006,
  marginPerGrid: number = 10
) {
  const configs = [
    { name: "symmetric_1.00", below: 1.00, above: 1.00 },
    { name: "symmetric_1.02", below: 1.02, above: 1.02 },
    { name: "symmetric_1.04", below: 1.04, above: 1.04 },
    { name: "symmetric_1.06", below: 1.06, above: 1.06 },
    { name: "current_asym", below: 1.07, above: 0.96 },
    { name: "mild_grow_1.03_1.00", below: 1.03, above: 1.00 },
    { name: "mild_grow_1.05_1.00", below: 1.05, above: 1.00 },
    { name: "grow_both_1.03", below: 1.03, above: 1.03 },
    { name: "grow_both_1.05", below: 1.05, above: 1.05 },
    { name: "shrink_above_0.98", below: 1.00, above: 0.98 },
    { name: "slight_asym_1.03_0.99", below: 1.03, above: 0.99 },
    { name: "moderate_asym_1.05_0.98", below: 1.05, above: 0.98 },
  ];

  const tpReserveOptions = [0, 0.05, 0.10, 0.15];

  const results: {
    config: string;
    gapBelow: number;
    gapAbove: number;
    tpReserve: number;
    totalPnl: number;
    realizedPnl: number;
    unrealizedPnl: number;
    maxDrawdown: number;
    trades: number;
    buys: number;
    sells: number;
    gridsBelow: number;
    gridsAbove: number;
    score: number;
  }[] = [];

  for (const cfg of configs) {
    for (const reserve of tpReserveOptions) {
      const sim = simulateGridWithGaps(priceHistory, feeRate, marginPerGrid, cfg.below, cfg.above, reserve);
      if (!sim) continue;

      const score = sim.totalPnl - sim.maxDrawdown * 0.5;

      results.push({
        config: cfg.name,
        gapBelow: cfg.below,
        gapAbove: cfg.above,
        tpReserve: reserve,
        totalPnl: sim.totalPnl,
        realizedPnl: sim.realizedPnl,
        unrealizedPnl: sim.unrealizedPnl,
        maxDrawdown: sim.maxDrawdown,
        trades: sim.totalTrades,
        buys: sim.buys,
        sells: sim.sells,
        gridsBelow: sim.gridsBelow,
        gridsAbove: sim.gridsAbove,
        score,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export function optimizeFeeMultiplier(
  priceHistory: { timestamp: number; price: number }[],
  feeRate: number = 0.0006,
  marginPerGrid: number = 10,
  gapGrowthBelow: number = 1.05,
  gapShrinkAbove: number = 1.05,
  tpReservePct: number = 0.10
) {
  const multipliers = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0, 5.0];
  const roundTripFee = 2 * feeRate;

  const results: {
    feeMultiplier: number;
    gridGap: string;
    gridCount: number;
    totalPnl: number;
    realizedPnl: number;
    unrealizedPnl: number;
    maxDrawdown: number;
    totalTrades: number;
    buys: number;
    sells: number;
    totalFees: number;
    profitPerTrade: number;
    score: number;
  }[] = [];

  for (const mult of multipliers) {
    const sim = simulateGridWithGaps(priceHistory, feeRate, marginPerGrid, gapGrowthBelow, gapShrinkAbove, tpReservePct, mult);
    if (!sim) continue;

    const gridGapPct = mult * roundTripFee * 100;
    const totalFees = sim.totalTrades * marginPerGrid * (sim.leverage || 8) * feeRate;
    const profitPerTrade = sim.totalTrades > 0 ? sim.realizedPnl / sim.totalTrades : 0;
    const score = sim.totalPnl - sim.maxDrawdown * 0.5;

    results.push({
      feeMultiplier: mult,
      gridGap: `${gridGapPct.toFixed(3)}%`,
      gridCount: sim.gridCount,
      totalPnl: sim.totalPnl,
      realizedPnl: sim.realizedPnl,
      unrealizedPnl: sim.unrealizedPnl,
      maxDrawdown: sim.maxDrawdown,
      totalTrades: sim.totalTrades,
      buys: sim.buys,
      sells: sim.sells,
      totalFees,
      profitPerTrade,
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export interface VolatilityScore {
  symbol: string;
  name: string;
  score: number;
  swings1to5: number;
  largeSwingsUp: number;
  largeSwingsDown: number;
  riskGauge: number;
  currentPrice: number;
  bitunixSymbol: string;
  score4h: number;
  priceChange24h: number;
}

function computeSwings(history: { timestamp: number; price: number }[], startIdx: number = 0) {
  let swings1to5 = 0;
  let largeSwingsUp = 0;
  let largeSwingsDown = 0;
  for (let i = Math.max(startIdx, 1); i < history.length; i++) {
    const prev = history[i - 1].price;
    const curr = history[i].price;
    if (!prev) continue;
    const changePct = ((curr - prev) / prev) * 100;
    const absChange = Math.abs(changePct);
    if (absChange >= 1 && absChange <= 5) {
      swings1to5++;
    } else if (absChange > 5) {
      if (changePct > 0) largeSwingsUp++;
      else largeSwingsDown++;
    }
  }
  return { swings1to5, largeSwingsUp, largeSwingsDown };
}

export function computeVolatilityScores(
  cryptoStats: { symbol: string; name: string; currentPrice: number; priceHistory: { timestamp: number; price: number }[] | null }[]
): VolatilityScore[] {
  const scores: VolatilityScore[] = [];

  for (const coin of cryptoStats) {
    const history = coin.priceHistory;
    if (!history || history.length < 2) continue;

    const full = computeSwings(history);

    const now = Date.now();
    const fourHoursAgo = now - 4 * 60 * 60 * 1000;
    const idx4h = history.findIndex(h => h.timestamp >= fourHoursAgo);
    const swings4h = idx4h >= 1 ? computeSwings(history, idx4h) : { swings1to5: 0, largeSwingsUp: 0, largeSwingsDown: 0 };

    const oldestPrice = history[0]?.price || 0;
    const latestPrice = history[history.length - 1]?.price || coin.currentPrice || 0;
    const priceChange24h = oldestPrice > 0 ? ((latestPrice - oldestPrice) / oldestPrice) * 100 : 0;

    const riskGauge = full.largeSwingsDown > 0
      ? full.largeSwingsUp / full.largeSwingsDown
      : (full.largeSwingsUp > 0 ? 10 : 1);

    const sym = coin.symbol.toUpperCase();
    const bitunixSymbol = sym + "USDT";

    scores.push({
      symbol: coin.symbol,
      name: coin.name,
      score: full.swings1to5,
      swings1to5: full.swings1to5,
      largeSwingsUp: full.largeSwingsUp,
      largeSwingsDown: full.largeSwingsDown,
      riskGauge,
      currentPrice: coin.currentPrice || 0,
      bitunixSymbol,
      score4h: swings4h.swings1to5,
      priceChange24h,
    });
  }

  return scores.sort((a, b) => b.score - a.score);
}

export async function checkPairRotation(strategy: Strategy): Promise<{ shouldRotate: boolean; newSymbol?: string; reason?: string }> {
  const config = strategy.config as GridConfig & { rotationEnabled?: boolean };
  if (!config.rotationEnabled) return { shouldRotate: false };

  const stats = await storage.getCryptoStats();
  const scores = computeVolatilityScores(
    stats.map(s => ({
      symbol: s.symbol,
      name: s.name,
      currentPrice: s.currentPrice || 0,
      priceHistory: s.priceHistory as any,
    }))
  );

  const currentSymbolBase = strategy.symbol.replace("USDT", "").toLowerCase();
  const currentScore = scores.find(s => s.symbol.toLowerCase() === currentSymbolBase);
  if (!currentScore) return { shouldRotate: false };

  const client = getBitunixClient();
  let availablePairs: Set<string> = new Set();
  if (client) {
    try {
      const pairsRes = await client.getTradingPairs();
      if (pairsRes?.data) {
        for (const p of pairsRes.data) {
          availablePairs.add(p.symbol || p.pair || "");
        }
      }
    } catch { }
  }

  for (const candidate of scores) {
    if (candidate.symbol.toLowerCase() === currentSymbolBase) continue;
    if (availablePairs.size > 0 && !availablePairs.has(candidate.bitunixSymbol)) continue;

    if (candidate.score >= currentScore.score * 2) {
      if (candidate.riskGauge < 1 && candidate.largeSwingsDown > candidate.largeSwingsUp) {
        continue;
      }

      return {
        shouldRotate: true,
        newSymbol: candidate.bitunixSymbol,
        reason: `${candidate.name} score ${candidate.score} vs current ${currentScore.score} (${currentScore.name}). Risk: ${candidate.riskGauge.toFixed(1)}`,
      };
    }
  }

  return { shouldRotate: false };
}

export async function executePairRotation(strategy: Strategy, newSymbol: string, reason: string) {
  const client = getBitunixClient();
  if (!client) return;

  console.log(`[Rotation ${strategy.id}] Starting rotation from ${strategy.symbol} to ${newSymbol}: ${reason}`);

  try {
    await cancelAllGridOrders(strategy.id, strategy.symbol);
    console.log(`[Rotation ${strategy.id}] Cancelled all orders/TPs for ${strategy.symbol}`);
  } catch (e: any) {
    console.error(`[Rotation ${strategy.id}] Cancel orders error:`, e.message);
  }

  try {
    const posRes = await client.getPositions(strategy.symbol);
    if (posRes?.code === 0 && Array.isArray(posRes.data)) {
      for (const pos of posRes.data) {
        if (String(pos.symbol || "").toUpperCase() !== strategy.symbol.toUpperCase()) continue;
        if (pos.positionId && parseFloat(pos.qty || "0") > 0) {
          await client.flashClose(pos.positionId);
          console.log(`[Rotation ${strategy.id}] Flash closed position ${pos.positionId} on ${strategy.symbol}`);
        }
      }
    }
  } catch (e: any) {
    console.error(`[Rotation ${strategy.id}] Failed to close ${strategy.symbol}:`, e.message);
  }

  const ticker = await getTickerPrice(newSymbol);
  if (!ticker) {
    console.error(`[Rotation ${strategy.id}] Cannot get price for ${newSymbol}`);
    return;
  }

  const newGrid = calculateOptimizedGrid(ticker.lastPrice);
  const oldConfig = strategy.config as GridConfig;

  const newConfig: GridConfig & { initialBuyDone?: boolean } = {
    ...oldConfig,
    upperPrice: newGrid.upperPrice,
    lowerPrice: newGrid.lowerPrice,
    liquidationPrice: newGrid.liquidationPrice,
    gridCount: newGrid.gridCount,
    leverage: newGrid.leverage,
    gridRatio: newGrid.gridRatio,
    gapGrowthBelow: newGrid.gapGrowthBelow,
    gapShrinkAbove: newGrid.gapShrinkAbove,
    startPrice: newGrid.startPrice,
    gridsAbove: newGrid.gridsAbove,
    gridsBelow: newGrid.gridsBelow,
    extensionsBelow: 0,
    extensionsAbove: 0,
    initialBuyDone: false,
    lastTpCount: 0,
    lastTpEntryPrice: 0,
    lastTpPositionQty: 0,
    lastTpPlacedAt: 0,
    lastTrackedPnl: 0,
    lastTrackedPositionId: null,
  };

  await storage.updateStrategy(strategy.id, {
    symbol: newSymbol,
    config: newConfig,
  });

  priceFeed.subscribe(newSymbol);

  await storage.createTradeLog({
    strategyId: strategy.id,
    symbol: newSymbol,
    side: "BUY",
    orderType: "MARKET",
    quantity: 0,
    price: ticker.lastPrice,
    status: "filled",
    orderId: null,
    pnl: null,
    errorMsg: `Rotation: ${reason}`,
  });

  console.log(`[Rotation ${strategy.id}] Switched to ${newSymbol} at ${ticker.lastPrice} — will place initial buy next cycle`);
}

const lastRotationCheck = new Map<number, number>();

async function guardedExecuteGridStrategy(strategy: Strategy) {
  const last = lastGridTrades.get(strategy.id);
  const now = Date.now();
  if (last && (now - last.time) < 60_000) {
    return;
  }

  const lastRotation = lastRotationCheck.get(strategy.id) || 0;
  if (now - lastRotation > 5 * 60 * 1000) {
    lastRotationCheck.set(strategy.id, now);
    const rotation = await checkPairRotation(strategy);
    if (rotation.shouldRotate && rotation.newSymbol) {
      await executePairRotation(strategy, rotation.newSymbol, rotation.reason || "Score-based rotation");
      return;
    }
  }

  await executeGridStrategy(strategy);
}


import { executeTandemStrategy } from "./tandem-engine";
import { executeHedgePairStrategy } from "./hedge-pair-engine";
import { executeGoldLongStrategy } from "./gold-long-engine";

const strategyExecutors: Record<string, (strategy: Strategy) => Promise<void>> = {
  grid: guardedExecuteGridStrategy,
  dca: executeDCAStrategy,
  momentum: executeMomentumStrategy,
  tandem: executeTandemStrategy,
  hedge_pair: executeHedgePairStrategy,
  gold_long: executeGoldLongStrategy,
};

let intervalId: NodeJS.Timeout | null = null;
let cycleRunning = false;

export async function runStrategyCycle() {
  if (cycleRunning) {
    return;
  }
  cycleRunning = true;
  try {
    const activeStrategies = await storage.getStrategiesByStatus("running");
    console.log(`[Strategy Cycle] Found ${activeStrategies.length} running strategies`);

    for (const strategy of activeStrategies) {
      const executor = strategyExecutors[strategy.type];
      if (!executor) {
        console.error(`Unknown strategy type: ${strategy.type}`);
        continue;
      }

      try {
        console.log(`[Strategy ${strategy.id}] Executing ${strategy.name} (${strategy.symbol})`);
        await storage.updateStrategy(strategy.id, { lastRunAt: new Date() });
        await executor(strategy);
        (strategy as any)._consecutiveErrors = 0;
      } catch (e: any) {
        const errorCount = ((strategy as any)._consecutiveErrors || 0) + 1;
        (strategy as any)._consecutiveErrors = errorCount;
        console.error(`Error executing strategy ${strategy.id} (${strategy.name}) [${errorCount}/5]:`, e.message);
        if (errorCount >= 5) {
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
            errorMsg: `${errorCount} consecutive errors: ${e.message}`,
          });
        } else {
          console.log(`[Strategy ${strategy.id}] Will retry next cycle (${errorCount}/5 before error state)`);
          try { await storage.updateStrategy(strategy.id, { lastRunAt: new Date() }); } catch {}
        }
      }
    }
  } finally {
    cycleRunning = false;
  }
}

export async function cancelAllGridOrders(strategyId: number, symbol: string) {
  const client = getBitunixClient();
  if (!client) return;

  try {
    const cancelRes = await client.cancelAllOrders(symbol);
    console.log(`[Grid ${strategyId}] Cancel all limit orders: code=${cancelRes?.code}`);
  } catch (e: any) {
    console.error(`[Grid ${strategyId}] Cancel limit orders error:`, e.message);
  }

  try {
    const tpslRes = await client.getPendingTpslOrders(symbol);
    if (tpslRes?.code === 0) {
      let tpList = tpslRes.data;
      if (tpList && !Array.isArray(tpList) && Array.isArray(tpList.orderList)) {
        tpList = tpList.orderList;
      }
      if (Array.isArray(tpList) && tpList.length > 0) {
        let cancelled = 0;
        for (const tp of tpList) {
          const tpId = tp.id || tp.orderId;
          if (!tpId) continue;
          try {
            await client.cancelTpslOrder(symbol, tpId);
            cancelled++;
          } catch (ce: any) {
            console.error(`[Grid ${strategyId}] Cancel TP ${tpId} error:`, ce.message);
          }
        }
        console.log(`[Grid ${strategyId}] Cancelled ${cancelled}/${tpList.length} TP/SL orders for ${symbol}`);
      } else {
        console.log(`[Grid ${strategyId}] No pending TP/SL orders for ${symbol}`);
      }
    }
  } catch (e: any) {
    console.error(`[Grid ${strategyId}] Cancel TP/SL orders error:`, e.message);
  }

  const orders = activeGridOrders.get(strategyId);
  if (orders) orders.clear();
  activeGridOrders.delete(strategyId);
}

export function startStrategyEngine() {
  if (intervalId) return;
  console.log("Strategy engine started (15s cycle + WebSocket price feed)");
  intervalId = setInterval(runStrategyCycle, 15_000);

  const strategies = storage.getStrategiesByStatus("running").then((strats) => {
    for (const s of strats) {
      if (s.type === "grid" || s.type === "tandem") {
        priceFeed.subscribe(s.symbol);
      }
    }
    if (strats.length > 0) {
      priceFeed.connect();
    }
  });

  runStrategyCycle();
}

export function stopStrategyEngine() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("Strategy engine stopped");
  }
  priceFeed.disconnect();
}

export async function getMarginInfo(strategy: Strategy): Promise<{
  removableOrders: number;
  removableMargin: number;
  currentPrice: number;
  lowestBuyPrice: number | null;
  bandLow: number;
  needsExtension: boolean;
  uncoveredLevels: number;
}> {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = (strategy.config || {}) as GridConfig & Record<string, any>;
  const precision = await getPairPrecision(strategy.symbol);
  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) throw new Error("Could not get current price");
  const currentPrice = ticker.lastPrice;
  const threshold = currentPrice * 0.99;

  const openRes = await client.getOpenOrders(strategy.symbol);
  let openOrders: any[] = [];
  if (openRes?.code === 0) {
    if (Array.isArray(openRes.data)) openOrders = openRes.data;
    else if (openRes.data?.orderList) openOrders = openRes.data.orderList;
  }

  const allLevels = getAsymmetricGridLevels(config);
  const gridPriceSet = new Set(allLevels.map(l => roundPrice(l, precision.quotePrecision)));
  const leverage = config.leverage || 8;

  const buyOrders = openOrders
    .filter((o: any) => o.side === "BUY")
    .map((o: any) => ({
      price: parseFloat(o.price || "0"),
      qty: parseFloat(o.qty || "0"),
      priceStr: roundPrice(parseFloat(o.price || "0"), precision.quotePrecision),
    }))
    .sort((a, b) => a.price - b.price);

  const removable = buyOrders.filter(o => o.price < threshold && gridPriceSet.has(o.priceStr));
  const removableMargin = removable.reduce((sum, o) => sum + (o.price * o.qty / leverage), 0);
  const lowestBuyPrice = buyOrders.length > 0 ? buyOrders[0].price : null;

  const bandLow = currentPrice * 0.99;
  const existingBuyPrices = new Set(buyOrders.map(o => o.priceStr));
  const uncoveredLevels = allLevels
    .filter(l => l < currentPrice && l >= bandLow)
    .filter(l => !existingBuyPrices.has(roundPrice(l, precision.quotePrecision)))
    .length;

  const needsExtension = uncoveredLevels > 0;

  return {
    removableOrders: removable.length,
    removableMargin: Math.round(removableMargin * 100) / 100,
    currentPrice,
    lowestBuyPrice,
    bandLow: Math.round(bandLow * 100) / 100,
    needsExtension,
    uncoveredLevels,
  };
}

export async function extendOrdersToLowerBand(strategy: Strategy): Promise<{ success: boolean; message: string; ordersPlaced: number }> {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = (strategy.config || {}) as GridConfig & Record<string, any>;
  const precision = await getPairPrecision(strategy.symbol);
  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) throw new Error("Could not get current price");
  const currentPrice = ticker.lastPrice;

  const openRes = await client.getOpenOrders(strategy.symbol);
  let openOrders: any[] = [];
  if (openRes?.code === 0) {
    if (Array.isArray(openRes.data)) openOrders = openRes.data;
    else if (openRes.data?.orderList) openOrders = openRes.data.orderList;
  }

  const existingBuyPrices = new Set(
    openOrders
      .filter((o: any) => o.side === "BUY")
      .map((o: any) => roundPrice(parseFloat(o.price || "0"), precision.quotePrecision))
  );

  const allLevels = getAsymmetricGridLevels(config);
  const bandLow = currentPrice * 0.99;
  const missingLevels = allLevels
    .filter(l => l < currentPrice && l >= bandLow)
    .filter(l => !existingBuyPrices.has(roundPrice(l, precision.quotePrecision)));

  if (missingLevels.length === 0) {
    return { success: true, message: "All levels within -1% band already covered", ordersPlaced: 0 };
  }

  const amountPerGrid = config.amountPerGrid || 5;
  let placed = 0;
  for (const level of missingLevels) {
    const notional = amountPerGrid * (config.leverage || 8) * 0.95;
    const qtyBase = notional / level;
    const qty = Math.max(qtyBase, precision.minTradeVolume);
    const qtyStr = roundQty(qty, precision.basePrecision);
    const priceStr = roundPrice(level, precision.quotePrecision);

    try {
      const result = await client.placeOrder({
        symbol: strategy.symbol,
        qty: qtyStr,
        side: "BUY",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: priceStr,
        effect: "GTC",
      });
      if (result?.code === 0 && result.data?.orderId) {
        placed++;
        console.log(`[ExtendOrders ${strategy.id}] Placed BUY ${qtyStr} @ ${priceStr}`);
      } else {
        console.error(`[ExtendOrders ${strategy.id}] BUY failed @ ${priceStr}: ${result?.msg}`);
      }
    } catch (e: any) {
      console.error(`[ExtendOrders ${strategy.id}] BUY error @ ${priceStr}:`, e.message);
    }
  }

  return { success: true, message: `Extended: placed ${placed} orders down to -1% band ($${bandLow.toFixed(precision.quotePrecision)})`, ordersPlaced: placed };
}

export async function addMarginToGrid(strategy: Strategy, amountUsdt: number): Promise<{ success: boolean; message: string; ordersPlaced: number }> {
  const client = getBitunixClient();
  if (!client) return { success: false, message: "Bitunix client not configured", ordersPlaced: 0 };

  const config = (strategy.config || {}) as GridConfig & Record<string, any>;

  if (!config.startPrice || !config.gridRatio || !config.lowerPrice || !config.upperPrice) {
    return { success: false, message: "Strategy config missing required grid parameters (startPrice, gridRatio, lowerPrice, upperPrice)", ordersPlaced: 0 };
  }

  const precision = await getPairPrecision(strategy.symbol);
  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return { success: false, message: `Could not get current price for ${strategy.symbol}`, ordersPlaced: 0 };
  const currentPrice = ticker.lastPrice;

  let openOrders: any[] = [];
  try {
    const openRes = await client.getOpenOrders(strategy.symbol);
    if (openRes?.code === 0) {
      if (Array.isArray(openRes.data)) openOrders = openRes.data;
      else if (openRes.data?.orderList) openOrders = openRes.data.orderList;
    }
  } catch (e: any) {
    console.error(`[AddMargin ${strategy.id}] Failed to fetch open orders:`, e.message);
    return { success: false, message: `Failed to fetch open orders: ${e.message}`, ordersPlaced: 0 };
  }

  const existingBuyPrices = new Set(
    openOrders
      .filter((o: any) => o.side === "BUY")
      .map((o: any) => roundPrice(parseFloat(o.price || "0"), precision.quotePrecision))
  );

  const allLevels = getAsymmetricGridLevels(config);
  const bandLow = currentPrice * 0.99;
  const lowerBound = config.lowerPrice || 0;
  const buyLevels = allLevels
    .filter(l => l < currentPrice && l >= bandLow && l >= lowerBound && !isNaN(l))
    .filter(l => !existingBuyPrices.has(roundPrice(l, precision.quotePrecision)));

  if (buyLevels.length === 0) {
    return { success: true, message: "All buy levels already covered", ordersPlaced: 0 };
  }

  const marginPerOrder = amountUsdt / buyLevels.length;
  let placed = 0;
  const errors: string[] = [];
  for (const level of buyLevels) {
    const notional = marginPerOrder * (config.leverage || 8) * 0.95;
    const qtyBase = notional / level;
    const qty = Math.max(qtyBase, precision.minTradeVolume);
    const qtyStr = roundQty(qty, precision.basePrecision);
    const priceStr = roundPrice(level, precision.quotePrecision);

    try {
      const result = await client.placeOrder({
        symbol: strategy.symbol,
        qty: qtyStr,
        side: "BUY",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: priceStr,
        effect: "GTC",
      });
      if (result?.code === 0 && result.data?.orderId) {
        placed++;
        console.log(`[AddMargin ${strategy.id}] Placed BUY ${qtyStr} @ ${priceStr}`);
      } else {
        const msg = `BUY failed @ ${priceStr}: ${result?.msg || "unknown"}`;
        errors.push(msg);
        console.error(`[AddMargin ${strategy.id}] ${msg}`);
      }
    } catch (e: any) {
      const msg = `BUY error @ ${priceStr}: ${e.message}`;
      errors.push(msg);
      console.error(`[AddMargin ${strategy.id}] ${msg}`);
    }
  }

  if (placed > 0) {
    config.allocatedBudget = (config.allocatedBudget || 0) + amountUsdt;
    await storage.updateStrategy(strategy.id, { config });
    console.log(`[AddMargin ${strategy.id}] Budget updated: allocated=${config.allocatedBudget.toFixed(2)}`);
  }

  const message = placed > 0
    ? `Placed ${placed}/${buyLevels.length} buy orders (+$${amountUsdt.toFixed(2)} to budget)`
    : `No orders placed. ${errors[0] || "All levels covered"}`;
  return { success: placed > 0, message, ordersPlaced: placed };
}

export async function removeMarginFromGrid(strategy: Strategy, count: number): Promise<{ success: boolean; message: string; ordersCancelled: number; freedMargin: number }> {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const precision = await getPairPrecision(strategy.symbol);
  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) throw new Error("Could not get current price");
  const currentPrice = ticker.lastPrice;
  const threshold = currentPrice * 0.99;

  const openRes = await client.getOpenOrders(strategy.symbol);
  let openOrders: any[] = [];
  if (openRes?.code === 0) {
    if (Array.isArray(openRes.data)) openOrders = openRes.data;
    else if (openRes.data?.orderList) openOrders = openRes.data.orderList;
  }

  const config = (strategy.config || {}) as GridConfig & Record<string, any>;
  const allLevels = getAsymmetricGridLevels(config);
  const gridPriceSet = new Set(allLevels.map(l => roundPrice(l, precision.quotePrecision)));

  const buyOrders = openOrders
    .filter((o: any) => o.side === "BUY")
    .map((o: any) => ({
      orderId: o.orderId,
      price: parseFloat(o.price || "0"),
      qty: parseFloat(o.qty || "0"),
      priceStr: roundPrice(parseFloat(o.price || "0"), precision.quotePrecision),
    }))
    .filter(o => o.price < threshold && gridPriceSet.has(o.priceStr))
    .sort((a, b) => a.price - b.price);

  if (buyOrders.length === 0) {
    return { success: true, message: "No buy orders below -1% from current price to remove", ordersCancelled: 0, freedMargin: 0 };
  }

  const toCancel = buyOrders.slice(0, count);
  let cancelled = 0;
  let freedMargin = 0;

  try {
    const cancelRes = await client.post("/api/v1/futures/trade/cancel_orders", {
      symbol: strategy.symbol,
      orderList: toCancel.map(o => ({ orderId: o.orderId })),
    });
    if (cancelRes?.code === 0) {
      cancelled = toCancel.length;
      const leverage = ((strategy.config as any)?.leverage) || 8;
      freedMargin = toCancel.reduce((sum, o) => sum + (o.price * o.qty / leverage), 0);
      console.log(`[RemoveMargin ${strategy.id}] Cancelled ${cancelled} bottom orders, freed ~$${freedMargin.toFixed(2)}`);

      if (config.allocatedBudget && freedMargin > 0) {
        config.allocatedBudget = Math.max(0, (config.allocatedBudget || 0) - freedMargin);
        await storage.updateStrategy(strategy.id, { config });
        console.log(`[RemoveMargin ${strategy.id}] Budget updated: allocated=${config.allocatedBudget.toFixed(2)}`);
      }
    }
  } catch (e: any) {
    console.error(`[RemoveMargin ${strategy.id}] Cancel error:`, e.message);
  }

  return {
    success: true,
    message: `Cancelled ${cancelled} bottom buy orders (below $${threshold.toFixed(precision.quotePrecision)})${freedMargin > 0 ? ` (-$${freedMargin.toFixed(2)} from budget)` : ""}`,
    ordersCancelled: cancelled,
    freedMargin,
  };
}

export function getActiveGridOrders(strategyId: number): Array<{ orderId: string; price: number; side: string }> {
  const orders = activeGridOrders.get(strategyId);
  if (!orders) return [];
  return Array.from(orders.values()).map(o => ({
    orderId: o.orderId,
    price: o.price,
    side: o.side,
  }));
}

export { cancelAllTandemOrders, simulateTandem, type TandemConfig, type TandemCycle, type TandemSimResult } from "./tandem-engine";
export { type HedgePairConfig } from "./hedge-pair-engine";
