import { getBitunixClient } from "./bitunix";
import { storage } from "./storage";
import type { Strategy, InsertTradeLog } from "@shared/schema";
import { priceFeed } from "./ws-price-feed";

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

export function calculateOptimizedGrid(currentPrice: number, feeRate: number = 0.0006) {
  const roundTripFee = 2 * feeRate;
  const targetProfitFeeRatio = 4.0;
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
}

export async function placeInitialGridBuy(strategy: Strategy): Promise<{ success: boolean; message: string; orderId?: string }> {
  const client = getBitunixClient();
  if (!client) return { success: false, message: "Bitunix client not configured" };

  const config = strategy.config as GridConfig;
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

    const budget = config.allocatedBudget && config.allocatedBudget > 0
      ? Math.min(config.allocatedBudget, accountAvailable)
      : accountAvailable;
    console.log(`[InitialBuy ${strategy.id}] Account available=${accountAvailable.toFixed(2)}, allocatedBudget=${config.allocatedBudget || 'none'}, using budget=${budget.toFixed(2)} USDT`);

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
          console.log(`[InitialBuy ${strategy.id}] Cleaned up ${cancelled}/${tpList.length} leftover TP/SL orders for ${strategy.symbol}`);
        }
      }
    } catch (e: any) {
      console.log(`[InitialBuy ${strategy.id}] TP cleanup note:`, e.message);
    }

    try {
      await client.setMarginMode(strategy.symbol, "ISOLATION");
    } catch (e: any) {
      console.log(`[InitialBuy ${strategy.id}] Margin mode note:`, e.message);
    }
    try {
      await client.setLeverage(strategy.symbol, leverage);
    } catch (e: any) {
      console.log(`[InitialBuy ${strategy.id}] Leverage note:`, e.message);
    }

    const allLevels = getAsymmetricGridLevels(config);
    const allBuyLevels = allLevels.filter(l => l < currentPrice);
    const totalGridCount = allBuyLevels.length;

    if (!config.lowerPrice) config.lowerPrice = currentPrice * 0.90;
    if (!config.upperPrice) config.upperPrice = currentPrice * 1.02;
    if (!config.liquidationPrice) config.liquidationPrice = currentPrice * 0.88;

    const minTpCount = 5;
    const tpReserve = config.tpReservePct || 0.10;
    const minInitialQty = (minTpCount * precision.minTradeVolume) / (1 - tpReserve);
    const minInitialMargin = (minInitialQty * currentPrice) / (leverage * 0.95);
    const initialBuyShare = Math.max(minInitialMargin, budget * 0.25);
    const remainingForGrids = budget - initialBuyShare;
    const marginPerGrid = totalGridCount > 0 ? remainingForGrids / totalGridCount : remainingForGrids;
    config.amountPerGrid = marginPerGrid;

    const initialNotional = initialBuyShare * leverage * 0.95;
    const baseQty = Math.max(initialNotional / currentPrice, minInitialQty);
    const qtyStr = roundQty(baseQty, precision.basePrecision);

    const buyLevelsIn1Pct = allBuyLevels.filter(l => l >= currentPrice * (1 - bandPct));
    const gridBuyCount = buyLevelsIn1Pct.length;

    console.log(`[InitialBuy ${strategy.id}] Budget=${budget.toFixed(2)} USDT, leverage=${leverage}x, totalGridLevels=${totalGridCount}, initialBuyShare=${initialBuyShare.toFixed(2)}, marginPerGrid=${marginPerGrid.toFixed(4)}, gridBuysIn1%=${gridBuyCount}, initialNotional=${initialNotional.toFixed(2)}, qty=${qtyStr} @ ${currentPrice}, minInitialQty=${minInitialQty.toFixed(2)}, range=[${config.lowerPrice.toFixed(2)}-${config.upperPrice.toFixed(2)}]`);

    const result = await client.placeOrder({
      symbol: strategy.symbol,
      qty: qtyStr,
      side: "BUY",
      tradeSide: "OPEN",
      orderType: "MARKET",
    });

    console.log(`[InitialBuy ${strategy.id}] Order result:`, JSON.stringify(result));

    const success = result?.code === 0;
    const orderId = result?.data?.orderId;

    await storage.createTradeLog({
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: "BUY",
      orderType: "MARKET",
      quantity: baseQty,
      price: currentPrice,
      status: success ? "filled" : "error",
      orderId: orderId || null,
      pnl: null,
      errorMsg: success ? null : (result?.msg || "Order failed"),
    });

    if (success) {
      config.allocatedBudget = budget;
      config.lastTrackedPnl = 0;
      console.log(`[InitialBuy ${strategy.id}] Set allocatedBudget=${budget.toFixed(2)} USDT`);
      await storage.updateStrategy(strategy.id, {
        totalTrades: (strategy.totalTrades || 0) + 1,
        config: { ...config, initialBuyDone: true, startPrice: currentPrice, lowerPrice: config.lowerPrice, upperPrice: config.upperPrice, liquidationPrice: config.liquidationPrice, amountPerGrid: config.amountPerGrid, allocatedBudget: config.allocatedBudget, lastTrackedPnl: 0 },
      });

      let remainingBalance = 0;
      try {
        const postBuyAccount = await client.getAccount();
        if (postBuyAccount?.code === 0 && postBuyAccount?.data) {
          remainingBalance = parseFloat(postBuyAccount.data.available || "0");
        }
      } catch {}

      const remainingBudget = Math.min(remainingBalance, budget - initialBuyShare);
      const gridMarginEach = gridBuyCount > 0 ? Math.max(0, remainingBudget) / gridBuyCount : marginPerGrid;
      console.log(`[InitialBuy ${strategy.id}] Now placing ${gridBuyCount} limit BUY orders within 1% below entry... (remainingBudget=${remainingBudget.toFixed(2)}, marginEach=${gridMarginEach.toFixed(4)} USDT)`);
      let placed = 0;
      const minExchangeMargin = (precision.minTradeVolume * currentPrice) / (leverage * 0.95);
      for (const level of buyLevelsIn1Pct) {
        if (remainingBalance < minExchangeMargin * 0.9) {
          console.log(`[InitialBuy ${strategy.id}] Stopping grid buys: insufficient remaining balance (${remainingBalance.toFixed(2)} USDT)`);
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
            side: "BUY",
            tradeSide: "OPEN",
            orderType: "LIMIT",
            price: priceStr,
            effect: "GTC",
          });

          if (gridResult?.code === 0 && gridResult.data?.orderId) {
            const orders = activeGridOrders.get(strategy.id) || new Map();
            orders.set(`BUY_${priceStr}`, {
              orderId: gridResult.data.orderId,
              price: level,
              side: "BUY",
              level,
            });
            activeGridOrders.set(strategy.id, orders);
            placed++;
            console.log(`[InitialBuy ${strategy.id}] Placed BUY ${gridQtyStr} @ ${priceStr}`);
          } else {
            console.error(`[InitialBuy ${strategy.id}] Grid BUY failed @ ${priceStr}: ${gridResult?.msg}`);
          }
        } catch (e: any) {
          console.error(`[InitialBuy ${strategy.id}] Grid BUY error @ ${priceStr}:`, e.message);
        }
      }
      console.log(`[InitialBuy ${strategy.id}] Placed ${placed}/${gridBuyCount} grid BUY orders`);
    }

    return {
      success,
      message: success
        ? `Bought ${qtyStr} ${strategy.symbol} at ~$${currentPrice.toFixed(2)} (${initialNotional.toFixed(2)} USDT notional, ${leverage}x, ${gridBuyCount} grid buys reserved)`
        : (result?.msg || "Order placement failed"),
      orderId,
    };
  } catch (e: any) {
    console.error(`[InitialBuy ${strategy.id}] Error:`, e);
    return { success: false, message: e.message };
  }
}

