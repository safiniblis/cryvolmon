/**
 * Gold Long Engine — XAUTUSDT perpetual futures on Bitrue (fapi.bitrue.com)
 *
 * Capital allocation (notional = margin × leverage):
 *   30%  — initial market BUY (entry)
 *   10% × 7 — GTC limit BUY support orders anchored to avgEntryPrice:
 *     L1: avgEntry × 0.990  (−1.0%)
 *     L2: avgEntry × 0.980  (−2.0%)
 *     L3: avgEntry × 0.968  (−3.2%)   ← intentional widening gaps, not evenly spaced
 *     L4: avgEntry × 0.954  (−4.6%)
 *     L5: avgEntry × 0.938  (−6.2%)
 *     L6: avgEntry × 0.920  (−8.0%)
 *     L7: avgEntry × 0.900  (−10.0%)
 *
 * Safety invariant: no BUY limit is ever placed at or above the live futures mark price
 * (would execute immediately and trigger a replacement loop). Spot price is never used
 * as a substitute for the futures safety ceiling.
 *
 * On any confirmed fill (verified via getOrder status): cancel remaining supports,
 * reconcile totalQty with live position from exchange, recalculate avgEntry using
 * actual executedQty, re-place 7 supports.
 *
 * Hourly: refresh supports if futures price drifted >0.5% from placement price.
 */

import { getBitrueClient } from "./bitrue";
import { storage } from "./storage";
import type { Strategy, InsertTradeLog } from "@shared/schema";

const SYMBOL = "XAUTUSDT";

// Widening support gaps from -1% to -10% — intentional DCA spacing
export const SUPPORT_MULTIPLIERS = [0.990, 0.980, 0.968, 0.954, 0.938, 0.920, 0.900];

const ENTRY_PCT = 0.30;
const SUPPORT_PCT = 0.10;
const REFRESH_MS = 3_600_000;
const DRIFT_THRESHOLD = 0.005;
const THROTTLE_MS = 30_000;
const QTY_PRECISION = 4;
const PRICE_PRECISION = 2;

// Bitrue order statuses that confirm a fill
const FILLED_STATUSES = new Set(["FILLED", "COMPLETE", "DONE", "COMPLETED"]);

function roundQty(n: number): number {
  const f = Math.pow(10, QTY_PRECISION);
  return Math.floor(n * f) / f;
}
function roundPrice(n: number): number {
  return Math.round(n * Math.pow(10, PRICE_PRECISION)) / Math.pow(10, PRICE_PRECISION);
}

/**
 * Pure function — compute support order specs for all 7 levels.
 * safe=false means price >= currentPrice; those orders MUST NOT be placed.
 * When currentPrice=0 (futures ticker unavailable), all levels are unsafe → nothing placed.
 * Exported for unit testing.
 */
export function computeSupportLevels(
  avgEntry: number,
  currentPrice: number,
  baseCapital: number,
  leverage: number,
): Array<{ level: number; price: number; qty: number; safe: boolean }> {
  const notional = baseCapital * leverage;
  return SUPPORT_MULTIPLIERS.map((mult, i) => {
    const price = roundPrice(avgEntry * mult);
    const qty = roundQty((notional * SUPPORT_PCT) / price);
    // safe iff strictly below futures mark — prevents immediately-marketable BUY limits
    return { level: i + 1, price, qty, safe: currentPrice > 0 && price < currentPrice };
  });
}

async function tradeLog(strategyId: number, fields: Partial<InsertTradeLog>): Promise<void> {
  try {
    await storage.createTradeLog({
      strategyId,
      symbol: SYMBOL,
      side: fields.side || "BUY",
      orderType: fields.orderType || "MARKET",
      quantity: fields.quantity || 0,
      price: fields.price ?? null,
      status: fields.status || "filled",
      orderId: fields.orderId ?? null,
      pnl: fields.pnl ?? null,
      errorMsg: fields.errorMsg ?? null,
    });
  } catch {}
}

