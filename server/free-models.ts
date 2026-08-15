/**
 * Free-model registry for the AI council.
 *
 * Compiled from the OpenRouter `/models` endpoint and ping-tested against the
 * configured OPENROUTER_API_KEY. Free models are flaky (rate limits, upstream
 * outages, provider dropouts), so every entry carries the last ping result and
 * the auto-fallback in `agent-providers.ts` re-pings candidates before wiring
 * them into a slot.
 */

export interface FreeModelEntry {
  id: string;
  context: number;
  family: string;
  notes: string;
}

export interface FreeModelStatus {
  ok: boolean | null;
  ms?: number;
  error?: string;
  checkedAt?: number;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const FREE_MODEL_REGISTRY: FreeModelEntry[] = [
  { id: "liquid/lfm-2.5-2.6b:free", context: 128_000, family: "liquid", notes: "Compact Liquid AI reasoning model." },
  { id: "nvidia/nemotron-3.5-lightning:free", context: 1_000_000, family: "nvidia", notes: "NVIDIA MoE, 3B active / 30B total, 1M context." },
  { id: "poolside/laguna-s-2.1:free", context: 262_144, family: "poolside", notes: "Poolside coding agent model, 118B total." },
  { id: "poolside/laguna-xs-2.1:free", context: 262_144, family: "poolside", notes: "Poolside coding agent, 33B-A3B." },
  { id: "cohere/north-mini-code:free", context: 256_000, family: "cohere", notes: "Cohere North agentic coding model." },
  { id: "nvidia/nemotron-3.5-content-safety:free", context: 128_000, family: "nvidia", notes: "4B multimodal guardrail model." },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", context: 1_000_000, family: "nvidia", notes: "Frontier reasoning/orchestration, 55B active, 1M context." },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", context: 256_000, family: "nvidia", notes: "30B-A3B multimodal, perception sub-agent." },
  { id: "google/gemma-4-26b-a4b-it:free", context: 262_144, family: "google", notes: "Google DeepMind MoE, 25.2B total." },
  { id: "google/gemma-4-31b-it:free", context: 262_144, family: "google", notes: "Google DeepMind dense 30.7B, multimodal." },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", context: 262_144, family: "nvidia", notes: "120B hybrid MoE, 12B active." },
  { id: "nvidia/nemotron-3-nano-30b-a3b:free", context: 256_000, family: "nvidia", notes: "Small MoE, high compute efficiency." },
  { id: "nvidia/nemotron-nano-12b-v2-vl:free", context: 128_000, family: "nvidia", notes: "12B multimodal reasoning, video understanding." },
  { id: "nvidia/nemotron-nano-9b-v2:free", context: 128_000, family: "nvidia", notes: "9B general-purpose LLM." },
  { id: "openai/gpt-oss-20b:free", context: 131_072, family: "openai", notes: "OpenAI open-weight MoE, 21B total." },
];

const statusCache = new Map<string, FreeModelStatus>();

export function recordPingResult(id: string, ok: boolean, ms?: number, error?: string): void {
  statusCache.set(id, { ok, ms, error, checkedAt: Date.now() });
}

export function getModelStatus(id: string): FreeModelStatus | undefined {
  return statusCache.get(id);
}

export function getFreeModels(): FreeModelEntry[] {
  return FREE_MODEL_REGISTRY.map((m) => ({ ...m, ...statusCache.get(m.id) }));
}

export function getHealthyFreeModels(): FreeModelEntry[] {
  const now = Date.now();
  return FREE_MODEL_REGISTRY.filter((m) => {
    const s = statusCache.get(m.id);
    if (!s) return true; // untested — treat as candidate
    if (s.ok === false) return false;
    return now - (s.checkedAt ?? 0) < 10 * 60_000; // healthy result within 10 min
  });
}

export function getModelFamily(id: string): string {
  const entry = FREE_MODEL_REGISTRY.find((m) => m.id === id);
  if (entry) return entry.family;
  const family = id.split("/")[0] ?? "other";
  return family;
}

/** Ping a single model through OpenRouter's chat-completions endpoint. */
export async function pingModel(id: string, apiKey: string, timeoutMs = 10_000): Promise<{ ok: boolean; ms: number; error?: string }> {
  const result = await pingEndpoint("openrouter", id, apiKey, timeoutMs);
  recordPingResult(id, result.ok, result.ms, result.error);
  return result;
}

export const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  opencode: "https://opencode.ai/zen/v1",
  abacus: "https://routellm.abacus.ai/v1",
  hyperbolic: "https://api.hyperbolic.xyz/v1",
  nemotron: "https://integrate.api.nvidia.com/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  deepseek: "https://api.deepseek.com",
  sambanova: "https://api.sambanova.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  hf: "https://router.huggingface.co/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  ovh: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  local: "http://127.0.0.1:11434/v1",
};

