import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let runtimeConfig: { baseUrl: string; apiKey: string } | null = null;
export const DEFAULT_RESOURCE_MANAGER_BASE_URL = "https://bfcf8e16-134a-45c0-baa0-2cd6a853bf53-00-3sk70h4mnkimn.spock.replit.dev";
const RESOURCE_STATE_PATH =
  process.env.RESOURCE_MANAGER_STATE_PATH ||
  join(process.cwd(), "data", "resource-manager.json");

function loadPersistedResourceConfig(): void {
  try {
    if (!existsSync(RESOURCE_STATE_PATH)) return;
    const raw = JSON.parse(readFileSync(RESOURCE_STATE_PATH, "utf8")) as { baseUrl?: string; apiKey?: string };
    if (raw.baseUrl || raw.apiKey) {
      runtimeConfig = {
        baseUrl: (raw.baseUrl || DEFAULT_RESOURCE_MANAGER_BASE_URL).replace(/\/api\/healthz\/?$/, "").replace(/\/+$/, ""),
        apiKey: raw.apiKey || "",
      };
      console.log(`[ResourceManager] Loaded persisted config from ${RESOURCE_STATE_PATH}`);
    }
  } catch (e: any) {
    console.warn(`[ResourceManager] Could not load persisted config: ${e.message}`);
  }
}

function persistResourceConfig(): void {
  try {
    if (!runtimeConfig) return;
    mkdirSync(dirname(RESOURCE_STATE_PATH), { recursive: true });
    writeFileSync(RESOURCE_STATE_PATH, JSON.stringify({ ...runtimeConfig, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch (e: any) {
    console.warn(`[ResourceManager] Could not persist config: ${e.message}`);
  }
}

function config() {
  return runtimeConfig || {
    baseUrl: process.env.RESOURCE_MANAGER_BASE_URL || DEFAULT_RESOURCE_MANAGER_BASE_URL,
    apiKey: process.env.RESOURCE_MANAGER_API_KEY || "",
  };
}

export function setResourceManagerConfig(baseUrl: string, apiKey?: string): void {
  const normalized = baseUrl.replace(/\/api\/healthz\/?$/, "").replace(/\/+$/, "");
  runtimeConfig = { baseUrl: normalized, apiKey: apiKey || config().apiKey };
  persistResourceConfig();
}

loadPersistedResourceConfig();

export function getResourceManagerStatus() {
  const current = config();
  return { configured: !!(current.baseUrl && current.apiKey), baseUrl: current.baseUrl, hasKey: !!current.apiKey };
}

export async function checkResourceManagerHealth(): Promise<{ ok: boolean; status: number; body: unknown }> {
  const current = config();
  if (!current.baseUrl) return { ok: false, status: 0, body: "Resource Manager base URL is missing" };
  if (!current.apiKey) return { ok: false, status: 0, body: "Resource Manager API key is missing — paste it and save" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${current.baseUrl}/api/healthz`, {
      headers: { "X-API-Key": current.apiKey, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, body };
  } catch (error: any) {
    const msg = error?.name === "AbortError" ? "health check timed out after 12s" : (error.message || String(error));
    return { ok: false, status: 0, body: msg };
  } finally {
    clearTimeout(timer);
  }
}
