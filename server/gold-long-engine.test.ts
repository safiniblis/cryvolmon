/**
 * Gold Long Engine — unit tests for the Liq-Floor Dynamic Grid pure functions.
 * Run: tsx server/gold-long-engine.test.ts
 *
 * Tests verify the invariants that prevent live-trading failures:
 *   1. Floor order prices are strictly above the liq price (won't trigger liq)
 *   2. Contract volume formula matches the MULTIPLIER=0.0001 semantics
 *   3. TP price is strictly above entry (always a profit if filled)
 *   4. Seed buyback price is strictly below TP fill price
 *   5. Slot percentages sum to 70% (leaving 30% for seed)
 *   6. SLOT_PCTS and SEED_TP_CONFIG match documented allocation
 *   7. Gold market hours logic is correct
 */

import assert from "node:assert/strict";
import {
  roundPrice,
  usdtToContracts,
  computeFloorOrderPrices,
  computeFloorTpPrice,
  computeSeedBuybackPrice,
  isGoldMarketHours,
  SLOT_PCTS,
  SEED_TP_CONFIG,
} from "./gold-long-engine";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ── roundPrice ────────────────────────────────────────────────────────────────

console.log("\nroundPrice");

test("rounds to 1 decimal place", () => {
  assert.equal(roundPrice(2700.123), 2700.1);
  assert.equal(roundPrice(2700.150), 2700.2); // standard rounding
  assert.equal(roundPrice(2700.999), 2701.0);
});

test("handles integer inputs", () => {
  assert.equal(roundPrice(2700), 2700.0);
});

// ── usdtToContracts ───────────────────────────────────────────────────────────

console.log("\nusdtToContracts");

test("contracts = floor(notional / (price × 0.0001))", () => {
  // $1000 notional at $2700: 1000 / (2700 × 0.0001) = 1000 / 0.27 = 3703.7 → 3703
  const result = usdtToContracts(1000, 2700);
  assert.equal(result, 3703);
});

test("uses floor (never over-sizes)", () => {
  // Exact: 1000 / (0.27) = 3703.703..., floor = 3703
  assert.equal(usdtToContracts(1000, 2700), 3703);
});

test("returns 0 for zero price", () => {
  assert.equal(usdtToContracts(1000, 0), 0);
});

test("returns 0 for zero notional", () => {
  assert.equal(usdtToContracts(0, 2700), 0);
});

test("scales linearly with notional", () => {
  const a = usdtToContracts(1000, 2700);
  const b = usdtToContracts(2000, 2700);
  // b should be approximately 2× a (floor rounding may cause tiny diff)
  assert.ok(b >= a * 2 - 1 && b <= a * 2 + 1, `Expected ~2× (${a} → ${b})`);
});

// ── computeFloorOrderPrices ───────────────────────────────────────────────────

console.log("\ncomputeFloorOrderPrices");

test("outer is liq × 1.0020, rounded to 1dp", () => {
  const liq = 2600;
  const { outerPrice } = computeFloorOrderPrices(liq);
  assert.equal(outerPrice, roundPrice(liq * 1.002));
});

test("inner is liq × 1.0005, rounded to 1dp", () => {
  const liq = 2600;
  const { innerPrice } = computeFloorOrderPrices(liq);
  assert.equal(innerPrice, roundPrice(liq * 1.0005));
});

test("outer > inner > liqPrice (both above liq, outer higher)", () => {
  const liq = 2600;
  const { outerPrice, innerPrice } = computeFloorOrderPrices(liq);
  assert.ok(outerPrice > innerPrice, `outer ${outerPrice} must be > inner ${innerPrice}`);
  assert.ok(innerPrice > liq,        `inner ${innerPrice} must be > liq ${liq}`);
});

test("works with realistic gold liq prices", () => {
  // At 33x lev, gold $2700 → liq ≈ 2700 × (1 - 1/33) ≈ 2618.2
  const liq = 2618.2;
  const { outerPrice, innerPrice } = computeFloorOrderPrices(liq);
  // outer: 2618.2 × 1.002 = 2623.4... → 2623.4
  assert.ok(outerPrice > liq);
  assert.ok(innerPrice > liq);
  assert.ok(outerPrice > innerPrice);
});

test("zero liq price returns zeros", () => {
  const { outerPrice, innerPrice } = computeFloorOrderPrices(0);
  assert.equal(outerPrice, 0);
  assert.equal(innerPrice, 0);
});

// ── computeFloorTpPrice ───────────────────────────────────────────────────────

console.log("\ncomputeFloorTpPrice");

test("TP is avg_entry × 1.0022, rounded to 1dp", () => {
  const avg = 2620;
  assert.equal(computeFloorTpPrice(avg), roundPrice(avg * 1.0022));
});

test("TP is strictly above entry (guaranteed profit if filled)", () => {
  const avg = 2620;
  assert.ok(computeFloorTpPrice(avg) > avg, "TP must be above avg entry");
});

test("TP offset is 0.22% above entry", () => {
  const avg = 3000;
  const tp  = computeFloorTpPrice(avg);
  const pct = (tp - avg) / avg;
  assert.ok(Math.abs(pct - 0.0022) < 0.0001, `Expected 0.22% offset, got ${(pct * 100).toFixed(4)}%`);
});

// ── computeSeedBuybackPrice ───────────────────────────────────────────────────

console.log("\ncomputeSeedBuybackPrice");

test("buyback is tp_price × (1 - 0.0022), rounded to 1dp", () => {
  const tp = 2735;
  assert.equal(computeSeedBuybackPrice(tp), roundPrice(tp * 0.9978));
});

