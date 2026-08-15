/**
 * AI Council & Manager — 5-slot multi-model system on OpenAI-compatible providers.
 *
 * Slots (from agent-providers.ts):
 *   manager    → GPT 5.6 Luna (OpenCode Go)
 *   critic     → DeepSeek
 *   architect  → Hyperbolic (hy3)
 *   auditor    → NVIDIA Nemotron
 *   strategist → Groq
 *
 * - `managerChat`: single lead-agent chat (the manager slot).
 * - `runCouncil`: critic + architect + auditor + strategist debate IN PARALLEL,
 *   then the manager synthesizes one decision.
 * - `tuneStrategy`: the four council members debate new values for a running
 *   strategy's MANAGED parameters (locked risk params are read-only), merged via
 *   median, clamped to hard bounds, then auto-applied.
 */

import {
  getAgentSlots,
  chatSlot,
  resolveSlotKey,
  AGENT_ROLES,
  type AgentMessage,
  type AgentPosition,
  type AgentProvider,
} from "./agent-providers";
import { storage } from "./storage";
import {
  MANAGED_PARAM_BOUNDS,
  MANAGED_PARAM_PRESETS,
  MANAGED_PARAM_DESCRIPTIONS,
  clampManaged,
  type ManagedParamKey,
} from "./managed-params";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBitunixClient } from "./bitunix";

export * from "./agent-providers";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CouncilMemberResult {
  position: AgentPosition;
  role: string;
  title: string;
  provider: string;
  model: string;
  ok: boolean;
  content: string | null;
  error?: string;
  ms: number;
}

export interface ManagerReply {
  ok: boolean;
  content: string | null;
  error?: string;
  position: AgentPosition;
  provider: string;
  model: string;
  ms: number;
}