async function saveConfig(strategy: Strategy, patch: Record<string, any>): Promise<void> {
  const merged = { ...(strategy.config || {}), ...patch };
  await storage.updateStrategy(strategy.id, { config: merged, lastRunAt: new Date() });
  strategy.config = merged;
}

/** Get live futures mark price — throws if unavailable. Never falls back to spot. */
async function getFuturesPrice(client: ReturnType<typeof getBitrueClient>): Promise<number> {
  const ticker = await client!.getTicker(SYMBOL);
  const price = parseFloat(ticker?.price || ticker?.data?.price || ticker?.lastPrice || "0");
  if (!price || isNaN(price)) {
    throw new Error(`Futures ticker unavailable: ${JSON.stringify(ticker)}`);
  }
  return price;
}

// ── Entry phase ──────────────────────────────────────────────────────────────

async function handleEntry(strategy: Strategy): Promise<void> {
  const client = getBitrueClient()!;
  const cfg = strategy.config as any;
  const { baseCapital, leverage = 10 } = cfg;
  const now = Date.now();

  console.log(`[Gold Long #${strategy.id}] Entry — margin=$${baseCapital} leverage=${leverage}x notional=$${baseCapital * leverage}`);

  // 1. Set leverage
  try {
    await client.setLeverage(SYMBOL, leverage);
    console.log(`[Gold Long #${strategy.id}] Leverage set ${leverage}x`);
  } catch (e: any) {
    console.warn(`[Gold Long #${strategy.id}] setLeverage warning: ${e.message}`);
  }

  // 2. Current futures price — abort if unavailable; no spot fallback
  let currentPrice = 0;
  try {
    currentPrice = await getFuturesPrice(client);
  } catch (e: any) {
    console.error(`[Gold Long #${strategy.id}] Cannot get futures price: ${e.message} — aborting entry`);
    await saveConfig(strategy, { lastActionAt: now, lastError: e.message });
    return;
  }

  // 3. Market BUY 30% of notional
  const notional = baseCapital * leverage;
  const entryQty = roundQty((notional * ENTRY_PCT) / currentPrice);
  let avgEntry = currentPrice;
  let totalQty = entryQty;

  console.log(`[Gold Long #${strategy.id}] Market BUY ${entryQty} XAUT @ ~$${currentPrice}`);
  try {
    const res = await client.placeOrder({
      symbol: SYMBOL,
      side: "BUY",
      type: "MARKET",
      quantity: String(entryQty),
      positionSide: "LONG",
    });
    const fillPrice = parseFloat(res?.avgPrice || res?.price || res?.data?.avgPrice || String(currentPrice));
    const filledQty = parseFloat(res?.executedQty || res?.quantity || res?.data?.executedQty || String(entryQty));
    if (fillPrice > 0) avgEntry = fillPrice;
    if (filledQty > 0) totalQty = filledQty;

    await tradeLog(strategy.id, {
      side: "BUY", orderType: "MARKET",
      quantity: filledQty || entryQty,
      price: fillPrice || currentPrice,
      status: "filled",
      orderId: res?.orderId || res?.data?.orderId || null,
    });
  } catch (e: any) {
    console.error(`[Gold Long #${strategy.id}] Entry market order failed: ${e.message}`);
    await tradeLog(strategy.id, { side: "BUY", orderType: "MARKET", quantity: entryQty, price: currentPrice, status: "error", errorMsg: e.message });
    await saveConfig(strategy, { lastActionAt: now, lastError: e.message });
    return;
  }

  // 4. Refresh futures price after fill for safety ceiling (fill may shift the mark)
  try {
    currentPrice = await getFuturesPrice(client);
  } catch {
    // If price unavailable post-fill, use avgEntry as a conservative ceiling
    // (all supports at avgEntry×mult < avgEntry, so all would be safe relative to entry price)
    currentPrice = avgEntry;
  }

  // 5. Place 7 support levels (safety ceiling = current futures price)
  const supportOrders = await placeSupportOrders(strategy, client, baseCapital, leverage, avgEntry, currentPrice);

  // 6. Estimate liquidation: entry × (1 - 1/lev) with 1% buffer
  const liquidationPrice = roundPrice(avgEntry * (1 - 1 / leverage) * 0.99);

  await saveConfig(strategy, {
    phase: "monitoring",
    entryPrice: roundPrice(avgEntry),
    avgEntryPrice: roundPrice(avgEntry),
    totalQty: roundQty(totalQty),
    supportOrders,
    liquidationPrice,
    fillCount: 0,
    lastRefreshAt: now,
    lastActionAt: now,
    lastError: null,
  });

  const placed = supportOrders.filter(o => o.id).length;
  console.log(`[Gold Long #${strategy.id}] Entry done. avgEntry=$${avgEntry} liq≈$${liquidationPrice} supports=${placed}/${supportOrders.length}`);
}

