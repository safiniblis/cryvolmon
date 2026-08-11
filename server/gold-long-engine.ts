/**
 * Gold Long Engine — Liq-Floor Dynamic Grid
 * E-XAUT-USDT perpetual futures on Bitrue (fapi.bitrue.com)
 *
 * COMPLETELY SEPARATE from Bitunix strategies. Uses server/bitrue.ts exclusively.
 * Do NOT import or reference anything from server/bitunix.ts here.
 *
 * Strategy overview:
 *   • 30% of notional → MARKET BUY seed position on start
 *   • 4 floor slots (10 / 15 / 20 / 25% of notional), activated sequentially:
 *       Each slot = two limit BUY tiers placed simultaneously:
 *         outer tier (40% of slot notional) at liq + 0.20%
 *         inner tier (60% of slot notional) at liq + 0.05%
 *       When slot N outer fills → pre-place slot N+1 outer immediately
 *       When slot N inner fills → place TP for slot N + place slot N+1 inner
 *       When slot TP fills     → recycle: place fresh outer+inner at updated liq
 *   • 3 seed TPs on the seed position:
 *       A: 6% of notional SELL at seed_entry × 1.0120
 *       B: 4% of notional SELL at seed_entry × 1.0180
 *       C: 3% of notional SELL at seed_entry × 1.0240
 *       On TP fill → buyback at tp_price × (1 − 0.0022), then re-place TP
 *   • Hourly drift check: if live liq price drifted > 0.05% from open floor orders, re-place them
 *   • Funding guard: if currentFundRate < −0.05% AND outside gold market hours,
 *       close floor portion, keep only seed, re-deploy slot #1 at new liq
 *
 * Contract: E-XAUT-USDT
 *   multiplier:     0.0001  (1 contract = 0.0001 XAUT)
 *   pricePrecision: 1       (1 decimal place)
 *   quantity unit:  integer contracts
 *   MARKET orders → "amount" (USDT notional, min $5)
 *   LIMIT  orders → "volume" (integer contracts)
 *   leverage is per-order (no separate leverage endpoint)
 *   Cancel: POST /fapi/v1/cancel — DELETE not supported on Bitrue futures
 */

import { getBitrueClient } from "./bitrue";
import { storage } from "./storage";
import type { Strategy, InsertTradeLog } from "@shared/schema";

// ── Contract constants ────────────────────────────────────────────────────────

const CONTRACT      = "E-XAUT-USDT";
const MULTIPLIER    = 0.0001;       // 1 contract = 0.0001 XAUT
const PRICE_PREC    = 1;            // round to 1 decimal place
const POSITION_TYPE = 1 as const;  // 1 = long (one-way mode)

// ── Capital allocation (% of notional = baseCapital × leverage) ───────────────

const SEED_PCT  = 0.30;
/** Slot notional percentages: slots 1–4. Exported for tests. */
export const SLOT_PCTS = [0.10, 0.15, 0.20, 0.25] as const;
const OUTER_PCT = 0.40;   // 40% of slot notional → outer tier
const INNER_PCT = 0.60;   // 60% of slot notional → inner tier

// ── Floor order placement above liq price ─────────────────────────────────────

const OUTER_LIQ_OFFSET = 0.0020;  // outer: liq + 0.20%
const INNER_LIQ_OFFSET = 0.0005;  // inner: liq + 0.05%
const FLOOR_TP_OFFSET  = 0.0022;  // TP at slot avg_entry + 0.22%

// ── Seed TP configuration ─────────────────────────────────────────────────────

/** Exported for tests. */
export const SEED_TP_CONFIG = [
  { tranche: "A" as const, pct: 0.06, tpPct: 0.0120 },
  { tranche: "B" as const, pct: 0.04, tpPct: 0.0180 },
  { tranche: "C" as const, pct: 0.03, tpPct: 0.0240 },
] as const;
const SEED_BUYBACK_OFFSET = 0.0022;  // buyback at tp_price × (1 − 0.0022)

// ── Timing / thresholds ───────────────────────────────────────────────────────

const THROTTLE_MS         = 30_000;
const REFRESH_MS          = 3_600_000;
const FUNDING_CHECK_MS    = 15 * 60_000;
const FUNDING_COOLDOWN_MS = 4  * 3_600_000;
const DRIFT_THRESHOLD     = 0.0005;   // 0.05% — re-place open floor orders if drifted this far
const FUNDING_THRESHOLD   = -0.0005;  // −0.05% per 8h — trigger funding guard
const MIN_USDT_MARKET     = 5;        // Bitrue minimum market order USDT

