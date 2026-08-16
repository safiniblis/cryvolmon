#!/usr/bin/env node
/**
 * Background task worker with a FOREMAN assignment step.
 *
 * Design (operator-approved):
 *   - A task queue lives in data/worker-tasks.json.
 *   - On each run (systemd worker.timer, every ~3 min) ONE queued task is picked.
 *   - A FOREMAN model (chosen from a static reasoning-capable rank, first one
 *     healthy per the live watchdog index) reads the job + the live model index
 *     and assigns the best model for THIS job — biased to the local qwen3:4b
 *     ("let her" when adequate: zero cost, unlimited), escalating to a more
 *     competent healthy free model when the job needs real reasoning, code, or
 *     speed. Competence is therefore dynamic per job, not a static list.
 *   - The assigned worker runs the job (Ollama for local, OpenAI-compatible
 *     chat/completions for free APIs) and the result is written to
 *     data/worker-results/<id>.md.
 *   - Long tasks are fine: systemd oneshot never starts a second instance while
 *     one is running, so a 15-minute qwen task simply delays the next pick.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// --- env (systemd provides /etc/cryvolmon.env; self-read is a benign fallback) ---
try {
  const envPath = "/etc/cryvolmon.env";
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
} catch (e) {
  console.warn(`[Worker] could not read /etc/cryvolmon.env: ${e.message}`);
}

const QUEUE_PATH = process.env.WORKER_QUEUE_PATH || resolve(process.cwd(), "data", "worker-tasks.json");
const RESULTS_DIR = process.env.WORKER_RESULTS_DIR || resolve(process.cwd(), "data", "worker-results");
const INDEX_PATH = process.env.WORKER_INDEX_PATH || resolve(process.cwd(), "data", "council-free-index.json");
const FOREMAN_TIMEOUT = Number(process.env.WORKER_FOREMAN_TIMEOUT || 90_000);
const TASK_TIMEOUT = Number(process.env.WORKER_TASK_TIMEOUT || 25 * 60_000);
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MAX_TASK_RETRIES = Number(process.env.WORKER_MAX_TASK_RETRIES || 2);

// --- provider map (same as watchdog) ---
const PROVIDER_BASE_URLS = {
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  nemotron: "https://integrate.api.nvidia.com/v1",
  ovh: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  opencode: "https://opencode.ai/zen/v1",
};
function providerKey(provider) {
  return { groq: "GROQ_API_KEY", nvidia: "NVIDIA_API_KEY", nemotron: "NVIDIA_API_KEY", openrouter: "OPENROUTER_API_KEY", opencode: "OPENCODE_API_KEY" }[provider] || null;
}
const KEYLESS = new Set(["ovh", "local"]);

// --- static foreman rank (reasoning-capable, first healthy wins) ---
// Primary: groq gpt-oss-120b. Secondary: big-pickle (operator's preferred
// model, served by the opencode gateway). Then free fallbacks, local qwen last.
const FOREMAN_RANK = [
  ["groq", "openai/gpt-oss-120b"],
  ["opencode", "big-pickle"],
  ["nvidia", "openai/gpt-oss-120b"],
  ["nvidia", "nvidia/nemotron-3-super-120b-a12b"],
  ["groq", "llama-3.3-70b-versatile"],
  ["ovh", "Qwen3.5-397B-A17B"],
  ["ovh", "gpt-oss-120b"],
  ["groq", "openai/gpt-oss-20b"],
  ["local", "qwen3:4b"],
];

// --- queue helpers ---
function readQueue() {
  try {
    if (existsSync(QUEUE_PATH)) return JSON.parse(readFileSync(QUEUE_PATH, "utf8")).tasks || [];
  } catch (e) {
    console.warn(`[Worker] could not read ${QUEUE_PATH}: ${e.message}`);
  }
  return [];
}
function writeQueue(tasks) {
  try {
    mkdirSync(dirname(QUEUE_PATH), { recursive: true });
    writeFileSync(QUEUE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), tasks }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn(`[Worker] could not write ${QUEUE_PATH}: ${e.message}`);
  }
}
function appendChangelog(line) {
  try {
    appendFileSync(resolve(process.cwd(), "data", "changelog.md"), `\n- ${new Date().toISOString()} — ${line}`);
  } catch (e) {
    console.warn(`[Worker] could not append changelog: ${e.message}`);
  }
}

function readIndex() {
  try {
    if (existsSync(INDEX_PATH)) return JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  } catch (e) {}
  return { models: {} };
}

// --- model calls ---
function stripThinking(text) {
  let t = text;
  let prev = null;
  while (t !== prev) {
    prev = t;
    t = t.replace(/<think>[\s\S]*?<\/think>/g, " ").trim();
    t = t.replace(/^```json\s*/i, "").replace(/```$/m, "").trim();
  }
  return t.trim();
}

async function chatCompletions(provider, model, messages, opts = {}) {
  const baseUrl = PROVIDER_BASE_URLS[provider];
  const key = providerKey(provider) ? process.env[providerKey(provider)] : null;
  if (!baseUrl) throw new Error(`unknown provider ${provider}`);
  if (!key && !KEYLESS.has(provider)) throw new Error(`no ${providerKey(provider)} set`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TASK_TIMEOUT);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(KEYLESS.has(provider) || !key ? {} : { Authorization: `Bearer ${key}` }),
        ...(provider === "openrouter"
          ? {
              "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://cryvolmon.local",
              "X-OpenRouter-Title": process.env.OPENROUTER_SITE_NAME || "Cryvolmon Worker",
            }
          : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens || 2048,
        temperature: opts.temperature ?? 0.3,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

async function resolveLocalModel() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { headers: { Connection: "close" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    return names.find((n) => n.startsWith("qwen3:4b")) || names.find((n) => n.startsWith("qwen3:")) || names[0] || null;
  } catch {
    return null;
  }
}

async function localChat(prompt, maxTokens, model = "qwen3:4b") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0.3, num_predict: maxTokens || 2048 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    return data.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// --- foreman ---
function healthyForeman(index) {
  const now = Date.now();
  for (const [provider, model] of FOREMAN_RANK) {
    const e = index.models?.[`${provider}:${model}`];
    if (e && e.ok === true && now - e.checkedAt < 15 * 60_000) return { provider, model };
  }
  return null;
}

const FOREMAN_SYSTEM = `You are the FOREMAN of a background job queue for a crypto trading system. You assign each job to the best available model. Reply with ONLY a JSON object, no prose, no markdown fences.

{"provider": "model-provider-id", "model": "model-id", "reason": "one short sentence"}

Rules:
- DEFAULT to the local model "qwen3:4b" (provider "local") for non-urgent jobs that need extraction, summarization, classification, tagging, or structured JSON: it is free, unlimited, and never rate-limited. Local is slow (a few tokens/sec) but these jobs are fine in the background.
- For ANY job that matters — important, reasoning-heavy, code, multi-step logic, math, or a fast turnaround — PREFER "big-pickle" (provider "opencode") when it is in the AVAILABLE MODELS list and healthy: it is the operator's preferred, most capable model.
- Use a remote free model ONLY when big-pickle is not available: reasoning-heavy jobs: openai/gpt-oss-120b.
- Code jobs: openai/gpt-oss-120b or openai/gpt-oss-20b.
- Fast short replies: llama-3.3-70b-versatile or openai/gpt-oss-20b.
- NEVER invent a model that is not in the AVAILABLE MODELS list.`;

async function assign(foreman, task, index) {
  const healthy = Object.values(index.models || {})
    .filter((e) => e && e.ok === true && Date.now() - e.checkedAt < 15 * 60_000)
    .map((e) => `${e.provider}/${e.model} (${e.ms}ms)`)
    .join("\n");
  const prior = (task.attempts || [])
    .map((a) => `- attempt: assigned ${a.provider}/${a.model} -> failed: ${a.error}`)
    .join("\n");
  const prompt = [
    `JOB TITLE: ${task.title || task.type || "untitled"}`,
    `JOB TYPE: ${task.type || "generic"}`,
    `JOB INSTRUCTIONS: ${task.prompt}`,
    task.maxOutputTokens ? `MAX OUTPUT TOKENS: ${task.maxOutputTokens}` : "MAX OUTPUT TOKENS: default",
    ``,
    prior ? `PREVIOUS ATTEMPTS (avoid re-assigning a model that already failed for this job — pick a different healthy one):\n${prior}` : "",
    ``,
    `AVAILABLE MODELS (live):`,
    healthy || "(none) — if truly none, still return the local model qwen3:4b as best-effort",
    ``,
    `Choose the best model for THIS job and reply with the JSON object only.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
  const reply = await chatCompletions(foreman.provider, foreman.model, [
    { role: "system", content: FOREMAN_SYSTEM },
    { role: "user", content: prompt },
  ], { maxTokens: 1024, timeoutMs: FOREMAN_TIMEOUT });
  const cleaned = stripThinking(reply);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`foreman reply was not JSON: ${cleaned.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  if (!parsed.provider || !parsed.model) throw new Error(`foreman JSON missing provider/model: ${match[0].slice(0, 200)}`);
  return { provider: String(parsed.provider).toLowerCase(), model: String(parsed.model), reason: String(parsed.reason || "").slice(0, 200) };
}

// --- execute on assigned model ---
const TRANSIENT_RE = /fetch failed|ECONN|ETIMEDOUT|abort|503|502|429|rate limit|too many requests|timeout/i;
async function withTransientRetry(fn, { attempts = 3, backoffMs = 15_000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts && TRANSIENT_RE.test(e.message)) {
        console.log(`[Worker] transient error (${e.message}) — retry ${i}/${attempts - 1} in ${backoffMs / 1000}s`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function execute(task, assignment) {
  const started = Date.now();
  const feedback =
    task.feedback && task.feedback.length
      ? `\n\nIMPROVEMENTS FROM THE LAST REVIEW — your result must address EVERY point (produce a fresh complete result, no apology or preamble):\n${task.feedback
          .map((f, i) => `${i + 1}. ${f}`)
          .join("\n")}`
      : "";
  const prompt = task.prompt + feedback;
  let content;
  if (assignment.provider === "local") {
    const localModel = await resolveLocalModel();
    if (!localModel) throw new Error("Ollama has no model available — run `ollama pull qwen3:4b`");
    content = await withTransientRetry(() => localChat(prompt, task.maxOutputTokens, localModel));
  } else {
    content = await withTransientRetry(() =>
      chatCompletions(assignment.provider, assignment.model, [
        { role: "system", content: "You are a background worker. Complete the assigned job precisely and concisely." },
        { role: "user", content: prompt },
      ], { maxTokens: task.maxOutputTokens || 2048, timeoutMs: TASK_TIMEOUT }),
    );
  }
  return { content: stripThinking(content), ms: Date.now() - started };
}

// --- main ---
async function run() {
  const tasks = readQueue();
  const queued = tasks
    .filter((t) => t.status === "queued")
    .sort((a, b) => (a.priority || 0) - (b.priority || 0) || (a.createdAt || "").localeCompare(b.createdAt || ""));
  if (tasks.some((t) => t.status === "running")) {
    console.log(`[Worker] another task is running — skipping this tick.`);
    return;
  }
  if (queued.length === 0) {
    console.log(`[Worker] queue empty — nothing to do.`);
    return;
  }
  const task = queued[0];
  const id = task.id;
  const index = readIndex();

  task.status = "running";
  task.startedAt = new Date().toISOString();
  writeQueue(tasks);
  console.log(`[Worker] START ${id} "${task.title || task.prompt.slice(0, 60)}"`);

  const foreman = healthyForeman(index);
  if (!foreman) {
    task.status = "failed";
    task.error = "no healthy foreman model (watchdog index all down)";
    writeQueue(tasks);
    console.log(`[Worker] FAIL ${id}: ${task.error}`);
    return;
  }
  console.log(`[Worker] foreman: ${foreman.provider}/${foreman.model}`);
  task.foreman = { provider: foreman.provider, model: foreman.model };
  writeQueue(tasks);

  let assignment;
  try {
    assignment = await assign(foreman, task, index);
    console.log(`[Worker] assigned ${id} -> ${assignment.provider}/${assignment.model} (${assignment.reason})`);
  } catch (e) {
    return failOrRequeue(tasks, task, `foreman error: ${e.message}`, null);
  }

  try {
    const { content, ms } = await execute(task, assignment);
    // Fast foreman check on the finished work: accept -> manager review; reject -> rework.
    let verified;
    try {
      verified = await verifyResult(foreman, task, content);
    } catch (e) {
      verified = { accept: true, note: `verification unavailable (${e.message})` };
    }
    if (!verified.accept && (task.retries || 0) < MAX_TASK_RETRIES) {
      task.attempts = [...(task.attempts || []), { at: new Date().toISOString(), provider: assignment.provider, model: assignment.model, error: `foreman rejected result: ${verified.note}` }];
      task.retries = (task.retries || 0) + 1;
      task.status = "queued";
      task.startedAt = null;
      task.finishedAt = null;
      task.assigned = null;
      task.error = null;
      writeQueue(tasks);
      const logLine = `Worker ${id} "${task.title || task.type}" result rejected by foreman (${verified.note}) — re-queued for rework (attempt ${task.retries}/${MAX_TASK_RETRIES}).`;
      console.log(`[Worker] REWORK ${id}: ${logLine}`);
      appendChangelog(logLine);
      return;
    }
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, `${id}.md`);
    const header = `# ${task.title || task.type || id}\n\n- task: ${id}\n- assigned: ${assignment.provider}/${assignment.model}\n- foreman reason: ${assignment.reason}\n- foreman acceptance: ${verified.accept ? "accepted" : "accepted (retries exhausted)"} — ${verified.note}\n- ran: ${(ms / 1000).toFixed(1)}s\n- done: ${new Date().toISOString()}\n\n---\n\n`;
    writeFileSync(file, header + content, { mode: 0o600 });
    task.status = "done";
    task.resultPath = file;
    task.assigned = assignment;
    task.verified = { at: new Date().toISOString(), by: `${foreman.provider}/${foreman.model}`, accept: verified.accept, note: verified.note };
    // Only tasks flagged for it get a paid manager final evaluation; routine
    // work (review:"none") is closed by the free foreman acceptance alone.
    task.needsManagerReview = task.review !== "none";
    task.finishedAt = new Date().toISOString();
    task.ms = ms;
    writeQueue(tasks);
    const logLine = `Worker ${id} "${task.title || task.type}" done via ${assignment.provider}/${assignment.model} (foreman ${verified.accept ? "accepted" : "accepted-with-reservations"}) in ${(ms / 1000).toFixed(0)}s — queued for manager review.`;
    console.log(`[Worker] DONE ${id}: ${logLine}`);
    appendChangelog(logLine);
  } catch (e) {
    return failOrRequeue(tasks, task, `run error: ${e.message}`, assignment);
  }
}

