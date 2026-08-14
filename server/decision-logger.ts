import { storage } from "./storage";
import type { InsertStrategyDecisionEvent, DecisionCondition, DecisionOutcome } from "@shared/schema";
import type { InsertTradeLog } from "@shared/schema";

export type { DecisionCondition, DecisionOutcome };

export interface RecordDecisionInput {
  strategyId: number;
  engine: string;
  phase: string;
  decisionKey: string;
  eventType?: "evaluate" | "action" | "skip" | "phase_change" | "error";
  actionConsidered: string;
  actionTaken?: string | null;
  outcome: DecisionOutcome;
  reasonCode?: string | null;
  reasonText?: string | null;
  symbol: string;
  price?: number | null;
  stateJson?: Record<string, unknown>;
  signalsJson?: Record<string, unknown>;
  conditionsJson?: DecisionCondition[];
  exposureJson?: Record<string, unknown>;
  orderId?: string | null;
}

/** Append-only decision ledger write. Failures are swallowed so logging never affects trading. */
export async function recordDecision(input: RecordDecisionInput): Promise<number | null> {
  try {
    const row: InsertStrategyDecisionEvent = {
      strategyId: input.strategyId,
      engine: input.engine,
      phase: input.phase,
      decisionKey: input.decisionKey,
      eventType: input.eventType ?? "evaluate",
      actionConsidered: input.actionConsidered,
      actionTaken: input.actionTaken ?? null,
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      reasonText: input.reasonText ?? null,
      symbol: input.symbol,
      price: input.price ?? null,
      stateJson: input.stateJson ?? {},
      signalsJson: input.signalsJson ?? {},
      conditionsJson: input.conditionsJson ?? [],
      exposureJson: input.exposureJson ?? null,
      tradeLogId: null,
      orderId: input.orderId ?? null,
    };
    const created = await storage.createStrategyDecisionEvent(row);
    return created.id;
  } catch (e: any) {
    console.warn(`[DecisionLogger] Failed to record ${input.decisionKey}:`, e.message);
    return null;
  }
}

/** Link an existing trade_log row to a decision event (both directions). */
export async function linkTradeToDecision(tradeLogId: number, decisionEventId: number): Promise<void> {
  try {
    await storage.linkTradeLogToDecision(tradeLogId, decisionEventId);
  } catch (e: any) {
    console.warn(`[DecisionLogger] Failed to link trade ${tradeLogId} to decision ${decisionEventId}:`, e.message);
  }
}

/** Create trade_log and associate it with a decision event in one step. */
export async function createTradeLogForDecision(
  decisionEventId: number,
  log: InsertTradeLog,
): Promise<number | null> {
  try {
    const trade = await storage.createTradeLog({ ...log, decisionEventId });
    await storage.setDecisionEventTradeLog(decisionEventId, trade.id);
    return trade.id;
  } catch (e: any) {
    console.warn(`[DecisionLogger] Failed to create linked trade for decision ${decisionEventId}:`, e.message);
    return null;
  }
}