async function executeGridStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as GridConfig & { initialBuyDone?: boolean };

  if (!config.startPrice || !config.lowerPrice || !config.upperPrice) {
    const ticker = await getTickerPrice(strategy.symbol);
    if (ticker) {
      const cp = ticker.lastPrice;
      if (!config.startPrice) config.startPrice = cp;
      if (!config.lowerPrice) config.lowerPrice = cp * 0.90;
      if (!config.upperPrice) config.upperPrice = cp * 1.02;
      if (!config.liquidationPrice) config.liquidationPrice = cp * 0.88;
      if (!config.amountPerGrid) config.amountPerGrid = 2;
      await storage.updateStrategy(strategy.id, { config });
    }
  }

  if (!config.initialBuyDone) {
    if (initialBuyLocks.has(strategy.id)) {
      console.log(`[Grid ${strategy.id}] Initial buy already in progress, skipping...`);
      return;
    }
    initialBuyLocks.add(strategy.id);
    try {
      console.log(`[Grid ${strategy.id}] No initial buy yet, placing initial position...`);
      const result = await placeInitialGridBuy(strategy);
      console.log(`[Grid ${strategy.id}] Initial buy result: ${result.message}`);
      if (!result.success) {
        console.error(`[Grid ${strategy.id}] Initial buy failed: ${result.message}`);
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
  const levels = getAsymmetricGridLevels(config);

  const lowerBound = config.lowerPrice || currentPrice * 0.90;
  const upperBound = config.upperPrice || currentPrice * 1.02;

  const feeRate = 0.0006;
  const roundTripFee = 2 * feeRate;
  const minProfitableGap = roundTripFee * 4.0;

  const buyCap = currentPrice * (1 - minProfitableGap);
  const buyLevels = levels.filter(l => l <= buyCap && l >= lowerBound).reverse();

  let openOrders: any[] = [];
  try {
    const res = await client.getOpenOrders(strategy.symbol);
    if (res?.code === 0) {
      if (Array.isArray(res.data)) {
        openOrders = res.data;
      } else if (res.data?.orderList && Array.isArray(res.data.orderList)) {
        openOrders = res.data.orderList;
      }
      console.log(`[Grid ${strategy.id}] Open orders on exchange: ${openOrders.length} (sides: ${openOrders.map((o: any) => `${o.side}@${o.price}`).join(', ')})`);
    }
  } catch (e: any) {
    console.error(`[Grid ${strategy.id}] Failed to fetch open orders:`, e.message);
  }

  let positionId: string | null = null;
  let positionQty = 0;
  let positionEntryPrice = 0;
  let posRealizedPnl = 0;
  let posFee = 0;
  let posFunding = 0;
  try {
    const posRes = await client.getPositions(strategy.symbol);
    if (posRes?.code === 0 && Array.isArray(posRes.data) && posRes.data.length > 0) {
      const pos = posRes.data.find((p: any) => p.side === "BUY");
      if (pos) {
        positionId = pos.positionId;
        positionQty = parseFloat(pos.qty || "0");
        positionEntryPrice = parseFloat(pos.entryPrice || pos.avgPrice || "0");
        posRealizedPnl = parseFloat(pos.realizedPNL || "0");
        posFee = parseFloat(pos.fee || "0");
        posFunding = parseFloat(pos.funding || "0");
      }
    }
  } catch (e: any) {
    console.error(`[Grid ${strategy.id}] Failed to fetch positions:`, e.message);
  }

  const desiredBuyPrices = new Set(buyLevels.map(l => roundPrice(l, precision.quotePrecision)));

  const ordersToCancel: string[] = [];
  const coveredBuyPrices = new Set<string>();

  for (const order of openOrders) {
    const orderPrice = roundPrice(parseFloat(order.price || "0"), precision.quotePrecision);
    const orderSide = order.side;

    if (orderSide === "SELL") {
      ordersToCancel.push(order.orderId);
      continue;
    }

    if (orderSide === "BUY" && desiredBuyPrices.has(orderPrice)) {
      if (coveredBuyPrices.has(orderPrice)) {
        ordersToCancel.push(order.orderId);
      } else {
        coveredBuyPrices.add(orderPrice);
      }
    } else {
      ordersToCancel.push(order.orderId);
    }
  }

  if (ordersToCancel.length > 0) {
    try {
      await client.post("/api/v1/futures/trade/cancel_orders", {
        symbol: strategy.symbol,
        orderList: ordersToCancel.map(id => ({ orderId: id })),
      });
      console.log(`[Grid ${strategy.id}] Cancelled ${ordersToCancel.length} unwanted orders (dupes/sells/out-of-range)`);
    } catch (e: any) {
      console.error(`[Grid ${strategy.id}] Cancel error:`, e.message);
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

  if (allocatedBudget > 0) {
    const lastTrackedPnl = config.lastTrackedPnl ?? 0;
    const lastTrackedPositionId = config.lastTrackedPositionId || null;

    if (positionId) {
      const netPnl = posRealizedPnl + posFee + posFunding;

      if (lastTrackedPositionId && lastTrackedPositionId !== positionId) {
        config.lastTrackedPnl = 0;
        config.lastTrackedPositionId = positionId;
        console.log(`[Grid ${strategy.id}] Position changed (${lastTrackedPositionId} -> ${positionId}), reset PnL tracking`);
      }

      const trackBase = (lastTrackedPositionId === positionId) ? lastTrackedPnl : 0;
      const pnlDelta = netPnl - trackBase;

      if (Math.abs(pnlDelta) > 0.001) {
        allocatedBudget += pnlDelta;
        config.allocatedBudget = Math.max(0, allocatedBudget);
        config.lastTrackedPnl = netPnl;
        config.lastTrackedPositionId = positionId;
        console.log(`[Grid ${strategy.id}] PnL adjustment: realized=${posRealizedPnl.toFixed(4)} fee=${posFee.toFixed(4)} funding=${posFunding.toFixed(4)} net=${netPnl.toFixed(4)} delta=${pnlDelta > 0 ? "+" : ""}${pnlDelta.toFixed(4)} -> budget=${config.allocatedBudget.toFixed(2)}`);
        await storage.updateStrategy(strategy.id, { config });
      }
    } else if (lastTrackedPositionId) {
      config.lastTrackedPnl = 0;
      config.lastTrackedPositionId = null;
      console.log(`[Grid ${strategy.id}] Position closed, reset PnL tracking. Budget remains at ${allocatedBudget.toFixed(2)}`);
      await storage.updateStrategy(strategy.id, { config });
    }
  }

  let availableBalance = allocatedBudget > 0 ? Math.min(accountAvailable, allocatedBudget) : accountAvailable;

  if (allocatedBudget > 0 && accountAvailable > allocatedBudget + 0.5) {
    console.log(`[Grid ${strategy.id}] Budget cap: account=${accountAvailable.toFixed(2)}, allocated=${allocatedBudget.toFixed(2)}, capped to ${availableBalance.toFixed(2)}`);
  }

  const lastTpPosQty = config.lastTpPositionQty || 0;
  const tpWasHit = lastTpPosQty > 0 && positionQty < lastTpPosQty * 0.98;
  if (tpWasHit) {
    const qtyFreed = lastTpPosQty - positionQty;
    console.log(`[Grid ${strategy.id}] TP hit detected: position ${lastTpPosQty} -> ${positionQty} (freed ${qtyFreed.toFixed(precision.basePrecision)} qty). Freed margin available for new buys.`);
  }

  const missingBuyLevels = buyLevels.filter(l => !coveredBuyPrices.has(roundPrice(l, precision.quotePrecision)));
  const leverage = config.leverage || 8;
  const minMarginPerOrder = (precision.minTradeVolume * currentPrice) / (leverage * 0.95);
  const marginPerOrder = missingBuyLevels.length > 0
    ? Math.max(minMarginPerOrder, (availableBalance - 0.1) / missingBuyLevels.length)
    : minMarginPerOrder;
  const usableBalance = availableBalance - 0.1;

  const levelsToFill = usableBalance >= minMarginPerOrder
    ? missingBuyLevels.length
    : 0;
  const buySlice = missingBuyLevels.slice(0, levelsToFill);

  if (missingBuyLevels.length > 0 && levelsToFill === 0 && coveredBuyPrices.size === 0) {
    console.log(`[Grid ${strategy.id}] No balance for buy orders: ${availableBalance.toFixed(2)} USDT (need ${minMarginPerOrder.toFixed(2)} min per grid)`);
  }

  let placedBuys = 0;
  for (const level of buySlice) {
    const effectiveMargin = Math.min(marginPerOrder, (availableBalance - 0.1) * 0.95);
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
        side: "BUY",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: priceStr,
        effect: "GTC",
      });

      if (result?.code === 0 && result.data?.orderId) {
        placedBuys++;
        availableBalance -= effectiveMargin;
      } else {
        console.error(`[Grid ${strategy.id}] BUY failed @ ${priceStr}: ${result?.msg}`);
      }
    } catch (e: any) {
      console.error(`[Grid ${strategy.id}] BUY error @ ${priceStr}:`, e.message);
    }
  }

  let placedTps = 0;
  let cancelledTps = 0;

  const tpRefPrice = positionEntryPrice > 0 ? positionEntryPrice : config.startPrice;
  const minTpPrice = tpRefPrice * (1 + minProfitableGap);
  const tpUpperLimit = Math.max(currentPrice * 1.03, minTpPrice * 1.005);

  const allSellLevels: number[] = [];
  let tpPrice = minTpPrice;
  while (tpPrice <= tpUpperLimit) {
    allSellLevels.push(tpPrice);
    tpPrice *= (1 + minProfitableGap);
  }

  const maxTpLevels = Math.max(
    Math.floor(positionQty / precision.minTradeVolume),
    1
  );
  const sellLevels = allSellLevels.slice(0, maxTpLevels);

  console.log(`[Grid ${strategy.id}] Price: ${currentPrice.toFixed(4)} | Entry: ${tpRefPrice.toFixed(4)} | minTp: ${minTpPrice.toFixed(4)} | TP levels: ${sellLevels.length}/${allSellLevels.length} | Buy levels: ${buyLevels.length}`);

  if (positionId && positionQty > 0 && sellLevels.length > 0) {
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
      console.error(`[Grid ${strategy.id}] Check live TPs error:`, e.message);
    }

    const hasTpsPlaced = lastTpCount > 0 && lastTpTime > 0;
    const tpsMissing = hasTpsPlaced && liveTpCount === 0;
    const hasDuplicates = hasTpsPlaced && liveTpCount > lastTpCount + 2;
    const entryDroppedEnough = hasTpsPlaced && lastTpEntry > 0 && tpRefPrice < lastTpEntry * 0.995;
    const positionGrewEnough = hasTpsPlaced && lastTpPosQty > 0 && positionQty > lastTpPosQty * 1.15;
    const tpsConsumed = hasTpsPlaced && liveTpCount < lastTpCount && liveTpCount > 0;
    const cooldownOk = (now - lastTpTime) > 60000;

    const needsRebuild = !hasTpsPlaced || tpsMissing || hasDuplicates || tpsConsumed || ((entryDroppedEnough || positionGrewEnough) && cooldownOk);

    if (!needsRebuild) {
      console.log(`[Grid ${strategy.id}] TPs stable: ${liveTpCount} live on exchange (saved=${lastTpCount}) at entry ${lastTpEntry.toFixed(4)} for qty ${lastTpPosQty} — no changes`);
    } else {
      const reason = !hasTpsPlaced
        ? "first TP placement"
        : tpsMissing
          ? `TPs missing from exchange (saved=${lastTpCount}, live=${liveTpCount})`
          : hasDuplicates
            ? `duplicate TPs detected (saved=${lastTpCount}, live=${liveTpCount}) — cleaning up`
            : tpsConsumed
              ? `TPs consumed (saved=${lastTpCount}, live=${liveTpCount}) — replanting for remaining qty ${positionQty}`
              : entryDroppedEnough
                ? `entry dropped ${lastTpEntry.toFixed(4)}->${tpRefPrice.toFixed(4)}`
                : `position grew ${lastTpPosQty}->${positionQty}`;
      console.log(`[Grid ${strategy.id}] TP rebuild: ${reason} — cancelling ${liveTpCount} existing TPs first`);

      for (const tp of liveTpOrders) {
        const tpId = tp.id || tp.orderId;
        if (tpId) {
          try {
            await client.cancelTpslOrder(strategy.symbol, tpId);
            cancelledTps++;
          } catch (e: any) {
            console.error(`[Grid ${strategy.id}] Cancel TP ${tpId} error:`, e.message);
          }
        }
      }
      if (liveTpOrders.length > 0) {
        console.log(`[Grid ${strategy.id}] Cancelled ${cancelledTps}/${liveTpOrders.length} existing TPs`);
      }

      const tpReservePct = Math.min(Math.max(config.tpReservePct ?? 0.10, 0), 0.5);
      const sellableQty = positionQty * (1 - tpReservePct);
      const reservedQty = positionQty - sellableQty;

      const basePrecisionMultiplier = Math.pow(10, precision.basePrecision);
      const tpQtyPerLevel = Math.max(
        Math.floor((sellableQty / sellLevels.length) * basePrecisionMultiplier) / basePrecisionMultiplier,
        precision.minTradeVolume
      );

      let levelsToPlace = sellLevels;
      if (tpQtyPerLevel * sellLevels.length > sellableQty * 1.02) {
        const maxLevels = Math.floor(sellableQty / tpQtyPerLevel);
        levelsToPlace = sellLevels.slice(0, Math.max(maxLevels, 1));
      }

      const lastLevelQty = Math.max(
        Math.round((sellableQty - tpQtyPerLevel * (levelsToPlace.length - 1)) * basePrecisionMultiplier) / basePrecisionMultiplier,
        precision.minTradeVolume
      );

      console.log(`[Grid ${strategy.id}] Placing ${levelsToPlace.length} TP orders, ${tpQtyPerLevel.toFixed(precision.basePrecision)} each (last=${lastLevelQty.toFixed(precision.basePrecision)}) (posQty: ${positionQty}, sellable: ${sellableQty.toFixed(precision.basePrecision)}, reserved: ${reservedQty.toFixed(precision.basePrecision)} [${(tpReservePct*100).toFixed(0)}%], entry: ${tpRefPrice.toFixed(4)})`);

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
            tpOrderType: "MARKET",
            tpQty: qtyStr,
          });
          if (result?.code === 0) {
            placedTps++;
            console.log(`[Grid ${strategy.id}] TP placed @ ${priceStr} qty=${qtyStr} ✓`);
          } else {
            console.error(`[Grid ${strategy.id}] TP failed @ ${priceStr} qty=${qtyStr}: code=${result?.code} msg=${result?.msg}`);
          }
        } catch (e: any) {
          console.error(`[Grid ${strategy.id}] TP error @ ${priceStr}:`, e.message);
        }
      }

      config.lastTpEntryPrice = tpRefPrice;
      config.lastTpPositionQty = positionQty;
      config.lastTpPlacedAt = now;
      config.lastTpCount = placedTps;
      await storage.updateStrategy(strategy.id, { config });
      console.log(`[Grid ${strategy.id}] TP state saved: entry=${tpRefPrice.toFixed(4)} qty=${positionQty} placed=${placedTps}/${levelsToPlace.length}`);
    }
  }

  const budgetInfo = config.allocatedBudget ? ` | Budget=${config.allocatedBudget.toFixed(2)}` : "";
  console.log(`[Grid ${strategy.id}] Price=${currentPrice.toFixed(precision.quotePrecision)} | BuyBand=[${lowerBound.toFixed(precision.quotePrecision)}-${currentPrice.toFixed(precision.quotePrecision)}] TpRange=[${minTpPrice.toFixed(precision.quotePrecision)}-${tpUpperLimit.toFixed(precision.quotePrecision)}] gap=${(minProfitableGap*100).toFixed(2)}% | Buys=${buyLevels.length}(live=${coveredBuyPrices.size}+${placedBuys}) TPs=${sellLevels.length}/${allSellLevels.length}(+${placedTps}/-${cancelledTps}) maxByQty=${maxTpLevels} | Cancelled=${ordersToCancel.length} | PosQty=${positionQty} | Avail=${availableBalance.toFixed(2)}${budgetInfo}`);

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

  const newConfig: GridConfig = {
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

export interface TandemConfig {
  leverage: number;
  capitalPerSide: number;
  feeMultiplier: number;
  phase: "entry" | "waiting_liquidation" | "cascade" | "trailing" | "complete";
  entryPrice: number;
  longPositionId: string | null;
  shortPositionId: string | null;
  longEntryQty: number;
  shortEntryQty: number;
  liquidatedSide: "LONG" | "SHORT" | null;
  liquidationPrice: number;
  cascadeStep: number;
  tpOrderIds: string[];
  highWatermark: number;
  remainingQty: number;
  survivingSide: "LONG" | "SHORT" | null;
  survivingPositionId: string | null;
  cycleCount: number;
  totalPnl: number;
  lastActionAt: number;
  rotationEnabled?: boolean;
}

const tandemEntryLocks: Set<number> = new Set();

async function executeTandemStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as TandemConfig;
  const phase = config.phase || "entry";

  console.log(`[Tandem ${strategy.id}] Phase: ${phase} | Cycle: ${config.cycleCount || 0} | Symbol: ${strategy.symbol}`);

  switch (phase) {
    case "entry":
      await tandemEntry(strategy, config, client);
      break;
    case "waiting_liquidation":
      await tandemWaitLiquidation(strategy, config, client);
      break;
    case "cascade":
      await tandemCascade(strategy, config, client);
      break;
    case "trailing":
      await tandemTrailing(strategy, config, client);
      break;
    case "complete":
      await tandemComplete(strategy, config, client);
      break;
  }

  await storage.updateStrategy(strategy.id, { lastRunAt: new Date() });
}

