import { pgTable, text, serial, integer, boolean, timestamp, jsonb, doublePrecision, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const cryptoCache = pgTable("crypto_cache", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  marketCap: doublePrecision("market_cap"),
  currentPrice: doublePrecision("current_price"),
  hourlySwings: integer("hourly_swings"),
  lastUpdated: timestamp("last_updated").defaultNow(),
  priceHistory: jsonb("price_history").$type<{ timestamp: number; price: number }[]>(),
});

export const insertCryptoCacheSchema = createInsertSchema(cryptoCache).omit({ id: true, lastUpdated: true });
export type CryptoStat = typeof cryptoCache.$inferSelect;
export type CryptoStatsResponse = CryptoStat[];

export const strategies = pgTable("strategies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // "grid" | "dca" | "momentum" | "mean_reversion"
  symbol: text("symbol").notNull(), // e.g. "BTCUSDT"
  side: text("side").notNull(), // "LONG" | "SHORT" | "BOTH"
  status: text("status").notNull().default("stopped"), // "running" | "stopped" | "error"
  config: jsonb("config").$type<Record<string, any>>().notNull(),
  totalPnl: doublePrecision("total_pnl").default(0),
  totalTrades: integer("total_trades").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  lastRunAt: timestamp("last_run_at"),
});

export const insertStrategySchema = createInsertSchema(strategies)
  .omit({ id: true, createdAt: true, lastRunAt: true, totalPnl: true, totalTrades: true })
  .extend({ config: z.record(z.unknown()) });
export type Strategy = typeof strategies.$inferSelect;
export type InsertStrategy = z.infer<typeof insertStrategySchema>;

export const tradeLog = pgTable("trade_log", {
  id: serial("id").primaryKey(),
  strategyId: integer("strategy_id"),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // "BUY" | "SELL"
  orderType: text("order_type").notNull(), // "MARKET" | "LIMIT"
  quantity: doublePrecision("quantity").notNull(),
  price: doublePrecision("price"),
  status: text("status").notNull(), // "filled" | "pending" | "cancelled" | "error"
  orderId: text("order_id"),
  pnl: doublePrecision("pnl"),
  errorMsg: text("error_msg"),
  decisionEventId: integer("decision_event_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTradeLogSchema = createInsertSchema(tradeLog).omit({ id: true, createdAt: true });
export type TradeLogEntry = typeof tradeLog.$inferSelect;
export type InsertTradeLog = z.infer<typeof insertTradeLogSchema>;

export type DecisionOutcome = "executed" | "skipped" | "blocked" | "waiting" | "failed" | "deferred";

export interface DecisionCondition {
  name: string;
  value: unknown;
  threshold?: unknown;
  passed: boolean;
}

export const strategyDecisionEvents = pgTable("strategy_decision_events", {
  id: serial("id").primaryKey(),
  strategyId: integer("strategy_id").notNull(),
  engine: text("engine").notNull(),
  phase: text("phase").notNull(),
  decisionKey: text("decision_key").notNull(),
  eventType: text("event_type").notNull().default("evaluate"),
  actionConsidered: text("action_considered").notNull(),
  actionTaken: text("action_taken"),
  outcome: text("outcome").notNull(),
  reasonCode: text("reason_code"),
  reasonText: text("reason_text"),
  symbol: text("symbol").notNull(),
  price: doublePrecision("price"),
  stateJson: jsonb("state_json").$type<Record<string, unknown>>().default({}),
  signalsJson: jsonb("signals_json").$type<Record<string, unknown>>().default({}),
  conditionsJson: jsonb("conditions_json").$type<DecisionCondition[]>().default([]),
  exposureJson: jsonb("exposure_json").$type<Record<string, unknown>>(),
  tradeLogId: integer("trade_log_id"),
  orderId: text("order_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertStrategyDecisionEventSchema = createInsertSchema(strategyDecisionEvents).omit({
  id: true,
  createdAt: true,
});
export type StrategyDecisionEvent = typeof strategyDecisionEvents.$inferSelect;
export type InsertStrategyDecisionEvent = z.infer<typeof insertStrategyDecisionEventSchema>;

export const councilMessages = pgTable("council_messages", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  mode: text("mode").notNull(), // manager | council | agent | cross_talk
  position: text("position").notNull(),
  role: text("role").notNull(), // user | assistant | system | tool
  provider: text("provider"),
  model: text("model"),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCouncilMessageSchema = createInsertSchema(councilMessages).omit({ id: true, createdAt: true });
export type CouncilMessage = typeof councilMessages.$inferSelect;
export type InsertCouncilMessage = z.infer<typeof insertCouncilMessageSchema>;

export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  markPrice: doublePrecision("mark_price"),
  unrealizedPnl: doublePrecision("unrealized_pnl"),
  leverage: integer("leverage").default(1),
  lastUpdated: timestamp("last_updated").defaultNow(),
});

export type Position = typeof positions.$inferSelect;

export const accountBalance = pgTable("account_balance", {
  id: serial("id").primaryKey(),
  currency: text("currency").notNull(),
  available: doublePrecision("available").notNull(),
  frozen: doublePrecision("frozen").default(0),
  total: doublePrecision("total").notNull(),
  lastUpdated: timestamp("last_updated").defaultNow(),
});

export type AccountBalance = typeof accountBalance.$inferSelect;