export interface CouncilChatResult {
  mode: "manager" | "council";
  context?: string;
  slots: ReturnType<typeof getAgentSlots>;
  reply?: ManagerReply;
  members?: CouncilMemberResult[];
  synthesis?: CouncilMemberResult;
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

const SHARED_COMMUNICATION = `COMMUNICATION RULES (always):
- Answer the user's actual question first. Do not drag every reply into trading-engine parameter talk.
- Prefer plain English and simple math. Avoid code jargon unless the user asked for code or file paths.
- If something is broken, explain it like a dashboard/gauge/scoreboard problem before naming files.
- Never chant "=0" without saying what number is missing and why that matters in money terms.
- Do not refuse forever. If blocked, state: (1) what is wrong in plain words, (2) what must be fixed first, (3) the next concrete step.
- Trading engines are ONE domain. Other valid domains: product/UI, deployment/VM, council workflow, resource efficiency, documentation, and operator questions.
- Never invent budgets, P&L, prices, or fills. If a number is unknown, say "unknown" and ask one clear question.
- NEVER paste raw file contents, git status/diff output, service logs, build logs, or source code into your reply. Tool output is for your own analysis; the operator only sees your written reply. Summarize findings in short plain English.
- When you have to say what changed, write a short human summary — never dump the diff. Log technical detail to data/changelog.md via log_change instead of posting it in chat.
- Keep replies short. A reply that fits on one screen is best. If you used tools, close with one or two lines on what you did and what to look at.`;

const MANAGER_SYSTEM = `You are the MANAGER / BUILDER of cryvolmon (crypto trading bot + multi-agent council on a VM).

Your job is to decide and explain clearly to a non-coder operator. Coordinate specialists when their reports are present.

${SHARED_COMMUNICATION}

Rules:
- Be concrete and actionable: verdict → why → next steps.
- Never recommend increasing user-locked risk (leverage, capital, ticker).
- Only discuss managed strategy parameters when the user asked about tuning or trading behavior.
- Treat an explicit user command as authorization for that scope, but only execute through a real available tool/endpoint. If none exists, say so plainly.
- Never claim Critic/Architect/Auditor/Strategist were consulted unless their reports are in context. In Manager-only mode, say Council mode is needed for full debate.`;

const CRITIC_SYSTEM = `You are the CRITIC on the cryvolmon council. Find what is wrong or risky — not to be nice, and not to monologue about the trading engine by default.

${SHARED_COMMUNICATION}

Focus on the user's topic. When the topic IS trading risk: attack edge cases, liquidation math, bad assumptions, missing ledgers, and unsafe parameter ideas. Rank CRITICAL > MAJOR > MINOR.

Format:
- ## Verdict (one plain sentence)
- ## Critical Issues (money/risk first, plain English)
- ## Major Issues
- ## Minor Issues
- ## What You Agree With`;

const ARCHITECT_SYSTEM = `You are the ARCHITECT on the cryvolmon council. Design sound structure for whatever the user asked: systems, workflows, UI, deployment, OR trading params — not trading-only by default.

${SHARED_COMMUNICATION}

When the user asks for structure/plans: propose a clear target design and migration steps. When they ask for trading parameters: only then propose concrete managed-parameter values within locked risk bounds.

Format:
- ## Recommendation
- ## Plan (ordered steps)
- ## Trade-offs
- ## What You'd Keep As-Is`;

const AUDITOR_SYSTEM = `You are the AUDITOR on the cryvolmon council. Find dead weight, rot, missing scoreboards, and silent failure — across app, council, deploy, and trading — not only the trading engine.

${SHARED_COMMUNICATION}

Call out missing ledgers, blank budgets, mark=0 gauges, unused code paths, and config drift. Distinguish "safe to fix now" vs "needs a human decision".

Format:
- ## Health Summary (one plain paragraph)
- ## Findings (item | where in plain words | why it matters)
- ## Safe Adjustments
- ## Needs A Human Decision`;

const STRATEGIST_SYSTEM = `You are the STRATEGIST on the cryvolmon council. Give a fast, data-grounded read of the current situation in English and math.

${SHARED_COMMUNICATION}

Summarize account, positions, and strategy cards the operator can understand. Propose parameter changes ONLY if the user asked for tuning and the numbers are trustworthy. If gauges are broken, say that first.

Format:
- ## Read (one paragraph, plain English)
- ## Numbers That Matter (simple list)
- ## Risks I See
- ## What Needs More Data`;

const RESOURCE_MANAGER_SYSTEM = `You are the RESOURCE MANAGER for cryvolmon. Strictly read-only.

${SHARED_COMMUNICATION}

Inspect snapshot, workspace context, archive, logs, and exchange data. Organize facts and point to sources. Never edit files, run commands, change parameters, place orders, or restart services. If information is missing, state exactly what source is needed.`;

const DELEGATION_RULE = `DELEGATION: You have the same edit/build/check tools as the manager. If the MANAGER explicitly delegates a specific write/edit to you, carry it out with your tools and report the exact result. Otherwise do not modify files — propose changes in text and let the manager or a delegated member apply them. Never alter leverage, capital, ticker, exchange order semantics, authentication, or live risk behavior without explicit user confirmation.`;

const ROLE_SYSTEMS: Record<Exclude<AgentPosition, "manager">, string> = {
  critic: CRITIC_SYSTEM,
  architect: ARCHITECT_SYSTEM,
  auditor: AUDITOR_SYSTEM,
  strategist: STRATEGIST_SYSTEM,
  resource_manager: RESOURCE_MANAGER_SYSTEM,
};

const COUNCIL_POSITIONS: Exclude<AgentPosition, "manager">[] = ["critic", "architect", "auditor", "strategist"];
const FREE_AGENT_POOL: { provider: AgentProvider; model: string }[] = [
  { provider: "groq", model: "llama-3.3-70b-versatile" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "cerebras", model: "gpt-oss-120b" },
  { provider: "openrouter", model: "openrouter/free" },
  { provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free" },
  { provider: "openrouter", model: "openai/gpt-oss-20b:free" },
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "openrouter", model: "liquid/lfm-2.5-2.6b:free" },
  { provider: "openrouter", model: "poolside/laguna-s-2.1:free" },
  { provider: "openrouter", model: "inclusionai/ling-3.0-tiny:free" },
  { provider: "deepseek", model: "deepseek-chat" },
  { provider: "hyperbolic", model: "hy3" },
  { provider: "nvidia", model: "openai/gpt-oss-20b" },
  { provider: "nvidia", model: "openai/gpt-oss-120b" },
  { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b" },
  { provider: "ovh", model: "gpt-oss-20b" },
  { provider: "ovh", model: "gpt-oss-120b" },
  { provider: "ovh", model: "Qwen3.5-397B-A17B" },
  { provider: "sambanova", model: "Meta-Llama-3.3-70B-Instruct" },
  { provider: "mistral", model: "mistral-small-4" },
  { provider: "hf", model: "meta-llama/Llama-3.3-70B-Instruct" },
  { provider: "gemini", model: "gemini-3.5-flash" },
  { provider: "opencode", model: "big-pickle" },
];

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RISK_POLICY = `RISK POLICY (applies when discussing trading or parameter changes):
- Leverage, total capital, ticker, and exchange are locked inputs. Never propose increasing or changing them.
- Only propose managed-parameter changes when the user asked for tuning or trading changes.
- Prefer reducing liquidation risk and uncontrolled exposure before chasing more profit.
- If equity/budget/mark data is missing or untrustworthy, do not invent numbers; hold current trading values and explain the scoreboard gap in plain English.
- Review recent Council archive before repeating an earlier proposal.
- A failed provider, missing data, or weak evidence means keep current values. Never guess a parameter change.
- This policy does NOT require every answer to be about trading parameters.`;

const UNCERTAINTY_POLICY = `UNCERTAINTY POLICY:
- Do not force a conclusion to fill silence, satisfy a timeout, or make every specialist agree.
- If required data is missing, stale, contradictory, or the exchange response is ambiguous, stop and ask exactly one targeted question under "## Clarification Needed".
- A clarification request must not recommend a trade, parameter change, or deployment.
- For tuning calls, uncertainty means return {} and let the safety gate hold current values.
- For execution paths, uncertainty means skip/retry safely and record a waiting or blocked decision; never invent a fill, position, PnL, or price.`;

const execFileAsync = promisify(execFile);
const MANAGER_TOOLS = [
  { type: "function" as const, function: { name: "read_file", description: "Read a non-sensitive project file before proposing or applying a change.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function" as const, function: { name: "apply_patch", description: "Replace one exact old text block with new text in a project file. You have full local write permissions on this system — apply the edit directly.", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } } },
  { type: "function" as const, function: { name: "run_check", description: "Run the project's TypeScript check after an edit.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "run_build", description: "Build the project after an edit.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "git_status", description: "Inspect the current repository status without changing files.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "service_logs", description: "Read recent Cryvolmon service logs on the VM.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "restart_service", description: "Restart the deployed Cryvolmon systemd service after a build.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "run_shell", description: "Run an explicit project/VM command as the service user. You have full local permissions — use for build, diagnostics, deployment, and service operations; do not merely print commands when the user asked you to execute them.", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] } } },
  { type: "function" as const, function: { name: "run_sudo", description: "Run an explicit command as root via passwordless sudo (sudo -n). Use for privileged VM operations the service user cannot perform, such as editing /etc/caddy/Caddyfile, installing packages, or managing other system services. Never use for routine project work.", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] } } },
  { type: "function" as const, function: { name: "git_commit", description: "Commit ALL current uncommitted project changes with a short message. Safe to run after an edit passes run_check/run_build. Returns the commit hash.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } },
  { type: "function" as const, function: { name: "log_change", description: "Append a plain-English change-log entry to data/changelog.md describing what was just changed and verified. The operator reads this file to see actual work. One concise line.", parameters: { type: "object", properties: { entry: { type: "string" } }, required: ["entry"] } } },
  { type: "function" as const, function: { name: "mark_job", description: "Record or clear your current active job so it can be resumed after a server restart. Call with status=\"in_progress\" and a short summary when you START a multi-step job, and status=\"done\" when you finish it. The server reads this on startup to wake you up to continue unfinished work.", parameters: { type: "object", properties: { status: { type: "string", enum: ["in_progress", "done"] }, summary: { type: "string" } }, required: ["status"] } } },
];

interface ActiveJobState {
  status: "in_progress" | "done";
  summary: string;
  startedAt: string;
  updatedAt?: string;
  lastTool?: string;
}

const ACTIVE_JOB_FILE = () => join(process.cwd(), "data", "active-job.json");

// Prevent two startup/request recovery loops from working the same job at once.
let interruptedJobResumeInFlight = false;

export function getActiveJob(): ActiveJobState | null {
  try { return JSON.parse(readFileSync(ACTIVE_JOB_FILE(), "utf8")) as ActiveJobState; } catch { return null; }
}

function setActiveJob(state: ActiveJobState): void {
  writeFileSync(ACTIVE_JOB_FILE(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

function recordToolProgress(tool: string): void {
  const job = getActiveJob();
  if (!job || job.status !== "in_progress") return;
  setActiveJob({ ...job, lastTool: tool });
}

/** Read-only external directories the council may inspect but never patch. */
const READONLY_EXTERNAL_ROOTS: string[] = [
  "/home/safin/gridbot", // legacy manager/builder codebase (Claude-authored)
];

function safeToolPath(path: string, { allowExternalRead = false } = {}): string {
  const root = resolve(process.cwd());
  const target = resolve(root, path);
  const relativeTarget = relative(root, target);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    if (allowExternalRead) {
      for (const external of READONLY_EXTERNAL_ROOTS) {
        const externalRoot = resolve(external);
        const relativeExternal = relative(externalRoot, target);
        if (!relativeExternal.startsWith("..") && !isAbsolute(relativeExternal)) return target;
      }
    }
    throw new Error("Path outside project");
  }
  if (path.startsWith(".env") || path.endsWith("auth.json") || path.includes("node_modules")) throw new Error("Sensitive/dependency file blocked");
  return target;
}

async function executeManagerTool(name: string, args: Record<string, unknown>, approved: boolean, allowRestart: boolean = true): Promise<string> {
  recordToolProgress(name);
  if (name === "read_file") {
    const target = safeToolPath(String(args.path || ""), { allowExternalRead: true });
    return readFileSync(target, "utf8").slice(0, 16000);
  }
  if (!approved) return "ACTION_BLOCKED: agent tools are disabled (COUNCIL_AGENT_TOOLS_ENABLED is not \"true\").";
  if (name === "apply_patch") {
    const target = safeToolPath(String(args.path || ""));
    const current = readFileSync(target, "utf8");
    const oldText = String(args.oldText || "");
    if (!oldText || !current.includes(oldText)) return "PATCH_REJECTED: oldText was not found exactly once.";
    if (current.indexOf(oldText) !== current.lastIndexOf(oldText)) return "PATCH_REJECTED: oldText matched more than once.";
    writeFileSync(target, current.replace(oldText, String(args.newText || "")), "utf8");
    return `PATCH_APPLIED: ${args.path}`;
  }
  if (name === "run_check") {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = await execFileAsync(command, ["run", "check"], { cwd: process.cwd(), timeout: 120_000, maxBuffer: 2_000_000 });
    return `${result.stdout}\n${result.stderr}`.slice(-16000);
  }
  if (name === "run_build") {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = await execFileAsync(command, ["run", "build"], { cwd: process.cwd(), timeout: 300_000, maxBuffer: 2_000_000 });
    return `${result.stdout}\n${result.stderr}`.slice(-16000);
  }
  if (name === "git_status") {
    const command = process.platform === "win32" ? "git.exe" : "git";
    const result = await execFileAsync(command, ["status", "--short", "--branch"], { cwd: process.cwd(), timeout: 30_000 });
    return result.stdout;
  }
  if (name === "service_logs") {
    if (process.platform === "win32") return "SERVICE_LOGS_UNAVAILABLE_ON_WINDOWS";
    const result = await execFileAsync("journalctl", ["-u", "cryvolmon", "-n", "80", "--no-pager"], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 2_000_000 });
    return `${result.stdout}\n${result.stderr}`.slice(-16000);
  }
  if (name === "restart_service") {
    if (process.platform === "win32") return "SERVICE_RESTART_UNAVAILABLE_ON_WINDOWS";
    if (!allowRestart) return "SERVICE_ALREADY_RUNNING: the service just restarted (that is why you are running now). Do NOT restart again. Verify the current build is live with service_logs or an HTTP check, then continue to log_change, git_commit, and mark_job done.";
    const result = await execFileAsync("/bin/bash", ["-lc", "sudo -n systemctl restart cryvolmon"], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 500_000 });
    return `${result.stdout}\n${result.stderr}\nSERVICE_RESTARTED`;
  }
  if (name === "run_shell") {
    const command = String(args.command || "").trim();
    if (!command) return "SHELL_REJECTED: command is empty.";
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120_000, 1_000), 300_000);
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
    const shellArgs = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
    const result = await execFileAsync(shell, shellArgs, { cwd: process.cwd(), timeout: timeoutMs, maxBuffer: 2_000_000 });
    return `${result.stdout}\n${result.stderr}`.slice(-16000);
  }
  if (name === "run_sudo") {
    if (process.platform === "win32") return "SUDO_UNAVAILABLE_ON_WINDOWS";
    const command = String(args.command || "").trim();
    if (!command) return "SUDO_REJECTED: command is empty.";
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120_000, 1_000), 300_000);
    const result = await execFileAsync("/bin/bash", ["-lc", `sudo -n ${command}`], { cwd: process.cwd(), timeout: timeoutMs, maxBuffer: 2_000_000 });
    return `${result.stdout}\n${result.stderr}`.slice(-16000);
  }
  if (name === "git_commit") {
    const git = process.platform === "win32" ? "git.exe" : "git";
    const message = String(args.message || "council change").slice(0, 120);
    const identityCommands: Array<[string, string[]]> = [
      [git, ["config", "user.name", "Cryvolmon Manager"]],
      [git, ["config", "user.email", "manager@cryvolmon.local"]],
    ];
    for (const [cmd, cmdArgs] of identityCommands) {
      try { await execFileAsync(cmd, cmdArgs, { cwd: process.cwd(), timeout: 20_000 }); } catch { /* identity already set */ }
    }
    await execFileAsync(git, ["add", "-A"], { cwd: process.cwd(), timeout: 30_000 });
    try {
      const commit = await execFileAsync(git, ["commit", "-m", message], { cwd: process.cwd(), timeout: 30_000 });
      const log = await execFileAsync(git, ["log", "--oneline", "-1"], { cwd: process.cwd(), timeout: 20_000 });
      return `COMMITTED ${log.stdout.trim()}\n${commit.stdout}\n${commit.stderr}`.slice(-4000);
    } catch (error: any) {
      const stderr = String(error?.stderr || error?.message || "");
      if (/nothing to commit|no changes added|nothing added/i.test(stderr)) return "COMMITTED nothing to commit (working tree clean)";
      return `COMMIT_ERROR: ${stderr.slice(-1500)}`;
    }
  }
  if (name === "log_change") {
    const entry = String(args.entry || "").trim().slice(0, 500);
    if (!entry) return "LOG_REJECTED: entry is empty.";
    const changelog = join(process.cwd(), "data", "changelog.md");
    const existing = (() => { try { return readFileSync(changelog, "utf8"); } catch { return ""; } })();
    const line = `- ${new Date().toISOString()} — ${entry.replace(/\s*\n\s*/g, " ")}`;
    const next = existing.trim() ? `${existing.trimEnd()}\n${line}\n` : `# Cryvolmon Change Log\n\n${line}\n`;
    writeFileSync(changelog, next, "utf8");
    return `LOG_APPENDED: data/changelog.md\n${line}`;
  }
  if (name === "mark_job") {
    const status = String(args.status || "");
    if (status === "in_progress") {
      const summary = String(args.summary || "").trim().slice(0, 500) || "unspecified job";
      setActiveJob({ status: "in_progress", summary, startedAt: new Date().toISOString() });
      return `JOB_MARKED_IN_PROGRESS: ${summary}`;
    }
    if (status === "done") {
      setActiveJob({ status: "done", summary: "", startedAt: new Date().toISOString() });
      return "JOB_MARKED_DONE: active job cleared";
    }
    return "JOB_REJECTED: status must be \"in_progress\" or \"done\".";
  }
  return `UNKNOWN_TOOL: ${name}`;
}

