/**
 * Agent registry — the 5-slot system: one MANAGER + four BUILD/COUNCIL members.
 * Each slot is provider-agnostic (OpenAI-compatible chat completions) and can be
 * wired to: big-pickle (opencode), DeepSeek, Groq, NVIDIA NIM (nemotron/nvidia),
 * OpenRouter, Hyperbolic (hy3), SambaNova, Mistral, HuggingFace router (hf),
 * Gemini, or the keyless OVHcloud anonymous tier (ovh). Credentials come from
 * env vars, the opencode auth.json fallback for DeepSeek, or from per-slot
 * overrides set at runtime via POST /api/council/agents.
 */

import { getApiKey as getDeepSeekKey } from "./deepseek";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MANAGER_BASE_URL, MANAGER_MODEL } from "@shared/council-config";
import { OPENROUTER_BASE_URL, FREE_MODEL_REGISTRY, getHealthyFreeModels, pingEndpoint, MODEL_DUPLICATES, EXTRA_FREE_ENDPOINTS, MANAGER_TRUSTED_MODELS, PROVIDER_BASE_URLS, KEYLESS_PROVIDERS, recordPingResult } from "./free-models";

const COUNCIL_STATE_PATH =
  process.env.COUNCIL_STATE_PATH ||
  join(process.cwd(), "data", "council-runtime.json");

function loadPersistedOverrides(): void {
  try {
    if (!existsSync(COUNCIL_STATE_PATH)) return;
    const raw = JSON.parse(readFileSync(COUNCIL_STATE_PATH, "utf8")) as {
      slots?: Array<{ position: AgentPosition; provider?: AgentProvider; baseUrl?: string; model?: string; apiKey?: string | null }>;
    };
    for (const slot of raw.slots || []) {
      if (!slot?.position || !AGENT_ROLES.some((r) => r.position === slot.position)) continue;
      overrides.set(slot.position, {
        provider: slot.provider,
        baseUrl: slot.baseUrl,
        model: slot.model,
        apiKey: slot.apiKey ?? null,
        lastError: null,
      });
    }
    console.log(`[Council] Loaded ${overrides.size} persisted slot override(s) from ${COUNCIL_STATE_PATH}`);
  } catch (e: any) {
    console.warn(`[Council] Could not load persisted slots: ${e.message}`);
  }
}