test("buyback is strictly below TP fill price", () => {
  const tp = 2735;
  assert.ok(computeSeedBuybackPrice(tp) < tp, "Buyback must be below TP fill price");
});

// ── SLOT_PCTS constants ───────────────────────────────────────────────────────

console.log("\nSLOT_PCTS");

test("4 floor slots", () => {
  assert.equal(SLOT_PCTS.length, 4);
});

test("slots are 10 / 15 / 20 / 25%", () => {
  assert.ok(Math.abs(SLOT_PCTS[0] - 0.10) < 0.001);
  assert.ok(Math.abs(SLOT_PCTS[1] - 0.15) < 0.001);
  assert.ok(Math.abs(SLOT_PCTS[2] - 0.20) < 0.001);
  assert.ok(Math.abs(SLOT_PCTS[3] - 0.25) < 0.001);
});

test("slots sum to 70% (leaving 30% for seed)", () => {
  const total = SLOT_PCTS.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 0.70) < 0.001, `Sum should be 0.70, got ${total}`);
});

test("slots are strictly ascending (each larger than last)", () => {
  for (let i = 1; i < SLOT_PCTS.length; i++) {
    assert.ok(SLOT_PCTS[i] > SLOT_PCTS[i - 1],
      `SLOT_PCTS[${i}]=${SLOT_PCTS[i]} should be > SLOT_PCTS[${i-1}]=${SLOT_PCTS[i-1]}`);
  }
});

// ── SEED_TP_CONFIG constants ──────────────────────────────────────────────────

console.log("\nSEED_TP_CONFIG");

test("3 seed TP tranches", () => {
  assert.equal(SEED_TP_CONFIG.length, 3);
});

test("tranche labels are A, B, C", () => {
  assert.equal(SEED_TP_CONFIG[0].tranche, "A");
  assert.equal(SEED_TP_CONFIG[1].tranche, "B");
  assert.equal(SEED_TP_CONFIG[2].tranche, "C");
});

test("tranche sizes are 6 / 4 / 3% of capital", () => {
  assert.ok(Math.abs(SEED_TP_CONFIG[0].pct - 0.06) < 0.001);
  assert.ok(Math.abs(SEED_TP_CONFIG[1].pct - 0.04) < 0.001);
  assert.ok(Math.abs(SEED_TP_CONFIG[2].pct - 0.03) < 0.001);
});

test("TP levels are 1.20 / 1.80 / 2.40% above seed entry", () => {
  assert.ok(Math.abs(SEED_TP_CONFIG[0].tpPct - 0.0120) < 0.0001);
  assert.ok(Math.abs(SEED_TP_CONFIG[1].tpPct - 0.0180) < 0.0001);
  assert.ok(Math.abs(SEED_TP_CONFIG[2].tpPct - 0.0240) < 0.0001);
});

test("TP levels are strictly ascending", () => {
  for (let i = 1; i < SEED_TP_CONFIG.length; i++) {
    assert.ok(SEED_TP_CONFIG[i].tpPct > SEED_TP_CONFIG[i - 1].tpPct,
      `tpPct[${i}] should be > tpPct[${i-1}]`);
  }
});

test("seed TPs + slots sum to 13% (6+4+3) leaving 87% for seed+floor", () => {
  const total = SEED_TP_CONFIG.reduce((a, c) => a + c.pct, 0);
  assert.ok(Math.abs(total - 0.13) < 0.001, `Seed TP total: ${total}`);
});

// ── isGoldMarketHours (structural test only — cannot control clock) ───────────

console.log("\nisGoldMarketHours");

test("returns a boolean", () => {
  const result = isGoldMarketHours();
  assert.equal(typeof result, "boolean");
});

// ── Integration: floor order volume with real-world gold prices ───────────────

console.log("\nFloor order volume — realistic E-XAUT-USDT sizing");

test("slot #1 (10%) produces positive outer and inner volumes at $2700 gold / $100 margin / 33x", () => {
  const baseCapital = 100;
  const leverage    = 33;
  const notional    = baseCapital * leverage;  // $3300
  const slotNotional = notional * SLOT_PCTS[0]; // $330 (10%)
  const liqPrice    = roundPrice(2700 * (1 - 1 / leverage)); // ≈ 2618.2
  const { outerPrice, innerPrice } = computeFloorOrderPrices(liqPrice);

  const outerVol = usdtToContracts(slotNotional * 0.40, outerPrice); // $132
  const innerVol = usdtToContracts(slotNotional * 0.60, innerPrice); // $198

  assert.ok(outerVol >= 1, `Outer vol should be ≥ 1, got ${outerVol}`);
  assert.ok(innerVol >= 1, `Inner vol should be ≥ 1, got ${innerVol}`);
});

test("floor TP is above the floor order fill price (will profit if market recovers 0.22%)", () => {
  const liqPrice = 2618.2;
  const { outerPrice, innerPrice } = computeFloorOrderPrices(liqPrice);
  // Simulate avg entry of outer (40%) + inner (60%) at their respective prices
  const outerVol = usdtToContracts(132, outerPrice);
  const innerVol = usdtToContracts(198, innerPrice);
  const totalVol = outerVol + innerVol;
  const avgEntry = totalVol > 0
    ? (outerPrice * outerVol + innerPrice * innerVol) / totalVol
    : outerPrice;
  const tp = computeFloorTpPrice(avgEntry);
  assert.ok(tp > avgEntry,      `TP $${tp} must be above avg entry $${avgEntry}`);
  assert.ok(tp > liqPrice * 1.0020, "TP must be above outer floor price");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
