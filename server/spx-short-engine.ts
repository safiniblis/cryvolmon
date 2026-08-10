/**
 * SPX Short Strategy Engine
 * Default symbol: SPXUSDT
 *
 * Mirror of the Silver Long engine but SHORT direction.
 * Liquidation for a short is ABOVE entry, so support orders are
 * SELL limits placed just BELOW the liquidation price.
 *
 * ── Capital allocation ──────────────────────────────────────────────────────
 *   20%  — initial market SHORT entry
 *
 * ── Loop phase (ordersHit 0 → 4, first 5 fills) ────────────────────────────
 *   order1 (5%)  at liq − 0.1%   (liqPrice × 0.999)
 *   order2 (5%)  at liq − 0.05%  (liqPrice × 0.9995)
 *
 *   When order1 fills → immediately:
 *     1. Read fresh liq price from updated position
 *     2. Cancel order2 if still open
 *     3. Place new order1 5% at newLiq − 0.1%
 *     4. Place new order2 5% at newLiq − 0.05%
 *     5. Increment ordersHit
 *
 *   When ordersHit reaches 5 after a fill → final phase:
 *     order1 stays 5% at newLiq − 0.1%
 *     order2 becomes 20% at newLiq − 0.05%
 *
 * ── Final phase (ordersHit == 5) ────────────────────────────────────────────
 *   When order1 fills (6th total fill):
 *     1. Cancel order2 (20% at −0.05%) if open
 *     2. Place new order2 (20%) at newLiq − 0.1%  ← tightened
 *     3. order1 retired → terminal phase
 *
 * ── Terminal phase (ordersHit >= 6) ─────────────────────────────────────────
 *   order2 (20%) at liq − 0.1% — updated every hour if liq moved
 *
 * ── Hourly refresh (all phases) ─────────────────────────────────────────────
 *   If no fill detected and 1 h has passed, refresh orders if liq moved.
 *
 * NOTE: tpConfig reserved for next take-profit phase.
 */

import { getBitunixClient } from "./bitunix";
import { storage } from "./storage";
import type { Strategy } from "@shared/schema";
import { priceFeed } from "./ws-price-feed";
import { getPairPrecision } from "./strategy-engine";

// ─── helpers ─────────────────────────────────────────────────────────────────

function roundQty(qty: number, precision: number): string {
  return qty.toFixed(precision);
}
function roundPrice(price: number, precision: number): string {
  return price.toFixed(precision);
}
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function getTickerPrice(symbol: string): Promise<number | null> {
  const ws = priceFeed.getLastPrice(symbol);
  if (ws && ws > 0) return ws;
  const client = getBitunixClient();
  if (!client) return null;
  try {
    const result = await client.getTickers(symbol);
    if (result?.data?.length > 0)
      return parseFloat(result.data[0].lastPrice || result.data[0].last || "0");
  } catch (e: any) {
    console.error(`[SpxShort] Ticker error:`, e.message);
  }
  return null;
}

function getShortPos(positions: any[]): any | null {
  return (
    positions.find(
      (p: any) =>
        parseFloat(p.qty || "0") > 0 &&
        (p.side === "SHORT" || p.positionSide === "SHORT" || p.side === "SELL"),
    ) || null
  );
}

function parseLiq(pos: any): number {
  return parseFloat(pos.liqPrice || pos.liquidationPrice || "0");
}

// ─── config ───────────────────────────────────────────────────────────────────

export interface SpxShortConfig {
  baseCapital: number;
  leverage: number;

  /**
   * 0-4 : loop    (5% + 5%)
   *   5 : final   (5% + 20%)
   *  6+ : terminal (20% at liq−0.1% only, hourly refresh)
   */
  ordersHit: number;

  phase: "entry" | "monitoring" | "complete";

  entryPrice: number;
  entryQty: number;
  positionId: string | null;
  liquidationPrice: number;

  /** 5% SELL limit at liq − 0.1%  (null in terminal) */
  order1Id: string | null;
  /** SELL limit at liq − 0.05% (loop/final) or liq − 0.1% (terminal, 20%) */
  order2Id: string | null;

  lastLiqCheckAt: number;
  lastActionAt: number;
  totalPnl: number;

  /** Reserved for take-profit phase */
  tpConfig: null | Record<string, any>;
}

// ─── order sizing by phase ────────────────────────────────────────────────────

