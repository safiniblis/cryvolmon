import type { Strategy } from "@shared/schema";
import type { DecisionCondition, DecisionOutcome } from "@shared/schema";
import { recordDecision, createTradeLogForDecision } from "./decision-logger";

export interface TandemRebalanceContext {
  config: {
    phase?: string;
    cycleCount?: number;
    entryPrice?: number;
    longGridId?: number | null;
    shortGridId?: number | null;
    lastRebalanceAt?: number;
    lastRebalancePriceRef?: number;
    rebalanceCount?: number;
  };
  currentPrice: number;
  longQty: number;
  shortQty: number;
  longPnl: number;
  shortPnl: number;
  longRoi: number;
  shortRoi: number;
  longLiqDist: number;
  shortLiqDist: number;
  longLiqPrice: number;
  shortLiqPrice: number;
  ratio: number;
  targetLongRatio: number;
  divergence: number;
  liqUrgency: boolean;
  imbalanceThreshold: number;
  priceMove: number;
  velocityThreshold: number;
  cooldownMs: number;
  timeSinceRebalanceMs: number;
  consecutiveRebalances: number;
}

function buildRebalanceConditions(ctx: TandemRebalanceContext, extras: DecisionCondition[] = []): DecisionCondition[] {
  return [
    {
      name: "cooldown_elapsed",
      value: ctx.timeSinceRebalanceMs,
      threshold: ctx.cooldownMs,
      passed: ctx.timeSinceRebalanceMs >= ctx.cooldownMs,
    },
    {
      name: "qty_ratio",
      value: ctx.ratio,
      threshold: ctx.imbalanceThreshold,
      passed: ctx.ratio > ctx.imbalanceThreshold,
    },
    {
      name: "price_velocity",
      value: ctx.priceMove,
      threshold: ctx.velocityThreshold,
      passed: ctx.priceMove <= ctx.velocityThreshold || ctx.liqUrgency,
    },
    ...extras,
  ];
}

function rebalanceSignals(ctx: TandemRebalanceContext, extra: Record<string, unknown> = {}) {
  return {
    price: ctx.currentPrice,
    longQty: ctx.longQty,
    shortQty: ctx.shortQty,
    qtyRatio: ctx.ratio,
    targetLongRatio: ctx.targetLongRatio,
    divergence: ctx.divergence,
    longRoi: ctx.longRoi,
    shortRoi: ctx.shortRoi,
    longPnl: ctx.longPnl,
    shortPnl: ctx.shortPnl,
    longLiqDist: ctx.longLiqDist,
    shortLiqDist: ctx.shortLiqDist,
    longLiqPrice: ctx.longLiqPrice,
    shortLiqPrice: ctx.shortLiqPrice,
    liqUrgency: ctx.liqUrgency,
    priceMovePct: ctx.priceMove,
    velocityThreshold: ctx.velocityThreshold,
    imbalanceThreshold: ctx.imbalanceThreshold,
    cooldownMs: ctx.cooldownMs,
    timeSinceRebalanceMs: ctx.timeSinceRebalanceMs,
    consecutiveRebalances: ctx.consecutiveRebalances,
    rebalanceCount: ctx.config.rebalanceCount ?? 0,
    ...extra,
  };
}

export async function logTandemRebalanceDecision(
  strategy: Strategy,
  ctx: TandemRebalanceContext,
  outcome: DecisionOutcome,
  reasonCode: string,
  reasonText: string,
  options?: {
    actionTaken?: string | null;
    eventType?: "evaluate" | "action" | "skip";
    conditions?: DecisionCondition[];
    orderId?: string | null;
    extraSignals?: Record<string, unknown>;
  },
): Promise<number | null> {
  const config = ctx.config;
  return recordDecision({
    strategyId: strategy.id,
    engine: "tandem",
    phase: config.phase || "waiting_liquidation",
    decisionKey: "tandem.rebalance",
    eventType: options?.eventType ?? (outcome === "executed" ? "action" : "evaluate"),
    actionConsidered: "rebalance_trim",
    actionTaken: options?.actionTaken ?? (outcome === "executed" ? "rebalance_trim" : null),
    outcome,
    reasonCode,
    reasonText,
    symbol: strategy.symbol,
    price: ctx.currentPrice,
    stateJson: {
      cycleCount: config.cycleCount ?? 0,
      entryPrice: config.entryPrice,
      longGridId: config.longGridId,
      shortGridId: config.shortGridId,
      lastRebalanceAt: config.lastRebalanceAt,
      lastRebalancePriceRef: config.lastRebalancePriceRef,
    },
    signalsJson: rebalanceSignals(ctx, options?.extraSignals),
    conditionsJson: buildRebalanceConditions(ctx, options?.conditions),
    exposureJson: {
      long: { qty: ctx.longQty, pnl: ctx.longPnl, roi: ctx.longRoi, liqDist: ctx.longLiqDist },
      short: { qty: ctx.shortQty, pnl: ctx.shortPnl, roi: ctx.shortRoi, liqDist: ctx.shortLiqDist },
    },
    orderId: options?.orderId ?? null,
  });
}

export async function logTandemRebalanceTrade(
  decisionEventId: number,
  trade: {
    strategyId: number;
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    orderId: string | null;
    pnl: number | null;
    errorMsg: string | null;
  },
): Promise<void> {
  await createTradeLogForDecision(decisionEventId, {
    strategyId: trade.strategyId,
    symbol: trade.symbol,
    side: trade.side,
    orderType: "MARKET",
    quantity: trade.quantity,
    price: trade.price,
    status: "filled",
    orderId: trade.orderId,
    pnl: trade.pnl,
    errorMsg: trade.errorMsg,
  });
}
