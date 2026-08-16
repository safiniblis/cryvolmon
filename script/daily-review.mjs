#!/usr/bin/env node
/**
 * Nightly batch manager review (run by nightly-roll.sh just before the daily
 * summary enqueue). Finds every done task still flagged needsManagerReview,
 * evaluates them ALL in a single batched call to the first healthy foreman-rank
 * model (free stack), records the verdict on each task, and re-queues rework.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

try {
  const envPath = "/etc/cryvolmon.env";
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
} catch {}

const DATA_DIR = process.env.WORKER_DATA_DIR || resolve(process.cwd(), "data");
const QUEUE_PATH = process.env.WORKER_QUEUE_PATH || join(DATA_DIR, "worker-tasks.json");
const INDEX_PATH = process.env.WORKER_INDEX_PATH || join(DATA_DIR, "council-free-index.json");
const MAX_TASK_RETRIES = Number(process.env.WORKER_MAX_TASK_RETRIES || 2);
const REVIEW_TIMEOUT = Number(process.env.NIGHTLY_REVIEW_TIMEOUT || 120_000);
const MAX_TASKS_PER_BATCH = 12;

const PROVIDER_BASE_URLS = {
  groq: "https://api.groq.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  ovh: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  opencode: "https://opencode.ai/zen/v1",
};
const KEYLESS = new Set(["ovh"]);
function providerKey(provider) {
  return { groq: "GROQ_API_KEY", nvidia: "NVIDIA_API_KEY", opencode: "OPENCODE_API_KEY" }[provider] || null;
}

const REVIEW_RANK = [
  ["groq", "openai/gpt-oss-120b"],
  ["opencode", "big-pickle"],
  ["nvidia", "openai/gpt-oss-120b"],
  ["nvidia", "nvidia/nemotron-3-super-120b-a12b"],
  ["groq", "llama-3.3-70b-versatile"],
  ["ovh", "Qwen3.5-397B-A17B"],
  ["ovh", "gpt-oss-120b"],
  ["groq", "openai/gpt-oss-20b"],
];

function readQueue() {
  try {
    if (existsSync(QUEUE_PATH)) return JSON.parse(readFileSync(QUEUE_PATH, "utf8")).tasks || [];
  } catch (e) {
    console.error(`[DailyReview] could not read ${QUEUE_PATH}: ${e.message}`);
  }
  return [];
}
function writeQueue(tasks) {
  try {
    mkdirSync(dirname(QUEUE_PATH), { recursive: true });
    writeFileSync(QUEUE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), tasks }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error(`[DailyReview] could not write ${QUEUE_PATH}: ${e.message}`);
  }
}
function appendChangelog(line) {
  try {
    appendFileSync(join(DATA_DIR, "changelog.md"), `\n- ${new Date().toISOString()} — ${line}`);
  } catch (e) {
    console.error(`[DailyReview] could not append changelog: ${e.message}`);
  }
}

function readIndex() {
  try {
    if (existsSync(INDEX_PATH)) return JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  } catch {}
  return { models: {} };
}

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

function healthyReviewer(index) {
  const now = Date.now();
  for (const [provider, model] of REVIEW_RANK) {
    const e = index.models?.[`${provider}:${model}`];
    if (e && e.ok === true && now - e.checkedAt < 15 * 60_000) return { provider, model };
  }
  return null;
}

async function chatCompletions(provider, model, messages) {
  const baseUrl = PROVIDER_BASE_URLS[provider];
  const key = providerKey(provider) ? process.env[providerKey(provider)] : null;
  if (!baseUrl) throw new Error(`unknown provider ${provider}`);
  if (!key && !KEYLESS.has(provider)) throw new Error(`no ${providerKey(provider)} set`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(KEYLESS.has(provider) || !key ? {} : { Authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 2048,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

const REVIEW_SYSTEM = `You are the night-shift REVIEWER for a background job queue in a crypto trading system. The foreman already accepted each finished job with a fast sanity check; your job is the FINAL evaluation of that finished work against its original instructions.

Reply with ONLY a JSON array, no prose, no markdown fences:
[{"id":"task-id","verdict":"accepted","note":"one short sentence"}, ...]

Rules:
- "accepted": the result is complete, correct, and matches the job's instructions.
- "rework": the result misses something important or is wrong — note exactly what must change.
- Evaluate EVERY id you are given. Never invent ids. Keep notes under ~160 chars.`;

async function main() {
  const tasks = readQueue();
  const pending = tasks
    .filter((t) => t.needsManagerReview === true && t.status === "done" && !t.managerReview)
    .slice(0, MAX_TASKS_PER_BATCH);

  if (pending.length === 0) {
    console.log("[DailyReview] no pending manager reviews — nothing to do.");
    return;
  }
  console.log(`[DailyReview] ${pending.length} pending review(s): ${pending.map((t) => t.id).join(", ")}`);

  const index = readIndex();
  const reviewer = healthyReviewer(index);
  if (!reviewer) {
    console.error("[DailyReview] no healthy review model (index all down) — leaving reviews pending for next night.");
    process.exit(1);
  }
  console.log(`[DailyReview] reviewer: ${reviewer.provider}/${reviewer.model}`);

  const jobs = pending
    .map((t) => {
      let result = "";
      if (t.resultPath) {
        try {
          result = readFileSync(t.resultPath, "utf8").slice(0, 800);
        } catch {}
      }
      return `### ${t.id} "${t.title || t.type}"
- instructions: ${String(t.prompt || "").slice(0, 900)}
- foreman note: ${t.verified?.note || "(none)"}
- result: ${result || "(no result file)"}`;
    })
    .join("\n\n");

  const user = `Review these finished background jobs (final evaluation).\n\n${jobs.slice(0, 12000)}`;
  const reply = stripThinking(
    await chatCompletions(reviewer.provider, reviewer.model, [
      { role: "system", content: REVIEW_SYSTEM },
      { role: "user", content: user },
    ]),
  );

  let verdicts = [];
  const arrMatch = reply.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      verdicts = JSON.parse(arrMatch[0]);
    } catch (e) {
      console.error(`[DailyReview] verdict JSON unparseable: ${e.message}`);
      console.error(`[DailyReview] raw reply: ${reply.slice(0, 500)}`);
      process.exit(1);
    }
  } else {
    console.error(`[DailyReview] reviewer reply had no JSON array: ${reply.slice(0, 500)}`);
    process.exit(1);
  }

  // Re-read fresh before writing so we never clobber a worker tick that ran
  // while the review model was thinking.
  const fresh = readQueue();
  const byId = new Map(verdicts.filter((v) => v && v.id).map((v) => [v.id, v]));
  let accepted = 0;
  let reworked = 0;
  for (const t of fresh) {
    const v = byId.get(t.id);
    if (!v) continue;
    if (!t.needsManagerReview || t.managerReview) continue;
    if (v.verdict === "accepted") {
      t.managerReview = {
        at: new Date().toISOString(),
        verdict: "accepted",
        note: String(v.note || "").slice(0, 300),
        reviewer: `${reviewer.provider}/${reviewer.model} (nightly auto)`,
      };
      t.needsManagerReview = false;
      accepted++;
      appendChangelog(`Nightly review: worker ${t.id} "${t.title || t.type}" ACCEPTED by ${reviewer.provider}/${reviewer.model} — ${String(v.note || "").slice(0, 160)}`);
    } else if (v.verdict === "rework") {
      if ((t.retries || 0) < MAX_TASK_RETRIES) {
        t.retries = (t.retries || 0) + 1;
        t.attempts = [...(t.attempts || []), { at: new Date().toISOString(), provider: reviewer.provider, model: reviewer.model, error: `nightly review rework: ${v.note}` }];
        t.feedback = [...(t.feedback || []), String(v.note || "")];
        t.status = "queued";
        t.startedAt = null;
        t.finishedAt = null;
        t.assigned = null;
        t.resultPath = null;
        t.verified = null;
        t.needsManagerReview = true;
        reworked++;
        appendChangelog(`Nightly review: worker ${t.id} "${t.title || t.type}" needs REWORK — re-queued: ${String(v.note || "").slice(0, 160)}`);
      } else {
        t.status = "failed";
        t.error = `nightly review rework after retries exhausted: ${v.note}`;
        t.managerReview = {
          at: new Date().toISOString(),
          verdict: "rework",
          note: String(v.note || "").slice(0, 300),
          reviewer: `${reviewer.provider}/${reviewer.model} (nightly auto)`,
        };
        t.needsManagerReview = false;
        reworked++;
        appendChangelog(`Nightly review: worker ${t.id} "${t.title || t.type}" failed permanently (rework, retries exhausted): ${String(v.note || "").slice(0, 160)}`);
      }
    }
  }
  writeQueue(fresh);
  console.log(`[DailyReview] done: ${accepted} accepted, ${reworked} rework/closed.`);
}

main().catch((e) => {
  console.error(`[DailyReview] fatal: ${e.message}`);
  process.exit(1);
});
