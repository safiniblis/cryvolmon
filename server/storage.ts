import {
  cryptoCache, type CryptoStat,
  strategies, type Strategy, type InsertStrategy,
  tradeLog, type TradeLogEntry, type InsertTradeLog,
  positions, type Position,
  accountBalance, type AccountBalance,
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

  getPositions(): Promise<Position[]>;
  updatePositions(pos: any[]): Promise<void>;

  getAccountBalances(): Promise<AccountBalance[]>;
  updateAccountBalances(balances: any[]): Promise<void>;
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
}

export const storage = new DatabaseStorage();