async function tandemEntry(strategy: Strategy, config: TandemConfig, client: any) {
  if (tandemEntryLocks.has(strategy.id)) {
    console.log(`[Tandem ${strategy.id}] Entry already in progress, skipping...`);
    return;
  }
  tandemEntryLocks.add(strategy.id);

  try {
    const precision = await getPairPrecision(strategy.symbol);
    const ticker = await getTickerPrice(strategy.symbol);
    if (!ticker) throw new Error(`Cannot get price for ${strategy.symbol}`);

    const currentPrice = ticker.lastPrice;
    const leverage = config.leverage || 33;
    const capitalPerSide = config.capitalPerSide || 50;

    const accountRes = await client.getAccount();
    if (accountRes?.code !== 0 || !accountRes?.data) throw new Error("Cannot fetch account balance");
    const accountAvailable = parseFloat(accountRes.data.available || "0");
    const totalNeeded = capitalPerSide * 2;
    if (accountAvailable < totalNeeded) {
      throw new Error(`Insufficient balance: ${accountAvailable.toFixed(2)} USDT, need ${totalNeeded.toFixed(2)} for both sides`);
    }

    try { await client.setMarginMode(strategy.symbol, "ISOLATION"); } catch (e: any) {
      console.log(`[Tandem ${strategy.id}] Margin mode note:`, e.message);
    }
    try { await client.setLeverage(strategy.symbol, leverage); } catch (e: any) {
      console.log(`[Tandem ${strategy.id}] Leverage note:`, e.message);
    }

    const notionalPerSide = capitalPerSide * leverage * 0.95;
    const qty = notionalPerSide / currentPrice;
    const qtyStr = roundQty(qty, precision.basePrecision);

    console.log(`[Tandem ${strategy.id}] Opening LONG + SHORT at ${currentPrice}, qty=${qtyStr}, leverage=${leverage}x, capital/side=${capitalPerSide}`);

    const longResult = await client.placeOrder({
      symbol: strategy.symbol,
      qty: qtyStr,
      side: "BUY",
      tradeSide: "OPEN",
      orderType: "MARKET",
    });
    console.log(`[Tandem ${strategy.id}] LONG result:`, JSON.stringify(longResult));

    if (longResult?.code !== 0) throw new Error(`LONG order failed: ${longResult?.msg}`);

    const shortResult = await client.placeOrder({
      symbol: strategy.symbol,
      qty: qtyStr,
      side: "SELL",
      tradeSide: "OPEN",
      orderType: "MARKET",
    });
    console.log(`[Tandem ${strategy.id}] SHORT result:`, JSON.stringify(shortResult));

    if (shortResult?.code !== 0) {
      console.error(`[Tandem ${strategy.id}] SHORT failed, closing LONG...`);
      try { await client.flashClose(strategy.symbol); } catch {}
      throw new Error(`SHORT order failed: ${shortResult?.msg}`);
    }

    await new Promise(r => setTimeout(r, 2000));

    let longPosId: string | null = null;
    let shortPosId: string | null = null;
    let longQty = 0;
    let shortQty = 0;
    try {
      const posRes = await client.getPositions(strategy.symbol);
      if (posRes?.code === 0 && Array.isArray(posRes.data)) {
        for (const pos of posRes.data) {
          const posQty = parseFloat(pos.qty || "0");
          if (pos.side === "BUY" && posQty > 0) {
            longPosId = pos.positionId;
            longQty = posQty;
          } else if (pos.side === "SELL" && posQty > 0) {
            shortPosId = pos.positionId;
            shortQty = posQty;
          }
        }
      }
    } catch (e: any) {
      console.error(`[Tandem ${strategy.id}] Position fetch error:`, e.message);
    }

    const updatedConfig: TandemConfig = {
      ...config,
      phase: "waiting_liquidation",
      entryPrice: currentPrice,
      longPositionId: longPosId,
      shortPositionId: shortPosId,
      longEntryQty: longQty || qty,
      shortEntryQty: shortQty || qty,
      liquidatedSide: null,
      liquidationPrice: 0,
      cascadeStep: 0,
      tpOrderIds: [],
      highWatermark: 0,
      remainingQty: 0,
      survivingSide: null,
      survivingPositionId: null,
      cycleCount: (config.cycleCount || 0) + 1,
      lastActionAt: Date.now(),
    };

    await storage.updateStrategy(strategy.id, { config: updatedConfig });

    await storage.createTradeLog({
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: "BUY",
      orderType: "MARKET",
      quantity: qty,
      price: currentPrice,
      status: "filled",
      orderId: longResult.data?.orderId || null,
      pnl: null,
      errorMsg: `Tandem cycle ${updatedConfig.cycleCount}: LONG opened`,
    });
    await storage.createTradeLog({
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: "SELL",
      orderType: "MARKET",
      quantity: qty,
      price: currentPrice,
      status: "filled",
      orderId: shortResult.data?.orderId || null,
      pnl: null,
      errorMsg: `Tandem cycle ${updatedConfig.cycleCount}: SHORT opened`,
    });

    console.log(`[Tandem ${strategy.id}] Cycle ${updatedConfig.cycleCount} started: LONG ${longPosId}, SHORT ${shortPosId} @ ${currentPrice}`);
  } finally {
    tandemEntryLocks.delete(strategy.id);
  }
}

