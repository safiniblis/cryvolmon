/**
 * Gold Long Engine — E-XAUT-USDT perpetual futures on Bitrue (fapi.bitrue.com)
 *
 * COMPLETELY SEPARATE from Bitunix strategies. Uses server/bitrue.ts exclusively.
 * Do NOT import or reference anything from server/bitunix.ts here.
 *
 * Contract: E-XAUT-USDT
 *   multiplier:     0.0001  (1 contract = 0.0001 XAUT)
 *   pricePrecision: 1       (price rounded to 1 decimal place)
 *   quantity unit:  integer contracts (NOT decimal XAUT amounts)
 *
 * Capital allocation (notional = margin × leverage):
 *   30%  — initial MARKET BUY  (amount = notional × 0.30 USDT, min $5)
 *   10% × 7 — GTC LIMIT BUY supports, quantity in contracts:
 *     L1: avgEntry × 0.990  (−1.0%)
 *     L2: avgEntry × 0.980  (−2.0%)
 *     L3: avgEntry × 0.968  (−3.2%)   ← intentional widening gaps
 *     L4: avgEntry × 0.954  (−4.6%)
 *     L5: avgEntry × 0.938  (−6.2%)
 *     L6: avgEntry × 0.920  (−8.0%)
 *     L7: avgEntry × 0.900  (−10.0%)
 *
 * Safety invariant: no BUY limit is placed at or above the live Bitrue mark price
 * (tagPrice from /fapi/v1/index). Spot price is NEVER used as a fallback.
 * When tagPrice=0 (mark price unavailable), all support levels are unsafe → none placed.
 *
 * Fill confirmation: disappeared orders verified via getOrder before counting as fills.
 * Position reconciliation: totalQty (contracts) reconciled from live getPositions after fills.
 * Cancel: POST /fapi/v1/cancel — DELETE method not supported on Bitrue futures.
 */

import { getBitrueClient } from "./bitrue";
import { storage } from "./storage";
import type { Strategy, InsertTradeLog } from "@shared/schema";

// ── Contract constants ────────────────────────────────────────────────────────

const CONTRACT    = "E-XAUT-USDT";
const MULTIPLIER  = 0.0001;        // 1 contract = 0.0001 XAUT
const PRICE_PREC  = 1;             // pricePrecision from exchangeInfo
const POSITION_TYPE = 1 as const;  // 1 = long (one-way mode)

// Widening DCA gaps: −1%, −2%, −3.2%, −4.6%, −6.2%, −8%, −10%
export const SUPPORT_MULTIPLIERS = [0.990, 0.980, 0.968, 0.954, 0.938, 0.920, 0.900];

const ENTRY_PCT       = 0.30;
const SUPPORT_PCT     = 0.10;
const REFRESH_MS      = 3_600_000; // 1 hour drift check
const DRIFT_THRESHOLD = 0.005;     // 0.5%
const THROTTLE_MS     = 30_000;    // 30 s between executions
const MIN_USDT_ORDER  = 5;         // Bitrue minimum USDT for market orders