const FILLED_STATUSES = new Set(["FILLED", "COMPLETE", "DONE", "COMPLETED", "2", "3"]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FloorSlot {
  index: 1 | 2 | 3 | 4;
  usdtNotional: number;       // total notional USDT for this slot

  outerOrderId: string | null;
  innerOrderId: string | null;
  tpOrderId:    string | null;

  outerFilled:        boolean;
  outerFillContracts: number;
  outerFillPrice:     number;

  innerFilled:        boolean;
  innerFillContracts: number;
  innerFillPrice:     number;

  tpFilled:      boolean;
  avgEntryPrice: number;   // weighted avg; set when both tiers filled
}

export interface SeedTpSlot {
  tranche:        "A" | "B" | "C";
  usdtNotional:   number;
  tpPct:          number;
  tpContracts:    number;
  tpOrderId:      string | null;
  tpFillPrice:    number;
  buybackOrderId: string | null;
  state: "tp_open" | "buyback_open";
}

// ── Pure functions (exported for unit tests) ──────────────────────────────────

export function roundPrice(n: number): number {
  const f = Math.pow(10, PRICE_PREC);
  return Math.round(n * f) / f;
}

/** Convert USDT notional to integer contracts at a given price. */
export function usdtToContracts(usdtNotional: number, price: number): number {
  if (!price || !usdtNotional) return 0;
  return Math.floor(usdtNotional / (price * MULTIPLIER));
}

/** Outer and inner limit-BUY prices for a floor slot given the live liq price. */
export function computeFloorOrderPrices(liqPrice: number): { outerPrice: number; innerPrice: number } {
  return {
    outerPrice: roundPrice(liqPrice * (1 + OUTER_LIQ_OFFSET)),
    innerPrice: roundPrice(liqPrice * (1 + INNER_LIQ_OFFSET)),
  };
}

/** TP limit-sell price for a floor slot based on the slot's weighted-avg entry. */
export function computeFloorTpPrice(avgEntryPrice: number): number {
  return roundPrice(avgEntryPrice * (1 + FLOOR_TP_OFFSET));
}

/** Buyback price for a seed TP re-entry: 0.22% below the TP fill price. */
export function computeSeedBuybackPrice(tpFillPrice: number): number {
  return roundPrice(tpFillPrice * (1 - SEED_BUYBACK_OFFSET));
}

/** True when gold markets are typically active: 08:00–17:00 UTC, Monday–Friday. */
export function isGoldMarketHours(): boolean {
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 17;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
 * Fetch live liq price, avg entry, and contract count from exchange position.
 * Returns null if no long position found.
 * Falls back to formula estimate for liq price if exchange field absent.
 */
async function getLivePosition(
  client:   NonNullable<ReturnType<typeof getBitrueClient>>,
  leverage: number,
): Promise<{ contracts: number; avgPrice: number; liqPrice: number } | null> {
  const res  = await client.getPositions(CONTRACT);
  const list: any[] = res?.positions || [];
  const pos  = list.find((p: any) => {
    const qty = parseFloat(p.volume || p.holdVol || p.qty || "0");
    return qty > 0 && (p.positionType === 1 || p.positionType === undefined);
  });
  if (!pos) return null;

  const contracts = parseFloat(pos.volume   || pos.holdVol  || pos.qty       || "0");
  const avgPrice  = parseFloat(pos.avgOpenPrice || pos.avgPrice  || pos.openPrice || "0");
  const liqRaw    = parseFloat(
    pos.liqPrice || pos.liquidationPrice || pos.liqP || pos.forceClosePrice || pos.blastPrice || "0"
  );
  const liqPrice  = liqRaw > 0
    ? liqRaw
    : (avgPrice > 0 ? roundPrice(avgPrice * (1 - 1 / leverage)) : 0);

  return { contracts, avgPrice, liqPrice };
}

async function getMarkAndFundingRate(
  client: NonNullable<ReturnType<typeof getBitrueClient>>,
): Promise<{ tagPrice: number; fundingRate: number }> {
  const res         = await client.getMarkPrice(CONTRACT);
  const tagPrice    = parseFloat(res?.tagPrice    || res?.indexPrice     || "0");
  const fundingRate = parseFloat(res?.currentFundRate || "0");
  return { tagPrice, fundingRate };
}

/**
 * Confirm a disappeared order is truly filled (not cancelled/expired).
 * Returns fill volume (≥ 0) if filled, or -1 if not a fill.
 * Volume of 0 means "confirmed filled but exchange returned no volume" — caller uses fallback.
 */
async function confirmFill(
  client:  NonNullable<ReturnType<typeof getBitrueClient>>,
  orderId: string,
  id:      number,
): Promise<number> {
  try {
    const detail    = await client.getOrder(CONTRACT, orderId);
    const statusRaw = detail?.data?.status ?? detail?.status ?? "";
    const status    = String(statusRaw).toUpperCase();
    if (!FILLED_STATUSES.has(status)) return -1;
    return parseFloat(
      detail?.data?.dealVolume || detail?.data?.executedQty || detail?.data?.volume || "0"
    );
  } catch (e: any) {
    console.warn(`[Gold Long #${id}] getOrder ${orderId}: ${e.message} — treating as not filled`);
    return -1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Slot activation: place outer + inner limit BUY orders ─────────────────────

async function activateSlot(
  client:   NonNullable<ReturnType<typeof getBitrueClient>>,
  slot:     FloorSlot,
  liqPrice: number,
  leverage: number,
  id:       number,
): Promise<void> {
  const { outerPrice, innerPrice } = computeFloorOrderPrices(liqPrice);
  const outerVol = usdtToContracts(slot.usdtNotional * OUTER_PCT, outerPrice);
  const innerVol = usdtToContracts(slot.usdtNotional * INNER_PCT, innerPrice);

  if (outerVol >= 1) {
    try {
      const res = await client.placeLimitOrder({
        contractName: CONTRACT, side: "BUY", positionType: POSITION_TYPE,
        open: "OPEN", volume: outerVol, price: String(outerPrice), leverage,
      });
      slot.outerOrderId = String(res?.data?.orderId || res?.orderId || "");
      await tradeLog(id, { side: "BUY", orderType: "LIMIT", quantity: outerVol, price: outerPrice, status: "pending", orderId: slot.outerOrderId });
      console.log(`[Gold Long #${id}] Slot #${slot.index} outer: ${outerVol}ct @ $${outerPrice} (liq+0.20%) id=${slot.outerOrderId}`);
    } catch (e: any) {
      console.error(`[Gold Long #${id}] Slot #${slot.index} outer failed: ${e.message}`);
    }
  } else {
    console.warn(`[Gold Long #${id}] Slot #${slot.index} outer: ${outerVol}ct < 1 — insufficient capital`);
  }

  await sleep(250);

  if (innerVol >= 1) {
    try {
      const res = await client.placeLimitOrder({
        contractName: CONTRACT, side: "BUY", positionType: POSITION_TYPE,
        open: "OPEN", volume: innerVol, price: String(innerPrice), leverage,
      });
      slot.innerOrderId = String(res?.data?.orderId || res?.orderId || "");
      await tradeLog(id, { side: "BUY", orderType: "LIMIT", quantity: innerVol, price: innerPrice, status: "pending", orderId: slot.innerOrderId });
      console.log(`[Gold Long #${id}] Slot #${slot.index} inner: ${innerVol}ct @ $${innerPrice} (liq+0.05%) id=${slot.innerOrderId}`);
    } catch (e: any) {
      console.error(`[Gold Long #${id}] Slot #${slot.index} inner failed: ${e.message}`);
    }
  } else {
    console.warn(`[Gold Long #${id}] Slot #${slot.index} inner: ${innerVol}ct < 1 — insufficient capital`);
  }
}

// ── Entry phase ───────────────────────────────────────────────────────────────

async function handleEntry(strategy: Strategy): Promise<void> {
  const client = getBitrueClient()!;
  const cfg    = strategy.config as any;
  const { baseCapital, leverage = 33 } = cfg;
  const notional = baseCapital * leverage;
  const now      = Date.now();
  const id       = strategy.id;

  console.log(`[Gold Long #${id}] Entry — margin=$${baseCapital} lev=${leverage}x notional=$${notional}`);

  // 1. Market BUY seed (30% of notional)
  const seedAmount = Math.max(notional * SEED_PCT, MIN_USDT_MARKET);
  try {
    const res     = await client.placeMarketOrder({
      contractName: CONTRACT, side: "BUY", positionType: POSITION_TYPE,
      open: "OPEN", amount: seedAmount, leverage,
    });
    const orderId = String(res?.data?.orderId || res?.orderId || "");
    console.log(`[Gold Long #${id}] Seed market BUY $${seedAmount.toFixed(2)} placed — orderId=${orderId}`);
    await tradeLog(id, { side: "BUY", orderType: "MARKET", quantity: 0, price: 0, status: "pending", orderId });
  } catch (e: any) {
    console.error(`[Gold Long #${id}] Seed entry failed: ${e.message}`);
    await tradeLog(id, { side: "BUY", orderType: "MARKET", status: "error", errorMsg: e.message });
    await saveConfig(strategy, { lastActionAt: now, lastError: e.message });
    return;
  }

  // 2. Wait for exchange to populate position, then reconcile
  await sleep(3000);
  let seedContracts  = 0;
  let seedEntryPrice = 0;
  let liqPrice       = 0;
  try {
    const pos = await getLivePosition(client, leverage);
    if (pos && pos.contracts > 0) {
      seedContracts  = Math.round(pos.contracts);
      seedEntryPrice = pos.avgPrice;
      liqPrice       = pos.liqPrice;
      console.log(`[Gold Long #${id}] Seed: ${seedContracts}ct @ $${seedEntryPrice}, liq=$${liqPrice}`);
    }
  } catch (e: any) {
    console.warn(`[Gold Long #${id}] Position reconcile: ${e.message}`);
  }

  // Fallback: estimate from mark price
  if (!seedEntryPrice) {
    try {
      const { tagPrice } = await getMarkAndFundingRate(client);
      seedEntryPrice = tagPrice;
      seedContracts  = usdtToContracts(seedAmount, tagPrice);
      liqPrice       = roundPrice(tagPrice * (1 - 1 / leverage));
      console.log(`[Gold Long #${id}] Seed estimated from mark price: $${seedEntryPrice}`);
    } catch (e: any) {
      console.error(`[Gold Long #${id}] Cannot determine seed price — aborting: ${e.message}`);
      await saveConfig(strategy, { lastActionAt: now, lastError: e.message });
      return;
    }
  }

  if (!liqPrice && seedEntryPrice) {
    liqPrice = roundPrice(seedEntryPrice * (1 - 1 / leverage));
  }

  // 3. Build floor slots (idle by default)
  const floorSlots: FloorSlot[] = SLOT_PCTS.map((pct, i) => ({
    index:              (i + 1) as 1 | 2 | 3 | 4,
    usdtNotional:       notional * pct,
    outerOrderId:       null, innerOrderId: null, tpOrderId: null,
    outerFilled: false, outerFillContracts: 0, outerFillPrice: 0,
    innerFilled: false, innerFillContracts: 0, innerFillPrice: 0,
    tpFilled: false, avgEntryPrice: 0,
  }));

  // 4. Activate slot #1 (outer + inner)
  await activateSlot(client, floorSlots[0], liqPrice, leverage, id);

  // 5. Place seed TPs
  const seedTpSlots: SeedTpSlot[] = [];
  for (const tcfg of SEED_TP_CONFIG) {
    const tpNotional  = notional * tcfg.pct;
    const tpContracts = usdtToContracts(tpNotional, seedEntryPrice);
    const tpPrice     = roundPrice(seedEntryPrice * (1 + tcfg.tpPct));
    let   tpOrderId: string | null = null;

    if (tpContracts >= 1) {
      try {
        const res = await client.placeLimitOrder({
          contractName: CONTRACT, side: "SELL", positionType: POSITION_TYPE,
          open: "CLOSE", volume: tpContracts, price: String(tpPrice), leverage,
        });
        tpOrderId = String(res?.data?.orderId || res?.orderId || "");
        await tradeLog(id, { side: "SELL", orderType: "LIMIT", quantity: tpContracts, price: tpPrice, status: "pending", orderId: tpOrderId });
        console.log(`[Gold Long #${id}] Seed TP ${tcfg.tranche}: SELL ${tpContracts}ct @ $${tpPrice} (+${(tcfg.tpPct * 100).toFixed(2)}%) id=${tpOrderId}`);
      } catch (e: any) {
        console.error(`[Gold Long #${id}] Seed TP ${tcfg.tranche} failed: ${e.message}`);
      }
    } else {
      console.warn(`[Gold Long #${id}] Seed TP ${tcfg.tranche}: ${tpContracts}ct < 1 — skipped`);
    }
    await sleep(250);

    seedTpSlots.push({
      tranche: tcfg.tranche, usdtNotional: tpNotional,
      tpPct: tcfg.tpPct, tpContracts, tpOrderId,
      tpFillPrice: 0, buybackOrderId: null, state: "tp_open",
    });
  }

  await saveConfig(strategy, {
    phase: "floor_active",
    seedContracts, seedEntryPrice, liqPrice,
    floorSlots, activeSlotIndex: 0,
    seedTpSlots,
    fundingRate: 0, fundingCheckedAt: 0, fundingReductionAt: null,
    lastRefreshAt: now, lastActionAt: now, lastError: null,
  });

  console.log(`[Gold Long #${id}] Entry done. seed=${seedContracts}ct @ $${seedEntryPrice} liq=$${liqPrice} slot#1 placed`);
}

// ── Monitoring phase ──────────────────────────────────────────────────────────

async function handleMonitoring(strategy: Strategy): Promise<void> {
  const client = getBitrueClient()!;
  const cfg    = strategy.config as any;
  const { leverage = 33 } = cfg;
  const now    = Date.now();
  const id     = strategy.id;

  const floorSlots: FloorSlot[]  = cfg.floorSlots  || [];
  const seedTpSlots: SeedTpSlot[] = cfg.seedTpSlots || [];
  let   liqPrice: number          = cfg.liqPrice     || 0;
  let   activeSlotIndex: number   = cfg.activeSlotIndex ?? 0;

  // 1. Fetch all live open order IDs
  let liveIds = new Set<string>();
  try {
    const res  = await client.getOpenOrders(CONTRACT);
    const list: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    liveIds = new Set(list.map((o: any) => String(o.orderId || o.id)));
  } catch (e: any) {
    console.warn(`[Gold Long #${id}] getOpenOrders: ${e.message}`);
    await saveConfig(strategy, { lastActionAt: now });
    return;
  }

  // 2. Collect all tracked order IDs
  type Kind = "outer" | "inner" | "tp" | "seedTp" | "buyback";
  interface Tracked { kind: Kind; slotIdx: number; orderId: string }
  const tracked: Tracked[] = [];

  for (let i = 0; i < floorSlots.length; i++) {
    const s = floorSlots[i];
    if (s.outerOrderId && !s.outerFilled) tracked.push({ kind: "outer",  slotIdx: i, orderId: s.outerOrderId });
    if (s.innerOrderId && !s.innerFilled) tracked.push({ kind: "inner",  slotIdx: i, orderId: s.innerOrderId });
    if (s.tpOrderId    && !s.tpFilled)    tracked.push({ kind: "tp",     slotIdx: i, orderId: s.tpOrderId    });
  }
  for (let i = 0; i < seedTpSlots.length; i++) {
    const s = seedTpSlots[i];
    if (s.state === "tp_open"      && s.tpOrderId)      tracked.push({ kind: "seedTp",  slotIdx: i, orderId: s.tpOrderId      });
    if (s.state === "buyback_open" && s.buybackOrderId) tracked.push({ kind: "buyback", slotIdx: i, orderId: s.buybackOrderId });
  }

  // 3. Find disappeared (potentially filled) orders
  const disappeared = tracked.filter(t => !liveIds.has(t.orderId));

  if (disappeared.length === 0) {
    await runPeriodicTasks(strategy, client, floorSlots, seedTpSlots, liqPrice, leverage, now, id);
    return;
  }

  // 4. Confirm fills, process in order: outer → inner → tp/seed
  const priority: Record<Kind, number> = { outer: 0, inner: 1, tp: 2, seedTp: 2, buyback: 2 };
  disappeared.sort((a, b) => priority[a.kind] - priority[b.kind]);

  let anyFill = false;

  for (const t of disappeared) {
    const fillVol = await confirmFill(client, t.orderId, id);
    await sleep(150);
    if (fillVol < 0) continue; // not confirmed as fill (cancelled/expired)

    // ── Outer fill ──────────────────────────────────────────────────────────
    if (t.kind === "outer") {
      const slot = floorSlots[t.slotIdx];
      const { outerPrice } = computeFloorOrderPrices(liqPrice);
      const actualVol      = fillVol > 0 ? fillVol : usdtToContracts(slot.usdtNotional * OUTER_PCT, outerPrice);
      slot.outerFilled        = true;
      slot.outerFillContracts = actualVol;
      slot.outerFillPrice     = outerPrice;
      console.log(`[Gold Long #${id}] Slot #${slot.index} OUTER filled: ${actualVol}ct`);
      await tradeLog(id, { side: "BUY", orderType: "LIMIT", quantity: actualVol, price: outerPrice, status: "filled", orderId: t.orderId });
      anyFill = true;

      // Pre-place next slot's outer immediately (cascade protection)
      const nextIdx = t.slotIdx + 1;
      if (nextIdx < floorSlots.length) {
        const nextSlot = floorSlots[nextIdx];
        if (!nextSlot.outerOrderId) {
          try {
            const pos = await getLivePosition(client, leverage);
            if (pos?.liqPrice) liqPrice = pos.liqPrice;
          } catch {}
          const { outerPrice: nOuterPrice } = computeFloorOrderPrices(liqPrice);
          const nVol = usdtToContracts(nextSlot.usdtNotional * OUTER_PCT, nOuterPrice);
          if (nVol >= 1) {
            try {
              const res = await client.placeLimitOrder({
                contractName: CONTRACT, side: "BUY", positionType: POSITION_TYPE,
                open: "OPEN", volume: nVol, price: String(nOuterPrice), leverage,
              });
              nextSlot.outerOrderId = String(res?.data?.orderId || res?.orderId || "");
              await tradeLog(id, { side: "BUY", orderType: "LIMIT", quantity: nVol, price: nOuterPrice, status: "pending", orderId: nextSlot.outerOrderId });
              console.log(`[Gold Long #${id}] Slot #${nextSlot.index} outer pre-placed: ${nVol}ct @ $${nOuterPrice} id=${nextSlot.outerOrderId}`);
            } catch (e: any) {
              console.error(`[Gold Long #${id}] Slot #${nextSlot.index} outer pre-place failed: ${e.message}`);
            }
          }
        }
      }
    }

    // ── Inner fill ──────────────────────────────────────────────────────────
    else if (t.kind === "inner") {
      const slot = floorSlots[t.slotIdx];
      const { innerPrice } = computeFloorOrderPrices(liqPrice);
      const actualVol      = fillVol > 0 ? fillVol : usdtToContracts(slot.usdtNotional * INNER_PCT, innerPrice);
      slot.innerFilled        = true;
      slot.innerFillContracts = actualVol;
      slot.innerFillPrice     = innerPrice;
      console.log(`[Gold Long #${id}] Slot #${slot.index} INNER filled: ${actualVol}ct`);
      await tradeLog(id, { side: "BUY", orderType: "LIMIT", quantity: actualVol, price: innerPrice, status: "filled", orderId: t.orderId });
      anyFill = true;

      // Weighted avg entry for this slot
      const totalCt = slot.outerFillContracts + slot.innerFillContracts;
      slot.avgEntryPrice = totalCt > 0
        ? roundPrice((slot.outerFillPrice * slot.outerFillContracts + innerPrice * slot.innerFillContracts) / totalCt)
        : innerPrice;

      // Refresh liq from exchange (position just grew)
      try {
        const pos = await getLivePosition(client, leverage);
        if (pos?.liqPrice) liqPrice = pos.liqPrice;
      } catch {}

      // Place TP for this slot
      if (!slot.tpOrderId) {
        const tpPrice = computeFloorTpPrice(slot.avgEntryPrice);
        const tpVol   = slot.outerFillContracts + slot.innerFillContracts;
        if (tpVol >= 1) {
          try {
            const res = await client.placeLimitOrder({
              contractName: CONTRACT, side: "SELL", positionType: POSITION_TYPE,
              open: "CLOSE", volume: tpVol, price: String(tpPrice), leverage,
            });
            slot.tpOrderId = String(res?.data?.orderId || res?.orderId || "");
            await tradeLog(id, { side: "SELL", orderType: "LIMIT", quantity: tpVol, price: tpPrice, status: "pending", orderId: slot.tpOrderId });
            console.log(`[Gold Long #${id}] Slot #${slot.index} TP: SELL ${tpVol}ct @ $${tpPrice} (+0.22%) id=${slot.tpOrderId}`);
          } catch (e: any) {
            console.error(`[Gold Long #${id}] Slot #${slot.index} TP failed: ${e.message}`);
          }
        }
      }

      // Place inner for next slot (outer was already pre-placed on outer fill)
      const nextIdx = t.slotIdx + 1;
      if (nextIdx < floorSlots.length) {
        const nextSlot = floorSlots[nextIdx];
        if (!nextSlot.innerOrderId) {
          await sleep(250);
          const { innerPrice: nInnerPrice } = computeFloorOrderPrices(liqPrice);
          const nVol = usdtToContracts(nextSlot.usdtNotional * INNER_PCT, nInnerPrice);
          if (nVol >= 1) {
            try {
              const res = await client.placeLimitOrder({
                contractName: CONTRACT, side: "BUY", positionType: POSITION_TYPE,
                open: "OPEN", volume: nVol, price: String(nInnerPrice), leverage,
              });
              nextSlot.innerOrderId = String(res?.data?.orderId || res?.orderId || "");
              await tradeLog(id, { side: "BUY", orderType: "LIMIT", quantity: nVol, price: nInnerPrice, status: "pending", orderId: nextSlot.innerOrderId });
              console.log(`[Gold Long #${id}] Slot #${nextSlot.index} inner placed: ${nVol}ct @ $${nInnerPrice} id=${nextSlot.innerOrderId}`);
            } catch (e: any) {
              console.error(`[Gold Long #${id}] Slot #${nextSlot.index} inner failed: ${e.message}`);
            }
          }
          activeSlotIndex = nextIdx;
        }
      }
    }

    // ── Floor TP fill → recycle ─────────────────────────────────────────────
    else if (t.kind === "tp") {
      const slot   = floorSlots[t.slotIdx];
      const closed = slot.outerFillContracts + slot.innerFillContracts;
      console.log(`[Gold Long #${id}] Slot #${slot.index} TP FILLED (~${closed}ct) — recycling`);
      await tradeLog(id, { side: "SELL", orderType: "LIMIT", quantity: closed, price: slot.avgEntryPrice, status: "filled", orderId: t.orderId });
      anyFill = true;

      // Refresh liq after TP close
      try {
        const pos = await getLivePosition(client, leverage);
        if (pos?.liqPrice) liqPrice = pos.liqPrice;
      } catch {}

      // Reset slot and place fresh outer+inner at updated liq
      slot.outerOrderId = null; slot.innerOrderId = null; slot.tpOrderId = null;
      slot.outerFilled  = false; slot.outerFillContracts = 0; slot.outerFillPrice = 0;
      slot.innerFilled  = false; slot.innerFillContracts = 0; slot.innerFillPrice = 0;
      slot.tpFilled     = false; slot.avgEntryPrice = 0;
      await sleep(250);
      await activateSlot(client, slot, liqPrice, leverage, id);
    }

    // ── Seed TP fill → place buyback ────────────────────────────────────────
    else if (t.kind === "seedTp") {
      const sSlot   = seedTpSlots[t.slotIdx];
      const tpPrice = roundPrice((cfg.seedEntryPrice || 0) * (1 + sSlot.tpPct));
      sSlot.tpFillPrice = tpPrice;
      console.log(`[Gold Long #${id}] Seed TP ${sSlot.tranche} FILLED @ $${tpPrice} — placing buyback`);
      await tradeLog(id, { side: "SELL", orderType: "LIMIT", quantity: sSlot.tpContracts, price: tpPrice, status: "filled", orderId: t.orderId });
      anyFill = true;

      const buybackPrice = computeSeedBuybackPrice(tpPrice);
      const buybackVol   = usdtToContracts(sSlot.usdtNotional, buybackPrice);
      if (buybackVol >= 1) {
        try {
          const res = await client.placeLimitOrder({
            contractName: CONTRACT, side: "BUY", positionType: POSITION_TYPE,
            open: "OPEN", volume: buybackVol, price: String(buybackPrice), leverage,
          });
          sSlot.buybackOrderId = String(res?.data?.orderId || res?.orderId || "");
          sSlot.state          = "buyback_open";
          sSlot.tpOrderId      = null;
          await tradeLog(id, { side: "BUY", orderType: "LIMIT", quantity: buybackVol, price: buybackPrice, status: "pending", orderId: sSlot.buybackOrderId });
          console.log(`[Gold Long #${id}] Seed TP ${sSlot.tranche} buyback: ${buybackVol}ct @ $${buybackPrice} (-0.22%) id=${sSlot.buybackOrderId}`);
        } catch (e: any) {
          console.error(`[Gold Long #${id}] Seed TP ${sSlot.tranche} buyback failed: ${e.message}`);
        }
      }
    }

    // ── Buyback fill → re-place seed TP ────────────────────────────────────
    else if (t.kind === "buyback") {
      const sSlot = seedTpSlots[t.slotIdx];
      console.log(`[Gold Long #${id}] Seed TP ${sSlot.tranche} buyback FILLED — re-placing TP`);
      await tradeLog(id, { side: "BUY", orderType: "LIMIT", quantity: sSlot.tpContracts, price: computeSeedBuybackPrice(sSlot.tpFillPrice), status: "filled", orderId: t.orderId });
      anyFill = true;

      const tpPrice = roundPrice((cfg.seedEntryPrice || 0) * (1 + sSlot.tpPct));
      try {
        const res = await client.placeLimitOrder({
          contractName: CONTRACT, side: "SELL", positionType: POSITION_TYPE,
          open: "CLOSE", volume: sSlot.tpContracts, price: String(tpPrice), leverage,
        });
        sSlot.tpOrderId      = String(res?.data?.orderId || res?.orderId || "");
        sSlot.buybackOrderId = null;
        sSlot.state          = "tp_open";
        await tradeLog(id, { side: "SELL", orderType: "LIMIT", quantity: sSlot.tpContracts, price: tpPrice, status: "pending", orderId: sSlot.tpOrderId });
        console.log(`[Gold Long #${id}] Seed TP ${sSlot.tranche} re-placed @ $${tpPrice}`);
      } catch (e: any) {
        console.error(`[Gold Long #${id}] Seed TP ${sSlot.tranche} re-place failed: ${e.message}`);
      }
    }
  }

  await saveConfig(strategy, {
    floorSlots, seedTpSlots, liqPrice, activeSlotIndex,
    lastActionAt: now, lastError: anyFill ? null : cfg.lastError,
  });

  await runPeriodicTasks(strategy, client, floorSlots, seedTpSlots, liqPrice, leverage, now, id);
}

// ── Periodic tasks: funding check + hourly drift rebalance ────────────────────

async function runPeriodicTasks(
  strategy:    Strategy,
  client:      NonNullable<ReturnType<typeof getBitrueClient>>,
  floorSlots:  FloorSlot[],
  seedTpSlots: SeedTpSlot[],
  liqPrice:    number,
  leverage:    number,
  now:         number,
  id:          number,
): Promise<void> {
  const cfg = strategy.config as any;

  // Funding rate check (every 15 min)
  let fundingRate        = cfg.fundingRate        || 0;
  let fundingCheckedAt   = cfg.fundingCheckedAt   || 0;
  let fundingReductionAt = cfg.fundingReductionAt || null;

  if (now - fundingCheckedAt >= FUNDING_CHECK_MS) {
    try {
      const { fundingRate: fr } = await getMarkAndFundingRate(client);
      fundingRate      = fr;
      fundingCheckedAt = now;
    } catch {}

    const recentReduction = fundingReductionAt && (now - fundingReductionAt < FUNDING_COOLDOWN_MS);
    if (fundingRate < FUNDING_THRESHOLD && !isGoldMarketHours() && !recentReduction) {
      console.log(`[Gold Long #${id}] Funding guard: rate=${fundingRate} off-hours — reducing to seed`);
      await reduceToSeedPosition(strategy, client, floorSlots, leverage, id);
      fundingReductionAt = now;
      // Re-read updated liqPrice from config after reduce
      liqPrice = (strategy.config as any).liqPrice || liqPrice;
    }

    await saveConfig(strategy, { fundingRate, fundingCheckedAt, fundingReductionAt, floorSlots, seedTpSlots });
  }

  // Hourly drift check
  if (now - (cfg.lastRefreshAt || 0) < REFRESH_MS) {
    await saveConfig(strategy, { lastActionAt: now });
    return;
  }

  // Fetch fresh liq price
  let freshLiq = liqPrice;
  try {
    const pos = await getLivePosition(client, leverage);
    if (pos?.liqPrice) freshLiq = pos.liqPrice;
  } catch {}

  const { outerPrice: targetOuter, innerPrice: targetInner } = computeFloorOrderPrices(freshLiq);
  let rebalanced = false;

  for (const slot of floorSlots) {
    // Rebalance outer only if not yet filled
    if (slot.outerOrderId && !slot.outerFilled) {
      const storedOuter = computeFloorOrderPrices(liqPrice).outerPrice;
      const drift       = Math.abs(storedOuter - targetOuter) / targetOuter;
      if (drift > DRIFT_THRESHOLD) {
        try { await client.cancelOrder(CONTRACT, slot.outerOrderId); } catch {}
        await sleep(200);
        const vol = usdtToContracts(slot.usdtNotional * OUTER_PCT, targetOuter);
        if (vol >= 1) {
          try {
            const res = await client.placeLimitOrder({
              contractName: CONTRACT, side: "BUY", positionType: POSITION_TYPE,
              open: "OPEN", volume: vol, price: String(targetOuter), leverage,
            });
            slot.outerOrderId = String(res?.data?.orderId || res?.orderId || "");
            rebalanced = true;
            console.log(`[Gold Long #${id}] Slot #${slot.index} outer rebalanced → $${targetOuter} (drift ${(drift * 100).toFixed(3)}%)`);
          } catch (e: any) {
            slot.outerOrderId = null;
            console.error(`[Gold Long #${id}] Slot #${slot.index} outer rebalance failed: ${e.message}`);
          }
        }
      }
    }
    // Rebalance inner only if not yet filled
    if (slot.innerOrderId && !slot.innerFilled) {
      const storedInner = computeFloorOrderPrices(liqPrice).innerPrice;
      const drift       = Math.abs(storedInner - targetInner) / targetInner;
      if (drift > DRIFT_THRESHOLD) {
        try { await client.cancelOrder(CONTRACT, slot.innerOrderId); } catch {}
        await sleep(200);
        const vol = usdtToContracts(slot.usdtNotional * INNER_PCT, targetInner);
        if (vol >= 1) {
          try {
            const res = await client.placeLimitOrder({
              contractName: CONTRACT, side: "BUY", positionType: POSITION_TYPE,
              open: "OPEN", volume: vol, price: String(targetInner), leverage,
            });
            slot.innerOrderId = String(res?.data?.orderId || res?.orderId || "");
            rebalanced = true;
            console.log(`[Gold Long #${id}] Slot #${slot.index} inner rebalanced → $${targetInner}`);
          } catch (e: any) {
            slot.innerOrderId = null;
            console.error(`[Gold Long #${id}] Slot #${slot.index} inner rebalance failed: ${e.message}`);
          }
        }
      }
    }
  }

  if (rebalanced) console.log(`[Gold Long #${id}] Drift check done — fresh liq=$${freshLiq}`);
  await saveConfig(strategy, {
    floorSlots, liqPrice: freshLiq,
    lastRefreshAt: now, lastActionAt: now, lastError: null,
  });
}

// ── Funding guard: trim position back to seed only ────────────────────────────

async function reduceToSeedPosition(
  strategy:   Strategy,
  client:     NonNullable<ReturnType<typeof getBitrueClient>>,
  floorSlots: FloorSlot[],
  leverage:   number,
  id:         number,
): Promise<void> {
  const cfg = strategy.config as any;

  // Cancel all open floor orders (batch)
  const cancelIds: string[] = [];
  for (const slot of floorSlots) {
    if (slot.outerOrderId && !slot.outerFilled) cancelIds.push(slot.outerOrderId);
    if (slot.innerOrderId && !slot.innerFilled) cancelIds.push(slot.innerOrderId);
    if (slot.tpOrderId    && !slot.tpFilled)    cancelIds.push(slot.tpOrderId);
  }
  if (cancelIds.length > 0) {
    try {
      await client.cancelOrders(CONTRACT, cancelIds);
      console.log(`[Gold Long #${id}] Funding guard: cancelled ${cancelIds.length} floor orders`);
    } catch (e: any) {
      console.warn(`[Gold Long #${id}] Funding guard batch cancel: ${e.message}`);
    }
  }

  // Reset all slot state
  for (const slot of floorSlots) {
    slot.outerOrderId = null; slot.innerOrderId = null; slot.tpOrderId = null;
    slot.outerFilled  = false; slot.outerFillContracts = 0; slot.outerFillPrice = 0;
    slot.innerFilled  = false; slot.innerFillContracts = 0; slot.innerFillPrice = 0;
    slot.tpFilled     = false; slot.avgEntryPrice = 0;
  }

  // Close floor portion (everything above seed contracts)
  const seedContracts = cfg.seedContracts || 0;
  let   liqPrice      = (strategy.config as any).liqPrice || 0;

  try {
    const pos = await getLivePosition(client, leverage);
    if (pos?.liqPrice) liqPrice = pos.liqPrice;
    const liveContracts = Math.round(pos?.contracts || 0);
    const toClose       = liveContracts - seedContracts;
    if (toClose > 0) {
      await client.closePosition({ contractName: CONTRACT, positionType: POSITION_TYPE, volume: toClose, leverage });
      console.log(`[Gold Long #${id}] Funding guard: closed ${toClose}ct floor position`);
      await tradeLog(id, { side: "SELL", orderType: "MARKET", quantity: toClose, status: "filled" });
      await sleep(2000);
      const pos2 = await getLivePosition(client, leverage);
      if (pos2?.liqPrice) liqPrice = pos2.liqPrice;
    }
  } catch (e: any) {
    console.error(`[Gold Long #${id}] Funding guard close: ${e.message}`);
  }

  // Re-activate slot #1 at updated liq
  await activateSlot(client, floorSlots[0], liqPrice, leverage, id);
  await saveConfig(strategy, { activeSlotIndex: 0, floorSlots, liqPrice });
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
    } else if (cfg.phase === "floor_active") {
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
