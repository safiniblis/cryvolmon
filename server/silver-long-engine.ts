/**
 * Silver Long Strategy Engine
 * Symbol: XAGUSDT (or any symbol)
 *
 * ── Capital allocation ──────────────────────────────────────────────────────
 *   20%  — initial market LONG entry
 *
 * ── Loop phase (ordersHit 0 → 4, i.e. first 5 fills) ──────────────────────
 *   order1 (5%)  at liq + 0.1%
 *   order2 (5%)  at liq + 0.05%
 *
 *   When order1 fills → immediately (no hourly wait):
 *     1. Read fresh liq price from updated position
 *     2. Cancel order2 if still open
 *     3. Place new order1 5% at newLiq + 0.1%
 *     4. Place new order2 5% at newLiq + 0.05%
 *     5. Increment ordersHit
 *
 *   When ordersHit reaches 5 after a fill → switch to final phase:
 *     order1 stays 5% at newLiq + 0.1%
 *     order2 becomes 20% at newLiq + 0.05%
 *
 * ── Final phase (ordersHit == 5) ────────────────────────────────────────────
 *   order1 (5%)  at liq + 0.1%
 *   order2 (20%) at liq + 0.05%
 *
 *   When order1 fills (6th total fill):
 *     1. Read fresh liq price
 *     2. Cancel order2 (20% at 0.05%) if still open
 *     3. Place new order2 (20%) at newLiq + 0.1%   ← moved from 0.05% to 0.1%
 *     4. No new order1 — loop is over
 *     5. ordersHit = 6 → terminal phase
 *
 * ── Terminal phase (ordersHit >= 6) ─────────────────────────────────────────
 *   order2 (20%) at liq + 0.1%   — updated every hour if liq moved
 *   order1Id = null
 *
 * ── Hourly refresh (all phases) ─────────────────────────────────────────────
 *   If no fill detected and 1 hour has passed, re-read liq price and refresh
 *   open orders if liq moved meaningfully.
 *
 * NOTE: tpConfig is reserved for the next take-profit implementation phase.
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

function getLongPos(positions: any[]): any | null {
  return (
    positions.find(
      (p: any) =>
        parseFloat(p.qty || "0") > 0 &&
        (p.side === "LONG" || p.positionSide === "LONG" || p.side === "BUY"),
    ) || null
  );
}

function parseLiq(pos: any): number {
  return parseFloat(pos.liqPrice || pos.liquidationPrice || "0");
}

// ─── config ──────────────────────────────────────────────────────────────────

export interface SilverLongConfig {
  baseCapital: number;
  leverage: number;

  phase: "entry" | "monitoring" | "complete";

  /**
   * 0-4 : loop phase   (5% + 5%)
   *   5 : final phase  (5% + 20%)
   *  6+ : terminal     (20% at 0.1% only, hourly refresh)
   */
  ordersHit: number;

  entryPrice: number;
  entryQty: number;

  positionId: string | null;
  liquidationPrice: number;

  /** 5% limit BUY at liq + 0.1%  (null in terminal phase) */
  order1Id: string | null;
  /** Support limit BUY at liq + 0.05% (loop/final) or liq + 0.1% (terminal, 20%) */
  order2Id: string | null;

  lastLiqCheckAt: number;
  lastActionAt: number;
  totalPnl: number;

  /** Reserved for next implementation phase */
  tpConfig: null | Record<string, any>;
}

// ─── order sizing by phase ───────────────────────────────────────────────────

/**
 * Returns the sizes and offsets for order1 and order2 given ordersHit.
 * Used both when placing orders after a fill AND during hourly refresh.
 */