function orderSpec(ordersHit: number) {
  if (ordersHit < 5) {
    return { order1CapPct: 0.05, order1Offset: 0.999,  order2CapPct: 0.05, order2Offset: 0.9995, hasOrder1: true };
  } else if (ordersHit === 5) {
    return { order1CapPct: 0.05, order1Offset: 0.999,  order2CapPct: 0.20, order2Offset: 0.9995, hasOrder1: true };
  } else {
    return { order1CapPct: 0,    order1Offset: 0.999,  order2CapPct: 0.20, order2Offset: 0.999,  hasOrder1: false };
  }
}

// ─── executor ────────────────────────────────────────────────────────────────

export async function executeSpxShortStrategy(strategy: Strategy): Promise<void> {
  const config = strategy.config as SpxShortConfig;
  const client = getBitunixClient();
  if (!client) return;
  const symbol = strategy.symbol;
  try {
    if (config.phase === "entry")      await doEntry(strategy, config, client, symbol);
    else if (config.phase === "monitoring") await doMonitoring(strategy, config, client, symbol);
  } catch (e: any) {
    console.error(`[SpxShort ${strategy.id}] Unhandled error:`, e.message);
  }
}

// ─── entry ────────────────────────────────────────────────────────────────────

async function doEntry(
  strategy: Strategy,
  config: SpxShortConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
) {
  console.log(`[SpxShort ${strategy.id}] Entry phase starting`);

  try {
    await client!.setLeverage(symbol, config.leverage);
    await client!.setMarginMode(symbol, "ISOLATION");
  } catch (e: any) {
    console.warn(`[SpxShort ${strategy.id}] Leverage/margin setup:`, e.message);
  }

  const currentPrice = await getTickerPrice(symbol);
  if (!currentPrice || currentPrice <= 0) {
    console.error(`[SpxShort ${strategy.id}] Could not get ticker price`);
    return;
  }

  const precision = await getPairPrecision(symbol);

  // Market SHORT entry — 20% of base capital as margin
  const entryMargin = config.baseCapital * 0.20;
  const entryQty = (entryMargin * config.leverage) / currentPrice;
  const entryQtyStr = roundQty(entryQty, precision.basePrecision);

  console.log(`[SpxShort ${strategy.id}] Market SELL ${entryQtyStr} @ ~${currentPrice} (20% = $${entryMargin})`);

  const entryResult = await client!.placeOrder({
    symbol,
    qty: entryQtyStr,
    side: "SELL",
    tradeSide: "OPEN",
    orderType: "MARKET",
  });

  if (!entryResult?.data?.orderId) {
    console.error(`[SpxShort ${strategy.id}] Entry order failed:`, JSON.stringify(entryResult));
    return;
  }

  await storage.createTradeLog({
    strategyId: strategy.id,
    symbol,
    side: "SELL",
    orderType: "MARKET",
    quantity: parseFloat(entryQtyStr),
    price: currentPrice,
    status: "filled",
    orderId: entryResult.data.orderId,
  });

  await sleep(3000);

  const posRes = await client!.getPositions(symbol);
  const shortPos = getShortPos(posRes?.data || []);

  if (!shortPos) {
    console.error(`[SpxShort ${strategy.id}] Short position not found after entry — will retry`);
    return;
  }

  const liqPrice = parseLiq(shortPos);
  const positionId: string | null = shortPos.positionId || shortPos.id || null;
  const actualEntryPrice = parseFloat(shortPos.openPrice || shortPos.avgOpenPrice || String(currentPrice));

  if (liqPrice <= 0) {
    console.error(`[SpxShort ${strategy.id}] Liq price is 0 — will retry`);
    return;
  }

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
    } satisfies SpxShortConfig,
  });

  console.log(
    `[SpxShort ${strategy.id}] Entry done. entry=${actualEntryPrice}, liq=${liqPrice}. ` +
    `Loop orders: 5% @ liq−0.1%=${(liqPrice * 0.999).toFixed(precision.quotePrecision)}, ` +
    `5% @ liq−0.05%=${(liqPrice * 0.9995).toFixed(precision.quotePrecision)}`,
  );
}

// ─── monitoring ───────────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000;