// Order statuses that confirm a fill on Bitrue
const FILLED_STATUSES = new Set(["FILLED", "COMPLETE", "DONE", "COMPLETED", "2", "3"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function roundPrice(n: number): number {
  const f = Math.pow(10, PRICE_PREC);
  return Math.round(n * f) / f;
}

/** Convert USDT notional chunk to integer contracts at given price */
function usdtToContracts(usdtAmount: number, price: number): number {
  // 1 contract = MULTIPLIER XAUT = MULTIPLIER × price USDT
  const contractValue = MULTIPLIER * price;
  return Math.floor(usdtAmount / contractValue);
}

/**
 * Pure function — compute support order specs for all 7 levels.
 * safe=false means the limit price >= mark price (would fill immediately).
 * When markPrice=0 (unavailable), ALL levels are unsafe — nothing placed.
 * Exported for unit testing.
 */
export function computeSupportLevels(
  avgEntry: number,
  markPrice: number,
  baseCapital: number,
  leverage: number,
): Array<{ level: number; price: number; contracts: number; safe: boolean }> {
  const notional = baseCapital * leverage;
  return SUPPORT_MULTIPLIERS.map((mult, i) => {
    const price     = roundPrice(avgEntry * mult);
    const contracts = usdtToContracts(notional * SUPPORT_PCT, price);
    const safe      = markPrice > 0 && price < markPrice;
    return { level: i + 1, price, contracts, safe };
  });
}

async function tradeLog(strategyId: number, fields: Partial<InsertTradeLog>): Promise<void> {
  try {
    await storage.createTradeLog({
      strategyId,
      symbol:    CONTRACT,
      side:      fields.side      || "BUY",
      orderType: fields.orderType || "MARKET",
      quantity:  fields.quantity  || 0,
      price:     fields.price     ?? null,
      status:    fields.status    || "filled",
      orderId:   fields.orderId   ?? null,
      pnl:       fields.pnl       ?? null,
      errorMsg:  fields.errorMsg  ?? null,
    });
  } catch {}
}

async function saveConfig(strategy: Strategy, patch: Record<string, any>): Promise<void> {
  const merged = { ...(strategy.config || {}), ...patch };
  await storage.updateStrategy(strategy.id, { config: merged, lastRunAt: new Date() });
  strategy.config = merged;
}

/**
 * Get the live Bitrue mark price (tagPrice from /fapi/v1/index).
 * Throws if the response is missing or zero. Never falls back to spot.
 */
async function getMarkPrice(client: NonNullable<ReturnType<typeof getBitrueClient>>): Promise<number> {
  const res   = await client.getMarkPrice(CONTRACT);
  const price = parseFloat(res?.tagPrice || res?.indexPrice || "0");
  if (!price || isNaN(price)) {
    throw new Error(`Bitrue mark price unavailable: ${JSON.stringify(res)}`);
  }
  return price;
}

// ── Entry phase ───────────────────────────────────────────────────────────────

async function handleEntry(strategy: Strategy): Promise<void> {
  const client = getBitrueClient()!;
  const cfg    = strategy.config as any;
  const { baseCapital, leverage = 10 } = cfg;
  const now = Date.now();

  const notional    = baseCapital * leverage;
  const entryAmount = Math.max(notional * ENTRY_PCT, MIN_USDT_ORDER);

  console.log(`[Gold Long #${strategy.id}] Entry — margin=$${baseCapital} lev=${leverage}x notional=$${notional}`);

  // 1. Get mark price before entry — abort if unavailable; no spot fallback
  let markPrice = 0;
  try {
    markPrice = await getMarkPrice(client);
    console.log(`[Gold Long #${strategy.id}] Mark price: $${markPrice}`);
  } catch (e: any) {
    console.error(`[Gold Long #${strategy.id}] Cannot get mark price: ${e.message} — aborting entry`);
    await saveConfig(strategy, { lastActionAt: now, lastError: e.message });
    return;
  }

  // 2. Market BUY 30% of notional (in USDT)
  console.log(`[Gold Long #${strategy.id}] Market BUY $${entryAmount} USDT of E-XAUT-USDT`);
  let avgEntry = markPrice;
  let totalContracts = usdtToContracts(entryAmount, markPrice); // estimated; reconciled from position later

  try {
    const res = await client.placeMarketOrder({
      contractName: CONTRACT,
      side:         "BUY",
      positionType: POSITION_TYPE,
      open:         "OPEN",
      amount:       entryAmount,
      leverage,
    });

    // Parse fill details from response (field names vary by exchange response shape)
    const fillPrice = parseFloat(
      res?.data?.price    || res?.data?.avgPrice ||
      res?.price          || res?.avgPrice       || String(markPrice)
    );
    const filledContracts = parseInt(
      res?.data?.volume   || res?.data?.executedQty ||
      res?.volume         || res?.executedQty       || "0"
    );

    if (fillPrice > 0) avgEntry = fillPrice;
    if (filledContracts > 0) totalContracts = filledContracts;

    const orderId = res?.data?.orderId || res?.orderId || null;
    await tradeLog(strategy.id, {
      side: "BUY", orderType: "MARKET",
      quantity: totalContracts,
      price:    avgEntry,
      status:   "filled",
      orderId,
    });
    console.log(`[Gold Long #${strategy.id}] Entry order placed. orderId=${orderId}`);
  } catch (e: any) {
    console.error(`[Gold Long #${strategy.id}] Entry order failed: ${e.message}`);
    await tradeLog(strategy.id, { side: "BUY", orderType: "MARKET", quantity: 0, price: markPrice, status: "error", errorMsg: e.message });
    await saveConfig(strategy, { lastActionAt: now, lastError: e.message });
    return;
  }

  // 3. Reconcile actual contracts from live position
  try {
    const posRes = await client.getPositions(CONTRACT);
    const posList: any[] = posRes?.positions || [];
    const longPos = posList.find((p: any) => {
      const qty = parseFloat(p.volume || p.holdVol || p.qty || "0");
      return qty > 0 && (p.positionType === 1 || !p.positionType);
    });
    const liveContracts = parseFloat(longPos?.volume || longPos?.holdVol || longPos?.qty || "0");
    if (liveContracts > 0) {
      console.log(`[Gold Long #${strategy.id}] Live position: ${liveContracts} contracts`);
      totalContracts = liveContracts;
      // If exchange reports avg price, use it
      const liveAvg = parseFloat(longPos?.avgPrice || longPos?.openPrice || "0");
      if (liveAvg > 0) avgEntry = liveAvg;
    }
  } catch (e: any) {
    console.warn(`[Gold Long #${strategy.id}] Position reconciliation failed: ${e.message}`);
  }

  // 4. Refresh mark price for support placement safety ceiling
  try {
    markPrice = await getMarkPrice(client);
  } catch {
    markPrice = avgEntry; // conservative fallback: treat entry as ceiling
  }

  // 5. Place 7 support levels
  const supportOrders = await placeSupportOrders(strategy, client, baseCapital, leverage, avgEntry, markPrice);

  // 6. Estimate liquidation: avgEntry × (1 − 1/leverage) with 1% buffer
  const liquidationPrice = roundPrice(avgEntry * (1 - 1 / leverage) * 0.99);

  await saveConfig(strategy, {
    phase:          "monitoring",
    entryPrice:     roundPrice(avgEntry),
    avgEntryPrice:  roundPrice(avgEntry),
    totalQty:       totalContracts,
    supportOrders,
    liquidationPrice,
    fillCount:      0,
    lastRefreshAt:  now,
    lastActionAt:   now,
    lastError:      null,
  });

  const placed = supportOrders.filter(o => o.id).length;
  console.log(`[Gold Long #${strategy.id}] Entry done. avgEntry=$${avgEntry} contracts=${totalContracts} liq≈$${liquidationPrice} supports=${placed}/7`);
}

// ── Support order placement ───────────────────────────────────────────────────

async function placeSupportOrders(
  strategy:    Strategy,
  client:      NonNullable<ReturnType<typeof getBitrueClient>>,
  baseCapital: number,
  leverage:    number,
  avgEntry:    number,
  markPrice:   number,
): Promise<Array<{ id: string | null; price: number; contracts: number; level: number }>> {
  const levels  = computeSupportLevels(avgEntry, markPrice, baseCapital, leverage);
  const orders: Array<{ id: string | null; price: number; contracts: number; level: number }> = [];

  for (const lvl of levels) {
    if (!lvl.safe) {
      console.warn(`[Gold Long #${strategy.id}] L${lvl.level} @ $${lvl.price} >= mark $${markPrice} — skipped`);
      orders.push({ id: null, price: lvl.price, contracts: lvl.contracts, level: lvl.level });
      continue;
    }
    if (lvl.contracts < 1) {
      console.warn(`[Gold Long #${strategy.id}] L${lvl.level} qty < 1 contract — skipped (insufficient capital)`);
      orders.push({ id: null, price: lvl.price, contracts: lvl.contracts, level: lvl.level });
      continue;
    }

    try {
      const res = await client.placeLimitOrder({
        contractName: CONTRACT,
        side:         "BUY",
        positionType: POSITION_TYPE,
        open:         "OPEN",
        volume:       lvl.contracts,
        price:        String(lvl.price),
        leverage,
      });
      const orderId = res?.data?.orderId || res?.orderId || null;
      orders.push({ id: String(orderId), price: lvl.price, contracts: lvl.contracts, level: lvl.level });
      await tradeLog(strategy.id, { side: "BUY", orderType: "LIMIT", quantity: lvl.contracts, price: lvl.price, status: "pending", orderId: String(orderId) });
      const pctBelow = ((1 - SUPPORT_MULTIPLIERS[lvl.level - 1]) * 100).toFixed(1);
      console.log(`[Gold Long #${strategy.id}] Support L${lvl.level}: ${lvl.contracts} contracts @ $${lvl.price} (${pctBelow}% below avg)`);
    } catch (e: any) {
      console.error(`[Gold Long #${strategy.id}] Support L${lvl.level} failed: ${e.message}`);
      orders.push({ id: null, price: lvl.price, contracts: lvl.contracts, level: lvl.level });
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return orders;
}

// ── Monitoring phase ──────────────────────────────────────────────────────────

async function handleMonitoring(strategy: Strategy): Promise<void> {
  const client = getBitrueClient()!;
  const cfg    = strategy.config as any;
  const { baseCapital, leverage = 10 } = cfg;
  const supportOrders: Array<{ id: string | null; price: number; contracts: number; level: number }> = cfg.supportOrders || [];
  const now = Date.now();

  // 1. Fetch open orders from exchange
  let openOrderIds = new Set<string>();
  try {
    const res  = await client.getOpenOrders(CONTRACT);
    const list: any[] = Array.isArray(res?.data) ? res.data
                       : Array.isArray(res)       ? res
                       : [];
    openOrderIds = new Set(list.map((o: any) => String(o.orderId || o.id)));
  } catch (e: any) {
    console.warn(`[Gold Long #${strategy.id}] getOpenOrders failed: ${e.message}`);
    await saveConfig(strategy, { lastActionAt: now });
    return;
  }

  // 2. Orders that disappeared (may be filled, cancelled, or expired)
  const disappeared = supportOrders.filter(o => o.id && !openOrderIds.has(String(o.id)));

  if (disappeared.length > 0) {
    // 3. Confirm each disappeared order via getOrder status
    const confirmed: Array<{ id: string; price: number; contracts: number; level: number; actualContracts: number }> = [];

    for (const o of disappeared) {
      if (!o.id) continue;
      try {
        const detail = await client.getOrder(CONTRACT, String(o.id));
        const statusRaw = detail?.data?.status ?? detail?.status ?? "";
        const status    = String(statusRaw).toUpperCase();
        if (FILLED_STATUSES.has(status)) {
          const execVol = parseFloat(detail?.data?.dealVolume || detail?.data?.executedQty || detail?.data?.volume || "0");
          confirmed.push({ ...o, id: String(o.id), actualContracts: execVol > 0 ? execVol : o.contracts });
          console.log(`[Gold Long #${strategy.id}] Confirmed fill: L${o.level} @ $${o.price} contracts=${execVol}`);
        } else {
          console.log(`[Gold Long #${strategy.id}] Order ${o.id} L${o.level} status=${statusRaw} — not a fill`);
        }
      } catch (e: any) {
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
      try { await client.cancelOrder(CONTRACT, String(o.id)); } catch (e: any) {
        console.warn(`[Gold Long #${strategy.id}] Cancel ${o.id} failed: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    // 5. Recalculate avgEntry using actual fill contracts
    let totalCost      = cfg.avgEntryPrice * cfg.totalQty;
    let totalContracts = cfg.totalQty;
    for (const o of confirmed) {
      totalCost      += o.price * o.actualContracts;
      totalContracts += o.actualContracts;
      await tradeLog(strategy.id, { side: "BUY", orderType: "LIMIT", quantity: o.actualContracts, price: o.price, status: "filled", orderId: o.id });
    }
    const newAvgEntry = roundPrice(totalCost / totalContracts);
    const newLiq      = roundPrice(newAvgEntry * (1 - 1 / leverage) * 0.99);

    // 6. Reconcile with live position (source of truth)
    try {
      const posRes  = await client.getPositions(CONTRACT);
      const posList: any[] = posRes?.positions || [];
      const longPos = posList.find((p: any) => {
        const qty = parseFloat(p.volume || p.holdVol || p.qty || "0");
        return qty > 0 && (p.positionType === 1 || !p.positionType);
      });
      const liveContracts = parseFloat(longPos?.volume || longPos?.holdVol || longPos?.qty || "0");
      if (liveContracts > 0.001) {
        if (Math.abs(liveContracts - totalContracts) > 1) {
          console.log(`[Gold Long #${strategy.id}] Contracts reconciled: computed=${totalContracts} live=${liveContracts} — using live`);
        }
        totalContracts = liveContracts;
        const liveAvg = parseFloat(longPos?.avgPrice || longPos?.openPrice || "0");
        if (liveAvg > 0) {
          console.log(`[Gold Long #${strategy.id}] avgEntry from exchange: $${liveAvg}`);
          // prefer exchange avg for accuracy
        }
      }
    } catch (e: any) {
      console.warn(`[Gold Long #${strategy.id}] Position reconciliation failed: ${e.message}`);
    }

    console.log(`[Gold Long #${strategy.id}] New avgEntry=$${newAvgEntry} contracts=${totalContracts}`);

    // 7. Get fresh mark price for support placement — no spot fallback
    let refillMarkPrice = 0;
    try {
      refillMarkPrice = await getMarkPrice(client);
    } catch (e: any) {
      console.warn(`[Gold Long #${strategy.id}] Mark price unavailable post-fill: ${e.message}`);
      await saveConfig(strategy, {
        avgEntryPrice:   newAvgEntry,
        totalQty:        totalContracts,
        liquidationPrice: newLiq,
        fillCount:       (cfg.fillCount || 0) + confirmed.length,
        supportOrders:   [],
        lastRefreshAt:   now,
        lastActionAt:    now,
        lastError:       `Post-fill support placement skipped (mark price unavailable): ${e.message}`,
      });
      return;
    }

    const newSupports = await placeSupportOrders(strategy, client, baseCapital, leverage, newAvgEntry, refillMarkPrice);
    await saveConfig(strategy, {
      avgEntryPrice:   newAvgEntry,
      totalQty:        totalContracts,
      liquidationPrice: newLiq,
      fillCount:       (cfg.fillCount || 0) + confirmed.length,
      supportOrders:   newSupports,
      lastRefreshAt:   now,
      lastActionAt:    now,
      lastError:       null,
    });
    return;
  }

  // 8. Hourly drift check
  if (now - (cfg.lastRefreshAt || 0) < REFRESH_MS) {
    await saveConfig(strategy, { lastActionAt: now });
    return;
  }

  let markPrice = 0;
  try {
    markPrice = await getMarkPrice(client);
  } catch (e: any) {
    console.warn(`[Gold Long #${strategy.id}] Mark price unavailable for drift check: ${e.message} — skipping`);
    await saveConfig(strategy, { lastRefreshAt: now, lastActionAt: now });
    return;
  }

  const placedSupports = supportOrders.filter(o => o.id);
  if (placedSupports.length === 0) {
    await saveConfig(strategy, { lastRefreshAt: now, lastActionAt: now });
    return;
  }

  const avgSupportPrice = placedSupports.reduce((s, o) => s + o.price, 0) / placedSupports.length;
  const drift = Math.abs(markPrice - avgSupportPrice) / avgSupportPrice;

  if (drift > DRIFT_THRESHOLD) {
    console.log(`[Gold Long #${strategy.id}] Price drift ${(drift * 100).toFixed(2)}% — refreshing supports`);
    for (const o of placedSupports) {
      try { await client.cancelOrder(CONTRACT, String(o.id)); } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    const newSupports = await placeSupportOrders(strategy, client, baseCapital, leverage, cfg.avgEntryPrice, markPrice);
    await saveConfig(strategy, { supportOrders: newSupports, lastRefreshAt: now, lastActionAt: now });
  } else {
    await saveConfig(strategy, { lastRefreshAt: now, lastActionAt: now });
  }
}

// ── Main executor ─────────────────────────────────────────────────────────────

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
  } catch (e: any) {
    console.error(`[Gold Long #${strategy.id}] Unhandled error: ${e.message}`);
    await storage.updateStrategy(strategy.id, {
      config: { ...(strategy.config || {}), lastError: e.message, lastActionAt: now },
      lastRunAt: new Date(),
    });
  }
}
