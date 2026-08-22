// Shared coordinator between a tandem parent and its grid children.
//
// Grid spacing defines ownership "cells" anchored at the tandem entry price.
// A tandem close/reduce intent reserves its cell so a child grid cannot place
// an offsetting OPEN in the same cell while the close is still settling. This
// prevents the fee churn where one side closes while the other opens at the
// same grid level. Close/reduce orders get priority; new opens are delayed
// until the reservation expires (the close is confirmed done or cancelled).

const RESERVATION_TTL_MS = 30_000;

const tandemCellReservations = new Map<string, { orderId?: string; at: number }>();

// A Tandem parent and its children share one async gate. This is deliberately
// separate from the per-process strategy locks: a child cycle must not overlap
// the parent's pause/cancel/act/verify sequence, even when both are awaiting
// exchange responses.
const tandemSequenceTails = new Map<number, Promise<void>>();

export async function acquireTandemSequence(parentId: number): Promise<() => void> {
  const previous = tandemSequenceTails.get(parentId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  // Store the unresolved operation itself. This makes later callers wait for
  // the complete previous operation and lets the final caller clean up safely.
  tandemSequenceTails.set(parentId, current);
  await previous;
  return () => {
    release();
    if (tandemSequenceTails.get(parentId) === current) tandemSequenceTails.delete(parentId);
  };
}

function cellKey(strategyId: number, cell: string): string {
  return `${strategyId}:${cell}`;
}

/** Bucket a price into a cell given the grid anchor and ratio (mirrors grid level math). */
export function tandemCellFor(price: number, anchor: number, ratio: number): string {
  if (!(price > 0) || !(anchor > 0) || !(ratio > 1)) return `price:${price.toFixed(8)}`;
  return `cell:${Math.round(Math.log(price / anchor) / Math.log(ratio))}`;
}

/** Grid ratio used by tandem child grids, derived from the parent config the same way defaultGridConfigForSide does. */
export function tandemGridRatio(config: { feeMultiplier?: number; twinMode?: boolean; twinGapPct?: number }): number {
  const feeRate = 0.0006;
  const roundTripFee = 2 * feeRate;
  const fm = config?.feeMultiplier || 3.5;
  if (config?.twinMode) {
    const twinGapPct = config?.twinGapPct || 0.006;
    return 1 + roundTripFee * ((twinGapPct / 2) / roundTripFee);
  }
  return 1 + roundTripFee * fm;
}

export function reserveTandemCell(strategyId: number, cell: string, orderId?: string): void {
  tandemCellReservations.set(cellKey(strategyId, cell), { orderId, at: Date.now() });
}

export function releaseTandemCell(strategyId: number, cell: string): void {
  tandemCellReservations.delete(cellKey(strategyId, cell));
}

export function isTandemCellReserved(strategyId: number, cell: string): boolean {
  const key = cellKey(strategyId, cell);
  const entry = tandemCellReservations.get(key);
  if (!entry) return false;
  if (Date.now() - entry.at > RESERVATION_TTL_MS) {
    tandemCellReservations.delete(key);
    return false;
  }
  return true;
}

/**
 * True if any reservation exists within `halfWidth` cells of the given price.
 * A close price often sits between grid levels, so a child grid opening at the
 * nearest level lives in a neighbouring cell; check the small band to catch it.
 */
export function isTandemCellReservedNear(strategyId: number, anchor: number, ratio: number, price: number, halfWidth = 1): boolean {
  if (!(anchor > 0) || !(ratio > 1) || !(price > 0)) return false;
  const center = Math.round(Math.log(price / anchor) / Math.log(ratio));
  const now = Date.now();
  for (let d = -halfWidth; d <= halfWidth; d++) {
    const key = cellKey(strategyId, `cell:${center + d}`);
    const entry = tandemCellReservations.get(key);
    if (!entry) continue;
    if (now - entry.at > RESERVATION_TTL_MS) {
      tandemCellReservations.delete(key);
      continue;
    }
    return true;
  }
  return false;
}

/** Drop reservations older than the TTL. Called each tandem manage cycle. */
export function expireStaleTandemReservations(): void {
  const now = Date.now();
  for (const [key, entry] of tandemCellReservations) {
    if (now - entry.at > RESERVATION_TTL_MS) tandemCellReservations.delete(key);
  }
}

/** True if any resting order on the exchange is a CLOSE at (nearly) the given price. */
export function hasPendingCloseAtPrice(openOrders: unknown[] | undefined, price: number): boolean {
  if (!Array.isArray(openOrders) || openOrders.length === 0) return false;
  const tolerance = Math.max(price * 0.000001, 0.00000001);
  return openOrders.some((order: any) => {
    if (order === null || typeof order !== "object") return false;
    const orderSide = String(order.tradeSide ?? order.trade_side ?? "").toUpperCase();
    if (orderSide !== "CLOSE") return false;
    const orderPrice = Number(order.price ?? order.orderPrice ?? 0);
    return Math.abs(orderPrice - price) <= tolerance;
  });
}

/**
 * True if it is safe to OPEN an order in this cell. False (blocked) when a
 * tandem close/reduce is pending there: either an in-memory reservation or a
 * resting CLOSE order near the price. On an unclear exchange response we err
 * on the side of blocking the open.
 */
export async function reconcileBeforeTandemOpen(
  client: any,
  symbol: string,
  strategyId: number,
  cell: string,
  price: number,
): Promise<boolean> {
  if (isTandemCellReserved(strategyId, cell)) return false;
  try {
    const response = await client.getOpenOrders(symbol);
    if (response?.code !== 0) return false;
    let orders = response.data;
    if (!Array.isArray(orders) && Array.isArray(orders?.orderList)) orders = orders.orderList;
    if (!Array.isArray(orders)) return false;
    return !hasPendingCloseAtPrice(orders, price);
  } catch {
    return false;
  }
}