async function doMonitoring(
  strategy: Strategy,
  config: SpxShortConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
) {
  const posRes = await client!.getPositions(symbol);
  const shortPos = getShortPos(posRes?.data || []);

  if (!shortPos) {
    console.log(`[SpxShort ${strategy.id}] Position gone — stopping`);
    await storage.updateStrategy(strategy.id, {
      status: "stopped",
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    return;
  }

  const now = Date.now();
  const ordersHit = config.ordersHit ?? 0;

  const openOrdersRes = await client!.getOpenOrders(symbol);
  const openIds = new Set<string>((openOrdersRes?.data || []).map((o: any) => String(o.orderId)));

  const order1Filled = !!(config.order1Id && !openIds.has(String(config.order1Id)));

  if (order1Filled) {
    console.log(`[SpxShort ${strategy.id}] order1 filled (total fills so far: ${ordersHit + 1})`);
    await handleOrder1Fill(strategy, config, client!, symbol, shortPos, now, ordersHit);
    return;
  }

  if (now - (config.lastLiqCheckAt || 0) >= ONE_HOUR_MS) {
    const order1Alive = !!(config.order1Id && openIds.has(String(config.order1Id)));
    await doHourlyRefresh(strategy, config, client!, symbol, shortPos, ordersHit, order1Alive, now);
  }
}

// ─── order1 fill handler ──────────────────────────────────────────────────────

async function handleOrder1Fill(
  strategy: Strategy,
  config: SpxShortConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
  shortPos: any,
  now: number,
  ordersHit: number,
) {
  const precision = await getPairPrecision(symbol);
  await sleep(2000);

  const posRes2 = await client!.getPositions(symbol);
  const freshPos = getShortPos(posRes2?.data || []) || shortPos;
  const newLiqPrice = parseLiq(freshPos);

  if (newLiqPrice <= 0) {
    console.warn(`[SpxShort ${strategy.id}] Fill detected but liq=0, retrying next cycle`);
    return;
  }

  if (config.order2Id) {
    try {
      await client!.cancelOrder(config.order2Id, symbol);
      console.log(`[SpxShort ${strategy.id}] Cancelled old order2 (${config.order2Id})`);
    } catch (e: any) {
      console.warn(`[SpxShort ${strategy.id}] Cancel order2 (may have filled):`, e.message);
    }
    await sleep(400);
  }

  const newOrdersHit = ordersHit + 1;

  if (newOrdersHit <= 5) {
    const phaseLabel = newOrdersHit < 5 ? "loop" : "final";
    console.log(`[SpxShort ${strategy.id}] Placing ${phaseLabel} orders (ordersHit=${newOrdersHit}) at liq=${newLiqPrice}`);

    const { order1Id, order2Id } = await placeOrders(strategy, config, client!, symbol, newLiqPrice, newOrdersHit, precision);

    const spec = orderSpec(newOrdersHit);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, ordersHit: newOrdersHit, liquidationPrice: newLiqPrice, order1Id, order2Id, lastLiqCheckAt: now, lastActionAt: now },
    });
    console.log(
      `[SpxShort ${strategy.id}] New orders: ` +
      `${(spec.order1CapPct * 100).toFixed(0)}% @ liq−0.1%=${(newLiqPrice * 0.999).toFixed(precision.quotePrecision)}, ` +
      `${(spec.order2CapPct * 100).toFixed(0)}% @ liq−0.05%=${(newLiqPrice * 0.9995).toFixed(precision.quotePrecision)}`,
    );

  } else {
    // 6th fill → terminal: move 20% order to liq − 0.1%
    console.log(`[SpxShort ${strategy.id}] 6th fill — terminal phase. Moving 20% order to liq−0.1%`);

    const termPrice = newLiqPrice * 0.999;
    const termQty = (config.baseCapital * 0.20 * config.leverage) / termPrice;
    let order2Id: string | null = null;

    try {
      const res = await client!.placeOrder({
        symbol,
        qty: roundQty(termQty, precision.basePrecision),
        side: "SELL",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: roundPrice(termPrice, precision.quotePrecision),
        effect: "GTC",
      });
      order2Id = res?.data?.orderId || null;
      console.log(`[SpxShort ${strategy.id}] Terminal order2 (20% @ liq−0.1% = ${termPrice.toFixed(precision.quotePrecision)}): ${order2Id || "FAILED"}`);
    } catch (e: any) {
      console.error(`[SpxShort ${strategy.id}] Terminal order2 error:`, e.message);
    }

    await storage.updateStrategy(strategy.id, {
      config: { ...config, ordersHit: 6, liquidationPrice: newLiqPrice, order1Id: null, order2Id, lastLiqCheckAt: now, lastActionAt: now },
    });
  }
}

