#!/usr/bin/env node
/**
 * Council seat watchdog — standalone sweeper for the VM (systemd timer).
 *
 * Each run (intended every ~5 min via council-watchdog.timer):
 *   1. Pings every reachable free endpoint (Groq / NVIDIA / keyless OVH extras
 *      + the currently-wired member-seat models) and persists a LIVE INDEX to
 *      data/council-free-index.json (survives restarts, inspectable).
 *   2. If a member seat's current model has failed CONSECUTIVE_FAILS sweeps in
 *      a row, switches it to the first HEALTHY model in MODEL_PRIORITY — the
 *      operator-curated list of free models ordered by competence (most
 *      competent first; a competent model that is currently down is skipped for
 *      the next healthy one). See server/agent-providers.ts MEMBER_FREE_MATRIX.
 *   3. Never touches the manager seat. Every switch is logged + appended to the
 *      changelog so it is always attributable.
 *
 * The OpenRouter free registry is NOT pinged by default (50 req/day quota —
 * a 5-min sweep would exhaust it in minutes). Enable with
 * COUNCIL_WATCHDOG_PING_OPENROUTER=1 if you want it anyway.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// --- env (load /etc/cryvolmon.env when missing) ----------------------------
try {
  const envPath = "/etc/cryvolmon.env";
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
} catch (e) {
  console.warn(`[Watchdog] could not read /etc/cryvolmon.env: ${e.message}`);
}

const API_BASE = process.env.COUNCIL_WATCHDOG_API_BASE || "http://127.0.0.1:5000";
const INDEX_PATH = process.env.COUNCIL_WATCHDOG_INDEX_PATH || resolve(process.cwd(), "data", "council-free-index.json");
const CONSECUTIVE_FAILS = Number(process.env.COUNCIL_WATCHDOG_FAILS || 2);
const COOLDOWN_MS = Number(process.env.COUNCIL_WATCHDOG_COOLDOWN || 15 * 60) * 1000;
const TIMEOUT_MS = Number(process.env.COUNCIL_WATCHDOG_TIMEOUT || 10_000);
const PING_OPENROUTER = process.env.COUNCIL_WATCHDOG_PING_OPENROUTER === "1";
const WRITE_TOKEN = process.env.COUNCIL_WRITE_TOKEN || "";

// --- candidates -------------------------------------------------------------
// Competence-ordered FREE member models (most competent first). Keep in sync
// with server/agent-providers.ts MEMBER_FREE_MATRIX. The watchdog picks the
// first HEALTHY model in this order when a seat must be switched — health is
// measured fresh each sweep, so a competent model that is currently down is
// skipped for the next healthy one.
const MODEL_PRIORITY = [
  ["groq", "openai/gpt-oss-120b"],
  ["nvidia", "openai/gpt-oss-120b"],
  ["ovh", "gpt-oss-120b"],
  ["ovh", "Qwen3.5-397B-A17B"],
  ["nvidia", "nvidia/nemotron-3-ultra-550b-a55b"],
  ["groq", "llama-3.3-70b-versatile"],
  ["ovh", "Meta-Llama-3_3-70B-Instruct"],
  ["nvidia", "nvidia/nemotron-3-super-120b-a12b"],
  ["groq", "openai/gpt-oss-20b"],
  ["nvidia", "openai/gpt-oss-20b"],
  ["ovh", "gpt-oss-20b"],
  ["ovh", "Qwen3-32B"],
  ["ovh", "Mistral-Small-3.2-24B-Instruct-2506"],
  ["openrouter", "google/gemma-4-26b-a4b-it:free"],
  ["openrouter", "nvidia/nemotron-3.5-lightning:free"],
  ["openrouter", "openai/gpt-oss-20b:free"],
  ["openrouter", "poolside/laguna-s-2.1:free"],
  ["openrouter", "cohere/north-mini-code:free"],
  ["openrouter", "liquid/lfm-2.5-2.6b:free"],
];
const MEMBER_SEATS = ["critic", "architect", "auditor", "strategist"];

const PROVIDER_BASE_URLS = {
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  nemotron: "https://integrate.api.nvidia.com/v1",
  ovh: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  opencode: "https://opencode.ai/zen/v1",
};
const KEYLESS_PROVIDERS = new Set(["ovh"]);

function providerKey(name) {
  const map = {
    groq: "GROQ_API_KEY",
    nvidia: "NVIDIA_API_KEY",
    nemotron: "NVIDIA_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    opencode: "OPENCODE_API_KEY",
    ovh: null,
  };
  return map[name];
}

// Paid-gateway models pinged into the live index (so the worker foreman sees
// them in AVAILABLE MODELS and can assign work to them) but NEVER auto-switched
// into a free member seat. big-pickle is the operator's preferred model: shown
// FIRST so it tops the foreman's list.
const INDEX_ONLY_MODELS = [
  ["opencode", "big-pickle"],
];

// Non-OpenRouter free endpoints (mirror of MEMBER_FREE_MATRIX providers) +
// the index-only paid models above. Pinged every sweep.
const FREE_ENDPOINTS = [
  ...INDEX_ONLY_MODELS,
  ...MODEL_PRIORITY.filter(([p]) => p !== "openrouter"),
];

// OpenRouter free registry (only when COUNCIL_WATCHDOG_PING_OPENROUTER=1).
const OPENROUTER_MODELS = [
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "poolside/laguna-s-2.1:free",
  "cohere/north-mini-code:free",
  "google/gemma-4-26b-a4b-it:free",
  "openai/gpt-oss-20b:free",
];

// --- helpers ----------------------------------------------------------------
function readIndex() {
  try {
    if (existsSync(INDEX_PATH)) return JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  } catch (e) {
    console.warn(`[Watchdog] could not read ${INDEX_PATH}: ${e.message}`);
  }
  return { updatedAt: null, models: {}, seats: {} };
}

function writeIndex(index) {
  try {
    mkdirSync(dirname(INDEX_PATH), { recursive: true });
    writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn(`[Watchdog] could not write ${INDEX_PATH}: ${e.message}`);
  }
}

function appendChangelog(line) {
  try {
    const p = resolve(process.cwd(), "data", "changelog.md");
    const stamp = new Date().toISOString();
    appendFileSync(p, `\n- ${stamp} — ${line}`);
  } catch (e) {
    console.warn(`[Watchdog] could not append changelog: ${e.message}`);
  }
}

async function pingEndpoint(provider, model, timeoutMs) {
  const baseUrl = PROVIDER_BASE_URLS[provider];
  if (!baseUrl) return { ok: false, ms: 0, error: `Unknown provider ${provider}` };
  const key = providerKey(provider) ? process.env[providerKey(provider)] : null;
  if (!key && !KEYLESS_PROVIDERS.has(provider)) {
    return { ok: false, ms: 0, error: `No ${providerKey(provider)} set` };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(KEYLESS_PROVIDERS.has(provider) || !key ? {} : { Authorization: `Bearer ${key}` }),
        ...(provider === "openrouter"
          ? {
              "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://cryvolmon.local",
              "X-OpenRouter-Title": process.env.OPENROUTER_SITE_NAME || "Cryvolmon Council",
            }
          : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (res.ok) return { ok: true, ms };
    const body = await res.text();
    return { ok: false, ms, error: `HTTP ${res.status} ${body.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e?.name === "AbortError" ? `timeout ${timeoutMs}ms` : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function getSeats() {
  try {
    const res = await fetch(`${API_BASE}/api/council/status`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.slots || []).map((s) => ({ position: s.position, provider: s.provider, model: s.model }));
  } catch (e) {
    return null;
  }
}

async function applySwitch(position, provider, model) {
  const headers = { "Content-Type": "application/json" };
  if (WRITE_TOKEN) headers["x-council-write-token"] = WRITE_TOKEN;
  const res = await fetch(`${API_BASE}/api/council/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ slots: [{ position, provider, model }] }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

// --- main sweep -------------------------------------------------------------
async function run() {
  const index = readIndex();
  const started = Date.now();
  const modelKey = (p, m) => `${p}:${m}`;

  // Build candidate set: free endpoints (+ openrouter registry if enabled) + current seat models.
  const candidates = new Map();
  for (const [p, m] of FREE_ENDPOINTS) candidates.set(modelKey(p, m), [p, m]);
  if (PING_OPENROUTER) for (const m of OPENROUTER_MODELS) candidates.set(modelKey("openrouter", m), ["openrouter", m]);

  const seats = await getSeats();
  if (seats) {
    for (const s of seats) {
      if (s.position === "manager") continue;
      candidates.set(modelKey(s.provider, s.model), [s.provider, s.model]);
    }
  } else {
    console.warn(`[Watchdog] /api/council/status unreachable — index only (no switching this sweep).`);
  }

  // Ping everything (sequential, staggered — mostly network wait).
  const models = index.models || {};
  for (const [key, [provider, model]] of candidates) {
    const result = await pingEndpoint(provider, model, TIMEOUT_MS);
    const prev = models[key] || {};
    models[key] = {
      provider,
      model,
      ok: result.ok,
      ms: result.ms,
      error: result.ok ? null : (result.error || "failed"),
      checkedAt: Date.now(),
      consecutiveFails: result.ok ? 0 : (prev.consecutiveFails || 0) + 1,
      firstFailAt: result.ok ? null : (prev.firstFailAt || Date.now()),
    };
    const r = models[key];
    console.log(`[Watchdog] ping ${key} -> ${r.ok ? `OK ${r.ms}ms` : `DOWN ${r.error}`} (${r.consecutiveFails}x)`);
    await new Promise((r) => setTimeout(r, 250));
  }
  // Reorder the index so the ping list order wins (big-pickle first, then free
  // priority models) — the worker foreman reads AVAILABLE MODELS in index
  // order, so big-pickle must top the list.
  const ordered = {};
  for (const [p, m] of FREE_ENDPOINTS) {
    const key = modelKey(p, m);
    if (models[key]) ordered[key] = models[key];
  }
  for (const [key, entry] of Object.entries(models)) {
    if (!ordered[key]) ordered[key] = entry;
  }
  index.models = ordered;

  // Auto-switch failing member seats.
  const seatsState = index.seats || {};
  const switches = [];
  for (const position of MEMBER_SEATS) {
    const seat = seats?.find((s) => s.position === position);
    if (!seat) continue;
    const key = modelKey(seat.provider, seat.model);
    const entry = models[key];
    const fails = entry && entry.ok === false ? entry.consecutiveFails : 0;
    const state = seatsState[position] || {};
    state.position = position;
    state.currentProvider = seat.provider;
    state.currentModel = seat.model;
    state.consecutiveFails = fails;
    const lastSwitchAt = Number(state.lastSwitchAt || 0);

    if (fails >= CONSECUTIVE_FAILS && Date.now() - lastSwitchAt >= COOLDOWN_MS) {
      // Pick the first HEALTHY model in competence-priority order (skips the
      // failing current one). Health is judged from this sweep's fresh pings.
      const keyOf = (p, m) => modelKey(p, m);
      const pick = MODEL_PRIORITY.map(([p, m]) => models[keyOf(p, m)])
        .filter((e) => e && e.ok === true && keyOf(e.provider, e.model) !== key && Date.now() - e.checkedAt < 15 * 60_000)[0];
      if (pick) {
        try {
          await applySwitch(position, pick.provider, pick.model);
          state.lastSwitchAt = Date.now();
          state.lastSwitch = `${pick.provider}/${pick.model} (${pick.ms}ms)`;
          const msg = `[Watchdog] SWITCH ${position}: ${seat.provider}/${seat.model} (${fails}x fail) -> ${pick.provider}/${pick.model} (${pick.ms}ms)`;
          console.log(msg);
          appendChangelog(msg.replace(/^\[Watchdog\] /, "Seat watchdog: "));
          switches.push(msg);
        } catch (e) {
          console.warn(`[Watchdog] switch for ${position} failed: ${e.message}`);
        }
      } else {
        const msg = `[Watchdog] ${position} down (${seat.provider}/${seat.model}, ${fails}x) — no healthy candidate available.`;
        console.log(msg);
      }
    }
    seatsState[position] = state;
  }
  index.seats = seatsState;
  index.updatedAt = new Date().toISOString();
  index.sweepMs = Date.now() - started;
  writeIndex(index);
  console.log(`[Watchdog] sweep done in ${index.sweepMs}ms, ${Object.keys(models).length} models indexed, ${switches.length} switch(es).`);
  process.exit(0);
}

run().catch((e) => {
  console.error(`[Watchdog] fatal: ${e.message}`);
  process.exit(1);
});
