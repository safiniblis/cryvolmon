/**
 * LLM Call Ledger — append-only log of every model invocation.
 *
 * Tracks: provider, model, position, role, tokens (in/out), estimated cost,
 * latency, outcome, and timestamp.  Used by the spend ceiling and circuit
 * breaker downstream.
 *
 * Storage: data/llm-ledger.jsonl (one JSON object per line, never rewritten).
 * A summary rollup is kept in data/llm-ledger-summary.json for fast lookups.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  ts: string;               // ISO-8601
  position: string;         // manager | architect | builder | auditor | trader
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;          // estimated, 0 if unknown
  ms: number;               // wall-clock latency
  ok: boolean;
  error?: string;
  pipelineJobId?: string;   // set when called from runPipeline
  pipelineStage?: string;   // order | architect | manager-plan | builder | auditor | manager-final
}

export interface LedgerSummary {
  windowStart: string;      // start of the rolling window (UTC midnight)
  totalCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  byProvider: Record<string, { calls: number; costUsd: number; tokensOut: number }>;
  byPosition: Record<string, { calls: number; costUsd: number }>;
  consecutiveFailures: number;  // for circuit breaker
}

// ---------------------------------------------------------------------------
// Pricing estimates (USD per 1K tokens) — update as providers change pricing.
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  // Paid models
  "opencode":       { input: 0.003, output: 0.012 },  // gpt-5.6-luna estimate
  "abacus":         { input: 0.003, output: 0.015 },  // claude-sonnet-4 estimate
  // Free models — $0 but we still track token volume
  "groq":           { input: 0, output: 0 },
  "nvidia":         { input: 0, output: 0 },
  "ovh":            { input: 0, output: 0 },
  "openrouter":     { input: 0, output: 0 },
  "deepseek":       { input: 0.00014, output: 0.00028 },  // deepseek-chat
  "hyperbolic":     { input: 0, output: 0 },
};

function estimateCost(provider: string, model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[provider] ?? { input: 0, output: 0 };
  return (tokensIn / 1000) * p.input + (tokensOut / 1000) * p.output;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = join(process.cwd(), "data");
const LEDGER_PATH = join(DATA_DIR, "llm-ledger.jsonl");
const SUMMARY_PATH = join(DATA_DIR, "llm-ledger-summary.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function logCall(entry: Omit<LedgerEntry, "ts" | "costUsd">): void {
  ensureDir();
  const costUsd = estimateCost(entry.provider, entry.model, entry.tokensIn, entry.tokensOut);
  const full: LedgerEntry = { ...entry, ts: new Date().toISOString(), costUsd };
  appendFileSync(LEDGER_PATH, JSON.stringify(full) + "\n");
  updateSummary(full);
}

/** Read today's summary (resets at UTC midnight). */
export function todaySummary(): LedgerSummary {
  ensureDir();
  if (!existsSync(SUMMARY_PATH)) return emptySummary();
  try {
    const raw = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as LedgerSummary;
    const today = new Date().toISOString().slice(0, 10);
    if (raw.windowStart !== today) return emptySummary();
    return raw;
  } catch {
    return emptySummary();
  }
}

/** Check if the daily spend ceiling has been hit. */
export function overSpendCeiling(ceilingUsd: number): boolean {
  return todaySummary().totalCostUsd >= ceilingUsd;
}

/** Check if the circuit breaker should trip (too many consecutive failures). */
export function circuitBroken(threshold = 5): boolean {
  return todaySummary().consecutiveFailures >= threshold;
}

/** Read recent entries (last N). */
export function recentEntries(n = 50): LedgerEntry[] {
  ensureDir();
  if (!existsSync(LEDGER_PATH)) return [];
  try {
    const lines = readFileSync(LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l) as LedgerEntry);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function emptySummary(): LedgerSummary {
  return {
    windowStart: new Date().toISOString().slice(0, 10),
    totalCalls: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCostUsd: 0,
    byProvider: {},
    byPosition: {},
    consecutiveFailures: 0,
  };
}

function updateSummary(entry: LedgerEntry): void {
  ensureDir();
  let summary: LedgerSummary;
  const today = new Date().toISOString().slice(0, 10);
  if (existsSync(SUMMARY_PATH)) {
    try {
      summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as LedgerSummary;
      if (summary.windowStart !== today) summary = emptySummary();
    } catch {
      summary = emptySummary();
    }
  } else {
    summary = emptySummary();
  }

  summary.totalCalls += 1;
  summary.totalTokensIn += entry.tokensIn;
  summary.totalTokensOut += entry.tokensOut;
  summary.totalCostUsd += entry.costUsd;

  if (!summary.byProvider[entry.provider]) {
    summary.byProvider[entry.provider] = { calls: 0, costUsd: 0, tokensOut: 0 };
  }
  summary.byProvider[entry.provider].calls += 1;
  summary.byProvider[entry.provider].costUsd += entry.costUsd;
  summary.byProvider[entry.provider].tokensOut += entry.tokensOut;

  if (!summary.byPosition[entry.position]) {
    summary.byPosition[entry.position] = { calls: 0, costUsd: 0 };
  }
  summary.byPosition[entry.position].calls += 1;
  summary.byPosition[entry.position].costUsd += entry.costUsd;

  // Circuit breaker: track consecutive failures
  if (entry.ok) {
    summary.consecutiveFailures = 0;
  } else {
    summary.consecutiveFailures += 1;
  }

  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
}
