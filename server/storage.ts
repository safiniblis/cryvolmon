import { cryptoCache, type CryptoStat } from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";

export interface IStorage {
  getCryptoStats(): Promise<CryptoStat[]>;
  updateCryptoStat(stat: CryptoStat): Promise<CryptoStat>;
  updateCryptoStats(stats: CryptoStat[]): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getCryptoStats(): Promise<CryptoStat[]> {
    return await db.select().from(cryptoCache);
  }

  async updateCryptoStat(stat: CryptoStat): Promise<CryptoStat> {
    // Upsert logic
    await db
      .insert(cryptoCache)
      .values(stat)
      .onConflictDoUpdate({
        target: cryptoCache.slug,
        set: stat,
      });
    return stat;
  }

  async updateCryptoStats(stats: CryptoStat[]): Promise<void> {
    await db.transaction(async (tx) => {
      // Clear old data first to handle ranking changes?
      // Or just upsert everything. Let's truncate and re-insert to keep it clean for top 20.
      await tx.delete(cryptoCache);
      if (stats.length > 0) {
        await tx.insert(cryptoCache).values(stats);
      }
    });
  }
}

export const storage = new DatabaseStorage();
