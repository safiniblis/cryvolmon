/**
 * DeepSeek API client — powers the AI parameter council and the manager chat.
 * Reads DEEPSEEK_API_KEY from env; if absent, falls back to the key stored in
 * opencode's local auth file (~/.local/share/opencode/auth.json) so the app can
 * reuse the same DeepSeek credential you already configured for opencode.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://api.deepseek.com";

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekOptions {
  temperature?: number;
  maxTokens?: number;
  /** Hard timeout in ms. Defaults to 45s — a slow model must not block the council. */
  timeoutMs?: number;
}

export interface DeepSeekReply {
  ok: boolean;
  content: string | null;
  error?: string;
  model: string;
  ms: number;
}

let cachedFallbackKey: string | null | undefined;

function openCodeAuthKey(): string | null {
  if (cachedFallbackKey !== undefined) return cachedFallbackKey;
  cachedFallbackKey = null;
  try {
    const path = join(homedir(), ".local", "share", "opencode", "auth.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const key = parsed?.deepseek?.key;
    if (typeof key === "string" && key.length > 0) cachedFallbackKey = key;
  } catch {
    // fallback unavailable — env key is the only source
  }
  return cachedFallbackKey;
}

export function getApiKey(): string | null {
  return process.env.DEEPSEEK_API_KEY || openCodeAuthKey() || null;
}

export function getApiKeySource(): "env" | "opencode-auth" | "none" {
  if (process.env.DEEPSEEK_API_KEY) return "env";
  if (openCodeAuthKey()) return "opencode-auth";
  return "none";
}

export function isDeepSeekConfigured(): boolean {
  return getApiKey() !== null;
}

export interface CouncilRoleConfig {
  role: string;
  title: string;
  model: string;
}

const roleDefaults: Omit<CouncilRoleConfig, "model">[] = [
  { role: "critic", title: "Critic" },
  { role: "architect", title: "Architect" },
  { role: "auditor", title: "Auditor" },
];

const ROLE_MODEL_ENV: Record<string, string> = {
  critic: "COUNCIL_CRITIC_MODEL",
  architect: "COUNCIL_ARCHITECT_MODEL",
  auditor: "COUNCIL_AUDITOR_MODEL",
};

/** Model per council role. Overridable via env (e.g. COUNCIL_ARCHITECT_MODEL=deepseek-v4-pro). */
export function getCouncilRoles(): CouncilRoleConfig[] {
  return roleDefaults.map((r) => ({
    ...r,
    model: process.env[ROLE_MODEL_ENV[r.role]] || defaultRoleModel(r.role),
  }));
}

export function getManagerModel(): string {
  return process.env.COUNCIL_MANAGER_MODEL || defaultRoleModel("architect");
}

function defaultRoleModel(role: string): string {
  switch (role) {
    case "critic":
      return "deepseek-reasoner";
    case "architect":
      return "deepseek-chat";
    case "auditor":
      return "deepseek-chat";
    default:
      return "deepseek-chat";
  }
}

export async function chatDeepSeek(
  model: string,
  messages: DeepSeekMessage[],
  opts: DeepSeekOptions = {},
): Promise<DeepSeekReply> {
  const started = Date.now();
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      content: null,
      error: "DEEPSEEK_API_KEY not set — council disabled",
      model,
      ms: Date.now() - started,
    };
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        // deepseek-reasoner rejects temperature — only send it for chat-class models.
        ...(opts.temperature !== undefined && model !== "deepseek-reasoner"
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : { max_tokens: 1400 }),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        content: null,
        error: `HTTP ${res.status}: ${body.slice(0, 300)}`,
        model,
        ms: Date.now() - started,
      };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      return { ok: true, content: content.trim(), model, ms: Date.now() - started };
    }
    return { ok: false, content: null, error: "Empty completion from model", model, ms: Date.now() - started };
  } catch (e: any) {
    const err = e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e?.message || e);
    return { ok: false, content: null, error: err, model, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}