const TUNING_SYSTEM = `This is a parameter-tuning call, not a general review. Ignore the role's normal report formatting for this call. Return ONLY one flat JSON object containing numeric proposals for the explicitly listed editable parameters. No Markdown, headings, explanations, or extra keys.`;
const CROSS_TALK_SYSTEM = `This is a machine cross-talk round. Keep the response compact and use exactly these fields:
AGREE: [brief points]
DISAGREE: [brief points]
MISSING: [data needed]
POSITION: [your revised conclusion]
QUESTION: [one question only if blocked]
Do not repeat the full initial report and do not claim another agent took an action.`;

async function askCouncilMember(position: Exclude<AgentPosition, "manager">, messages: ChatTurn[], context: string, system = ROLE_SYSTEMS[position], tuning = false, tools?: typeof MANAGER_TOOLS, executeTool?: (name: string, args: Record<string, unknown>) => Promise<string>) {
  const roleSystem = tuning ? `${system}\n\n${TUNING_SYSTEM}` : system;
  const delegatedSystem = tools ? `${roleSystem}\n\n${DELEGATION_RULE}` : roleSystem;
  const prompt = toAgentMessages(messages, delegatedSystem, context);
  const baseOpts = { timeoutMs: 30_000, maxTokens: 700, ...(tools ? { tools, executeTool } : {}) };
  const primary = await chatSlot(position, prompt, baseOpts);
  if (primary.ok) return primary;

  const errors = [primary.error || "primary provider failed"];
  for (const fallback of FREE_AGENT_POOL) {
    if (fallback.provider === primary.provider && fallback.model === primary.model) continue;
    if (!resolveSlotKey(fallback.provider, null)) continue;
    const result = await chatSlot(position, prompt, {
      providerOverride: fallback.provider,
      modelOverride: fallback.model,
      timeoutMs: 25_000,
      maxTokens: 700,
      ...(tools ? { tools, executeTool } : {}),
    });
    if (result.ok) return result;
    errors.push(`${result.provider}/${result.model}: ${result.error || "failed"}`);
  }
  return { ...primary, error: errors.join(" | ") };
}