async function tandemWaitLiquidation(strategy: Strategy, config: TandemConfig, client: any) {
  const posRes = await client.getPositions(strategy.symbol);
  if (posRes?.code !== 0 || !Array.isArray(posRes.data)) {
    console.log(`[Tandem ${strategy.id}] Position fetch failed, retrying next cycle`);
    return;
  }

  let longAlive = false;
  let shortAlive = false;
  let longPos: any = null;
  let shortPos: any = null;

  for (const pos of posRes.data) {
    const posQty = parseFloat(pos.qty || "0");
    if (posQty <= 0) continue;
    if (pos.side === "BUY") { longAlive = true; longPos = pos; }
    if (pos.side === "SELL") { shortAlive = true; shortPos = pos; }
  }

  if (longAlive && shortAlive) {
    const ticker = await getTickerPrice(strategy.symbol);
    if (ticker) {
      const liqDist = 1 / config.leverage;
      const longLiqPrice = config.entryPrice * (1 - liqDist);
      const shortLiqPrice = config.entryPrice * (1 + liqDist);
      console.log(`[Tandem ${strategy.id}] Both alive @ ${ticker.lastPrice.toFixed(4)} | LongLiq=${longLiqPrice.toFixed(4)} ShortLiq=${shortLiqPrice.toFixed(4)}`);
    }
    return;
  }

  if (!longAlive && !shortAlive) {
    console.log(`[Tandem ${strategy.id}] Both liquidated! Resetting to entry phase.`);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    await storage.createTradeLog({
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: "BUY",
      orderType: "MARKET",
      quantity: 0,
      price: config.entryPrice,
      status: "filled",
      orderId: null,
      pnl: -(config.capitalPerSide * 2),
      errorMsg: `Tandem cycle ${config.cycleCount}: BOTH liquidated`,
    });
    return;
  }

  const liquidatedSide: "LONG" | "SHORT" = longAlive ? "SHORT" : "LONG";
  const survivingSide: "LONG" | "SHORT" = longAlive ? "LONG" : "SHORT";
  const survivingPos = longAlive ? longPos : shortPos;
  const survivingPositionId = survivingPos?.positionId || null;
  const survivingQty = parseFloat(survivingPos?.qty || "0");

  const ticker = await getTickerPrice(strategy.symbol);
  const liquidationPrice = ticker?.lastPrice || config.entryPrice;

  console.log(`[Tandem ${strategy.id}] ${liquidatedSide} LIQUIDATED @ ~${liquidationPrice.toFixed(4)} | Survivor: ${survivingSide} (qty=${survivingQty}, posId=${survivingPositionId})`);

  await storage.updateStrategy(strategy.id, {
    config: {
      ...config,
      phase: "cascade",
      liquidatedSide,
      liquidationPrice,
      survivingSide,
      survivingPositionId,
      remainingQty: survivingQty,
      cascadeStep: 0,
      tpOrderIds: [],
      highWatermark: liquidationPrice,
      lastActionAt: Date.now(),
    },
  });

  await storage.createTradeLog({
    strategyId: strategy.id,
    symbol: strategy.symbol,
    side: liquidatedSide === "LONG" ? "BUY" : "SELL",
    orderType: "MARKET",
    quantity: 0,
    price: liquidationPrice,
    status: "filled",
    orderId: null,
    pnl: -config.capitalPerSide,
    errorMsg: `Tandem cycle ${config.cycleCount}: ${liquidatedSide} liquidated`,
  });
}