function orderSpec(ordersHit: number, baseCapital: number) {
  if (ordersHit < 5) {
    // loop phase
    return {
      order1CapPct: 0.05,
      order1Offset: 1.001,
      order2CapPct: 0.05,
      order2Offset: 1.0005,
      hasOrder1: true,
    };
  } else if (ordersHit === 5) {
    // final phase
    return {
      order1CapPct: 0.05,
      order1Offset: 1.001,
      order2CapPct: 0.20,
      order2Offset: 1.0005,
      hasOrder1: true,
    };
  } else {
    // terminal phase — only the 20% order, now at liq + 0.1%
    return {
      order1CapPct: 0,
      order1Offset: 1.001,
      order2CapPct: 0.20,
      order2Offset: 1.001,
      hasOrder1: false,
    };
  }
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

  try {
    await client!.setLeverage(symbol, config.leverage);
    await client!.setMarginMode(symbol, "ISOLATION");
  } catch (e: any) {
    console.warn(`[SilverLong ${strategy.id}] Leverage/margin setup:`, e.message);
  }

  const currentPrice = await getTickerPrice(symbol);
  if (!currentPrice || currentPrice <= 0) {
    console.error(`[SilverLong ${strategy.id}] Could not get ticker price`);
    return;
  }

  const precision = await getPairPrecision(symbol);

  // Market buy 20% of base capital
  const entryMargin = config.baseCapital * 0.20;
  const entryQty = (entryMargin * config.leverage) / currentPrice;
  const entryQtyStr = roundQty(entryQty, precision.basePrecision);

  console.log(`[SilverLong ${strategy.id}] Market BUY ${entryQtyStr} @ ~${currentPrice} (20% = $${entryMargin})`);

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

  // Wait for position to appear on exchange
  await sleep(3000);

  const posRes = await client!.getPositions(symbol);
  const longPos = getLongPos(posRes?.data || []);

  if (!longPos) {
    console.error(`[SilverLong ${strategy.id}] Position not found after entry — will retry`);
    return;
  }

  const liqPrice = parseLiq(longPos);
  const positionId: string | null = longPos.positionId || longPos.id || null;
  const actualEntryPrice = parseFloat(longPos.openPrice || longPos.avgOpenPrice || String(currentPrice));

  if (liqPrice <= 0) {
    console.error(`[SilverLong ${strategy.id}] Liq price is 0 — will retry`);
    return;
  }

  // ordersHit=0 → loop phase, place 5% + 5%
  const { order1Id, order2Id } = await placeOrders(strategy, config, client!, symbol, liqPrice, 0, precision);

  await storage.updateStrategy(strategy.id, {
    config: {
      ...config,
      phase: "monitoring",
      ordersHit: 0,
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
    `[SilverLong ${strategy.id}] Entry done. entry=${actualEntryPrice}, liq=${liqPrice}. ` +
    `Loop orders: 5% @ liq+0.1%=${(liqPrice * 1.001).toFixed(precision.quotePrecision)}, ` +
    `5% @ liq+0.05%=${(liqPrice * 1.0005).toFixed(precision.quotePrecision)}`,
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
  // 1. Check position still alive
  const posRes = await client!.getPositions(symbol);
  const longPos = getLongPos(posRes?.data || []);

  if (!longPos) {
    console.log(`[SilverLong ${strategy.id}] Position gone — stopping`);
    await storage.updateStrategy(strategy.id, {
      status: "stopped",
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    return;
  }

  const now = Date.now();
  const ordersHit = config.ordersHit ?? 0;

  // 2. Check which orders are still open
  const openOrdersRes = await client!.getOpenOrders(symbol);
  const openIds = new Set<string>((openOrdersRes?.data || []).map((o: any) => String(o.orderId)));

  const order1Alive = !!(config.order1Id && openIds.has(String(config.order1Id)));
  // order1 is set, not in open orders → was filled (we never cancel order1 without immediately
  // replacing it, so disappearance == fill)
  const order1Filled = !!(config.order1Id && !openIds.has(String(config.order1Id)));

  // 3. Handle order1 fill (event-driven, no hourly wait needed)
  if (order1Filled) {
    console.log(`[SilverLong ${strategy.id}] order1 filled (total fills so far: ${ordersHit + 1})`);
    await handleOrder1Fill(strategy, config, client!, symbol, longPos, now, ordersHit);
    return;
  }

  // 4. No fill — hourly liq refresh (all phases)
  if (now - (config.lastLiqCheckAt || 0) >= ONE_HOUR_MS) {
    await doHourlyRefresh(strategy, config, client!, symbol, longPos, ordersHit, order1Alive, now);
  }
}

// ─── order1 fill handler ─────────────────────────────────────────────────────

async function handleOrder1Fill(
  strategy: Strategy,
  config: SilverLongConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
  longPos: any,
  now: number,
  ordersHit: number,
) {
  const precision = await getPairPrecision(symbol);

  // Wait briefly for exchange to update position/liq after the fill
  await sleep(2000);

  // Re-read position for fresh liq price
  const posRes2 = await client!.getPositions(symbol);
  const freshPos = getLongPos(posRes2?.data || []) || longPos;
  const newLiqPrice = parseLiq(freshPos);

  if (newLiqPrice <= 0) {
    console.warn(`[SilverLong ${strategy.id}] Fill detected but liq=0, will retry next cycle`);
    return;
  }

  // Cancel order2 if still open
  if (config.order2Id) {
    try {
      await client!.cancelOrder(config.order2Id, symbol);
      console.log(`[SilverLong ${strategy.id}] Cancelled old order2 (${config.order2Id})`);
    } catch (e: any) {
      console.warn(`[SilverLong ${strategy.id}] Cancel order2 (may have filled):`, e.message);
    }
    await sleep(400);
  }

  const newOrdersHit = ordersHit + 1;

  if (newOrdersHit <= 5) {
    // Still in loop phase OR just switched to final phase (newOrdersHit==5 → final)
    const phaseLabel = newOrdersHit < 5 ? "loop" : "final";
    console.log(
      `[SilverLong ${strategy.id}] Placing ${phaseLabel} orders (ordersHit=${newOrdersHit}) at liq=${newLiqPrice}`,
    );

    const { order1Id, order2Id } = await placeOrders(
      strategy, config, client!, symbol, newLiqPrice, newOrdersHit, precision,
    );

    await storage.updateStrategy(strategy.id, {
      config: {
        ...config,
        ordersHit: newOrdersHit,
        liquidationPrice: newLiqPrice,
        order1Id,
        order2Id,
        lastLiqCheckAt: now,
        lastActionAt: now,
      },
    });

    const spec = orderSpec(newOrdersHit, config.baseCapital);
    console.log(
      `[SilverLong ${strategy.id}] New orders: ` +
      `${(spec.order1CapPct * 100).toFixed(0)}% @ liq+0.1%=${(newLiqPrice * 1.001).toFixed(precision.quotePrecision)}, ` +
      `${(spec.order2CapPct * 100).toFixed(0)}% @ liq+0.05%=${(newLiqPrice * 1.0005).toFixed(precision.quotePrecision)}`,
    );

  } else {
    // newOrdersHit == 6 → terminal phase
    // Move the 20% order from liq+0.05% to liq+0.1%, no more order1
    console.log(`[SilverLong ${strategy.id}] 6th fill — entering terminal phase. Moving 20% order to liq+0.1%`);

    const termPrice = newLiqPrice * 1.001;
    const termQty = (config.baseCapital * 0.20 * config.leverage) / termPrice;

    let order2Id: string | null = null;
    try {
      const res = await client!.placeOrder({
        symbol,
        qty: roundQty(termQty, precision.basePrecision),
        side: "BUY",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: roundPrice(termPrice, precision.quotePrecision),
        effect: "GTC",
      });
      order2Id = res?.data?.orderId || null;
      console.log(
        `[SilverLong ${strategy.id}] Terminal order2 (20% @ liq+0.1% = ${termPrice.toFixed(precision.quotePrecision)}): ${order2Id || "FAILED"}`,
      );
    } catch (e: any) {
      console.error(`[SilverLong ${strategy.id}] Terminal order2 error:`, e.message);
    }

    await storage.updateStrategy(strategy.id, {
      config: {
        ...config,
        ordersHit: 6,
        liquidationPrice: newLiqPrice,
        order1Id: null,
        order2Id,
        lastLiqCheckAt: now,
        lastActionAt: now,
      },
    });
  }
}

// ─── hourly liq refresh ───────────────────────────────────────────────────────

async function doHourlyRefresh(
  strategy: Strategy,
  config: SilverLongConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
  longPos: any,
  ordersHit: number,
  order1Alive: boolean,
  now: number,
) {
  const precision = await getPairPrecision(symbol);
  const liveLiq = parseLiq(longPos);

  if (liveLiq <= 0) {
    await storage.updateStrategy(strategy.id, { config: { ...config, lastLiqCheckAt: now } });
    return;
  }

  const minTick = Math.pow(10, -precision.quotePrecision);
  if (Math.abs(liveLiq - config.liquidationPrice) < minTick * 2) {
    console.log(`[SilverLong ${strategy.id}] Hourly: liq unchanged (${liveLiq})`);
    await storage.updateStrategy(strategy.id, { config: { ...config, lastLiqCheckAt: now } });
    return;
  }

  console.log(
    `[SilverLong ${strategy.id}] Hourly: liq moved ${config.liquidationPrice} → ${liveLiq}. Refreshing orders.`,
  );

  // Cancel all open orders for this strategy
  for (const oid of [config.order1Id, config.order2Id]) {
    if (oid) {
      try { await client!.cancelOrder(oid, symbol); } catch (_) {}
    }
  }
  await sleep(500);

  // Place fresh orders appropriate to current phase
  const { order1Id, order2Id } = await placeOrders(
    strategy, config, client!, symbol, liveLiq, ordersHit, precision,
  );

  await storage.updateStrategy(strategy.id, {
    config: {
      ...config,
      liquidationPrice: liveLiq,
      order1Id,
      order2Id,
      lastLiqCheckAt: now,
      lastActionAt: now,
    },
  });

  console.log(`[SilverLong ${strategy.id}] Hourly refresh done at liq=${liveLiq}`);
}

// ─── unified order placement ──────────────────────────────────────────────────

/**
 * Places order1 and/or order2 based on the current ordersHit phase.
 * ordersHit is the NEW value (already incremented after a fill).
 */
async function placeOrders(
  strategy: Strategy,
  config: SilverLongConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
  liqPrice: number,
  ordersHit: number,
  precision: Awaited<ReturnType<typeof getPairPrecision>>,
): Promise<{ order1Id: string | null; order2Id: string | null }> {
  const spec = orderSpec(ordersHit, config.baseCapital);

  let order1Id: string | null = null;
  let order2Id: string | null = null;

  // Place order1 (only in loop and final phases)
  if (spec.hasOrder1) {
    const price1 = liqPrice * spec.order1Offset;
    const qty1 = (config.baseCapital * spec.order1CapPct * config.leverage) / price1;
    try {
      const res = await client!.placeOrder({
        symbol,
        qty: roundQty(qty1, precision.basePrecision),
        side: "BUY",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: roundPrice(price1, precision.quotePrecision),
        effect: "GTC",
      });
      order1Id = res?.data?.orderId || null;
      console.log(
        `[SilverLong ${strategy.id}] order1 (${(spec.order1CapPct * 100).toFixed(0)}% @ liq+0.1% = ${price1.toFixed(precision.quotePrecision)}): ${order1Id || "FAILED"}`,
      );
    } catch (e: any) {
      console.error(`[SilverLong ${strategy.id}] order1 error:`, e.message);
    }
    await sleep(400);
  }

  // Place order2
  {
    const price2 = liqPrice * spec.order2Offset;
    const qty2 = (config.baseCapital * spec.order2CapPct * config.leverage) / price2;
    const label = ordersHit >= 6
      ? `20% @ liq+0.1% = ${price2.toFixed(precision.quotePrecision)}`
      : `${(spec.order2CapPct * 100).toFixed(0)}% @ liq+0.05% = ${price2.toFixed(precision.quotePrecision)}`;
    try {
      const res = await client!.placeOrder({
        symbol,
        qty: roundQty(qty2, precision.basePrecision),
        side: "BUY",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: roundPrice(price2, precision.quotePrecision),
        effect: "GTC",
      });
      order2Id = res?.data?.orderId || null;
      console.log(`[SilverLong ${strategy.id}] order2 (${label}): ${order2Id || "FAILED"}`);
    } catch (e: any) {
      console.error(`[SilverLong ${strategy.id}] order2 error:`, e.message);
    }
  }

  return { order1Id, order2Id };
}
