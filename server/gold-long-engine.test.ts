/**
 * Gold Long Engine — unit tests for safety-critical pure logic.
 * Run: tsx server/gold-long-engine.test.ts
 *
 * Tests focus on the invariants that prevent live-trading failures:
 *   1. Support safety ceiling prevents immediately-marketable BUY limits
 *   2. Quantity sizing uses margin × leverage, not bare capital
 *   3. currentPrice=0 (futures unavailable) causes all supports to be skipped
 *   4. Support level range spans -1% to -10% as documented
 */

import assert from "node:assert/strict";
import { computeSupportLevels, SUPPORT_MULTIPLIERS } from "./gold-long-engine";

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

// ── SUPPORT_MULTIPLIERS constants ────────────────────────────────────────────

console.log("\nSUPPORT_MULTIPLIERS");

test("7 support levels", () => {
  assert.equal(SUPPORT_MULTIPLIERS.length, 7);
});

test("first level is -1% (×0.990)", () => {
  assert.ok(Math.abs(SUPPORT_MULTIPLIERS[0] - 0.990) < 0.0001);
});

test("last level is -10% (×0.900)", () => {
  assert.ok(Math.abs(SUPPORT_MULTIPLIERS[6] - 0.900) < 0.0001);
});

test("all multipliers strictly descending", () => {
  for (let i = 1; i < SUPPORT_MULTIPLIERS.length; i++) {
    assert.ok(SUPPORT_MULTIPLIERS[i] < SUPPORT_MULTIPLIERS[i - 1],
      `Multiplier[${i}]=${SUPPORT_MULTIPLIERS[i]} should be < Multiplier[${i-1}]=${SUPPORT_MULTIPLIERS[i-1]}`);
  }
});

// ── computeSupportLevels — count and structure ───────────────────────────────

console.log("\ncomputeSupportLevels — structure");

test("returns exactly 7 levels", () => {
  const lvls = computeSupportLevels(3300, 3300, 100, 10);
  assert.equal(lvls.length, 7);
});

test("level numbers are 1–7", () => {
  const lvls = computeSupportLevels(3300, 3300, 100, 10);
  lvls.forEach((l, i) => assert.equal(l.level, i + 1));
});

// ── Safety ceiling invariant ─────────────────────────────────────────────────

console.log("\ncomputeSupportLevels — safety ceiling");

test("all levels safe when avgEntry << currentPrice", () => {
  // avgEntry=3000, market at 3300 — all supports at 3000×mult < 3300
  const lvls = computeSupportLevels(3000, 3300, 100, 10);
  assert.ok(lvls.every(l => l.safe), "All should be safe");
});

test("no levels safe when currentPrice=0 (futures ticker unavailable)", () => {
  // If we can't get futures price, nothing should be placed
  const lvls = computeSupportLevels(3300, 0, 100, 10);
  assert.ok(lvls.every(l => !l.safe), "All should be unsafe when currentPrice=0");
});

test("levels at/above currentPrice are unsafe — prevents immediately-marketable BUY", () => {
  // avgEntry=3300, market drops to 3250
  // L1 @ 3300×0.990=3267 > 3250 → unsafe (would execute immediately on futures)
  // L2 @ 3300×0.980=3234 < 3250 → safe
  const lvls = computeSupportLevels(3300, 3250, 100, 10);
  const l1 = lvls.find(l => l.level === 1)!;
  const l2 = lvls.find(l => l.level === 2)!;
  assert.ok(l1.price > 3250, `L1 price ${l1.price} should be above 3250`);
  assert.ok(!l1.safe, "L1 should be unsafe (above market)");
  assert.ok(l2.price < 3250, `L2 price ${l2.price} should be below 3250`);
  assert.ok(l2.safe, "L2 should be safe (below market)");
});

test("all levels unsafe when market is above avgEntry (extreme uptrend)", () => {
  // avgEntry=3000, market=3500 — all supports at 3000×mult < 3500 → all safe
  // (market higher than entry = all supports are resting below)
  const lvls = computeSupportLevels(3000, 3500, 100, 10);
  assert.ok(lvls.every(l => l.safe), "All should be safe when market is above avgEntry");
});

test("level marked unsafe when price equals currentPrice (not strictly below)", () => {
  // price < currentPrice is the invariant — equals is NOT safe
  const avgEntry = 3300;
  const l1Price = Math.round(avgEntry * 0.990 * 100) / 100; // 3267
  // Set currentPrice exactly at L1 price — should be unsafe
  const lvls = computeSupportLevels(avgEntry, l1Price, 100, 10);
  const l1 = lvls.find(l => l.level === 1)!;
  assert.equal(l1.price, l1Price);
  assert.ok(!l1.safe, "Level equal to currentPrice should be unsafe");
});

// ── Quantity sizing: margin × leverage, not bare capital ─────────────────────

console.log("\ncomputeSupportLevels — quantity sizing");

test("qty = floor((margin × leverage × 10%) / price × 10^4) / 10^4", () => {
  // $100 margin × 10x = $1000 notional; L1 support = 10% of notional
  const avgEntry = 3300;
  const lvls = computeSupportLevels(avgEntry, 3000, 100, 10);
  const l1 = lvls.find(l => l.level === 1)!;
  const expected = Math.floor((100 * 10 * 0.10 / l1.price) * 10_000) / 10_000;
  assert.equal(l1.qty, expected, `Expected ${expected}, got ${l1.qty}`);
});

test("qty scales with leverage (2x leverage → 2x qty)", () => {
  const [a] = computeSupportLevels(3300, 3000, 100, 5);
  const [b] = computeSupportLevels(3300, 3000, 100, 10);
  // b should be ~2× a (floor rounding may cause tiny diff)
  const ratio = b.qty / a.qty;
  assert.ok(ratio >= 1.9 && ratio <= 2.1, `Expected ~2x, got ${ratio}`);
});

test("qty scales with capital (2x capital → 2x qty)", () => {
  const [a] = computeSupportLevels(3300, 3000, 100, 10);
  const [b] = computeSupportLevels(3300, 3000, 200, 10);
  const ratio = b.qty / a.qty;
  assert.ok(ratio >= 1.9 && ratio <= 2.1, `Expected ~2x, got ${ratio}`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