// ---------------------------------------------------------------------------
// App context so answers are grounded in the real operation
// ---------------------------------------------------------------------------

const WORKSPACE_OMIT = new Set([".git", "node_modules", "dist", ".cache", ".local"]);
const WORKSPACE_EXCERPTS = [
  "package.json",
  "shared/schema.ts",
  "server/bitunix.ts",
  "server/strategy-engine.ts",
  "server/routes.ts",
  "server/council.ts",
  ".agents/memory/exchange-api-rules.md",
  "client/src/App.tsx",
];

function workspaceFiles(root: string, current = root, out: string[] = []): string[] {
  if (out.length >= 400) return out;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (WORKSPACE_OMIT.has(entry.name) || entry.name === ".env" || entry.name.startsWith(".env.")) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) workspaceFiles(root, absolute, out);
    else out.push(relative(root, absolute).replaceAll("\\", "/"));
  }
  return out;
}

function buildWorkspaceContext(): string {
  try {
    const root = process.cwd();
    const files = workspaceFiles(root).sort();
    const excerpts = WORKSPACE_EXCERPTS.map((file) => {
      try {
        const content = readFileSync(join(root, file), "utf8");
        return `\n--- ${file} (excerpt) ---\n${content.slice(0, 1500)}`;
      } catch {
        return "";
      }
    }).join("\n").slice(0, 10000);
    return [
      "WORKSPACE SOURCE CONTEXT",
      "The repository is mounted for review. Do not claim files are unavailable.",
      `Files (secrets and dependency/build directories omitted): ${files.join(", ")}`,
      excerpts,
      "END WORKSPACE SOURCE CONTEXT",
    ].join("\n");
  } catch {
    return "WORKSPACE SOURCE CONTEXT\n(repository index unavailable)\nEND WORKSPACE SOURCE CONTEXT";
  }
}

function historyRows(raw: any): any[] {
  const candidates = [raw?.data?.orderList, raw?.data?.orders, raw?.data, raw?.orderList, raw?.orders, raw];
  return candidates.find((value) => Array.isArray(value)) || [];
}

