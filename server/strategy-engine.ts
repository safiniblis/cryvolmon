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
  const targetProfitFeeRatio = 2.5;
  const baseGridRatio = 1 + targetProfitFeeRatio * roundTripFee;

  const gapGrowthBelow = 1.07;
  const gapShrinkAbove = 0.96;

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
  const gapGrowth = config.gapGrowthBelow || 1.07;
  const gapShrink = config.gapShrinkAbove || 0.96;

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
  lastTpEntryPrice?: number;
  lastTpPositionQty?: number;
  lastTpPlacedAt?: number;
  lastTpCount?: number;
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
    const available = parseFloat(accountRes.data.available || "0");
    if (available < 1) {
      return { success: false, message: `Insufficient balance: ${available.toFixed(2)} USDT. Need at least 1 USDT.` };
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

    const levels = getAsymmetricGridLevels(config);
    const buyLevelsIn1Pct = levels.filter(l => l < currentPrice && l >= currentPrice * (1 - bandPct));
    const gridBuyCount = buyLevelsIn1Pct.length;

    const totalMarginSlots = 1 + gridBuyCount;
    const marginPerSlot = available / totalMarginSlots;
    const initialMargin = marginPerSlot;
    const initialNotional = initialMargin * leverage * 0.95;
    const baseQty = Math.max(initialNotional / currentPrice, precision.minTradeVolume);
    const qtyStr = roundQty(baseQty, precision.basePrecision);

    if (!config.lowerPrice) config.lowerPrice = currentPrice * 0.90;
    if (!config.upperPrice) config.upperPrice = currentPrice * 1.02;
    if (!config.liquidationPrice) config.liquidationPrice = currentPrice * 0.88;
    if (!config.amountPerGrid) {
      config.amountPerGrid = Math.max(marginPerSlot, 1);
    }

    console.log(`[InitialBuy ${strategy.id}] Balance=${available.toFixed(2)} USDT, leverage=${leverage}x, gridBuysIn1%=${gridBuyCount}, marginPerSlot=${marginPerSlot.toFixed(2)}, amountPerGrid=${config.amountPerGrid.toFixed(2)}, initialNotional=${initialNotional.toFixed(2)}, qty=${qtyStr} @ ${currentPrice}, range=[${config.lowerPrice.toFixed(2)}-${config.upperPrice.toFixed(2)}]`);

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
      await storage.updateStrategy(strategy.id, {
        totalTrades: (strategy.totalTrades || 0) + 1,
        config: { ...config, initialBuyDone: true, startPrice: currentPrice, lowerPrice: config.lowerPrice, upperPrice: config.upperPrice, liquidationPrice: config.liquidationPrice, amountPerGrid: config.amountPerGrid },
      });

      let remainingBalance = 0;
      try {
        const postBuyAccount = await client.getAccount();
        if (postBuyAccount?.code === 0 && postBuyAccount?.data) {
          remainingBalance = parseFloat(postBuyAccount.data.available || "0");
        }
      } catch {}

      console.log(`[InitialBuy ${strategy.id}] Now placing ${gridBuyCount} limit BUY orders within 1% below entry... (remaining=${remainingBalance.toFixed(2)} USDT)`);
      const gridMarginEach = gridBuyCount > 0 ? remainingBalance / gridBuyCount : 0;
      let placed = 0;
      for (const level of buyLevelsIn1Pct) {
        if (gridMarginEach < 0.5) {
          console.log(`[InitialBuy ${strategy.id}] Skipping grid buys: insufficient margin (${gridMarginEach.toFixed(2)} per order)`);
          break;
        }
        const gridNotional = gridMarginEach * leverage * 0.95;
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

  const bandPct = 0.03;
  const bandLow = currentPrice * (1 - bandPct);
  const bandHigh = currentPrice * (1 + bandPct);

  const feeRate = 0.0006;
  const roundTripFee = 2 * feeRate;
  const minProfitableGap = roundTripFee * 2.5;

  const buyLevels = levels.filter(l => l < currentPrice && l >= bandLow);

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
  try {
    const posRes = await client.getPositions(strategy.symbol);
    if (posRes?.code === 0 && Array.isArray(posRes.data) && posRes.data.length > 0) {
      const pos = posRes.data.find((p: any) => p.side === "BUY");
      if (pos) {
        positionId = pos.positionId;
        positionQty = parseFloat(pos.qty || "0");
        positionEntryPrice = parseFloat(pos.entryPrice || pos.avgPrice || "0");
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

  let availableBalance = 0;
  try {
    const accountRes = await client.getAccount();
    if (accountRes?.code === 0 && accountRes?.data) {
      availableBalance = parseFloat(accountRes.data.available || "0");
    }
  } catch {}

  const missingBuyLevels = buyLevels.filter(l => !coveredBuyPrices.has(roundPrice(l, precision.quotePrecision)));
  const leverage = config.leverage || 8;
  const minOrderMargin = 1.0;
  const usableBalance = availableBalance - 0.1;

  let levelsToFill = 0;
  if (usableBalance > minOrderMargin) {
    levelsToFill = Math.min(missingBuyLevels.length, 4, Math.floor(usableBalance / minOrderMargin));
  }
  const marginPerOrder = levelsToFill > 0 ? usableBalance / levelsToFill : 0;
  const buySlice = missingBuyLevels.slice(0, levelsToFill);

  if (missingBuyLevels.length > 0 && levelsToFill === 0 && coveredBuyPrices.size === 0) {
    console.log(`[Grid ${strategy.id}] No balance for buy orders: ${availableBalance.toFixed(2)} USDT`);
  }

  let placedBuys = 0;
  for (const level of buySlice) {
    const effectiveMargin = Math.min(marginPerOrder, (availableBalance - 0.1) * 0.95);
    if (effectiveMargin < 0.5) break;
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
  const maxTpLevels = 6;
  const allSellLevels = levels.filter(l => l >= minTpPrice && l <= (config.upperPrice || tpRefPrice * 1.02));
  const sellLevels = allSellLevels.slice(0, maxTpLevels);

  console.log(`[Grid ${strategy.id}] Price: ${currentPrice.toFixed(4)} | Entry: ${tpRefPrice.toFixed(4)} | minTp: ${minTpPrice.toFixed(4)} | TP levels: ${sellLevels.length}/${allSellLevels.length} | Buy levels: ${buyLevels.length}`);

  if (positionId && positionQty > 0 && sellLevels.length > 0) {
    const lastTpEntry = config.lastTpEntryPrice || 0;
    const lastTpPosQty = config.lastTpPositionQty || 0;
    const lastTpTime = config.lastTpPlacedAt || 0;
    const lastTpCount = config.lastTpCount || 0;
    const now = Date.now();

    const hasTpsPlaced = lastTpCount > 0 && lastTpTime > 0;
    const entryDroppedEnough = hasTpsPlaced && lastTpEntry > 0 && tpRefPrice < lastTpEntry * 0.995;
    const positionGrewEnough = hasTpsPlaced && lastTpPosQty > 0 && positionQty > lastTpPosQty * 1.15;
    const cooldownOk = (now - lastTpTime) > 60000;

    const needsRebuild = !hasTpsPlaced || ((entryDroppedEnough || positionGrewEnough) && cooldownOk);

    if (!needsRebuild) {
      console.log(`[Grid ${strategy.id}] TPs stable: ${lastTpCount} orders placed at entry ${lastTpEntry.toFixed(4)} for qty ${lastTpPosQty} — no changes`);
    } else {
      if (hasTpsPlaced) {
        const reason = entryDroppedEnough
          ? `entry dropped ${lastTpEntry.toFixed(4)}->${tpRefPrice.toFixed(4)}`
          : `position grew ${lastTpPosQty}->${positionQty}`;
        console.log(`[Grid ${strategy.id}] TP rebuild: ${reason} — cancelling existing TPs`);
        try {
          const tpRes = await client.getPendingTpslOrders(strategy.symbol);
          if (tpRes?.code === 0) {
            let rawData = tpRes.data;
            if (rawData && !Array.isArray(rawData) && Array.isArray(rawData.orderList)) {
              rawData = rawData.orderList;
            }
            if (Array.isArray(rawData)) {
              const positionTps = rawData.filter((t: any) => t.positionId === positionId);
              for (const tp of positionTps) {
                const tpId = tp.id || tp.orderId;
                if (tpId) {
                  await client.cancelTpslOrder(strategy.symbol, tpId);
                  cancelledTps++;
                }
              }
            }
          }
        } catch (e: any) {
          console.error(`[Grid ${strategy.id}] Cancel TPs error:`, e.message);
        }
      }

      const basePrecisionMultiplier = Math.pow(10, precision.basePrecision);
      const tpQtyPerLevel = Math.max(
        Math.floor((positionQty / sellLevels.length) * basePrecisionMultiplier) / basePrecisionMultiplier,
        precision.minTradeVolume
      );
      const targetQtyStr = tpQtyPerLevel.toFixed(precision.basePrecision);

      let levelsToPlace = sellLevels;
      if (tpQtyPerLevel * sellLevels.length > positionQty * 1.02) {
        const maxLevels = Math.floor(positionQty / tpQtyPerLevel);
        levelsToPlace = sellLevels.slice(0, Math.max(maxLevels, 1));
      }

      console.log(`[Grid ${strategy.id}] Placing ${levelsToPlace.length} TP orders, ${targetQtyStr} each (posQty: ${positionQty}, entry: ${tpRefPrice.toFixed(4)})`);

      for (const level of levelsToPlace) {
        const priceStr = roundPrice(level, precision.quotePrecision);
        try {
          const result = await client.placeTpslOrder({
            symbol: strategy.symbol,
            positionId,
            tpPrice: priceStr,
            tpStopType: "LAST_PRICE",
            tpOrderType: "MARKET",
            tpQty: targetQtyStr,
          });
          if (result?.code === 0) placedTps++;
          else console.error(`[Grid ${strategy.id}] TP failed @ ${priceStr}: ${result?.msg}`);
        } catch (e: any) {
          console.error(`[Grid ${strategy.id}] TP error @ ${priceStr}:`, e.message);
        }
      }

      config.lastTpEntryPrice = tpRefPrice;
      config.lastTpPositionQty = positionQty;
      config.lastTpPlacedAt = now;
      config.lastTpCount = placedTps;
      await storage.updateStrategy(strategy.id, { config });
      console.log(`[Grid ${strategy.id}] TP state saved: entry=${tpRefPrice.toFixed(4)} qty=${positionQty} count=${placedTps}`);
    }
  }

  const tpUpperBound = config.upperPrice ? config.upperPrice.toFixed(precision.quotePrecision) : bandHigh.toFixed(precision.quotePrecision);
  console.log(`[Grid ${strategy.id}] Price=${currentPrice.toFixed(precision.quotePrecision)} | BuyBand=[${bandLow.toFixed(precision.quotePrecision)}-${currentPrice.toFixed(precision.quotePrecision)}] TpRange=[${currentPrice.toFixed(precision.quotePrecision)}-${tpUpperBound}] | Buys=${buyLevels.length}(live=${coveredBuyPrices.size}+${placedBuys}) TPs=${sellLevels.length}(+${placedTps}/-${cancelledTps}) | Cancelled=${ordersToCancel.length} | PosQty=${positionQty} | Avail=${availableBalance.toFixed(2)}`);

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
  amountPerGrid: number = 10
): SimulationResult | null {
  if (!priceHistory || priceHistory.length < 3) return null;

  const startPrice = priceHistory[0].price;
  const grid = calculateOptimizedGrid(startPrice, feeRate);
  const levels = generateAllLevels(startPrice, grid.lowerPrice, grid.upperPrice, grid.gridRatio, grid.gapGrowthBelow, grid.gapShrinkAbove);

  if (levels.length < 2) return null;

  const roundTripFee = 2 * feeRate;
  let position = 0;
  let avgEntryPrice = 0;
  let realizedPnl = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;
  let buys = 0;
  let sells = 0;
  const trades: SimulationResult["trades"] = [];

  let lastGridIndex = findGridIndex(startPrice, levels);

  for (let i = 1; i < priceHistory.length; i++) {
    const price = priceHistory[i].price;
    const time = priceHistory[i].timestamp;
    const currentGridIndex = findGridIndex(price, levels);

    if (currentGridIndex !== lastGridIndex && currentGridIndex >= 0) {
      if (currentGridIndex < lastGridIndex && price < startPrice) {
        const cost = amountPerGrid * price;
        const fee = cost * feeRate;
        const newPos = position + amountPerGrid;
        avgEntryPrice = newPos > 0 ? ((avgEntryPrice * position) + cost) / newPos : price;
        position = newPos;
        realizedPnl -= fee;
        buys++;
        trades.push({ time, side: "BUY", price, gridLevel: currentGridIndex, pnl: -fee });
      } else if (currentGridIndex > lastGridIndex && position > 0) {
        const sellQty = Math.min(amountPerGrid, position);
        const revenue = sellQty * price;
        const fee = revenue * feeRate;
        const pnl = sellQty * (price - avgEntryPrice) - fee;
        position -= sellQty;
        realizedPnl += pnl;
        sells++;
        trades.push({ time, side: "SELL", price, gridLevel: currentGridIndex, pnl });
      }

      lastGridIndex = currentGridIndex;
    }

    const equity = realizedPnl + (position * (price - avgEntryPrice));
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
  }

  const endPrice = priceHistory[priceHistory.length - 1].price;
  const unrealizedPnl = position * (endPrice - avgEntryPrice);

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
    leverage: grid.leverage,
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
}

export function computeVolatilityScores(
  cryptoStats: { symbol: string; name: string; currentPrice: number; priceHistory: { timestamp: number; price: number }[] | null }[]
): VolatilityScore[] {
  const scores: VolatilityScore[] = [];

  for (const coin of cryptoStats) {
    const history = coin.priceHistory;
    if (!history || history.length < 2) continue;

    let swings1to5 = 0;
    let largeSwingsUp = 0;
    let largeSwingsDown = 0;

    for (let i = 1; i < history.length; i++) {
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

    const riskGauge = largeSwingsDown > 0
      ? largeSwingsUp / largeSwingsDown
      : (largeSwingsUp > 0 ? 10 : 1);

    const sym = coin.symbol.toUpperCase();
    const bitunixSymbol = sym + "USDT";

    scores.push({
      symbol: coin.symbol,
      name: coin.name,
      score: swings1to5,
      swings1to5,
      largeSwingsUp,
      largeSwingsDown,
      riskGauge,
      currentPrice: coin.currentPrice || 0,
      bitunixSymbol,
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

  try {
    await client.flashClose(strategy.symbol);
    console.log(`[Rotation ${strategy.id}] Closed ${strategy.symbol}: ${reason}`);
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
  };

  await storage.updateStrategy(strategy.id, {
    symbol: newSymbol,
    config: newConfig,
  });

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

  console.log(`[Rotation ${strategy.id}] Switched to ${newSymbol} at ${ticker.lastPrice}`);
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

const strategyExecutors: Record<string, (strategy: Strategy) => Promise<void>> = {
  grid: guardedExecuteGridStrategy,
  dca: executeDCAStrategy,
  momentum: executeMomentumStrategy,
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
    if (tpslRes?.code === 0 && Array.isArray(tpslRes.data) && tpslRes.data.length > 0) {
      let cancelled = 0;
      for (const tp of tpslRes.data) {
        try {
          await client.cancelTpslOrder(symbol, tp.id);
          cancelled++;
        } catch (ce: any) {
          console.error(`[Grid ${strategyId}] Cancel TP ${tp.id} error:`, ce.message);
        }
      }
      console.log(`[Grid ${strategyId}] Cancelled ${cancelled}/${tpslRes.data.length} TP/SL orders for ${symbol}`);
    } else {
      console.log(`[Grid ${strategyId}] No pending TP/SL orders for ${symbol}`);
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
      if (s.type === "grid") {
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
  const lowerBound = config.lowerPrice || 0;
  const buyLevels = allLevels
    .filter(l => l < currentPrice && l >= bandLow && l >= lowerBound)
    .filter(l => !existingBuyPrices.has(roundPrice(l, precision.quotePrecision)));

  if (buyLevels.length === 0) {
    return { success: true, message: "All buy levels already covered", ordersPlaced: 0 };
  }

  const marginPerOrder = amountUsdt / buyLevels.length;
  let placed = 0;
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
        console.error(`[AddMargin ${strategy.id}] BUY failed @ ${priceStr}: ${result?.msg}`);
      }
    } catch (e: any) {
      console.error(`[AddMargin ${strategy.id}] BUY error @ ${priceStr}:`, e.message);
    }
  }

  return { success: true, message: `Placed ${placed} additional buy orders`, ordersPlaced: placed };
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
    }
  } catch (e: any) {
    console.error(`[RemoveMargin ${strategy.id}] Cancel error:`, e.message);
  }

  return {
    success: true,
    message: `Cancelled ${cancelled} bottom buy orders (below $${threshold.toFixed(precision.quotePrecision)})`,
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