async function tandemCascade(strategy: Strategy, config: TandemConfig, client: any) {
  const posRes = await client.getPositions(strategy.symbol);
  if (posRes?.code !== 0 || !Array.isArray(posRes.data)) return;

  const survivingSide = config.survivingSide;
  const posSide = survivingSide === "LONG" ? "BUY" : "SELL";
  const survivingPos = posRes.data.find((p: any) => p.side === posSide && parseFloat(p.qty || "0") > 0);

  if (!survivingPos) {
    console.log(`[Tandem ${strategy.id}] Surviving position gone (liquidated during cascade)`);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    await storage.createTradeLog({
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: posSide,
      orderType: "MARKET",
      quantity: 0,
      price: config.liquidationPrice,
      status: "filled",
      orderId: null,
      pnl: -config.capitalPerSide,
      errorMsg: `Tandem cycle ${config.cycleCount}: survivor also liquidated`,
    });
    return;
  }

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return;
  const currentPrice = ticker.lastPrice;
  const currentQty = parseFloat(survivingPos.qty || "0");
  const positionId = survivingPos.positionId;
  const precision = await getPairPrecision(strategy.symbol);

  const direction = survivingSide === "LONG" ? 1 : -1;
  const cascadeStartPrice = config.liquidationPrice;

  const moveBeyondLiq = survivingSide === "LONG"
    ? (currentPrice - cascadeStartPrice) / cascadeStartPrice
    : (cascadeStartPrice - currentPrice) / cascadeStartPrice;

  const cascadeStep = config.cascadeStep || 0;

  if (cascadeStep < 3) {
    const targetPct = (cascadeStep + 1) * 0.01;

    if (moveBeyondLiq >= targetPct) {
      const originalQty = config.longEntryQty || config.remainingQty;
      const portionQty = originalQty * (2 / 7);
      const sellQty = Math.min(portionQty, currentQty);
      const qtyStr = roundQty(sellQty, precision.basePrecision);

      if (sellQty < precision.minTradeVolume) {
        console.log(`[Tandem ${strategy.id}] Cascade step ${cascadeStep + 1} qty too small (${sellQty}), skipping`);
      } else {
        const closeSide = survivingSide === "LONG" ? "SELL" : "BUY";
        console.log(`[Tandem ${strategy.id}] CASCADE TP ${cascadeStep + 1}/3: ${closeSide} ${qtyStr} @ MARKET (move=${(moveBeyondLiq * 100).toFixed(2)}% beyond liq)`);

        try {
          const result = await client.placeOrder({
            symbol: strategy.symbol,
            qty: qtyStr,
            side: closeSide,
            tradeSide: "CLOSE",
            orderType: "MARKET",
          });

          const profitPerUnit = direction * (currentPrice - config.entryPrice);
          const exitPnl = profitPerUnit * sellQty;

          if (result?.code === 0) {
            const newStep = cascadeStep + 1;
            const newRemainingQty = currentQty - sellQty;

            await storage.updateStrategy(strategy.id, {
              config: {
                ...config,
                cascadeStep: newStep,
                remainingQty: newRemainingQty,
                highWatermark: currentPrice,
                phase: newStep >= 3 ? "trailing" : "cascade",
                lastActionAt: Date.now(),
              },
              totalPnl: (strategy.totalPnl || 0) + exitPnl,
            });

            await storage.createTradeLog({
              strategyId: strategy.id,
              symbol: strategy.symbol,
              side: closeSide,
              orderType: "MARKET",
              quantity: sellQty,
              price: currentPrice,
              status: "filled",
              orderId: result.data?.orderId || null,
              pnl: exitPnl,
              errorMsg: `Tandem cascade TP ${newStep}/3 (${(targetPct * 100).toFixed(0)}% beyond liq)`,
            });

            console.log(`[Tandem ${strategy.id}] Cascade TP ${newStep}/3 filled: pnl=${exitPnl.toFixed(4)}, remaining=${newRemainingQty.toFixed(precision.basePrecision)}`);
          } else {
            console.error(`[Tandem ${strategy.id}] Cascade TP failed: ${result?.msg}`);
          }
        } catch (e: any) {
          console.error(`[Tandem ${strategy.id}] Cascade TP error:`, e.message);
        }
      }
    } else {
      console.log(`[Tandem ${strategy.id}] Cascade waiting: step ${cascadeStep + 1} needs ${((cascadeStep + 1) * 1).toFixed(0)}% move, current=${(moveBeyondLiq * 100).toFixed(2)}%`);
    }
  }
}