// ── Support order placement ──────────────────────────────────────────────────

async function placeSupportOrders(
  strategy: Strategy,
  client: ReturnType<typeof getBitrueClient>,
  baseCapital: number,
  leverage: number,
  avgEntry: number,
  currentPrice: number, // futures mark price safety ceiling
): Promise<Array<{ id: string | null; price: number; qty: number; level: number }>> {
  const levels = computeSupportLevels(avgEntry, currentPrice, baseCapital, leverage);
  const orders: Array<{ id: string | null; price: number; qty: number; level: number }> = [];

  for (const lvl of levels) {
    if (!lvl.safe) {
      console.warn(`[Gold Long #${strategy.id}] L${lvl.level} @ $${lvl.price} >= futures mark $${currentPrice} — skipped (would execute immediately)`);
      orders.push({ id: null, price: lvl.price, qty: lvl.qty, level: lvl.level });
      continue;
    }

    try {
      const res = await client!.placeOrder({
        symbol: SYMBOL,
        side: "BUY",
        type: "LIMIT",
        quantity: String(lvl.qty),
        price: String(lvl.price),
        positionSide: "LONG",
        timeInForce: "GTC",
      });
      const orderId = res?.orderId || res?.data?.orderId || null;
      orders.push({ id: orderId, price: lvl.price, qty: lvl.qty, level: lvl.level });
      await tradeLog(strategy.id, { side: "BUY", orderType: "LIMIT", quantity: lvl.qty, price: lvl.price, status: "pending", orderId });
      console.log(`[Gold Long #${strategy.id}] Support L${lvl.level}: ${lvl.qty} XAUT @ $${lvl.price} (${((1 - SUPPORT_MULTIPLIERS[lvl.level - 1]) * 100).toFixed(1)}% below avg)`);
    } catch (e: any) {
      console.error(`[Gold Long #${strategy.id}] Support L${lvl.level} failed: ${e.message}`);
      orders.push({ id: null, price: lvl.price, qty: lvl.qty, level: lvl.level });
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return orders;
}

// ── Monitoring phase ─────────────────────────────────────────────────────────

async function handleMonitoring(strategy: Strategy): Promise<void> {
  const client = getBitrueClient()!;
  const cfg = strategy.config as any;
  const { baseCapital, leverage = 10 } = cfg;
  const supportOrders: Array<{ id: string | null; price: number; qty: number; level: number }> = cfg.supportOrders || [];
  const now = Date.now();

  // 1. Fetch open orders from exchange
  let openOrderIds = new Set<string>();
  try {
    const res = await client.getOpenOrders(SYMBOL);
    const list: any[] = Array.isArray(res) ? res : (res?.list || res?.data || []);
    openOrderIds = new Set(list.map((o: any) => String(o.orderId || o.id)));
  } catch (e: any) {
    console.warn(`[Gold Long #${strategy.id}] getOpenOrders failed: ${e.message}`);
    await saveConfig(strategy, { lastActionAt: now });
    return;
  }

  // 2. Orders that disappeared from the open set (may be filled, cancelled, or rejected)
  const disappeared = supportOrders.filter(o => o.id && !openOrderIds.has(String(o.id)));

  if (disappeared.length > 0) {
    // 3. Confirm each disappeared order by querying its status — must be FILLED to count
    const confirmed: Array<{
      id: string; price: number; qty: number; level: number; actualQty: number;
    }> = [];

    for (const o of disappeared) {
      if (!o.id) continue;
      try {
        const detail = await client.getOrder(SYMBOL, String(o.id));
        const status = String(detail?.status || detail?.data?.status || "").toUpperCase();
        if (FILLED_STATUSES.has(status)) {
          // Use actual executedQty from exchange, not the originally configured qty
          const execQty = parseFloat(detail?.executedQty || detail?.data?.executedQty || "0");
          confirmed.push({ ...o, id: String(o.id), actualQty: execQty > 0 ? execQty : o.qty });
          console.log(`[Gold Long #${strategy.id}] Confirmed fill: L${o.level} @ $${o.price} executedQty=${execQty}`);
        } else {
          // Cancelled, rejected, or expired — do not count as a fill
          console.log(`[Gold Long #${strategy.id}] Order ${o.id} L${o.level} status=${status} — not a fill, ignoring`);
        }
      } catch (e: any) {
        // Cannot confirm — conservatively treat as not filled
        console.warn(`[Gold Long #${strategy.id}] getOrder ${o.id} failed: ${e.message} — treating as not filled`);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    if (confirmed.length === 0) {
      await saveConfig(strategy, { lastActionAt: now });
      return;
    }

    console.log(`[Gold Long #${strategy.id}] ${confirmed.length} confirmed fill(s)`);

    // 4. Cancel remaining open supports
    const stillOpen = supportOrders.filter(o => o.id && openOrderIds.has(String(o.id)));
    for (const o of stillOpen) {
      try {
        await client.cancelOrder(SYMBOL, String(o.id));
      } catch (e: any) {
        console.warn(`[Gold Long #${strategy.id}] Cancel ${o.id} failed: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    // 5. Recalculate avgEntry using actual executedQty (not configured qty)
    let totalCost = cfg.avgEntryPrice * cfg.totalQty;
    let totalQty: number = cfg.totalQty;
    for (const o of confirmed) {
      totalCost += o.price * o.actualQty;
      totalQty += o.actualQty;
      await tradeLog(strategy.id, {
        side: "BUY", orderType: "LIMIT",
        quantity: o.actualQty,
        price: o.price,
        status: "filled",
        orderId: o.id,
      });
    }
    const newAvgEntry = roundPrice(totalCost / totalQty);
    const newLiq = roundPrice(newAvgEntry * (1 - 1 / leverage) * 0.99);

    // 6. Reconcile totalQty with live exchange position (source of truth)
    try {
      const positions = await client.getPositions(SYMBOL);
      const posList: any[] = Array.isArray(positions) ? positions : (positions?.data || positions?.list || []);
      const longPos = posList.find((p: any) => parseFloat(p.positionAmt || p.posAmt || "0") > 0);
      const liveQty = parseFloat(longPos?.positionAmt || longPos?.posAmt || "0");
      if (liveQty > 0.0001) {
        if (Math.abs(liveQty - roundQty(totalQty)) > 0.001) {
          console.log(`[Gold Long #${strategy.id}] Qty reconciled: computed=${roundQty(totalQty)} live=${liveQty} — using live`);
        }
        totalQty = liveQty;
      }
    } catch (e: any) {
      console.warn(`[Gold Long #${strategy.id}] Position reconciliation failed: ${e.message}`);
    }

    console.log(`[Gold Long #${strategy.id}] New avgEntry=$${newAvgEntry} totalQty=${roundQty(totalQty)} XAUT`);

    // 7. Get fresh futures price for safety ceiling — no spot fallback; skip placement if unavailable
    let refillPrice = 0;
    try {
      refillPrice = await getFuturesPrice(client);
    } catch (e: any) {
      console.warn(`[Gold Long #${strategy.id}] Futures price unavailable for post-fill support placement: ${e.message}`);
      await saveConfig(strategy, {
        avgEntryPrice: newAvgEntry,
        totalQty: roundQty(totalQty),
        liquidationPrice: newLiq,
        fillCount: (cfg.fillCount || 0) + confirmed.length,
        supportOrders: [],
        lastRefreshAt: now,
        lastActionAt: now,
        lastError: `Post-fill support placement skipped (futures price unavailable): ${e.message}`,
      });
      return;
    }

    const newSupports = await placeSupportOrders(strategy, client, baseCapital, leverage, newAvgEntry, refillPrice);

    await saveConfig(strategy, {
      avgEntryPrice: newAvgEntry,
      totalQty: roundQty(totalQty),
      liquidationPrice: newLiq,
      fillCount: (cfg.fillCount || 0) + confirmed.length,
      supportOrders: newSupports,
      lastRefreshAt: now,
      lastActionAt: now,
      lastError: null,
    });
    return;
  }

  // 8. Hourly drift check
  if (now - (cfg.lastRefreshAt || 0) < REFRESH_MS) {
    await saveConfig(strategy, { lastActionAt: now });
    return;
  }

  // Get current futures price — no spot fallback; skip refresh if unavailable
  let currentPrice = 0;
  try {
    currentPrice = await getFuturesPrice(client);
  } catch (e: any) {
    console.warn(`[Gold Long #${strategy.id}] Futures price unavailable for drift check: ${e.message} — skipping refresh`);
    await saveConfig(strategy, { lastRefreshAt: now, lastActionAt: now });
    return;
  }

  const placedSupports = supportOrders.filter(o => o.id);
  if (placedSupports.length === 0) {
    await saveConfig(strategy, { lastRefreshAt: now, lastActionAt: now });
    return;
  }

  const avgSupportPrice = placedSupports.reduce((s, o) => s + o.price, 0) / placedSupports.length;
  const drift = Math.abs(currentPrice - avgSupportPrice) / avgSupportPrice;

  if (drift > DRIFT_THRESHOLD) {
    console.log(`[Gold Long #${strategy.id}] Price drift ${(drift * 100).toFixed(2)}% — refreshing supports`);

    for (const o of placedSupports) {
      try { await client.cancelOrder(SYMBOL, String(o.id)); } catch {}
      await new Promise(r => setTimeout(r, 150));
    }

    const newSupports = await placeSupportOrders(strategy, client, baseCapital, leverage, cfg.avgEntryPrice, currentPrice);
    await saveConfig(strategy, { supportOrders: newSupports, lastRefreshAt: now, lastActionAt: now });
  } else {
    await saveConfig(strategy, { lastRefreshAt: now, lastActionAt: now });
  }
}

// ── Main executor ────────────────────────────────────────────────────────────

export async function executeGoldLongStrategy(strategy: Strategy): Promise<void> {
  const client = getBitrueClient();
  if (!client) {
    console.log(`[Gold Long #${strategy.id}] Bitrue client not configured — set BITRUE_API_KEY + BITRUE_SECRET_KEY`);
    return;
  }

  const cfg = (strategy.config || {}) as any;
  const now = Date.now();

  if (cfg.lastActionAt && now - cfg.lastActionAt < THROTTLE_MS) return;

  try {
    if (cfg.phase === "entry") {
      await handleEntry(strategy);
    } else if (cfg.phase === "monitoring") {
      await handleMonitoring(strategy);
    }
    // "complete" phase — nothing to do; user exits manually
  } catch (e: any) {
    console.error(`[Gold Long #${strategy.id}] Unhandled error: ${e.message}`);
    await storage.updateStrategy(strategy.id, {
      config: { ...(strategy.config || {}), lastError: e.message, lastActionAt: now },
      lastRunAt: new Date(),
    });
  }
}