async function getExchangeHistoryContext(strategies: Array<{ symbol: string }>): Promise<string[]> {
  const client = getBitunixClient();
  if (!client) return [];
  const symbols = [...new Set(strategies.map((strategy) => strategy.symbol).filter(Boolean))].slice(0, 10);
  const rows: string[] = [];
  for (const symbol of symbols) {
    try {
      const history = historyRows(await client.getOrderHistory(symbol));
      for (const order of history.slice(0, 10)) {
        const status = String(order.status ?? order.orderStatus ?? order.state ?? "?");
        const isFilled = /fill|complete|done|success/i.test(status) || status === "2" || status === "3";
        if (!isFilled) continue;
        rows.push(
          `${symbol} order=${order.orderId ?? order.id ?? "?"} side=${order.side ?? "?"} tradeSide=${order.tradeSide ?? order.positionSide ?? "?"} qty=${order.qty ?? order.volume ?? order.quantity ?? order.dealVolume ?? "?"} price=${order.avgPrice ?? order.avgOpenPrice ?? order.dealPrice ?? order.price ?? "?"} status=${status} time=${order.ctime ?? order.createTime ?? order.updateTime ?? order.time ?? "?"}`,
        );
      }
    } catch {
      // Exchange history is supplementary; a temporary API failure must not block Council responses.
    }
  }
  return rows.slice(0, 30);
}

async function buildAppContext(): Promise<string> {
  const workspace = buildWorkspaceContext();
  const fallback = `CURRENT OPERATION SNAPSHOT:\n(database unavailable)\n\n${workspace}`;
  const inner = (async () => {
    try {
      const [strategies, positions, balances] = await Promise.all([
        storage.getStrategies(),
        storage.getPositions(),
        storage.getAccountBalances(),
      ]);
      const lines: string[] = ["CURRENT OPERATION SNAPSHOT"];
      lines.push(`- Strategies: ${strategies.length} total`);
      for (const s of strategies.slice(0, 25)) {
        const cfg = (s.config || {}) as Record<string, any>;
        const budget = cfg.allocatedBudget ?? cfg.risk?.allocatedBudget;
        const managed = cfg.managed ? ` managed=${JSON.stringify(cfg.managed)}` : "";
        lines.push(
          `  #${s.id} ${s.name} | ${s.type} | ${s.symbol} | ${s.status} | side=${s.side} lev=${cfg.leverage ?? cfg.risk?.leverage ?? "?"} budget=${budget ?? "?"} pnl=${s.totalPnl ?? 0} trades=${s.totalTrades ?? 0}${managed}`,
        );
      }
      if (positions.length > 0) {
        lines.push(`- Open positions: ${positions.length}`);
        for (const p of positions.slice(0, 10)) {
          lines.push(`  ${p.symbol} ${p.side} qty=${p.quantity} entry=${p.entryPrice} mark=${p.markPrice ?? "?"} upnl=${p.unrealizedPnl ?? "?"}`);
        }
      }
      if (balances.length > 0) {
        const total = balances.reduce((a, b) => a + (b.total || 0), 0);
        lines.push(`- Account balance: ${total.toFixed(2)} USDT total across ${balances.length} currency balance(s)`);
      }
      const exchangeHistory = await getExchangeHistoryContext(strategies);
      if (exchangeHistory.length > 0) {
        lines.push("- Recent Bitunix exchange fills (execution source of truth):");
        for (const fill of exchangeHistory) lines.push(`  ${fill}`);
      }
      const archived = await storage.getCouncilMessages(20).catch(() => []);
      if (archived.length > 0) {
        lines.push("- Recent Council archive (review and challenge prior proposals):");
        for (const entry of archived.slice(0, 20)) {
          lines.push(`  [${entry.position}/${entry.role}] ${entry.content.slice(0, 1200)}`);
        }
      }
      lines.push("END SNAPSHOT");
      return `${lines.join("\n")}\n\n${workspace}`;
    } catch {
      return fallback;
    }
  })();
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(fallback), 4000));
  return Promise.race([inner, timeout]);
}

function toAgentMessages(messages: ChatTurn[], system: string, context?: string): AgentMessage[] {
  const out: AgentMessage[] = [];
  if (system) out.push({ role: "system", content: `${system}\n\n${RISK_POLICY}\n\n${UNCERTAINTY_POLICY}` });
  if (context) out.push({ role: "system", content: context });
  for (const m of messages) out.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
  return out;
}

function memberFromReply(reply: { ok: boolean; content: string | null; error?: string; position: AgentPosition; provider: string; model: string; ms: number }): CouncilMemberResult {
  const def = AGENT_ROLES.find((r) => r.position === reply.position)!;
  return {
    position: reply.position,
    role: def.role,
    title: def.title,
    provider: reply.provider,
    model: reply.model,
    ok: reply.ok,
    content: reply.content,
    error: reply.error,
    ms: reply.ms,
  };
}

// ---------------------------------------------------------------------------
// Manager chat
// ---------------------------------------------------------------------------

export async function managerChat(messages: ChatTurn[]): Promise<ManagerReply> {
  const context = await buildAppContext();
  const reply = await chatSlot("manager", toAgentMessages(messages, MANAGER_SYSTEM, context));
  return {
    ok: reply.ok,
    content: reply.content,
    error: reply.error,
    position: reply.position,
    provider: reply.provider,
    model: reply.model,
    ms: reply.ms,
  };
}