async function tandemTrailing(strategy: Strategy, config: TandemConfig, client: any) {
  const posRes = await client.getPositions(strategy.symbol);
  if (posRes?.code !== 0 || !Array.isArray(posRes.data)) return;

  const posSide = config.survivingSide === "LONG" ? "BUY" : "SELL";
  const survivingPos = posRes.data.find((p: any) => p.side === posSide && parseFloat(p.qty || "0") > 0);

  if (!survivingPos) {
    console.log(`[Tandem ${strategy.id}] Trailing: position gone, completing cycle`);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    return;
  }

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return;
  const currentPrice = ticker.lastPrice;
  const currentQty = parseFloat(survivingPos.qty || "0");
  const precision = await getPairPrecision(strategy.symbol);

  let hwm = config.highWatermark || currentPrice;
  if (config.survivingSide === "LONG") {
    hwm = Math.max(hwm, currentPrice);
  } else {
    hwm = Math.min(hwm, currentPrice);
  }

  const trailingDrop = config.survivingSide === "LONG"
    ? (hwm - currentPrice) / hwm
    : (currentPrice - hwm) / hwm;

  console.log(`[Tandem ${strategy.id}] Trailing: price=${currentPrice.toFixed(4)} hwm=${hwm.toFixed(4)} drop=${(trailingDrop * 100).toFixed(3)}% (trigger=0.5%)`);

  if (trailingDrop >= 0.005) {
    const closeSide = config.survivingSide === "LONG" ? "SELL" : "BUY";
    const qtyStr = roundQty(currentQty, precision.basePrecision);

    console.log(`[Tandem ${strategy.id}] TRAILING STOP triggered: ${closeSide} ${qtyStr} @ MARKET`);

    try {
      const result = await client.placeOrder({
        symbol: strategy.symbol,
        qty: qtyStr,
        side: closeSide,
        tradeSide: "CLOSE",
        orderType: "MARKET",
      });

      const direction = config.survivingSide === "LONG" ? 1 : -1;
      const profitPerUnit = direction * (currentPrice - config.entryPrice);
      const exitPnl = profitPerUnit * currentQty;

      if (result?.code === 0) {
        await storage.updateStrategy(strategy.id, {
          config: { ...config, phase: "complete", highWatermark: hwm, lastActionAt: Date.now() },
          totalPnl: (strategy.totalPnl || 0) + exitPnl,
        });

        await storage.createTradeLog({
          strategyId: strategy.id,
          symbol: strategy.symbol,
          side: closeSide,
          orderType: "MARKET",
          quantity: currentQty,
          price: currentPrice,
          status: "filled",
          orderId: result.data?.orderId || null,
          pnl: exitPnl,
          errorMsg: `Tandem trailing stop (0.5% pullback from ${hwm.toFixed(4)})`,
        });

        console.log(`[Tandem ${strategy.id}] Trailing close: pnl=${exitPnl.toFixed(4)}`);
      } else {
        console.error(`[Tandem ${strategy.id}] Trailing close failed: ${result?.msg}`);
      }
    } catch (e: any) {
      console.error(`[Tandem ${strategy.id}] Trailing close error:`, e.message);
    }
  } else {
    await storage.updateStrategy(strategy.id, {
      config: { ...config, highWatermark: hwm },
    });
  }
}