/**
 * Providers that work WITHOUT an API key (anonymous tiers). The keyless OVH
 * cloud endpoint rejects any Authorization header (verified 2026-08-13), so
 * these are pinged with no auth at all.
 */
export const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(["ovh", "local"]);

/** Ping any OpenAI-compatible endpoint; used by the auto-heal to test candidates. */
export async function pingEndpoint(provider: string, modelId: string, apiKey: string | null, timeoutMs = 10_000): Promise<{ ok: boolean; ms: number; error?: string }> {
  const baseUrl = PROVIDER_BASE_URLS[provider];
  if (!baseUrl) return { ok: false, ms: 0, error: `Unknown provider ${provider}` };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(KEYLESS_PROVIDERS.has(provider) || !apiKey ? {} : { Authorization: `Bearer ${apiKey}` }),
        ...(provider === "openrouter"
          ? {
              "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://cryvolmon.local",
              "X-OpenRouter-Title": process.env.OPENROUTER_SITE_NAME || "Cryvolmon Council",
            }
          : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (res.ok) return { ok: true, ms };
    const body = await res.text();
    return { ok: false, ms, error: `HTTP ${res.status} ${body.slice(0, 160)}` };
  } catch (e: any) {
    const ms = Date.now() - started;
    return { ok: false, ms, error: e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The SAME underlying model served on a second provider, verified working free
 * (ping-tested 2026-08-13). Tried FIRST when a slot's model fails — a rate-limit
 * or outage on one provider is often healed by the same model on another.
 */
export interface DuplicateEndpoint {
  provider: string;
  modelId: string;
  free: boolean;
}

export const MODEL_DUPLICATES: Record<string, DuplicateEndpoint[]> = {
  "openai/gpt-oss-20b:free": [
    { provider: "groq", modelId: "openai/gpt-oss-20b", free: true },
    { provider: "nvidia", modelId: "openai/gpt-oss-20b", free: true },
    { provider: "ovh", modelId: "gpt-oss-20b", free: true },
  ],
  "nvidia/nemotron-3-ultra-550b-a55b:free": [
    { provider: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b", free: true },
  ],
  "nvidia/nemotron-3-super-120b-a12b:free": [
    { provider: "nvidia", modelId: "nvidia/nemotron-3-super-120b-a12b", free: true },
  ],
  "google/gemma-4-31b-it:free": [],
};

/** Verified working free endpoints on other providers (not on OpenRouter's free list). */
export const EXTRA_FREE_ENDPOINTS: DuplicateEndpoint[] = [
  { provider: "groq", modelId: "openai/gpt-oss-20b", free: true },
  { provider: "groq", modelId: "openai/gpt-oss-120b", free: true },
  { provider: "groq", modelId: "llama-3.3-70b-versatile", free: true },
  { provider: "nvidia", modelId: "openai/gpt-oss-20b", free: true },
  { provider: "nvidia", modelId: "openai/gpt-oss-120b", free: true },
  { provider: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b", free: true },
  { provider: "nvidia", modelId: "nvidia/nemotron-3-super-120b-a12b", free: true },
  { provider: "nvidia", modelId: "nvidia/nemotron-3-nano-30b-a3b", free: true },
  { provider: "nvidia", modelId: "nvidia/llama-3.1-nemotron-ultra-253b-v1", free: true },
  { provider: "nvidia", modelId: "meta/llama-3.3-70b-instruct", free: true },
  { provider: "ovh", modelId: "gpt-oss-20b", free: true },
  { provider: "ovh", modelId: "gpt-oss-120b", free: true },
  { provider: "ovh", modelId: "Qwen3.5-397B-A17B", free: true },
  { provider: "ovh", modelId: "Qwen3.6-27B", free: true },
  { provider: "ovh", modelId: "Qwen3-32B", free: true },
  { provider: "ovh", modelId: "Qwen3-Coder-30B-A3B-Instruct", free: true },
  { provider: "ovh", modelId: "Meta-Llama-3_3-70B-Instruct", free: true },
  { provider: "ovh", modelId: "Mistral-Small-3.2-24B-Instruct-2506", free: true },
];

/**
 * The ONLY models allowed to hold the manager seat. The manager can approve
 * file writes / live patches, so a random free model must never land here —
 * if none of these respond, the seat fails CLOSED (no call) instead of
 * handing write access to an untrusted model.
 */
export const MANAGER_TRUSTED_MODELS: { provider: string; model: string }[] = [
  { provider: "abacus", model: "claude-sonnet-4" },
  { provider: "abacus", model: "claude-sonnet-4-5" },
  { provider: "abacus", model: "claude-3-5-sonnet" },
  { provider: "opencode", model: "gpt-5.6-luna" },
  { provider: "opencode", model: "big-pickle" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
  { provider: "openrouter", model: "openai/gpt-4.1" },
  { provider: "openrouter", model: "x-ai/grok-4.1-fast" },
];
