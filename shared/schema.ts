import { pgTable, text, serial, integer, boolean, timestamp, jsonb, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// We might not need a database for this specific "live" query if we just fetch from API,
// but let's have a cache table to avoid hitting rate limits too often.

export const cryptoCache = pgTable("crypto_cache", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(), // e.g. "bitcoin"
  symbol: text("symbol").notNull(),      // e.g. "btc"
  name: text("name").notNull(),          // e.g. "Bitcoin"
  marketCap: doublePrecision("market_cap"),
  currentPrice: doublePrecision("current_price"),
  hourlySwings: integer("hourly_swings"), // Number of swings >= 1%
  lastUpdated: timestamp("last_updated").defaultNow(),
  priceHistory: jsonb("price_history").$type<{ timestamp: number; price: number }[]>(), // Store recent history for charting
});

export const insertCryptoCacheSchema = createInsertSchema(cryptoCache).omit({ id: true, lastUpdated: true });

// API Types
export type CryptoStat = typeof cryptoCache.$inferSelect;
export type CryptoStatsResponse = CryptoStat[];
