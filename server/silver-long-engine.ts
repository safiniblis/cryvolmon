/**
 * Silver Long Strategy Engine
 * Symbol: XAGUSDT (or any user-supplied symbol)
 *
 * Phases:
 *   entry      → Market buy 20% of base capital, then place 2 limit support orders near liq price
 *   monitoring → Every 1 hour re-read live liq price, update support orders if it moved
 *   complete   → Position closed/liquidated; strategy stops
 *
 * Capital allocation:
 *   20% — initial market long entry
 *    5% — limit BUY at liquidationPrice + 0.1%   (closer to liq, smaller size)
 *   15% — limit BUY at liquidationPrice + 0.05%  (just above liq, larger size)
 *
 * NOTE: Take-profit scheme is reserved for next implementation phase.
 *       The config has a `tpConfig` field (null for now) to hold future TP parameters.
 */

import { getBitunixClient } from "./bitunix";
import { storage } from "./storage";
import type { Strategy } from "@shared/schema";
import { priceFeed } from "./ws-price-feed";
import { getPairPrecision } from "./strategy-engine";

// ─── helpers ────────────────────────────────────────────────────────────────

function roundQty(qty: number, precision: number): string {
  return qty.toFixed(precision);
}

function roundPrice(price: number, precision: number): string {
  return price.toFixed(precision);
}