// ─── hourly liq refresh ───────────────────────────────────────────────────────

async function doHourlyRefresh(
  strategy: Strategy,
  config: SpxShortConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
  shortPos: any,
  ordersHit: number,
  _order1Alive: boolean,
  now: number,
) {
  const precision = await getPairPrecision(symbol);
  const liveLiq = parseLiq(shortPos);

  if (liveLiq <= 0) {
    await storage.updateStrategy(strategy.id, { config: { ...config, lastLiqCheckAt: now } });
    return;
  }

  const minTick = Math.pow(10, -precision.quotePrecision);
  if (Math.abs(liveLiq - config.liquidationPrice) < minTick * 2) {
    console.log(`[SpxShort ${strategy.id}] Hourly: liq unchanged (${liveLiq})`);
    await storage.updateStrategy(strategy.id, { config: { ...config, lastLiqCheckAt: now } });
    return;
  }

  console.log(`[SpxShort ${strategy.id}] Hourly: liq moved ${config.liquidationPrice} → ${liveLiq}. Refreshing orders.`);

  for (const oid of [config.order1Id, config.order2Id]) {
    if (oid) { try { await client!.cancelOrder(oid, symbol); } catch (_) {} }
  }
  await sleep(500);

  const { order1Id, order2Id } = await placeOrders(strategy, config, client!, symbol, liveLiq, ordersHit, precision);

  await storage.updateStrategy(strategy.id, {
    config: { ...config, liquidationPrice: liveLiq, order1Id, order2Id, lastLiqCheckAt: now, lastActionAt: now },
  });

  console.log(`[SpxShort ${strategy.id}] Hourly refresh done at liq=${liveLiq}`);
}

// ─── unified order placement ──────────────────────────────────────────────────

async function placeOrders(
  strategy: Strategy,
  config: SpxShortConfig,
  client: ReturnType<typeof getBitunixClient>,
  symbol: string,
  liqPrice: number,
  ordersHit: number,
  precision: Awaited<ReturnType<typeof getPairPrecision>>,
): Promise<{ order1Id: string | null; order2Id: string | null }> {
  const spec = orderSpec(ordersHit);
  let order1Id: string | null = null;
  let order2Id: string | null = null;

  if (spec.hasOrder1) {
    const price1 = liqPrice * spec.order1Offset;  // liq − 0.1%
    const qty1 = (config.baseCapital * spec.order1CapPct * config.leverage) / price1;
    try {
      const res = await client!.placeOrder({
        symbol,
        qty: roundQty(qty1, precision.basePrecision),
        side: "SELL",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: roundPrice(price1, precision.quotePrecision),
        effect: "GTC",
      });
      order1Id = res?.data?.orderId || null;
      console.log(`[SpxShort ${strategy.id}] order1 (${(spec.order1CapPct * 100).toFixed(0)}% @ liq−0.1% = ${price1.toFixed(precision.quotePrecision)}): ${order1Id || "FAILED"}`);
    } catch (e: any) {
      console.error(`[SpxShort ${strategy.id}] order1 error:`, e.message);
    }
    await sleep(400);
  }

  {
    const price2 = liqPrice * spec.order2Offset;
    const qty2 = (config.baseCapital * spec.order2CapPct * config.leverage) / price2;
    const label = ordersHit >= 6
      ? `20% @ liq−0.1% = ${price2.toFixed(precision.quotePrecision)}`
      : `${(spec.order2CapPct * 100).toFixed(0)}% @ liq−0.05% = ${price2.toFixed(precision.quotePrecision)}`;
    try {
      const res = await client!.placeOrder({
        symbol,
        qty: roundQty(qty2, precision.basePrecision),
        side: "SELL",
        tradeSide: "OPEN",
        orderType: "LIMIT",
        price: roundPrice(price2, precision.quotePrecision),
        effect: "GTC",
      });
      order2Id = res?.data?.orderId || null;
      console.log(`[SpxShort ${strategy.id}] order2 (${label}): ${order2Id || "FAILED"}`);
    } catch (e: any) {
      console.error(`[SpxShort ${strategy.id}] order2 error:`, e.message);
    }
  }

  return { order1Id, order2Id };
}
