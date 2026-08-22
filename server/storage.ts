import {
  cryptoCache, type CryptoStat,
  strategies, type Strategy, type InsertStrategy,
  tradeLog, type TradeLogEntry, type InsertTradeLog,
  strategyDecisionEvents, type StrategyDecisionEvent, type InsertStrategyDecisionEvent,
  councilMessages, type CouncilMessage, type InsertCouncilMessage,
  positions, type Position,
  accountBalance, type AccountBalance,
  exchangeOrderLedger, type ExchangeOrderLedgerEntry, type InsertExchangeOrderLedger,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";

export interface IStorage {
  getCryptoStats(): Promise<CryptoStat[]>;
  updateCryptoStats(stats: any[]): Promise<void>;

  getStrategies(): Promise<Strategy[]>;
  getStrategy(id: number): Promise<Strategy | undefined>;
  getStrategiesByStatus(status: string): Promise<Strategy[]>;
  createStrategy(strategy: InsertStrategy): Promise<Strategy>;
  updateStrategy(id: number, updates: Partial<Strategy>): Promise<Strategy | undefined>;
  deleteStrategy(id: number): Promise<void>;

  getTradeLogs(strategyId?: number, limit?: number): Promise<TradeLogEntry[]>;
  createTradeLog(log: InsertTradeLog): Promise<TradeLogEntry>;
  linkTradeLogToDecision(tradeLogId: number, decisionEventId: number): Promise<void>;
  setDecisionEventTradeLog(decisionEventId: number, tradeLogId: number): Promise<void>;

  getStrategyDecisionEvents(strategyId?: number, limit?: number): Promise<StrategyDecisionEvent[]>;
  createStrategyDecisionEvent(event: InsertStrategyDecisionEvent): Promise<StrategyDecisionEvent>;
  createCouncilMessage(message: InsertCouncilMessage): Promise<CouncilMessage>;
  getCouncilMessages(limit?: number, sessionId?: string): Promise<CouncilMessage[]>;

  getPositions(): Promise<Position[]>;
  updatePositions(pos: any[]): Promise<void>;

  getAccountBalances(): Promise<AccountBalance[]>;
  updateAccountBalances(balances: any[]): Promise<void>;
  getExchangeOrderLedger(symbol?: string, limit?: number): Promise<ExchangeOrderLedgerEntry[]>;
  upsertExchangeOrderLedger(entry: InsertExchangeOrderLedger): Promise<ExchangeOrderLedgerEntry>;
}

export class DatabaseStorage implements IStorage {
  async getCryptoStats(): Promise<CryptoStat[]> {
    return await db.select().from(cryptoCache);
  }

  async updateCryptoStats(stats: any[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(cryptoCache);
      if (stats.length > 0) {
        await tx.insert(cryptoCache).values(stats);
      }
    });
  }

  async getStrategies(): Promise<Strategy[]> {
    return await db.select().from(strategies).orderBy(desc(strategies.createdAt));
  }

  async getStrategy(id: number): Promise<Strategy | undefined> {
    const [result] = await db.select().from(strategies).where(eq(strategies.id, id));
    return result;
  }

  async getStrategiesByStatus(status: string): Promise<Strategy[]> {
    return await db.select().from(strategies).where(eq(strategies.status, status));
  }

  async createStrategy(strategy: InsertStrategy): Promise<Strategy> {
    const [result] = await db.insert(strategies).values(strategy).returning();
    return result;
  }

  async updateStrategy(id: number, updates: Partial<Strategy>): Promise<Strategy | undefined> {
    const [result] = await db.update(strategies).set(updates).where(eq(strategies.id, id)).returning();
    return result;
  }

  async deleteStrategy(id: number): Promise<void> {
    await db.delete(strategies).where(eq(strategies.id, id));
  }

  async getTradeLogs(strategyId?: number, limit: number = 50): Promise<TradeLogEntry[]> {
    if (strategyId) {
      return await db.select().from(tradeLog)
        .where(eq(tradeLog.strategyId, strategyId))
        .orderBy(desc(tradeLog.createdAt))
        .limit(limit);
    }
    return await db.select().from(tradeLog)
      .orderBy(desc(tradeLog.createdAt))
      .limit(limit);
  }

  async createTradeLog(log: InsertTradeLog): Promise<TradeLogEntry> {
    const [result] = await db.insert(tradeLog).values(log).returning();
    return result;
  }

  async linkTradeLogToDecision(tradeLogId: number, decisionEventId: number): Promise<void> {
    await db.update(tradeLog)
      .set({ decisionEventId })
      .where(eq(tradeLog.id, tradeLogId));
    await db.update(strategyDecisionEvents)
      .set({ tradeLogId })
      .where(eq(strategyDecisionEvents.id, decisionEventId));
  }

  async setDecisionEventTradeLog(decisionEventId: number, tradeLogId: number): Promise<void> {
    await db.update(strategyDecisionEvents)
      .set({ tradeLogId })
      .where(eq(strategyDecisionEvents.id, decisionEventId));
  }

  async getStrategyDecisionEvents(strategyId?: number, limit: number = 100): Promise<StrategyDecisionEvent[]> {
    if (strategyId) {
      return await db.select().from(strategyDecisionEvents)
        .where(eq(strategyDecisionEvents.strategyId, strategyId))
        .orderBy(desc(strategyDecisionEvents.createdAt))
        .limit(limit);
    }
    return await db.select().from(strategyDecisionEvents)
      .orderBy(desc(strategyDecisionEvents.createdAt))
      .limit(limit);
  }

  async createStrategyDecisionEvent(event: InsertStrategyDecisionEvent): Promise<StrategyDecisionEvent> {
    // Drizzle's inferred JSONB insert type widens nested condition values incorrectly.
    const [result] = await db.insert(strategyDecisionEvents).values(event as any).returning();
    return result;
  }

  async createCouncilMessage(message: InsertCouncilMessage): Promise<CouncilMessage> {
    const [result] = await db.insert(councilMessages).values(message as any).returning();
    return result;
  }

  async getCouncilMessages(limit: number = 200, sessionId?: string): Promise<CouncilMessage[]> {
    const query = sessionId
      ? db.select().from(councilMessages).where(eq(councilMessages.sessionId, sessionId))
      : db.select().from(councilMessages);
    return await query.orderBy(desc(councilMessages.createdAt)).limit(limit);
  }

  async getPositions(): Promise<Position[]> {
    return await db.select().from(positions);
  }

  async updatePositions(pos: any[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(positions);
      if (pos.length > 0) {
        await tx.insert(positions).values(pos);
      }
    });
  }

  async getAccountBalances(): Promise<AccountBalance[]> {
    return await db.select().from(accountBalance);
  }

  async updateAccountBalances(balances: any[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(accountBalance);
      if (balances.length > 0) {
        await tx.insert(accountBalance).values(balances);
      }
    });
  }
  async getExchangeOrderLedger(symbol?: string, limit: number = 500): Promise<ExchangeOrderLedgerEntry[]> {
    const query = symbol
      ? db.select().from(exchangeOrderLedger).where(eq(exchangeOrderLedger.symbol, symbol))
      : db.select().from(exchangeOrderLedger);
    return await query.orderBy(desc(exchangeOrderLedger.exchangeUpdatedAt), desc(exchangeOrderLedger.importedAt)).limit(limit);
  }

  async upsertExchangeOrderLedger(entry: InsertExchangeOrderLedger): Promise<ExchangeOrderLedgerEntry> {
    const [result] = await db.insert(exchangeOrderLedger).values(entry)
      .onConflictDoUpdate({ target: [exchangeOrderLedger.exchange, exchangeOrderLedger.exchangeOrderId], set: entry })
      .returning();
    return result;
  }

}

export const storage = new DatabaseStorage();