export async function managerChatWithTools(messages: ChatTurn[], approvalToken?: string, opts: { allowRestart?: boolean } = {}): Promise<ManagerReply> {
  const approved = process.env.COUNCIL_AGENT_TOOLS_ENABLED !== "false";
  const allowRestart = opts.allowRestart !== false;
  const context = await buildAppContext();
  const autonomous = process.env.COUNCIL_AUTONOMOUS_PATCHES !== "false";
  const system = `${MANAGER_SYSTEM}\n\nAutonomous Manager tools are enabled by the server and you have full local read/write/execute permissions on this system, including passwordless sudo (run_sudo) for privileged VM operations. Do not ask the user for a token or claim that tools are unavailable. When the user explicitly asks you to inspect, edit, build, deploy, or change the project, execute the work with the available tools instead of only printing code or commands. The UI is source code in client/src; inspect it with read_file when the user asks about visible controls or behavior. Use run_sudo for system-level files like /etc/caddy/Caddyfile or other services; when you change such a file, reload the service to make it live. You may DELEGATE write/edit work to individual council members by instructing them to apply the change — members share the same patch/build/check tools, so a delegated member can make the edit directly. You decide whether to apply a patch yourself or hand it to a member; no quorum vote is required. Never alter leverage, capital, ticker, exchange order semantics, authentication, or live risk behavior without explicit user confirmation. If a tool rejects an action, report the exact tool result and stop.

EXECUTION WORKFLOW (follow for every concrete build/fix/deploy request):
1. Start: call mark_job with status "in_progress" and a one-line summary of the job. This lets the server wake you to continue after a restart.
2. Inspect: read_file / git_status to see current state.
3. Edit: apply_patch for each change. Apply the change yourself — do not only describe it.
4. Verify: run_check, then run_build.
5. If anything failed, fix it with apply_patch and re-verify. Do not report success until run_build passes.
6. If the change is server-side or affects the running app, restart_service, then confirm with service_logs or a live HTTP check.
7. Record: log_change with one plain-English line, then git_commit with a short message.
8. Finish: call mark_job with status "done".
9. Reply to the operator in short plain English: what you changed (in words, not diff), verification result, and the commit hash. Never paste raw tool output.

AUTONOMOUS_PATCH_MODE=${autonomous ? "ENABLED" : "DISABLED"}`;
  let reply = await chatSlot("manager", toAgentMessages(messages, system, context), {
    tools: MANAGER_TOOLS,
    executeTool: (name, args) => executeManagerTool(name, args, approved, allowRestart),
  });
  // The provider can finish tool execution without emitting the final text turn.
  // Give it one explicit completion turn here, while the request is still alive,
  // instead of returning the generic "ask the manager" message to the operator.
  if (reply.ok && (!reply.content || !reply.content.trim()) && getActiveJob()?.status === "in_progress") {
    reply = await chatSlot("manager", toAgentMessages(messages, system, context), {
      tools: MANAGER_TOOLS,
      executeTool: (name, args) => executeManagerTool(name, args, approved, allowRestart),
      requestMessages: [
        ...toAgentMessages(messages, system, context),
        { role: "user", content: "Complete the current job now. If all work is finished, call mark_job done and then provide a short plain-English final summary. Do not stop after tool calls." },
      ],
      timeoutMs: 60_000,
      nudged: true,
    });
  }
  const activeJob = getActiveJob();
  if (activeJob?.status === "in_progress" && (!reply.ok || !reply.content?.trim())) {
    console.warn(`[Council] Manager ended without a final reply; job remains resumable after ${activeJob.lastTool || "unknown tool"}.`);
  }
  return {
    ok: reply.ok,
    content: reply.content,
    error: reply.error,
    position: reply.position,
    provider: reply.provider,
    model: reply.model,
    ms: reply.ms,
  };
}

/**
 * Called on server startup. If the manager left an in-progress job in
 * data/active-job.json (e.g. the service was restarted mid-build), wake the
 * manager to inspect the change log and git state and continue the job.
 * Runs in the background so server startup is never blocked.
 */