async function tandemComplete(strategy: Strategy, config: TandemConfig, client: any) {
  console.log(`[Tandem ${strategy.id}] Cycle ${config.cycleCount} complete. Cleaning up and restarting...`);

  try { await client.cancelAllOrders(strategy.symbol); } catch {}
  try {
    const tpRes = await client.getPendingTpslOrders(strategy.symbol);
    if (tpRes?.code === 0) {
      let tpList = tpRes.data;
      if (tpList && !Array.isArray(tpList) && Array.isArray(tpList.orderList)) tpList = tpList.orderList;
      if (Array.isArray(tpList)) {
        for (const tp of tpList) {
          const tpId = tp.id || tp.orderId;
          if (tpId) try { await client.cancelTpslOrder(strategy.symbol, tpId); } catch {}
        }
      }
    }
  } catch {}

  try {
    const posRes = await client.getPositions(strategy.symbol);
    if (posRes?.code === 0 && Array.isArray(posRes.data)) {
      for (const pos of posRes.data) {
        if (parseFloat(pos.qty || "0") > 0) {
          try { await client.flashClose(strategy.symbol, pos.positionId); } catch {}
        }
      }
    }
  } catch {}

  const checkRotation = config.rotationEnabled;
  if (checkRotation) {
    const rotation = await checkPairRotation(strategy);
    if (rotation.shouldRotate && rotation.newSymbol) {
      console.log(`[Tandem ${strategy.id}] Rotating to ${rotation.newSymbol}: ${rotation.reason}`);
      await storage.updateStrategy(strategy.id, {
        symbol: rotation.newSymbol,
        config: {
          ...config,
          phase: "entry",
          entryPrice: 0,
          longPositionId: null,
          shortPositionId: null,
          liquidatedSide: null,
          survivingSide: null,
          survivingPositionId: null,
          cascadeStep: 0,
          tpOrderIds: [],
          highWatermark: 0,
          remainingQty: 0,
          lastActionAt: Date.now(),
        },
      });
      priceFeed.subscribe(rotation.newSymbol);
      return;
    }
  }

  await storage.updateStrategy(strategy.id, {
    config: {
      ...config,
      phase: "entry",
      entryPrice: 0,
      longPositionId: null,
      shortPositionId: null,
      liquidatedSide: null,
      survivingSide: null,
      survivingPositionId: null,
      cascadeStep: 0,
      tpOrderIds: [],
      highWatermark: 0,
      remainingQty: 0,
      lastActionAt: Date.now(),
    },
  });

  console.log(`[Tandem ${strategy.id}] Reset to entry phase for next cycle`);
}

export async function cancelAllTandemOrders(strategyId: number, symbol: string) {
  const client = getBitunixClient();
  if (!client) return;

  try { await client.cancelAllOrders(symbol); } catch {}
  try {
    const tpRes = await client.getPendingTpslOrders(symbol);
    if (tpRes?.code === 0) {
      let tpList = tpRes.data;
      if (tpList && !Array.isArray(tpList) && Array.isArray(tpList.orderList)) tpList = tpList.orderList;
      if (Array.isArray(tpList)) {
        for (const tp of tpList) {
          const tpId = tp.id || tp.orderId;
          if (tpId) try { await client.cancelTpslOrder(symbol, tpId); } catch {}
        }
      }
    }
  } catch {}

  try {
    const posRes = await client.getPositions(symbol);
    if (posRes?.code === 0 && Array.isArray(posRes.data)) {
      for (const pos of posRes.data) {
        if (parseFloat(pos.qty || "0") > 0) {
          try { await client.flashClose(symbol, pos.positionId); } catch {}
        }
      }
    }
  } catch {}
}

