import type { GridConfig } from "./strategy-engine";

type Reservation = { at: number; orderId?: string };
const closeReservations = new Map<string, Reservation>();

function cell(price: number, config: GridConfig): string {
  const anchor = Number(config.startPrice);
  const ratio = Number(config.gridRatio);
  if (!(price > 0) || !(anchor > 0) || !(ratio > 1)) return `price:${price.toFixed(8)}`;
  return `cell:${Math.round(Math.log(price / anchor) / Math.log(ratio))}`;
}

function key(parentId: number, price: number, config: GridConfig): string {
  return `${parentId}:${cell(price, config)}`;
}

export function reserveTandemClose(parentId: number, price: number, config: GridConfig, orderId?: string): void {
  closeReservations.set(key(parentId, price, config), { at: Date.now(), orderId });
}

export function releaseTandemClose(parentId: number, price: number, config: GridConfig): void {
  closeReservations.delete(key(parentId, price, config));
}

/** Fail closed: an unclear exchange response must not permit a new tandem open. */
export async function canPlaceTandemOpen(client: any, symbol: string, parentId: number, price: number, config: GridConfig, quotePrecision: number): Promise<boolean> {
  const reservationKey = key(parentId, price, config);
  if (closeReservations.has(reservationKey)) return false;
  try {
    const response = await client.getOpenOrders(symbol);
    if (response?.code !== 0) return false;
    let orders = response.data;
    if (!Array.isArray(orders) && Array.isArray(orders?.orderList)) orders = orders.orderList;
    if (!Array.isArray(orders)) return false;
    const roundedPrice = Number(price.toFixed(quotePrecision));
    const hasClose = orders.some((order: any) => {
      const tradeSide = String(order.tradeSide || order.trade_side || "").toUpperCase();
      const orderPrice = Number(order.price || order.orderPrice || 0);
      return tradeSide === "CLOSE" && Number(orderPrice.toFixed(quotePrecision)) === roundedPrice && cell(orderPrice, config) === cell(price, config);
    });
    return !hasClose;
  } catch {
    return false;
  }
}