export async function resumeInterruptedJob(): Promise<void> {
  if (interruptedJobResumeInFlight) return;
  interruptedJobResumeInFlight = true;
  try {
    const job = getActiveJob();
    if (!job || job.status !== "in_progress" || !job.summary) return;
    if (process.env.COUNCIL_RESUME_ON_START === "false") return;
    console.log(`[Council] Resuming interrupted job after restart: ${job.summary}`);
    await pause(5000);
    const context = await buildAppContext();
    const prompt: ChatTurn[] = [
      {
        role: "user",
        content: `The server restarted while you were working. Your last in-progress job (started ${job.startedAt}) was: ${job.summary}\n\nInspect the current state: read the latest lines of data/changelog.md, run git_status to see uncommitted work, and check what remains unfinished. Then CONTINUE the job to completion following the EXECUTION WORKFLOW (inspect → edit → verify → build → log_change → git_commit). IMPORTANT: the service is already running fresh right now — that is why you are running. Do NOT call restart_service or restart the service yourself; instead confirm the current build is live with service_logs or an HTTP check, then continue. When finished, call mark_job with status "done" and reply in short plain English what you completed. If the job turns out to be already finished or no longer relevant, call mark_job with status "done" and say so in one line. Never paste raw tool output into your reply.`,
      },
    ];
    const reply = await managerChatWithTools(prompt, undefined, { allowRestart: false });
    if (reply?.content) {
      try {
        await storage.createCouncilMessage({
          sessionId: "default",
          mode: "manager",
          position: "manager",
          role: "assistant",
          provider: reply.provider,
          model: reply.model,
          content: reply.content,
          metadata: { resumed: true, job: job.summary },
        });
        console.log(`[Council] Resume reply archived (job: ${job.summary})`);
      } catch (e: any) {
        console.warn(`[Council] Failed to archive resume reply: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.warn(`[Council] resumeInterruptedJob failed: ${e.message}`);
  }
}

export async function agentChat(position: AgentPosition, messages: ChatTurn[]): Promise<ManagerReply> {
  const context = await buildAppContext();
  const system = position === "manager" ? MANAGER_SYSTEM : ROLE_SYSTEMS[position];
  const reply = await chatSlot(position, toAgentMessages(messages, system, context));
  return {
    ok: reply.ok,
    content: reply.content,
    error: reply.error,
    position: reply.position,
    provider: reply.provider,
    model: reply.model,
    ms: reply.ms,
  };
}

// ---------------------------------------------------------------------------
// Full council
// ---------------------------------------------------------------------------

export async function runCouncil(messages: ChatTurn[]): Promise<CouncilChatResult> {
  const context = await buildAppContext();
  const approved = process.env.COUNCIL_AGENT_TOOLS_ENABLED !== "false";
  const memberTools = approved
    ? {
        tools: MANAGER_TOOLS,
        executeTool: (name: string, args: Record<string, unknown>) => executeManagerTool(name, args, approved),
      }
    : undefined;

  const memberReplies = [];
  for (const [index, position] of COUNCIL_POSITIONS.entries()) {
    if (index > 0) await pause(1500);
    memberReplies.push(await askCouncilMember(position, messages, context, undefined, false, memberTools?.tools, memberTools?.executeTool));
  }
  const members = memberReplies.map(memberFromReply);

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = lastUser?.content ?? "";
  const reports = members
    .map((m) => `### ${m.title} (${m.provider}/${m.model})\n${m.ok ? m.content : `ERROR: ${m.error}`}`)
    .join("\n\n");

  const crossTalkPrompt: ChatTurn[] = [
    ...messages,
    {
      role: "user",
      content: `MACHINE CROSS-TALK ROUND. Initial reports from all specialists:\n${reports}\n\nReview the other positions and respond using the compact cross-talk fields. Challenge unsupported claims, retain useful points, and state your revised position. If the manager has delegated a specific write/edit to you in the thread, execute it with your tools instead of only describing it.`,
    },
  ];
  const crossTalkReplies = [];
  for (const [index, position] of COUNCIL_POSITIONS.entries()) {
    if (index > 0) await pause(1500);
    crossTalkReplies.push(await askCouncilMember(position, crossTalkPrompt, context, CROSS_TALK_SYSTEM, false, memberTools?.tools, memberTools?.executeTool));
  }
  const crossTalk = crossTalkReplies.map(memberFromReply);
  const crossTalkReports = crossTalk
    .map((m) => `### ${m.title} (${m.provider}/${m.model})\n${m.ok ? m.content : `ERROR: ${m.error}`}`)
    .join("\n\n");

  const synthesisPrompt: ChatTurn[] = [
    {
      role: "user",
      content: `The user asked: ${question}\n\nThe specialists produced initial reports and then cross-talked in a compact machine round. INITIAL REPORTS:\n${reports}\n\nCROSS-TALK ROUND:\n${crossTalkReports}\n\nIf the user explicitly asked you to build, edit, fix, clean up, or deploy something, EXECUTE it now with your tools instead of only writing a plan. EXECUTION WORKFLOW: (0) mark_job in_progress with a one-line summary, (1) read_file/git_status to inspect, (2) apply_patch to make each edit yourself, (3) run_check then run_build, (4) if it fails fix it and re-verify until build passes, (5) if server-side restart_service and confirm with service_logs or a live check, (6) log_change one plain-English line then git_commit a short message, (7) mark_job done. Apply concrete edits directly — do not only describe them. Never leave the change half-done: report the finished state.\n\nThen reply to the operator in SHORT PLAIN ENGLISH — a few sentences: what you changed (in words), verification result, and the commit hash. NEVER paste file contents, diffs, git status, build logs, or tool output into your reply.\n\nIf the user did NOT ask for concrete work and the reports lack enough reliable data or contain unresolved contradictions, ask exactly one question instead using:\n- ## Clarification Needed\n- [one targeted question]\nDo not recommend an action in that case. Otherwise use:\n- ## Recommendation (1-3 sentences)\n- ## Plan (ordered, actionable)\n- ## Disagreements (what the members disagreed on and your resolution)\n- ## What We're NOT Doing`,
    },
  ];
  const synthesis = await chatSlot("manager", toAgentMessages(synthesisPrompt, MANAGER_SYSTEM, context), {
    tools: memberTools?.tools,
    executeTool: memberTools?.executeTool,
  });

  return {
    mode: "council",
    context,
    slots: getAgentSlots(),
    members: crossTalk,
    synthesis: memberFromReply({ ...synthesis, position: "manager", provider: synthesis.provider, model: synthesis.model }),
  };
}

// ---------------------------------------------------------------------------
// Strategy parameter tuning
// ---------------------------------------------------------------------------

export interface TuneResult {
  strategyId: number;
  symbol: string;
  status: string;
  configApplied: boolean;
  before: Record<string, number>;
  merged: Record<string, number>;
  proposals: Record<string, number[]>[];
  bounds: Record<string, [number, number]>;
  members: CouncilMemberResult[];
  notes: string[];
}

function extractJsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  const re = /\{[\s\S]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      out.push(JSON.parse(m[0]));
    } catch {
      // unbalanced brace inside text — skip this candidate
    }
  }
  return out;
}

function currentManaged(config: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(MANAGED_PARAM_PRESETS)) {
    const raw = config.managed?.[key] ?? config[key] ?? MANAGED_PARAM_PRESETS[key as ManagedParamKey];
    const num = typeof raw === "number" ? raw : Number(raw);
    out[key] = Number.isFinite(num) ? clampManaged(key, num) : MANAGED_PARAM_PRESETS[key as ManagedParamKey];
  }
  return out;
}

export async function tuneStrategy(strategyId: number): Promise<TuneResult> {
  const strategy = await storage.getStrategy(strategyId);
  if (!strategy) throw new Error("Strategy not found");
  if (strategy.type !== "grid" && strategy.type !== "tandem") {
    throw new Error("Council tuning is currently available for grid and Tandem strategies only");
  }

  const cfg = (strategy.config || {}) as Record<string, any>;
  const tandemChildIds = strategy.type === "tandem"
    ? [cfg.longGridId, cfg.shortGridId].filter((id): id is number => typeof id === "number")
    : [];
  const childStrategies = await Promise.all(tandemChildIds.map((id) => storage.getStrategy(id)));
  const tuningConfig = strategy.type === "tandem"
    ? ((childStrategies.find(Boolean)?.config || {}) as Record<string, any>)
    : cfg;
  const tandemBounds: Record<string, [number, number]> = { longWeight: [1, 10], shortWeight: [1, 10] };
  const tunableBounds: Record<string, [number, number]> = strategy.type === "tandem"
    ? { ...MANAGED_PARAM_BOUNDS, ...tandemBounds }
    : MANAGED_PARAM_BOUNDS;
  const clampWeight = (value: unknown) => Math.min(10, Math.max(1, Number(value) || 1));
  const clampTunable = (key: string, value: number) => {
    const bounds = tunableBounds[key];
    if (!bounds) return value;
    return Math.min(bounds[1], Math.max(bounds[0], value));
  };
  const before: Record<string, number> = {
    ...currentManaged(tuningConfig),
    ...(strategy.type === "tandem" ? {
      longWeight: clampWeight(cfg.managed?.longWeight ?? cfg.longWeight),
      shortWeight: clampWeight(cfg.managed?.shortWeight ?? cfg.shortWeight),
    } : {}),
  };
  const locked = {
    type: strategy.type,
    name: strategy.name,
    symbol: strategy.symbol,
    side: strategy.side,
    leverage: cfg.leverage ?? cfg.risk?.leverage ?? null,
    allocatedBudget: cfg.allocatedBudget ?? cfg.risk?.allocatedBudget ?? null,
    totalPnl: strategy.totalPnl ?? 0,
    totalTrades: strategy.totalTrades ?? 0,
    ...(strategy.type === "tandem" ? {
      totalCapital: cfg.totalCapital ?? null,
      longGridId: cfg.longGridId ?? null,
      shortGridId: cfg.shortGridId ?? null,
    } : {}),
  };
  const reviewIds = [strategyId, ...tandemChildIds];
  const recentTrades = (await Promise.all(reviewIds.map((id) => storage.getTradeLogs(id, 10).catch(() => []))))
    .flat()
    .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))
    .slice(0, 20);
  const recentResults = recentTrades.length === 0
    ? "(no recent trade records)"
    : recentTrades.map((trade) =>
      `${trade.createdAt?.toISOString() ?? "?"} ${trade.side} ${trade.orderType} qty=${trade.quantity} price=${trade.price ?? "?"} status=${trade.status} pnl=${trade.pnl ?? "?"}`,
    ).join("\n");

  const task = `A running ${strategy.type === "tandem" ? "Tandem long/short strategy and its two child grids" : "grid strategy"} needs a parameter review. Here is the CURRENT managed parameter set (with acceptable bounds):\n
 ${Object.keys(tunableBounds)
   .map((k) => {
     const description = MANAGED_PARAM_DESCRIPTIONS[k as ManagedParamKey]
       || (k === "longWeight" ? "Tandem target LONG allocation weight; changes live rebalance target and order-sizing bias." : "Tandem target SHORT allocation weight; changes live rebalance target and order-sizing bias.");
     return `- ${k} = ${before[k]} (bounds: ${tunableBounds[k][0]}..${tunableBounds[k][1]}) — ${description}`;
   })
   .join("\n")}\n
USER-LOCKED RISK (never propose changing these): ${JSON.stringify(locked)}

RECENT RESULTS (newest first):
${recentResults}

 Debate new values for these MANAGED parameters based on the current operation and market logic. These are the ONLY editable parameters. Prefer the current value and return it unchanged unless recent exchange evidence supports a meaningful improvement. Reply with ONLY a JSON object mapping any keys you propose to numbers, e.g. {"feeMultiplier": 3.0, "tpReservePct": 0.12, "trailingTpPct": 0.006, "gridSizeMultiplier": 1.05, "initialSharePct": 0.28}. Do not invent keys or propose locked values. Values must stay within the stated bounds.`;

  const context = await buildAppContext();
  const memberReplies = [];
  for (const [index, position] of COUNCIL_POSITIONS.entries()) {
    if (index > 0) await pause(1500);
    memberReplies.push(await askCouncilMember(position, [{ role: "user", content: task }], context, ROLE_SYSTEMS[position], true));
  }
  const members = memberReplies.map(memberFromReply);

  const proposals: Record<string, number[]>[] = [];
  const notes: string[] = [];
  for (const member of members) {
    const objs = member.ok && member.content ? extractJsonObjects(member.content) : [];
    const merged = objs
      .flatMap((o) => (typeof o === "object" && o !== null ? [o as Record<string, unknown>] : []))
      .reduce<Record<string, unknown>>((acc, o) => ({ ...acc, ...o }), {});
    const numeric: Record<string, number[]> = {};
    for (const key of Object.keys(tunableBounds)) {
      const v = merged[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        numeric[key] = [tandemBounds[key] ? clampWeight(v) : clampTunable(key, v)];
      }
    }
    proposals.push(numeric);
    if (Object.keys(numeric).length === 0) {
      notes.push(`${member.title}: no valid proposal (${member.error || "unparseable output"})`);
    }
  }

  const merged: Record<string, number> = { ...before };
  const minimumChange: Record<string, number> = {
    feeMultiplier: 0.25,
    tpReservePct: 0.02,
    trailingTpPct: 0.001,
    gridSizeMultiplier: 0.05,
    initialSharePct: 0.02,
    longWeight: 0.5,
    shortWeight: 0.5,
  };
  const supportedChanges: { key: string; value: number; support: number }[] = [];
  for (const key of Object.keys(tunableBounds)) {
    const values = proposals.map((p) => p[key]?.[0]).filter((v): v is number => typeof v === "number");
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const tolerance = Math.max((tunableBounds[key][1] - tunableBounds[key][0]) * 0.05, 0.0001);
    const support = values.filter((proposal) => Math.abs(proposal - value) <= tolerance).length;
    if (support >= 2 && Math.abs(value - before[key]) >= (minimumChange[key] || 0)) {
      supportedChanges.push({ key, value: clampTunable(key, value), support });
    }
  }

  const validProposalCount = proposals.filter((proposal) => Object.keys(proposal).length > 0).length;
  const approvedChanges = validProposalCount >= 3
    ? supportedChanges.sort((a, b) => b.support - a.support)
    : [];
  for (const change of approvedChanges) merged[change.key] = change.value;
  const changed = approvedChanges.map((change) => change.key);
  const configApplied = changed.length > 0;
  if (validProposalCount < 3) {
    notes.push(`No changes applied: conservative quorum requires 3 valid specialist proposals, received ${validProposalCount}.`);
  } else if (changed.length === 0) {
    notes.push("No meaningful consensus change passed the stability threshold; current values were held.");
  }
  if (changed.length > 0) {
    if (strategy.type === "tandem") {
      const childManaged = Object.fromEntries(Object.keys(MANAGED_PARAM_BOUNDS).map((key) => [key, merged[key]]));
      for (const child of childStrategies) {
        if (!child) continue;
        await storage.updateStrategy(child.id, {
          config: { ...(child.config || {}), managed: childManaged },
        });
      }
    }
    const next = { ...cfg, managed: merged, risk: { ...locked } };
    await storage.updateStrategy(strategy.id, { config: next });
    notes.push(`Applied ${changed.length} param change(s): ${changed.map((k) => `${k}=${merged[k]}`).join(", ")}`);
  } else {
    notes.push("No parameter changes proposed — current values kept.");
  }

  return {
    strategyId: strategy.id,
    symbol: strategy.symbol,
    status: strategy.status,
    configApplied,
    before,
    merged,
    proposals,
    bounds: tunableBounds,
    members,
    notes,
  };
}

export async function resetManagedParams(strategyId: number): Promise<{ strategyId: number; reset: Record<string, number> }> {
  const strategy = await storage.getStrategy(strategyId);
  if (!strategy) throw new Error("Strategy not found");
  const cfg = (strategy.config || {}) as Record<string, any>;
  const reset = { ...MANAGED_PARAM_PRESETS };
  await storage.updateStrategy(strategy.id, { config: { ...cfg, managed: reset } });
  return { strategyId, reset };
}
