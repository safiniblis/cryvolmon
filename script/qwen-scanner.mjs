#!/usr/bin/env node
/**
 * QWEN — the always-on code auditor.
 *
 * Runs 24/7 in the background, slowly walking the whole codebase and using the
 * local qwen3:4b to flag WEIRD things and SUSPECTED BUGS that a script cannot
 * judge: race conditions, resource leaks, error-handling gaps, dead paths,
 * contradictory logic. Findings accumulate in data/qwen-findings.md for the
 * operator to review. Everything else is throttled and cheap:
 *   - one small file per cycle (default every ~4 min) -> a full pass over the
 *     repo every day or two, always re-scanning changed files first
 *   - a file is never re-scanned unless its content hash changed
 *   - only "OK" verdicts or real findings are recorded; nothing is acted on.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, relative } from "node:path";
import { createHash } from "node:crypto";

try {
  const envPath = "/etc/cryvolmon.env";
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
} catch (e) {
  console.warn(`[Qwen] could not read /etc/cryvolmon.env: ${e.message}`);
}

const SCAN_ROOT = process.env.QWEN_SCAN_ROOT || resolve(process.cwd());
const STATE_PATH = process.env.QWEN_SCAN_STATE || resolve(process.cwd(), "data", "qwen-scan-state.json");
const FINDINGS_PATH = process.env.QWEN_SCAN_FINDINGS || resolve(process.cwd(), "data", "qwen-findings.md");
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

const POLL_MS = Number(process.env.QWEN_SCAN_POLL_MS || 240_000);
const MAX_LINES = Number(process.env.QWEN_SCAN_MAX_LINES || 900);
const SCAN_TIMEOUT = Number(process.env.QWEN_SCAN_TIMEOUT || 8 * 60_000);
const FILES_PER_CYCLE = Number(process.env.QWEN_SCAN_FILES_PER_CYCLE || 1);
const MAX_FINDINGS_PER_FILE = 5;
const RETRY_ATTEMPTS = Number(process.env.QWEN_SCAN_RETRY_ATTEMPTS || 3);
const RETRY_BACKOFF_MS = Number(process.env.QWEN_SCAN_RETRY_BACKOFF_MS || 30_000);

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "data", ".git", "attached_assets", ".agents"]);

const sha1 = (s) => createHash("sha1").update(s).digest("hex");

function collectFiles(dir, root = SCAN_ROOT) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      out.push(...collectFiles(full, root));
    } else if (ent.isFile() && CODE_EXTS.has(extname(ent.name))) {
      out.push({ full, rel: relative(root, full).split("\\").join("/"), mtimeMs: statSync(full).mtimeMs });
    }
  }
  return out;
}

function readState() {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (e) {}
  return { files: {}, recent: [] };
}
function writeState(state) {
  try {
    mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn(`[Qwen] state write failed: ${e.message}`);
  }
}

function ensureFindingsFile() {
  if (!existsSync(FINDINGS_PATH)) {
    try {
      mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
      appendFileSync(FINDINGS_PATH, `# Qwen Code Findings\n\nSuspected bugs / weird code found by the always-on local auditor.\n\n`);
    } catch (e) {
      console.warn(`[Qwen] findings init failed: ${e.message}`);
    }
  }
}

function stripThinking(text) {
  let t = text;
  let prev = null;
  while (t !== prev) {
    prev = t;
    t = t.replace(/<think>[\s\S]*?<\/think>/g, " ").trim();
  }
  return t.trim();
}

async function auditFile(rel, code) {
  const prompt = [
    `You are a conservative code auditor for a crypto trading system. Analyze the code below and flag ONLY suspicious things a reviewer should look at: likely bugs, race conditions, resource leaks, missing error handling, wrong or contradictory logic, dead paths, security issues. Ignore style, formatting, and naming.`,
    `File: ${rel}`,
    `\`\`\`ts`,
    code,
    `\`\`\``,
    `If nothing is worth flagging, reply exactly: OK`,
    `Otherwise reply with up to ${MAX_FINDINGS_PER_FILE} bullet findings, each starting with "- [line] description (severity: low/med/high)". Do not invent issues.`,
  ].join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({
        model: "qwen3:4b",
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0.2, num_predict: 700 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const data = await res.json();
    return stripThinking(data.message?.content || "") || "OK";
  } catch (e) {
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function scanOne(file) {
  const { full, rel } = file;
  const content = readFileSync(full, "utf8");
  const hash = sha1(content);
  const state = readState();
  const prev = state.files[rel];
  if (prev && prev.hash === hash) return { rel, unchanged: true };

  const lines = content.split(/\r?\n/);
  const truncated = lines.length > MAX_LINES;
  const code = lines.slice(0, MAX_LINES).join("\n");
  const started = Date.now();

  let reply;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      reply = await auditFile(rel, code);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_ATTEMPTS) {
        console.log(`[Qwen] scan ${rel} transient error (${e.message}) — retry ${attempt}/${RETRY_ATTEMPTS - 1}`);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
  }
  if (lastErr) {
    console.warn(`[Qwen] scan ${rel} failed after ${RETRY_ATTEMPTS} attempts: ${lastErr.message}`);
    return { rel, error: lastErr.message };
  }
  const ms = Date.now() - started;

  state.files[rel] = { hash, scannedAt: new Date().toISOString() };
  writeState(state);

  if (/^\s*ok\b/i.test(reply.trim())) {
    console.log(`[Qwen] scan ${rel}: clean (${ms / 1000}s)`);
    return { rel, clean: true, ms };
  }

  const findings = reply
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s*\[?\d*\s*\]?\s*\S/.test(l) && !/^[-*]\s*ok\b/i.test(l))
    .slice(0, MAX_FINDINGS_PER_FILE);

  if (findings.length === 0) {
    console.log(`[Qwen] scan ${rel}: reply not OK but no bullet findings parsed (${ms / 1000}s)`);
    return { rel, clean: true, ms, note: reply.slice(0, 80) };
  }

  const now = new Date().toISOString();
  const rows = findings.map((f) => {
    const key = `${rel}::${f.replace(/[^a-z0-9]/gi, "").slice(0, 40)}`;
    if (state.recent.includes(key)) return null;
    state.recent.push(key);
    return `- ${now} — ${rel} — ${f}${truncated ? " (file truncated to first " + MAX_LINES + " lines)" : ""}`;
  });
  if (state.recent.length > 400) state.recent = state.recent.slice(-400);
  writeState(state);

  const newRows = rows.filter(Boolean);
  if (newRows.length > 0) {
    ensureFindingsFile();
    appendFileSync(FINDINGS_PATH, newRows.join("\n") + "\n");
    appendFileSync(resolve(process.cwd(), "data", "changelog.md"), `\n- ${now} — Qwen code audit flagged ${newRows.length} suspect${newRows.length === 1 ? "" : "s"} in ${rel}.`);
  }
  console.log(`[Qwen] scan ${rel}: ${findings.length} suspect${findings.length === 1 ? "" : "s"} (${ms / 1000}s)`);
  return { rel, findings: findings.length, new: newRows.length, ms };
}

async function main() {
  console.log(`[Qwen] code auditor started — root ${SCAN_ROOT}, poll ${POLL_MS / 1000}s, up to ${FILES_PER_CYCLE} file(s)/cycle, max ${MAX_LINES} lines/file.`);
  let allScannedLoggedAt = 0;
  while (true) {
    try {
      const files = collectFiles(SCAN_ROOT);
      const state = readState();
      const pending = files
        .filter((f) => {
          const prev = state.files[f.rel];
          let content;
          try {
            content = readFileSync(f.full, "utf8");
          } catch {
            return false;
          }
          return !prev || prev.hash !== sha1(content);
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));

      if (pending.length === 0) {
        if (Date.now() - allScannedLoggedAt > 60 * 60_000) {
          console.log(`[Qwen] no pending files (${files.length} tracked) — idle.`);
          allScannedLoggedAt = Date.now();
        }
      } else {
        allScannedLoggedAt = 0;
        for (const f of pending.slice(0, FILES_PER_CYCLE)) {
          await scanOne(f);
        }
      }
    } catch (e) {
      console.warn(`[Qwen] cycle error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(`[Qwen] fatal: ${e.message}`);
  process.exit(1);
});