async function getTickerPrice(symbol: string): Promise<number | null> {
  const ws = priceFeed.getLastPrice(symbol);
  if (ws && ws > 0) return ws;

  const client = getBitunixClient();
  if (!client) return null;
  try {
    const result = await client.getTickers(symbol);
    if (result?.data?.length > 0) {
      return parseFloat(result.data[0].lastPrice || result.data[0].last || "0");
    }
  } catch (e: any) {
    console.error(`[SilverLong] Ticker error:`, e.message);
  }
  return null;
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── config interface ────────────────────────────────────────────────────────

export interface SilverLongConfig {
  baseCapital: number;
  leverage: number;

  phase: "entry" | "monitoring" | "complete";

  entryPrice: number;
  entryQty: number;

  positionId: string | null;
  liquidationPrice: number;

  /** limit BUY at liq + 0.1%  (5% of base capital) */
  order1Id: string | null;
  /** limit BUY at liq + 0.05% (15% of base capital) */
  order2Id: string | null;

  lastLiqCheckAt: number;
  lastActionAt: number;

  totalPnl: number;

  /** Reserved for next phase — take-profit configuration */
  tpConfig: null | Record<string, any>;
}

// ─── main executor ───────────────────────────────────────────────────────────

export async function executeSilverLongStrategy(strategy: Strategy): Promise<void> {
  const config = strategy.config as SilverLongConfig;
  const client = getBitunixClient();
  if (!client) return;

  const symbol = strategy.symbol;

  try {
    if (config.phase === "entry") {
      await doEntry(strategy, config, client, symbol);
    } else if (config.phase === "monitoring") {
      await doMonitoring(strategy, config, client, symbol);
    }
  } catch (e: any) {
    console.error(`[SilverLong ${strategy.id}] Unhandled error:`, e.message);
  }
}

// ─── entry phase ─────────────────────────────────────────────────────────────

async function doEntry(
  strategy: Strategy,
  config: SilverLongConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
) {
  console.log(`[SilverLong ${strategy.id}] Entry phase starting`);

  // Set leverage and margin mode
  try {
    await client!.setLeverage(symbol, config.leverage);
    await client!.setMarginMode(symbol, "ISOLATION");
  } catch (e: any) {
    console.warn(`[SilverLong ${strategy.id}] Leverage/margin setup:`, e.message);
  }

  // Get current price
  const currentPrice = await getTickerPrice(symbol);
  if (!currentPrice || currentPrice <= 0) {
    console.error(`[SilverLong ${strategy.id}] Could not get ticker price`);
    return;
  }

  const precision = await getPairPrecision(symbol);

  // 20% of base capital as margin → qty
  const entryMargin = config.baseCapital * 0.20;
  const entryQty = (entryMargin * config.leverage) / currentPrice;
  const entryQtyStr = roundQty(entryQty, precision.basePrecision);

  console.log(`[SilverLong ${strategy.id}] Placing market BUY ${entryQtyStr} @ ~${currentPrice} (20% = $${entryMargin})`);

  const entryResult = await client!.placeOrder({
    symbol,
    qty: entryQtyStr,
    side: "BUY",
    tradeSide: "OPEN",
    orderType: "MARKET",
  });

  if (!entryResult?.data?.orderId) {
    console.error(`[SilverLong ${strategy.id}] Entry order failed:`, JSON.stringify(entryResult));
    return;
  }

  await storage.createTradeLog({
    strategyId: strategy.id,
    symbol,
    side: "BUY",
    orderType: "MARKET",
    quantity: parseFloat(entryQtyStr),
    price: currentPrice,
    status: "filled",
    orderId: entryResult.data.orderId,
  });

  // Wait for position to show up on exchange
  await sleep(3000);

  // Read position to get liquidation price and positionId
  const posRes = await client!.getPositions(symbol);
  const positions: any[] = posRes?.data || [];
  const longPos = positions.find(
    (p: any) =>
      parseFloat(p.qty || "0") > 0 &&
      (p.side === "LONG" || p.positionSide === "LONG" || p.side === "BUY"),
  );

  if (!longPos) {
    console.error(`[SilverLong ${strategy.id}] Position not found after entry — will retry next cycle`);
    return;
  }

  const liqPrice = parseFloat(longPos.liqPrice || longPos.liquidationPrice || "0");
  const positionId: string | null = longPos.positionId || longPos.id || null;
  const actualEntryPrice = parseFloat(
    longPos.openPrice || longPos.avgOpenPrice || String(currentPrice),
  );

  if (liqPrice <= 0) {
    console.error(`[SilverLong ${strategy.id}] Liquidation price is 0 — will retry next cycle`);
    return;
  }

  // Place 2 support limit BUY orders near liq price
  const { order1Id, order2Id } = await placeSupportOrders(
    strategy,
    config,
    client!,
    symbol,
    liqPrice,
    precision,
  );

  await storage.updateStrategy(strategy.id, {
    config: {
      ...config,
      phase: "monitoring",
      entryPrice: actualEntryPrice,
      entryQty: parseFloat(entryQtyStr),
      positionId,
      liquidationPrice: liqPrice,
      order1Id,
      order2Id,
      lastLiqCheckAt: Date.now(),
      lastActionAt: Date.now(),
    } satisfies SilverLongConfig,
  });

  console.log(
    `[SilverLong ${strategy.id}] Entry complete. entry=${actualEntryPrice}, liq=${liqPrice}, ` +
    `order1 (+0.1%)=${(liqPrice * 1.001).toFixed(precision.quotePrecision)}, ` +
    `order2 (+0.05%)=${(liqPrice * 1.0005).toFixed(precision.quotePrecision)}`,
  );
}

// ─── monitoring phase ─────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000;

async function doMonitoring(
  strategy: Strategy,
  config: SilverLongConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
) {
  // Check if position is still alive
  const posRes = await client!.getPositions(symbol);
  const positions: any[] = posRes?.data || [];
  const longPos = positions.find(
    (p: any) =>
      parseFloat(p.qty || "0") > 0 &&
      (p.side === "LONG" || p.positionSide === "LONG" || p.side === "BUY"),
  );

  if (!longPos) {
    console.log(`[SilverLong ${strategy.id}] Position gone — marking complete`);
    await storage.updateStrategy(strategy.id, {
      status: "stopped",
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    return;
  }

  // Hourly liq price check
  const now = Date.now();
  if (now - (config.lastLiqCheckAt || 0) < ONE_HOUR_MS) {
    return; // Not time yet
  }

  const liveLiqPrice = parseFloat(longPos.liqPrice || longPos.liquidationPrice || "0");
  if (liveLiqPrice <= 0) {
    console.warn(`[SilverLong ${strategy.id}] Hourly check: liq price still 0, skipping`);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, lastLiqCheckAt: now },
    });
    return;
  }

  const prevLiq = config.liquidationPrice;
  const precision = await getPairPrecision(symbol);
  const minTick = Math.pow(10, -precision.quotePrecision);

  if (Math.abs(liveLiqPrice - prevLiq) < minTick * 2) {
    // Negligible change — just refresh timestamp
    console.log(`[SilverLong ${strategy.id}] Hourly check: liq unchanged (${liveLiqPrice})`);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, lastLiqCheckAt: now },
    });
    return;
  }

  console.log(
    `[SilverLong ${strategy.id}] Hourly check: liq moved ${prevLiq} → ${liveLiqPrice}. Refreshing support orders.`,
  );

  // Cancel old support orders
  for (const orderId of [config.order1Id, config.order2Id]) {
    if (orderId) {
      try {
        await client!.cancelOrder(orderId, symbol);
      } catch (e: any) {
        console.warn(`[SilverLong ${strategy.id}] Cancel order ${orderId}:`, e.message);
      }
    }
  }
  await sleep(600);

  // Place fresh support orders at updated liq levels
  const { order1Id, order2Id } = await placeSupportOrders(
    strategy,
    config,
    client!,
    symbol,
    liveLiqPrice,
    precision,
  );

  await storage.updateStrategy(strategy.id, {
    config: {
      ...config,
      liquidationPrice: liveLiqPrice,
      order1Id,
      order2Id,
      lastLiqCheckAt: now,
      lastActionAt: now,
    },
  });

  console.log(
    `[SilverLong ${strategy.id}] Support orders refreshed at liq=${liveLiqPrice}`,
  );
}

