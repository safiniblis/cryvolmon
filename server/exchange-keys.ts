/**
 * Runtime storage for exchange API keys.
 *
 * Keys set via the Add Keys UI are persisted to data/exchange-keys.json and
 * merged over the environment variables. Env vars still win as a base layer;
 * a key saved through the UI overwrites the env value for that field.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ExchangeName = "bitunix" | "bitrue";

export interface ExchangeKeySet {
  apiKey: string;
  secretKey: string;
  updatedAt: string;
}

export interface ResolvedExchangeKey {
  apiKey: string | null;
  secretKey: string | null;
  source: "file" | "env" | "none";
  updatedAt: string | null;
}

const ENV_KEYS: Record<ExchangeName, { api: string; secret: string }> = {
  bitunix: { api: "BITUNIX_API_KEY", secret: "BITUNIX_SECRET_KEY" },
  bitrue:  { api: "BITRUE_API_KEY",  secret: "BITRUE_SECRET_KEY" },
};

function storePath(): string {
  return process.env.EXCHANGE_KEYS_PATH || join(process.cwd(), "data", "exchange-keys.json");
}

export function readExchangeKeys(): Partial<Record<ExchangeName, ExchangeKeySet>> {
  try {
    if (existsSync(storePath())) return JSON.parse(readFileSync(storePath(), "utf8"));
  } catch (e) {
    console.warn(`[Keys] Could not read ${storePath()}: ${(e as Error).message}`);
  }
  return {};
}

export function resolveExchangeKey(exchange: ExchangeName): ResolvedExchangeKey {
  const file = readExchangeKeys()[exchange];
  const envApi    = process.env[ENV_KEYS[exchange].api];
  const envSecret = process.env[ENV_KEYS[exchange].secret];
  const apiKey    = file?.apiKey    || envApi    || null;
  const secretKey = file?.secretKey || envSecret || null;
  const source: ResolvedExchangeKey["source"] =
    file?.apiKey && file?.secretKey ? "file" : apiKey && secretKey ? "env" : "none";
  return { apiKey, secretKey, source, updatedAt: file?.updatedAt ?? null };
}

export function setExchangeKeys(exchange: ExchangeName, apiKey: string, secretKey: string): void {
  const store = readExchangeKeys();
  store[exchange] = { apiKey, secretKey, updatedAt: new Date().toISOString() };
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 });
  // Mirror into env so any code path reading env directly sees the new keys.
  process.env[ENV_KEYS[exchange].api]    = apiKey;
  process.env[ENV_KEYS[exchange].secret] = secretKey;
}