const strategyExecutors: Record<string, (strategy: Strategy) => Promise<void>> = {
  grid: guardedExecuteGridStrategy,
  dca: executeDCAStrategy,
  momentum: executeMomentumStrategy,
  tandem: executeTandemStrategy,
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

export interface TandemCycle {
  cycleNum: number;
  entryPrice: number;
  liquidatedSide: "LONG" | "SHORT";
  liquidationPrice: number;
  gridPnlLong: number;
  gridPnlShort: number;
  cascadePnl: number;
  liquidationLoss: number;
  cyclePnl: number;
  cascadeExits: { percent: number; price: number; pnl: number }[];
  trailingExitPrice?: number;
}

export interface TandemSimResult {
  symbol: string;
  leverage: number;
  startPrice: number;
  endPrice: number;
  totalCycles: number;
  totalPnl: number;
  totalGridPnl: number;
  totalCascadePnl: number;
  totalLiquidationLoss: number;
  winCycles: number;
  lossCycles: number;
  maxDrawdown: number;
  capitalUsed: number;
  roiPercent: number;
  cycles: TandemCycle[];
  pricePoints: number;
}

export function simulateTandem(
  priceHistory: { timestamp: number; price: number }[],
  feeRate: number = 0.0006,
  capitalPerSide: number = 50,
  leverage: number = 100,
  feeMultiplier: number = 4.0
): TandemSimResult | null {
  if (!priceHistory || priceHistory.length < 10) return null;

  const roundTripFee = 2 * feeRate;
  const gridGap = feeMultiplier * roundTripFee;
  const liqDistance = 1 / leverage;
  const totalCapital = capitalPerSide * 2;
  const notionalPerSide = capitalPerSide * leverage;
  const maxGrids = Math.floor(liqDistance / gridGap);
  const gridSize = maxGrids > 0 ? notionalPerSide / maxGrids : notionalPerSide;
  const gridProfitPerRoundTrip = (gridSize * gridGap) - (gridSize * roundTripFee);

  const cycles: TandemCycle[] = [];
  let cumulativePnl = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  let i = 0;

  while (i < priceHistory.length - 1) {
    const entryPrice = priceHistory[i].price;
    const longLiqPrice = entryPrice * (1 - liqDistance);
    const shortLiqPrice = entryPrice * (1 + liqDistance);
    const posQty = notionalPerSide / entryPrice;

    const entryFees = notionalPerSide * feeRate * 2;
    let gridPnlLong = 0;
    let gridPnlShort = 0;

    const longOpenBuys = new Set<number>();
    const shortOpenSells = new Set<number>();
    let liquidatedSide: "LONG" | "SHORT" | null = null;
    let liquidationPrice = 0;
    let prevPrice = entryPrice;

    i++;

    while (i < priceHistory.length) {
      const price = priceHistory[i].price;

      if (price <= longLiqPrice) {
        liquidatedSide = "LONG";
        liquidationPrice = price;
        break;
      }
      if (price >= shortLiqPrice) {
        liquidatedSide = "SHORT";
        liquidationPrice = price;
        break;
      }

      const longGridIdx = Math.max(0, Math.floor((entryPrice - price) / (entryPrice * gridGap)));
      const shortGridIdx = Math.max(0, Math.floor((price - entryPrice) / (entryPrice * gridGap)));
      const prevLongIdx = Math.max(0, Math.floor((entryPrice - prevPrice) / (entryPrice * gridGap)));
      const prevShortIdx = Math.max(0, Math.floor((prevPrice - entryPrice) / (entryPrice * gridGap)));

      if (longGridIdx > prevLongIdx) {
        for (let g = prevLongIdx + 1; g <= Math.min(longGridIdx, maxGrids); g++) {
          if (!longOpenBuys.has(g)) {
            longOpenBuys.add(g);
            gridPnlLong -= gridSize * feeRate;
          }
        }
      } else if (longGridIdx < prevLongIdx) {
        for (let g = prevLongIdx; g > longGridIdx && g > 0; g--) {
          if (longOpenBuys.has(g)) {
            longOpenBuys.delete(g);
            gridPnlLong += gridProfitPerRoundTrip;
          }
        }
      }

      if (shortGridIdx > prevShortIdx) {
        for (let g = prevShortIdx + 1; g <= Math.min(shortGridIdx, maxGrids); g++) {
          if (!shortOpenSells.has(g)) {
            shortOpenSells.add(g);
            gridPnlShort -= gridSize * feeRate;
          }
        }
      } else if (shortGridIdx < prevShortIdx) {
        for (let g = prevShortIdx; g > shortGridIdx && g > 0; g--) {
          if (shortOpenSells.has(g)) {
            shortOpenSells.delete(g);
            gridPnlShort += gridProfitPerRoundTrip;
          }
        }
      }

      prevPrice = price;
      i++;
    }

    if (!liquidatedSide || i >= priceHistory.length) break;

    const liquidationLoss = capitalPerSide;

    const survivingSide = liquidatedSide === "LONG" ? "SHORT" : "LONG";
    const direction = survivingSide === "LONG" ? 1 : -1;

    const cascadeExits: TandemCycle["cascadeExits"] = [];
    let cascadePnl = 0;
    let remainingQty = posQty;
    const portions = [2 / 7, 2 / 7, 2 / 7, 1 / 7];
    let cascadeStep = 0;
    const cascadeStartPrice = liquidationPrice;
    let highWatermark = liquidationPrice;

    const survivorLiqPrice = survivingSide === "LONG" ? longLiqPrice : shortLiqPrice;

    i++;
    while (i < priceHistory.length && remainingQty > 0) {
      const price = priceHistory[i].price;

      const survivorLiquidated = survivingSide === "LONG"
        ? price <= survivorLiqPrice
        : price >= survivorLiqPrice;

      if (survivorLiquidated) {
        cascadePnl -= capitalPerSide;
        cascadeExits.push({ percent: -2, price, pnl: -capitalPerSide });
        remainingQty = 0;
        i++;
        break;
      }

      const profitPerUnit = direction * (price - entryPrice);

      if (survivingSide === "LONG") {
        highWatermark = Math.max(highWatermark, price);
      } else {
        highWatermark = Math.min(highWatermark, price);
      }

      if (cascadeStep < 3) {
        const moveBeyondLiq = survivingSide === "LONG"
          ? (price - cascadeStartPrice) / cascadeStartPrice
          : (cascadeStartPrice - price) / cascadeStartPrice;
        const targetPct = (cascadeStep + 1) * 0.01;

        if (moveBeyondLiq >= targetPct) {
          const sellQty = posQty * portions[cascadeStep];
          const exitPnl = profitPerUnit * sellQty - sellQty * price * feeRate;
          cascadePnl += exitPnl;
          remainingQty -= sellQty;
          cascadeExits.push({ percent: cascadeStep + 1, price, pnl: exitPnl });
          cascadeStep++;
          if (cascadeStep >= 3) {
            highWatermark = price;
          }
        }
      }

      if (cascadeStep >= 3) {
        const trailingDrop = survivingSide === "LONG"
          ? (highWatermark - price) / highWatermark
          : (price - highWatermark) / highWatermark;

        if (trailingDrop >= 0.005) {
          const profitPerUnitNow = direction * (price - entryPrice);
          const exitPnl = profitPerUnitNow * remainingQty - remainingQty * price * feeRate;
          cascadePnl += exitPnl;
          cascadeExits.push({ percent: -1, price, pnl: exitPnl });
          remainingQty = 0;
          break;
        }
      }

      i++;
    }

    if (remainingQty > 0 && i >= priceHistory.length) {
      const lastPrice = priceHistory[priceHistory.length - 1].price;
      const profitPerUnit = direction * (lastPrice - entryPrice);
      const exitPnl = profitPerUnit * remainingQty - remainingQty * lastPrice * feeRate;
      cascadePnl += exitPnl;
      cascadeExits.push({ percent: 0, price: lastPrice, pnl: exitPnl });
      remainingQty = 0;
    }

    const cyclePnl = gridPnlLong + gridPnlShort + cascadePnl - liquidationLoss - entryFees;
    cumulativePnl += cyclePnl;

    peakPnl = Math.max(peakPnl, cumulativePnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - cumulativePnl);

    cycles.push({
      cycleNum: cycles.length + 1,
      entryPrice,
      liquidatedSide,
      liquidationPrice,
      gridPnlLong,
      gridPnlShort,
      cascadePnl,
      liquidationLoss: liquidationLoss + entryFees,
      cyclePnl,
      cascadeExits,
    });
  }

  return {
    symbol: "",
    leverage,
    startPrice: priceHistory[0].price,
    endPrice: priceHistory[priceHistory.length - 1].price,
    totalCycles: cycles.length,
    totalPnl: cumulativePnl,
    totalGridPnl: cycles.reduce((s, c) => s + c.gridPnlLong + c.gridPnlShort, 0),
    totalCascadePnl: cycles.reduce((s, c) => s + c.cascadePnl, 0),
    totalLiquidationLoss: cycles.reduce((s, c) => s + c.liquidationLoss, 0),
    winCycles: cycles.filter(c => c.cyclePnl > 0).length,
    lossCycles: cycles.filter(c => c.cyclePnl <= 0).length,
    maxDrawdown,
    capitalUsed: totalCapital,
    roiPercent: totalCapital > 0 ? (cumulativePnl / totalCapital) * 100 : 0,
    cycles,
    pricePoints: priceHistory.length,
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
