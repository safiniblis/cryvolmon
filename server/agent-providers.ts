/**
 * Agent registry — the pipeline: one MANAGER + architect → builder → auditor
 * (with trader for strategy launch). Each slot is provider-agnostic
 * (OpenAI-compatible chat completions) and can be wired to: big-pickle
 * (opencode), DeepSeek, Groq, NVIDIA NIM (nemotron/nvidia), OpenRouter,
 * Hyperbolic (hy3), SambaNova, Mistral, HuggingFace router (hf), Gemini, or the
 * keyless OVHcloud anonymous tier (ovh). Credentials come from env vars, the
 * opencode auth.json fallback for DeepSeek, or from per-slot overrides set at
 * runtime via POST /api/council/agents.
 */

import { getApiKey as getDeepSeekKey } from "./deepseek";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MANAGER_BASE_URL, MANAGER_MODEL, MANAGER_PROVIDER } from "@shared/council-config";
import { OPENROUTER_BASE_URL, FREE_MODEL_REGISTRY, getHealthyFreeModels, pingEndpoint, MODEL_DUPLICATES, EXTRA_FREE_ENDPOINTS, MANAGER_TRUSTED_MODELS, PROVIDER_BASE_URLS, KEYLESS_PROVIDERS, recordPingResult } from "./free-models";
import { logCall } from "./llm-ledger";

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
      if (slot.provider && PROVIDER_BASE_URLS[slot.provider]) {
        slot.baseUrl = PROVIDER_BASE_URLS[slot.provider];
      }
      overrides.set(slot.position, {
        provider: slot.provider,
        baseUrl: slot.baseUrl,
        model: slot.model,
        apiKey: slot.apiKey ?? null,
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

export type AgentPosition = "manager" | "architect" | "builder" | "auditor" | "trader";
export type AgentProvider = "opencode" | "abacus" | "deepseek" | "groq" | "cerebras" | "openrouter" | "hyperbolic" | "nemotron" | "nvidia" | "sambanova" | "mistral" | "hf" | "gemini" | "ovh" | "local" | "nebius" | "llmgateway";

export const AGENT_POSITIONS: AgentPosition[] = ["manager", "architect", "builder", "auditor", "trader"];
export const OPERATOR_LOCKED_POSITIONS: ReadonlySet<AgentPosition> = new Set(["manager", "architect", "builder", "auditor"]);

export interface AgentRoleDef {
  position: AgentPosition;
  role: string;
  title: string;
  description: string;
  defaultProvider: AgentProvider;
  defaultModel?: string;
}

/**
 * Curated FREE member-seat models (cost rule: paid ONLY for the manager).
 * Any model here may hold a member seat; everything else (opencode, abacus,
 * deepseek, random registrations) is rejected for members unless the request
 * carries the COUNCIL_WRITE_TOKEN (header x-council-write-token). The seat
 * watchdog picks the MOST COMPETENT healthy model from this set.
 */
const MEMBER_FREE_MATRIX: { provider: AgentProvider; model: string }[] = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "nvidia", model: "openai/gpt-oss-120b" },
  { provider: "ovh", model: "gpt-oss-120b" },
  { provider: "ovh", model: "Qwen3.5-397B-A17B" },
  { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b" },
  { provider: "groq", model: "llama-3.3-70b-versatile" },
  { provider: "ovh", model: "Meta-Llama-3_3-70B-Instruct" },
  { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "nvidia", model: "openai/gpt-oss-20b" },
  { provider: "ovh", model: "gpt-oss-20b" },
  { provider: "ovh", model: "Qwen3-32B" },
  { provider: "ovh", model: "Mistral-Small-3.2-24B-Instruct-2506" },
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free" },
  { provider: "openrouter", model: "openai/gpt-oss-20b:free" },
  { provider: "openrouter", model: "poolside/laguna-s-2.1:free" },
  { provider: "openrouter", model: "cohere/north-mini-code:free" },
  { provider: "openrouter", model: "liquid/lfm-2.5-2.6b:free" },
];

function memberFreePolicy(): { provider: AgentProvider; model: string }[] {
  return MEMBER_FREE_MATRIX;
}

export const MEMBER_SEAT_POLICY: Record<Exclude<AgentPosition, "manager">, { provider: AgentProvider; model: string }[]> = {
  architect: memberFreePolicy(),
  builder: memberFreePolicy(),
  auditor: memberFreePolicy(),
  trader: memberFreePolicy(),
};

export const AGENT_ROLES: AgentRoleDef[] = [
  {
    position: "manager",
    role: "Orchestration & final gate",
    title: "Manager",
    description: `${MANAGER_MODEL} (${MANAGER_PROVIDER}, paid). Lead agent: writes the job order, approves the architect's build plan, runs the final review, and triggers the reboot after the auditor approves. The only paid seat.`,
    defaultProvider: MANAGER_PROVIDER,
    defaultModel: MANAGER_MODEL,
  },
  {
    position: "architect",
    role: "Build-plan design",
    title: "Architect",
    description: "DeepSeek Chat (free/cheap). Devises the build plan — files, interfaces, tests, risks — before any code is written.",
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
  },
  {
    position: "builder",
    role: "Implementation & verification",
    title: "Builder",
    description: "Groq GPT OSS 120B. Implements the approved build plan with patches, then verifies via run_check/run_build and commits.",
    defaultProvider: "groq",
    defaultModel: "openai/gpt-oss-120b",
  },
  {
    position: "auditor",
    role: "Quality & risk audit",
    title: "Auditor",
    description: "NVIDIA Nemotron. Audits the implementation against the plan and the build result. APPROVE or REJECT with findings.",
    defaultProvider: "nvidia",
    defaultModel: "nvidia/nemotron-3-super-120b-a12b",
  },
  {
    position: "trader",
    role: "Strategy launch & market read",
    title: "Trader",
    description: "Groq (free). Starts completed strategies when they are ready to run, and reads the market/account state. (Roadmap: autonomous open/close.)",
    defaultProvider: "groq",
    defaultModel: "llama-3.3-70b-versatile",
  },
];

interface ProviderDefaults {
  baseUrl: string;
  model: string;
}

const PROVIDER_DEFAULTS: Record<AgentProvider, ProviderDefaults> = {
  opencode: {
    baseUrl: process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1",
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
  local: {
    baseUrl: process.env.LOCAL_BASE_URL || "http://127.0.0.1:11434/v1",
    model: process.env.LOCAL_MODEL || "qwen3:4b",
  },
  nebius: {
    baseUrl: process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1",
    model: process.env.NEBIUS_MODEL || "deepseek-ai/DeepSeek-V4-Pro",
  },
  llmgateway: {
    baseUrl: process.env.LLMGATEWAY_BASE_URL || "https://llmgateway.io/v1",
    model: process.env.LLMGATEWAY_MODEL || "deepseek-v4-flash",
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
    case "local": return "none (keyless)";
    case "nebius": return "NEBIUS_API_KEY";
    case "llmgateway": return "LLMGATEWAY_API_KEY";
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
    case "local": return null; // local Ollama needs no key
    case "nebius": return process.env.NEBIUS_API_KEY || null;
    case "llmgateway": return process.env.LLMGATEWAY_API_KEY || null;
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

export function setAgentOverrides(
  positions: { position: AgentPosition; provider?: AgentProvider; baseUrl?: string; model?: string; apiKey?: string }[],
  opts?: { operator?: boolean },
): void {
  const operator = !!opts?.operator;
  for (const p of positions) {
    if (!AGENT_ROLES.some((r) => r.position === p.position)) continue;
    const cur = { ...(overrides.get(p.position) ?? {}) };
    const providerChanged = !!p.provider && p.provider !== cur.provider;
    if (p.provider && PROVIDER_DEFAULTS[p.provider]) {
      cur.provider = p.provider;
      // Provider changes always reset the endpoint; never carry another provider's URL.
      if (providerChanged || !p.baseUrl) cur.baseUrl = PROVIDER_DEFAULTS[p.provider].baseUrl;
      if (!p.model) cur.model = PROVIDER_DEFAULTS[p.provider].model;
    }
    if (p.baseUrl && !providerChanged) cur.baseUrl = p.baseUrl;
    if (p.model) cur.model = p.model;
    // Do NOT silently rewrite manager model. Operator choice is final.
    if (p.apiKey !== undefined) cur.apiKey = p.apiKey === "" ? null : p.apiKey;

    // Non-operator writers may only move member seats within the approved policy
    // (manager is exempt — it is the operator's own paid seat).
    if (!operator && p.position !== "manager") {
      const allowed = (MEMBER_SEAT_POLICY[p.position] || []).some(
        (a) => a.provider === cur.provider && a.model === cur.model,
      );
      if (!allowed) {
        console.warn(`[SeatPolicy] Blocked non-operator change of ${p.position} -> ${cur.provider}/${cur.model} (not in approved member matrix).`);
        continue;
      }
    }
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
 *    auditor, strategist) — the seat-taking chain.
 * 4. Healthy free-registry models not yet assigned to any slot (diversity).
 * 5. Remaining registry models.
 */
function fallbackCandidates(position: AgentPosition, exclude: string): { provider: string; model: string }[] {
  const assigned = assignedModels();
  const others = AGENT_POSITIONS
    .filter((p) => p !== position)
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
  if (OPERATOR_LOCKED_POSITIONS.has(position)) return null;
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
  toolCalls?: number;
}

export interface AgentToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type AgentToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export async function chatSlot(
  position: AgentPosition,
  messages: AgentMessage[],
  opts: { timeoutMs?: number; maxTokens?: number; modelOverride?: string; providerOverride?: AgentProvider; tools?: AgentToolDefinition[]; executeTool?: AgentToolExecutor; requestMessages?: any[]; toolRound?: number; toolResults?: string[]; toolCalls?: number; fallbackDepth?: number; nudged?: boolean } = {},
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
  const tryFallbackChain = async (reason: string, force = false): Promise<AgentReply | null> => {
    // Empty completions always trigger fallback — the provider returned nothing,
    // so retrying the same provider is unlikely to help.  Other errors respect
    // the COUNCIL_AUTO_HEAL gate to avoid overwriting operator-chosen models.
    if (!force && process.env.COUNCIL_AUTO_HEAL !== "1") return null;
    if ((opts.fallbackDepth ?? 0) >= 1) return null;
    // Never auto-heal manager — operator chose it on purpose.
    if (OPERATOR_LOCKED_POSITIONS.has(position)) return null;
    const hasKeyed = ["openrouter", "groq", "nvidia", "nemotron"].some((p) => resolveSlotKey(p as AgentProvider, null));
    if (!hasKeyed && !KEYLESS_PROVIDERS.has("ovh")) return null;
    const pick = await selectFallbackModel(position, model);
    if (!pick) return null;
    console.warn(`[Council] ${position} failed (${reason}) -> auto-switched to ${pick.provider}/${pick.model}`);
    return chatSlot(position, messages, { ...opts, modelOverride: pick.model, providerOverride: pick.provider as AgentProvider, timeoutMs: 60_000, fallbackDepth: (opts.fallbackDepth ?? 0) + 1 });
  };

  const fail = async (error: string, extra: Partial<AgentReply> = {}, force = false): Promise<AgentReply> => {
    const healed = await tryFallbackChain(error, force);
    if (healed) return healed;
    if ((opts.toolRound ?? 0) === 0) logCall({ position, provider, model, tokensIn: 0, tokensOut: 0, ms: Date.now() - started, ok: false, error });
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
      const totalToolCalls = (opts.toolCalls ?? 0) + toolCalls.length;
      const followUp = await chatSlot(position, messages, { ...opts, requestMessages: toolMessages, toolRound: (opts.toolRound || 0) + 1, toolResults, toolCalls: totalToolCalls });
      if (!followUp.ok && followUp.error === "Empty completion" && toolResults.length > 0 && !opts.nudged) {
        // The model returned empty after tool execution.  Build a LEAN nudge
        // context: original messages + a compact summary of what was called
        // (no raw output — that wall of text is what choked the model).
        const toolSummary = toolCalls.map((c: any) => c.function?.name || "unknown").join(", ");
        try {
          const nudged = await chatSlot(position, messages, {
            ...opts,
            toolRound: 0,
            nudged: true,
            requestMessages: [
              ...requestMessages,
              { role: "assistant", content: `[Tool calls completed: ${toolSummary}]` },
              { role: "user", content: "You were interrupted mid-task and produced no final reply. Your previous tool calls ran successfully. If you still have remaining steps for this job (e.g. run_build, restart_service, log_change, mark_job done), complete them now. Do not call git_commit unless the build plan explicitly requires it. When everything is done, reply to the operator in short plain English summarizing what you did and the result. Do not paste raw tool output. Do not call more tools once you reply." },
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
      const tokensIn = data?.usage?.prompt_tokens ?? 0;
      const tokensOut = data?.usage?.completion_tokens ?? 0;
      if ((opts.toolRound ?? 0) === 0) logCall({ position, provider, model, tokensIn, tokensOut, ms: Date.now() - started, ok: true });
      return { ok: true, content: content.trim(), position, provider, model, ms: Date.now() - started, toolCalls: opts.toolCalls };
    }
    const fallback = fallbackToBigPickle();
    if (fallback) return fallback;
    return fail("Empty completion", {}, true);
  } catch (e: any) {
    const error = e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e?.message || e);
    overrides.set(position, { ...overrides.get(position), ...{ lastError: error } });
    if (e?.name === "AbortError") {
      const fallback = fallbackToBigPickle();
      if (fallback) return fallback;
    }
    return fail(error, {}, e?.name === "AbortError");
  } finally {
    clearTimeout(timer);
  }
}

export function isAnyAgentConfigured(): boolean {
  return getAgentSlots().some((s) => s.configured);
}