// ─── shared: place the two support limit orders ───────────────────────────────

async function placeSupportOrders(
  strategy: Strategy,
  config: SilverLongConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
  liqPrice: number,
  precision: Awaited<ReturnType<typeof getPairPrecision>>,
): Promise<{ order1Id: string | null; order2Id: string | null }> {
  // Order 1: 5% of base capital, at liqPrice + 0.1%
  const price1 = liqPrice * 1.001;
  const qty1 = (config.baseCapital * 0.05 * config.leverage) / price1;

  // Order 2: 15% of base capital, at liqPrice + 0.05%
  const price2 = liqPrice * 1.0005;
  const qty2 = (config.baseCapital * 0.15 * config.leverage) / price2;

  let order1Id: string | null = null;
  let order2Id: string | null = null;

  try {
    const res1 = await client!.placeOrder({
      symbol,
      qty: roundQty(qty1, precision.basePrecision),
      side: "BUY",
      tradeSide: "OPEN",
      orderType: "LIMIT",
      price: roundPrice(price1, precision.quotePrecision),
      effect: "GTC",
    });
    order1Id = res1?.data?.orderId || null;
    console.log(
      `[SilverLong ${strategy.id}] Support order 1 (5% @ liq+0.1% = ${price1.toFixed(precision.quotePrecision)}): ${order1Id || "FAILED"}`,
    );
  } catch (e: any) {
    console.error(`[SilverLong ${strategy.id}] Support order 1 error:`, e.message);
  }

  await sleep(500);

  try {
    const res2 = await client!.placeOrder({
      symbol,
      qty: roundQty(qty2, precision.basePrecision),
      side: "BUY",
      tradeSide: "OPEN",
      orderType: "LIMIT",
      price: roundPrice(price2, precision.quotePrecision),
      effect: "GTC",
    });
    order2Id = res2?.data?.orderId || null;
    console.log(
      `[SilverLong ${strategy.id}] Support order 2 (15% @ liq+0.05% = ${price2.toFixed(precision.quotePrecision)}): ${order2Id || "FAILED"}`,
    );
  } catch (e: any) {
    console.error(`[SilverLong ${strategy.id}] Support order 2 error:`, e.message);
  }

  return { order1Id, order2Id };
}