function persistOverrides(): void {
  try {
    const slots = AGENT_POSITIONS.map((position) => {
      const ov = overrides.get(position) || {};
      return {
        position,
        provider: ov.provider,
        baseUrl: ov.baseUrl,
        model: ov.model,
        apiKey: ov.apiKey ?? null,
      };
    }).filter((s) => s.provider || s.baseUrl || s.model || s.apiKey);
    mkdirSync(dirname(COUNCIL_STATE_PATH), { recursive: true });
    writeFileSync(COUNCIL_STATE_PATH, JSON.stringify({ slots, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch (e: any) {
    console.warn(`[Council] Could not persist slots: ${e.message}`);
  }
}

export type AgentPosition = "manager" | "critic" | "architect" | "auditor" | "strategist" | "resource_manager";
export type AgentProvider = "opencode" | "abacus" | "deepseek" | "groq" | "cerebras" | "openrouter" | "hyperbolic" | "nemotron" | "nvidia" | "sambanova" | "mistral" | "hf" | "gemini" | "ovh";

export const AGENT_POSITIONS: AgentPosition[] = ["manager", "critic", "architect", "auditor", "strategist", "resource_manager"];

export interface AgentRoleDef {
  position: AgentPosition;
  role: string;
  title: string;
  description: string;
  defaultProvider: AgentProvider;
  defaultModel?: string;
}

export const AGENT_ROLES: AgentRoleDef[] = [
  {
    position: "manager",
    role: "Decision & orchestration",
    title: "Manager / Builder",
    description: "Claude Sonnet (Abacus). Lead agent: clear decisions for a non-coder operator, coordinates council, holds write/patch approval.",
    defaultProvider: "abacus",
    defaultModel: "claude-sonnet-4",
  },
  {
    position: "critic",
    role: "Adversarial risk review",
    title: "Critic",
    description: "GPT-class (OpenCode Luna). Adversarial risk review in plain English — money risk first.",
    defaultProvider: "opencode",
    defaultModel: "gpt-5.6-luna",
  },
  {
    position: "architect",
    role: "Structure & parameter design",
    title: "Architect",
    description: "GPT-OSS 120B (Groq). Structure, workflows, and parameter design when asked.",
    defaultProvider: "groq",
    defaultModel: "openai/gpt-oss-120b",
  },
  {
    position: "auditor",
    role: "Health & rot scan",
    title: "Auditor",
    description: "GPT-OSS 120B (Cerebras). Health, missing scoreboards, config drift, silent failures.",
    defaultProvider: "cerebras",
    defaultModel: "gpt-oss-120b",
  },
  {
    position: "strategist",
    role: "Market read & proposals",
    title: "Strategist",
    description: "Grok-class / Nemotron (OpenRouter). Fast market and account read in English + math.",
    defaultProvider: "openrouter",
    defaultModel: "x-ai/grok-4.1-fast",
  },
  {
    position: "resource_manager",
    role: "Read-only resource and context retrieval",
    title: "Resource Manager",
    description: "Read-only HTTP connector (Replit resource service). Not an LLM seat — health/context only.",
    defaultProvider: "openrouter",
    defaultModel: "cohere/north-mini-code:free",
  },
];

interface ProviderDefaults {
  baseUrl: string;
  model: string;
}

const PROVIDER_DEFAULTS: Record<AgentProvider, ProviderDefaults> = {
  opencode: {
    baseUrl: process.env.OPENCODE_BASE_URL || MANAGER_BASE_URL,
    model: process.env.OPENCODE_MODEL || MANAGER_MODEL,
  },
  abacus: {
    baseUrl: process.env.ABACUS_BASE_URL || "https://routellm.abacus.ai/v1",
    model: process.env.ABACUS_MODEL || "claude-sonnet-4",
  },
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  },
  groq: {
    baseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  },
  cerebras: {
    baseUrl: process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
    model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
  },
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    model: process.env.OPENROUTER_MODEL || "openrouter/free",
  },
  hyperbolic: {
    baseUrl: process.env.HYPERBOLIC_BASE_URL || "https://api.hyperbolic.xyz/v1",
    model: process.env.HYPERBOLIC_MODEL || "hy3",
  },
  nemotron: {
    baseUrl: process.env.NEMOTRON_BASE_URL || "https://integrate.api.nvidia.com/v1",
    model: process.env.NEMOTRON_MODEL || "nvidia/llama-3.3-nemotron-super-70b",
  },
  nvidia: {
    baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    model: process.env.NVIDIA_MODEL || "openai/gpt-oss-120b",
  },
  sambanova: {
    baseUrl: process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1",
    model: process.env.SAMBANOVA_MODEL || "Meta-Llama-3.3-70B-Instruct",
  },
  mistral: {
    baseUrl: process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1",
    model: process.env.MISTRAL_MODEL || "mistral-small-4",
  },
  hf: {
    baseUrl: process.env.HF_BASE_URL || "https://router.huggingface.co/v1",
    model: process.env.HF_MODEL || "meta-llama/Llama-3.3-70B-Instruct",
  },
  gemini: {
    baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash",
  },
  ovh: {
    baseUrl: process.env.OVH_BASE_URL || "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    model: process.env.OVH_MODEL || "gpt-oss-20b",
  },
};

const POSITION_PROVIDER: Record<AgentPosition, AgentProvider> = Object.fromEntries(
  AGENT_ROLES.map((r) => [r.position, r.defaultProvider]),
) as Record<AgentPosition, AgentProvider>;

export type AgentOverride = Partial<Pick<SlotInternal, "provider" | "baseUrl" | "model" | "apiKey">>;

interface SlotInternal {
  position: AgentPosition;
  provider: AgentProvider;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  lastError: string | null;
}

const overrides = new Map<AgentPosition, Partial<SlotInternal>>();
const authKeys = new Map<AgentProvider, string | null>();

function openCodeAuthKey(provider: AgentProvider): string | null {
  if (authKeys.has(provider)) return authKeys.get(provider) ?? null;

  let key: string | null = null;
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const ids = provider === "opencode"
      ? ["opencode-go", "opencode-zen", "opencode"]
      : provider === "nemotron"
        ? ["nemotron", "nvidia"]
        : provider === "nvidia"
          ? ["nvidia", "nemotron"]
          : provider === "hf"
            ? ["hf", "huggingface"]
            : [provider];
    for (const id of ids) {
      const candidate = auth?.[id]?.key;
      if (typeof candidate === "string" && candidate.length > 0) {
        key = candidate;
        break;
      }
    }
  } catch {
    // OpenCode desktop credentials are optional; environment variables still work.
  }
  authKeys.set(provider, key);
  return key;
}

function providerKeyName(provider: AgentProvider): string {
  switch (provider) {
    case "opencode": return "OPENCODE_API_KEY";
    case "abacus": return "ABACUS_API_KEY";
    case "deepseek": return "DEEPSEEK_API_KEY";
    case "groq": return "GROQ_API_KEY";
    case "cerebras": return "CEREBRAS_API_KEY";
    case "openrouter": return "OPENROUTER_API_KEY";
    case "hyperbolic": return "HYPERBOLIC_API_KEY";
    case "nemotron": return "NEMOTRON_API_KEY";
    case "nvidia": return "NVIDIA_API_KEY";
    case "sambanova": return "SAMBANOVA_API_KEY";
    case "mistral": return "MISTRAL_API_KEY";
    case "hf": return "HF_TOKEN";
    case "gemini": return "GEMINI_API_KEY";
    case "ovh": return "none (keyless)";
  }
}

export function resolveSlotKey(provider: AgentProvider, overrideKey: string | null | undefined): string | null {
  if (overrideKey) return overrideKey;
  switch (provider) {
    case "deepseek": return process.env.DEEPSEEK_API_KEY || getDeepSeekKey() || openCodeAuthKey(provider);
    case "opencode": return process.env.OPENCODE_API_KEY || openCodeAuthKey(provider);
    case "abacus": return process.env.ABACUS_API_KEY || null;
    case "groq": return process.env.GROQ_API_KEY || openCodeAuthKey(provider);
    case "cerebras": return process.env.CEREBRAS_API_KEY || openCodeAuthKey(provider);
    case "openrouter": return process.env.OPENROUTER_API_KEY || openCodeAuthKey(provider);
    case "hyperbolic": return process.env.HYPERBOLIC_API_KEY || openCodeAuthKey(provider);
    case "nemotron": return process.env.NEMOTRON_API_KEY || process.env.NVIDIA_API_KEY || openCodeAuthKey(provider);
    case "nvidia": return process.env.NVIDIA_API_KEY || process.env.NEMOTRON_API_KEY || openCodeAuthKey(provider);
    case "sambanova": return process.env.SAMBANOVA_API_KEY || openCodeAuthKey(provider);
    case "mistral": return process.env.MISTRAL_API_KEY || openCodeAuthKey(provider);
    case "hf": return process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || openCodeAuthKey(provider);
    case "gemini": return process.env.GEMINI_API_KEY || openCodeAuthKey(provider);
    case "ovh": return null; // keyless anonymous tier
  }
}

export function getSlot(position: AgentPosition): SlotInternal {
  const role = AGENT_ROLES.find((r) => r.position === position)!;
  const def = PROVIDER_DEFAULTS[POSITION_PROVIDER[position]];
  const ov = overrides.get(position);
  return {
    position,
    provider: ov?.provider ?? role.defaultProvider,
    baseUrl: ov?.baseUrl ?? def.baseUrl,
    model: ov?.model ?? role.defaultModel ?? def.model,
    apiKey: ov?.apiKey ?? null,
    lastError: ov?.lastError ?? null,
  };
}

export interface AgentSlotView {
  position: AgentPosition;
  role: string;
  title: string;
  description: string;
  provider: AgentProvider;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyName: string;
  configured: boolean;
  lastError: string | null;
}

export function getAgentSlots(): AgentSlotView[] {
  return AGENT_ROLES.map((role) => {
    const slot = getSlot(role.position);
    const key = resolveSlotKey(slot.provider, slot.apiKey);
    const keyName = slot.apiKey ? "runtime override" : providerKeyName(slot.provider);
    const keyless = KEYLESS_PROVIDERS.has(slot.provider);
    return {
      position: slot.position,
      role: role.role,
      title: role.title,
      description: role.description,
      provider: slot.provider,
      baseUrl: slot.baseUrl,
      model: slot.model,
      hasKey: keyless || !!key,
      keyName,
      configured: keyless || !!key,
      lastError: slot.lastError,
    };
  });
}

export function setAgentOverrides(positions: { position: AgentPosition; provider?: AgentProvider; baseUrl?: string; model?: string; apiKey?: string }[]): void {
  for (const p of positions) {
    if (!AGENT_ROLES.some((r) => r.position === p.position)) continue;
    const cur = { ...(overrides.get(p.position) ?? {}) };
    if (p.provider && PROVIDER_DEFAULTS[p.provider]) {
      cur.provider = p.provider;
      // Switching provider resets to its defaults unless explicitly overridden.
      if (!p.baseUrl) cur.baseUrl = PROVIDER_DEFAULTS[p.provider].baseUrl;
      if (!p.model) cur.model = PROVIDER_DEFAULTS[p.provider].model;
    }
    if (p.baseUrl) cur.baseUrl = p.baseUrl;
    if (p.model) cur.model = p.model;
    // Do NOT silently rewrite manager model. Operator choice is final.
    if (p.apiKey !== undefined) cur.apiKey = p.apiKey === "" ? null : p.apiKey;
    overrides.set(p.position, cur);
  }
  persistOverrides();
}

// Load operator-saved slot choices after the overrides map exists.
loadPersistedOverrides();

function assignedModels(): Map<AgentPosition, string> {
  const map = new Map<AgentPosition, string>();
  for (const p of AGENT_POSITIONS) map.set(p, getSlot(p).model);
  return map;
}

/**
 * Build the rescue candidate list for a failing NON-manager slot, in priority
 * order:
 * 1. The SAME underlying model on another provider (verified duplicates) — a
 *    rate-limit or outage on one provider is often healed by the same model
 *    elsewhere.
 * 2. Extra verified free endpoints on other providers (Groq etc.).
 * 3. Every OTHER slot's current model (manager first, then critic, architect,
 *    auditor, strategist) — the seat-taking chain. resource_manager is never a
 *    source: it is an external fixed service (Claude on the user's Replit).
 * 4. Healthy free-registry models not yet assigned to any slot (diversity).
 * 5. Remaining registry models.
 */
function fallbackCandidates(position: AgentPosition, exclude: string): { provider: string; model: string }[] {
  const assigned = assignedModels();
  const others = AGENT_POSITIONS
    .filter((p) => p !== position && p !== "resource_manager")
    .map((p) => assigned.get(p)!);
  const healthy = getHealthyFreeModels().map((m) => m.id);
  const assignedSet = new Set([...others, exclude]);
  const unassignedHealthy = healthy.filter((m) => !assignedSet.has(m));
  const registryOrder = FREE_MODEL_REGISTRY.map((m) => m.id);
  const rest = registryOrder.filter((m) => !others.includes(m) && !unassignedHealthy.includes(m));

  const duplicates = (MODEL_DUPLICATES[exclude] || []).map((e) => ({ provider: e.provider, model: e.modelId }));
  const extras = EXTRA_FREE_ENDPOINTS
    .filter((e) => !assignedSet.has(e.modelId) && e.modelId !== exclude)
    .map((e) => ({ provider: e.provider, model: e.modelId }));
  const chain = [
    ...others.map((m) => ({ provider: "openrouter", model: m })),
    ...unassignedHealthy.map((m) => ({ provider: "openrouter", model: m })),
    ...rest.map((m) => ({ provider: "openrouter", model: m })),
  ];
  const seen = new Set<string>();
  const out: { provider: string; model: string }[] = [];
  for (const c of [...duplicates, ...extras, ...chain]) {
    const tag = `${c.provider}:${c.model}`;
    if (seen.has(tag) || c.model === exclude) continue;
    seen.add(tag);
    out.push(c);
  }
  return out;
}

/**
 * The manager seat only ever falls back within MANAGER_TRUSTED_MODELS. If none
 * respond the seat fails CLOSED — a random free model never gets write/patch
 * approval.
 */
function managerCandidates(exclude: string): { provider: string; model: string }[] {
  return MANAGER_TRUSTED_MODELS.filter((m) => m.model !== exclude);
}

/**
 * Ping candidates (short timeouts, capped to respect free-tier rate limits) and
 * wire the first responder into the failing slot. Returns the chosen model, or
 * null when every candidate is down.
 */
export async function selectFallbackModel(position: AgentPosition, exclude: string): Promise<{ model: string; provider: string } | null> {
  const isManager = position === "manager";
  const candidates = (isManager ? managerCandidates(exclude) : fallbackCandidates(position, exclude)).slice(0, 8);
  for (const c of candidates) {
    const key = resolveSlotKey(c.provider as AgentProvider, null);
    if (!key && !KEYLESS_PROVIDERS.has(c.provider)) continue;
    const result = await pingEndpoint(c.provider, c.model, key);
    // Reflect duplicate-ping health back onto the primary registry entry.
    for (const [logicalId, dups] of Object.entries(MODEL_DUPLICATES)) {
      if (dups.some((e) => e.provider === c.provider && e.modelId === c.model)) {
        recordPingResult(logicalId, result.ok, result.ms, result.error);
      }
    }
    if (result.ok) {
      const cur = { ...(overrides.get(position) ?? {}) };
      cur.provider = c.provider as AgentProvider;
      cur.baseUrl = PROVIDER_BASE_URLS[c.provider] ?? OPENROUTER_BASE_URL;
      cur.model = c.model;
      cur.apiKey = null;
      overrides.set(position, cur);
      return { model: c.model, provider: c.provider };
    }
  }
  return null;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentReply {
  ok: boolean;
  content: string | null;
  error?: string;
  position: AgentPosition;
  provider: AgentProvider;
  model: string;
  ms: number;
}

export interface AgentToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type AgentToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export async function chatSlot(
  position: AgentPosition,
  messages: AgentMessage[],
  opts: { timeoutMs?: number; maxTokens?: number; modelOverride?: string; providerOverride?: AgentProvider; tools?: AgentToolDefinition[]; executeTool?: AgentToolExecutor; requestMessages?: any[]; toolRound?: number; toolResults?: string[]; fallbackDepth?: number; nudged?: boolean } = {},
): Promise<AgentReply> {
  const started = Date.now();
  const slot = getSlot(position);
  const provider = opts.providerOverride ?? slot.provider;
  const model = opts.modelOverride ?? slot.model;
  const key = resolveSlotKey(provider, opts.providerOverride ? null : slot.apiKey);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const fallbackToBigPickle = () =>
    position !== "manager" && provider === "opencode" && model !== "big-pickle"
      ? chatSlot(position, messages, { ...opts, modelOverride: "big-pickle", timeoutMs: 45_000 })
      : null;

  /**
   * Auto-heal is DISABLED by default.
   * It was permanently overwriting operator-chosen models (e.g. manager = gpt-5.6-luna
   * got swapped mid-query). Set COUNCIL_AUTO_HEAL=1 only if you explicitly want rescue swaps.
   * Even when enabled, the manager seat is never auto-healed — operator lock is sacred.
   */
  const tryFallbackChain = async (reason: string): Promise<AgentReply | null> => {
    if (process.env.COUNCIL_AUTO_HEAL !== "1") return null;
    if ((opts.fallbackDepth ?? 0) >= 1) return null;
    // Never auto-heal manager or resource_manager — operator chose them on purpose.
    if (position === "resource_manager" || position === "manager") return null;
    const hasKeyed = ["openrouter", "groq", "nvidia", "nemotron"].some((p) => resolveSlotKey(p as AgentProvider, null));
    if (!hasKeyed && !KEYLESS_PROVIDERS.has("ovh")) return null;
    const pick = await selectFallbackModel(position, model);
    if (!pick) return null;
    console.warn(`[Council] ${position} failed (${reason}) -> auto-switched to ${pick.provider}/${pick.model}`);
    return chatSlot(position, messages, { ...opts, modelOverride: pick.model, providerOverride: pick.provider as AgentProvider, timeoutMs: 60_000, fallbackDepth: (opts.fallbackDepth ?? 0) + 1 });
  };

  const fail = async (error: string, extra: Partial<AgentReply> = {}): Promise<AgentReply> => {
    const healed = await tryFallbackChain(error);
    if (healed) return healed;
    return { ok: false, content: null, error, position, provider, model, ms: Date.now() - started, ...extra };
  };

  if (!key && !KEYLESS_PROVIDERS.has(provider)) {
    const error = `No API key for ${provider} (${model}) — set ${providerKeyName(provider)} or configure the slot.`;
    overrides.set(position, { ...overrides.get(position), ...{ lastError: error } });
    return fail(error);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Use chat-completions when tools are enabled; the tool loop below uses the
  // OpenAI-compatible tool-call shape, while plain GPT requests use Responses.
  const usesResponsesApi = provider === "opencode" && /^gpt-/.test(model) && !opts.tools;
  const baseUrl = opts.providerOverride ? PROVIDER_DEFAULTS[provider].baseUrl : slot.baseUrl;
  const url = `${baseUrl.replace(/\/+$/, "")}/${usesResponsesApi ? "responses" : "chat/completions"}`;
  const requestMessages = opts.requestMessages || messages;
  const requestBody = usesResponsesApi
    ? {
        model,
        input: requestMessages,
        max_output_tokens: opts.maxTokens ?? 1400,
      }
    : {
        model,
        messages: requestMessages,
        max_tokens: opts.maxTokens ?? 1400,
        ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
      };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key && !KEYLESS_PROVIDERS.has(provider) ? { Authorization: `Bearer ${key}` } : {}),
        ...(provider === "openrouter" ? {
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://cryvolmon.local",
          "X-OpenRouter-Title": process.env.OPENROUTER_SITE_NAME || "Cryvolmon Council",
        } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      const error = `HTTP ${res.status} ${body.slice(0, 300)}`;
      overrides.set(position, { ...overrides.get(position), ...{ lastError: error } });
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        const fallback = fallbackToBigPickle();
        if (fallback) return fallback;
      }
      return fail(error);
    }

    const data = await res.json();
    const toolCalls = data?.choices?.[0]?.message?.tool_calls || [];
    if (toolCalls.length > 0 && opts.executeTool && (opts.toolRound || 0) < 12) {
      const assistantMessage = data.choices[0].message;
      const toolMessages = [...requestMessages, assistantMessage];
      const toolResults = [...(opts.toolResults || [])];
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function?.arguments || "{}"); } catch { }
        let result: string;
        try {
          result = await opts.executeTool(call.function?.name || "", args);
        } catch (error: any) {
          result = `TOOL_ERROR: ${error?.message || String(error)}`;
        }
        toolResults.push(result);
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      const followUp = await chatSlot(position, messages, { ...opts, requestMessages: toolMessages, toolRound: (opts.toolRound || 0) + 1, toolResults });
      if (!followUp.ok && followUp.error === "Empty completion" && toolResults.length > 0 && !opts.nudged) {
        // The manager likely hit the tool-round cap mid-workflow or returned an
        // empty final message. Give it ONE more bounded round, tools still
        // available, to finish remaining steps (build/restart/commit/mark_job)
        // and then write a real plain-English summary. If that also fails,
        // fall back to a short note instead of dumping raw tool output.
        try {
          const nudged = await chatSlot(position, messages, {
            ...opts,
            toolRound: 0,
            nudged: true,
            requestMessages: [
              ...toolMessages,
              { role: "user", content: "You were interrupted mid-task and produced no final reply. If you still have remaining steps for this job (e.g. run_build, restart_service, log_change, git_commit, mark_job done), complete them now. When everything is done, reply to the operator in short plain English summarizing what you did and the result. Do not paste raw tool output. Do not call more tools once you reply." },
            ],
            timeoutMs: 60_000,
          });
          if (nudged.ok && nudged.content) return nudged;
        } catch { /* fall through to note */ }
        return { ...followUp, ok: true, error: undefined, content: `Tool executions completed but the model returned no final reply. ${toolResults.length} tool call(s) ran; results were recorded in the server log. Ask the manager to summarize what it changed.` };
      }
      return followUp;
    }
    const responseParts = data?.output?.flatMap((item: any) => item?.content || []) || [];
    const messageContent = data?.choices?.[0]?.message?.content;
    const normalizedMessageContent = Array.isArray(messageContent)
      ? messageContent.map((part: any) => typeof part === "string" ? part : part?.text || part?.content || "").join("")
      : messageContent;
    const content = usesResponsesApi
      ? data?.output_text || responseParts
          .filter((part: any) => part?.type === "output_text" || typeof part?.text === "string")
          .map((part: any) => part.text)
          .join("")
      : normalizedMessageContent || data?.output_text || data?.text;
    overrides.set(position, { ...overrides.get(position), ...{ lastError: null } });
    if (typeof content === "string" && content.trim()) {
      return { ok: true, content: content.trim(), position, provider, model, ms: Date.now() - started };
    }
    const fallback = fallbackToBigPickle();
    if (fallback) return fallback;
    return fail("Empty completion");
  } catch (e: any) {
    const error = e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e?.message || e);
    overrides.set(position, { ...overrides.get(position), ...{ lastError: error } });
    if (e?.name === "AbortError") {
      const fallback = fallbackToBigPickle();
      if (fallback) return fallback;
    }
    return fail(error);
  } finally {
    clearTimeout(timer);
  }
}

export function isAnyAgentConfigured(): boolean {
  return getAgentSlots().some((s) => s.configured);
}