// --- foreman fast acceptance check on finished work ---
async function verifyResult(foreman, task, content) {
  const prompt = [
    `You are the FOREMAN doing a FAST acceptance check of a finished worker result. Quick sanity check only: did the worker actually complete the job (completeness, format, answers the job)?`,
    ``,
    `JOB TITLE: ${task.title || task.type}`,
    `JOB PROMPT: ${task.prompt}`.slice(0, 6000),
    ``,
    `WORKER RESULT:`,
    content.slice(0, 6000),
    ``,
    `Reply with ONLY the JSON object: {"accept":true,"note":"short"} or {"accept":false,"note":"what is missing or fixable"}`,
  ].join("\n");
  const reply = await chatCompletions(foreman.provider, foreman.model, [
    { role: "system", content: "You are a fast quality checker. Reply with a JSON object only." },
    { role: "user", content: prompt },
  ], { maxTokens: 300, timeoutMs: FOREMAN_TIMEOUT });
  const cleaned = stripThinking(reply);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`verifier reply was not JSON: ${cleaned.slice(0, 120)}`);
  const parsed = JSON.parse(match[0]);
  return { accept: parsed.accept !== false, note: String(parsed.note || "").slice(0, 200) };
}

// A failed task is re-queued (up to MAX_TASK_RETRIES) so the foreman can pick a
// different healthy model on the next pass — the retry logic belongs here, not
// in a separate watcher.
function failOrRequeue(tasks, task, err, assignment) {
  const attempt = { at: new Date().toISOString(), ...(assignment ? { provider: assignment.provider, model: assignment.model } : {}), error: err };
  task.attempts = [...(task.attempts || []), attempt];
  if ((task.retries || 0) < MAX_TASK_RETRIES) {
    task.retries = (task.retries || 0) + 1;
    task.status = "queued";
    task.startedAt = null;
    task.finishedAt = null;
    task.assigned = null;
    task.error = null;
    writeQueue(tasks);
    const logLine = `Worker ${task.id} "${task.title || task.type}" failed (${err}) — re-queued for foreman reassignment (attempt ${task.retries}/${MAX_TASK_RETRIES}).`;
    console.log(`[Worker] RETRY ${task.id}: ${logLine}`);
    appendChangelog(logLine);
    return;
  }
  task.status = "failed";
  task.error = err;
  task.finishedAt = new Date().toISOString();
  writeQueue(tasks);
  const logLine = `Worker ${task.id} "${task.title || task.type}" failed permanently after ${MAX_TASK_RETRIES} attempts: ${err}`;
  console.log(`[Worker] FAIL ${task.id}: ${logLine}`);
  appendChangelog(logLine);
}

run().catch((e) => {
  console.error(`[Worker] fatal: ${e.message}`);
  process.exit(1);
});
