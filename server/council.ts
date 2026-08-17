/**
 * AI Council & Manager — 5-slot multi-model pipeline on OpenAI-compatible providers.
 *
 * Slots (from agent-providers.ts):
 *   manager    → GPT 5.6 Luna (OpenCode Go, paid)
 *   architect  → DeepSeek Chat
 *   builder    → Hyperbolic (hy3)
 *   auditor    → NVIDIA Nemotron
 *   trader     → Groq
 *
 * - `managerChat` / `managerChatWithTools`: interactive lead-agent chat.
 * - `runPipeline`: the role-chain assembly line. Manager writes the job order →
 *   architect devises a build plan → manager approves it → builder implements
 *   and verifies → auditor APPROVE/REJECT → manager final review → reboot after
 *   approval. Rejections loop back to the architect until the loop budget is
 *   spent (then the job is marked blocked).
 * - `tuneStrategy`: the pipeline members debate new values for a running
 *   strategy's MANAGED parameters (locked risk params are read-only), merged via
 *   median, clamped to hard bounds, then auto-applied.
 * - The trader seat starts completed strategies and reads the market/account
 *   state (autonomous open/close is a future upgrade).
 */

import {
  getAgentSlots,
  getSlot,
  chatSlot,
  resolveSlotKey,
  AGENT_ROLES,
  AGENT_POSITIONS,
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
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBitunixClient } from "./bitunix";
import { placeInitialGridBuy, startStrategyEngine } from "./strategy-engine";
import { priceFeed } from "./ws-price-feed";

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

const MANAGER_SYSTEM = `You are the MANAGER of cryvolmon (crypto trading bot + agent pipeline on a VM).

Your job is to decide and explain clearly to a non-coder operator. You are the gatekeeper of the build pipeline: you write the job order, approve the architect's build plan before any code is written, and run the FINAL review after the auditor has approved — only then do you reboot the service.

${SHARED_COMMUNICATION}

Rules:
- Be concrete and actionable: verdict → why → next steps.
- Never recommend increasing user-locked risk (leverage, capital, ticker).
- Only discuss managed strategy parameters when the user asked about tuning or trading behavior.
- Treat an explicit user command as authorization for that scope, but only execute through a real available tool/endpoint. If none exists, say so plainly.
- Never claim Architect/Builder/Auditor/Trader were consulted unless their artifacts are in context. In Manager-only mode, say the pipeline is needed for the full build chain.

WORKER QUEUE:
- When the operator hands you open-ended or background work that does NOT require your interactive tools — reports, summaries, research, analysis, extraction, monitoring notes, drafting — convert it into an ACTIONABLE PLAN/ORDER and enqueue it with queue_worker_task. Write a fully self-contained prompt (the worker model has NO file access: include every fact, number, file excerpt, and output format it needs). Choose a fitting type and set maxOutputTokens to match the deliverable.
- The foreman (a reasoning model) reads the plan, assigns it to the best worker model — local qwen for summarization/extraction, gpt-oss-class for reasoning/code — and fast-checks the finished result. Tell the operator the task was queued (with its id) and that results land in data/worker-results.
- When PENDING WORKER REVIEWS appear in your context, the foreman already accepted them; the nightly roll (21:30 UTC) batches and clears them automatically with the free review stack, so you do NOT have to chase them. Call evaluate_worker_task anyway only when the operator explicitly asks for a live/immediate review of a specific task. For routine work the nightly batch is enough.
- Break big asks into SEVERAL focused tasks rather than one bloated prompt.
- Interactive code changes, deploys, and risk edits stay in your direct tools — do not queue those.`;

const ARCHITECT_SYSTEM = `You are the ARCHITECT in the cryvolmon build pipeline. You DESIGN — you do NOT modify files.

${SHARED_COMMUNICATION}

Your job: turn the MANAGER's job order into a BUILD PLAN the builder can execute directly. The plan must name the exact files and interfaces to touch, the tests/checks to run, and the risks to watch. Trading parameters belong in the plan only when the order explicitly asks for them — and never propose increasing locked risk (leverage, capital, ticker, exchange order semantics).

Format (use exactly these headings):
- ## Recommendation
- ## Build Plan (ordered steps: file → exact change → why)
- ## Verification (run_check / run_build / what to look at)
- ## Risks
- ## What We Keep As-Is`;

const BUILDER_SYSTEM = `You are the BUILDER in the cryvolmon build pipeline. You IMPLEMENT the approved build plan.

${SHARED_COMMUNICATION}

You have full local read/write/execute permissions. Apply each change from the plan with apply_patch, then verify with run_check and run_build. Fix anything that fails and re-verify until the build passes — never report success while the build is red. When the plan is fully implemented, commit with git_commit and log the change with log_change. Do NOT restart the service (the manager reboots after the audit). Never alter leverage, capital, ticker, exchange order semantics, authentication, or live risk behavior without explicit user confirmation.

Format (use exactly these headings):
- ## What I Built (short plain English)
- ## Verification Result
- ## Commit`;

const AUDITOR_SYSTEM = `You are the AUDITOR in the cryvolmon build pipeline. You verify the builder's work against the approved build plan. You have read + check + build + logs tools — NO write tools. You never patch files.

${SHARED_COMMUNICATION}

Run run_check and run_build yourself, read the changed files, and compare the implementation to the plan. Check for silent failures, dead weight, and anything that breaks the locked risk rules. End your reply with EXACTLY one verdict line:
- APPROVE
- REJECT: <the single most important blocker, one plain-English sentence>

Format (use exactly these headings):
- ## Verdict (APPROVE or REJECT: ...)
- ## Findings (item | where | why it matters)
- ## Plan Compliance (what matches / what drifted)
- ## Safe Adjustments
- ## Needs A Human Decision`;

const TRADER_SYSTEM = `You are the TRADER in the cryvolmon pipeline. Your current scope is STARTING completed strategies and reading the market/account state.

${SHARED_COMMUNICATION}

- Review stopped or newly created strategies with list_strategies. When a strategy is fully configured and safe to launch, start it with start_strategy.
- Read the operation snapshot and give a fast, data-grounded read in English and math. Propose managed-parameter changes ONLY if the user asked for tuning and the numbers are trustworthy.
- You do NOT open or close live positions yet (that capability is coming). Never claim a fill, position, PnL, or price you did not observe.
- Never alter leverage, capital, ticker, or exchange order semantics.

Format (use exactly these headings):
- ## Read (one paragraph, plain English)
- ## Strategies I Started / Could Start
- ## Numbers That Matter
- ## Risks I See`;

const DELEGATION_RULE = `DELEGATION: The pipeline passes an artifact (job order, build plan, audit) from one seat to the next; each seat only does its own stage. The BUILDER is the only seat that modifies files. The ARCHITECT designs, the AUDITOR verifies, the TRADER starts strategies, and the MANAGER gates each hand-off and reboots after the final review. Never alter leverage, capital, ticker, exchange order semantics, authentication, or live risk behavior without explicit user confirmation.`;

const ROLE_SYSTEMS: Record<Exclude<AgentPosition, "manager">, string> = {
  architect: ARCHITECT_SYSTEM,
  builder: BUILDER_SYSTEM,
  auditor: AUDITOR_SYSTEM,
  trader: TRADER_SYSTEM,
};

const PIPELINE_POSITIONS: Exclude<AgentPosition, "manager">[] = ["architect", "builder", "auditor", "trader"];
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
const MAX_TASK_RETRIES = Number(process.env.WORKER_MAX_TASK_RETRIES || 2);
const MANAGER_TOOLS = [
  { type: "function" as const, function: { name: "read_file", description: "Read a non-sensitive project file before proposing or applying a change.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function" as const, function: { name: "apply_patch", description: "Replace one exact old text block with new text in a project file. You have full local write permissions on this system — apply the edit directly.", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } } },
  { type: "function" as const, function: { name: "run_check", description: "Run the project's TypeScript check after an edit.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "run_build", description: "Build the project after an edit.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "git_status", description: "Inspect the current repository status without changing files.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "service_logs", description: "Read recent Cryvolmon service logs on the VM.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "restart_service", description: "Queue a restart of the deployed Cryvolmon systemd service. The restart fires automatically AFTER you deliver your final reply, so finish log_change, git_commit, and mark_job done before replying.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "run_shell", description: "Run an explicit project/VM command as the service user. You have full local permissions — use for build, diagnostics, deployment, and service operations; do not merely print commands when the user asked you to execute them.", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] } } },
  { type: "function" as const, function: { name: "run_sudo", description: "Run an explicit command as root via passwordless sudo (sudo -n). Use for privileged VM operations the service user cannot perform, such as editing /etc/caddy/Caddyfile, installing packages, or managing other system services. Never use for routine project work.", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] } } },
  { type: "function" as const, function: { name: "git_commit", description: "Commit ALL current uncommitted project changes with a short message. Safe to run after an edit passes run_check/run_build. Returns the commit hash.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } },
  { type: "function" as const, function: { name: "log_change", description: "Append a plain-English change-log entry to data/changelog.md describing what was just changed and verified. The operator reads this file to see actual work. One concise line.", parameters: { type: "object", properties: { entry: { type: "string" } }, required: ["entry"] } } },
  { type: "function" as const, function: { name: "mark_job", description: "Record or clear your current active job so it can be resumed after a server restart. Call with status=\"in_progress\" and a short summary when you START a multi-step job, and status=\"done\" when you finish it. The server reads this on startup to wake you up to continue unfinished work.", parameters: { type: "object", properties: { status: { type: "string", enum: ["in_progress", "done"] }, summary: { type: "string" } }, required: ["status"] } } },
  { type: "function" as const, function: { name: "remember", description: "Save a short plain-English note to the council's persistent memory (data/council-memory.json) about something just learned or decided that future sessions should NOT have to re-derive: what was done, why, and any gotcha. One concise line. Injected into every later query, so it is read repeatedly — keep it small.", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } } },
  { type: "function" as const, function: { name: "queue_worker_task", description: "Turn an open-ended request into an actionable PLAN/ORDER and enqueue it for the background worker system. The foreman (a reasoning model) will read it and assign it to the best worker model (local qwen for summarization/extraction/classification, gpt-oss-class for reasoning/code). Use for background work like reports, summaries, research, analysis, and extraction. The worker has NO file access — the prompt MUST be fully self-contained (include all facts, numbers, and the exact output format).", parameters: { type: "object", properties: { title: { type: "string", description: "Short task title" }, type: { type: "string", enum: ["report", "summary", "analysis", "research", "review", "extract", "draft", "generic"] }, prompt: { type: "string", description: "Fully self-contained worker instructions" }, maxOutputTokens: { type: "number", description: "Upper bound on the worker's output tokens (default 2048; use ~1200 for concise reports, more for long drafts)" }, priority: { type: "number", description: "0-10; lower runs first (default 5)" }, review: { type: "string", enum: ["manager", "none"], description: "manager (default) = you give the final evaluation when it completes; none = the free foreman acceptance is final (use for routine work)" } }, required: ["title", "prompt"] } } },
  { type: "function" as const, function: { name: "evaluate_worker_task", description: "Give the FINAL evaluation of a completed background worker task that the foreman already accepted. Pending tasks appear under PENDING WORKER REVIEWS in your context (each lists its id). Verdict \"accepted\" closes it; verdict \"rework\" sends it back through the foreman/worker with your feedback.", parameters: { type: "object", properties: { id: { type: "string", description: "The worker task id (the [id] shown in PENDING WORKER REVIEWS)" }, verdict: { type: "string", enum: ["accepted", "rework"] }, note: { type: "string", description: "One short sentence: why you accepted it, or exactly what must change for rework" } }, required: ["id", "verdict", "note"] } } },
  { type: "function" as const, function: { name: "list_strategies", description: "List all strategies with id, name, type, symbol, side, status, leverage, and budget. Use before starting a strategy so you only launch a fully configured one.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "start_strategy", description: "Start a fully configured, currently stopped strategy. Sets status running, places the initial grid buy when needed, subscribes price feed for tandem, and starts the strategy engine. Returns the launch result.", parameters: { type: "object", properties: { id: { type: "number", description: "The strategy id to start" } }, required: ["id"] } } },
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

// When the manager calls restart_service, do NOT restart mid-turn (that would
// kill the process and lose log_change/git_commit/mark_job done). Queue it and
// fire it only after the final reply has been produced.
let queuedRestart = false;

function isServiceRestartCommand(command: string): boolean {
  return /\b(systemctl|service)\b/.test(command) &&
         /\b(restart|stop|start|reload)\b/.test(command) &&
         /cryvolmon/.test(command);
}

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

// ---------------------------------------------------------------------------
// Episodic memory: the manager writes back a short "what I did / why" note on
// job completion. It is injected into every subsequent council query so agents
// do not re-derive history each time (cheaper + more focused on the task).
// ---------------------------------------------------------------------------

const MEMORY_FILE = () => join(process.cwd(), "data", "council-memory.json");
const MEMORY_LIMIT = 40;
const MEMORY_INJECT_COUNT = 12;

interface MemoryEntry {
  at: string;
  text: string;
}

function readMemoryEntries(): MemoryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(MEMORY_FILE(), "utf8")) as { entries?: MemoryEntry[] };
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

function appendMemoryEntry(note: string): void {
  const text = note.replace(/\s*\n\s*/g, " ").trim().slice(0, 240);
  if (!text) return;
  const entries = [...readMemoryEntries(), { at: new Date().toISOString(), text }];
  try {
    writeFileSync(MEMORY_FILE(), JSON.stringify({ updatedAt: new Date().toISOString(), entries: entries.slice(-MEMORY_LIMIT) }, null, 2), "utf8");
  } catch (e: any) {
    console.warn(`[Council] Could not write memory: ${e.message}`);
  }
}

function memoryContext(): string {
  const entries = readMemoryEntries().slice(-MEMORY_INJECT_COUNT);
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `- ${entry.at.slice(0, 16)} — ${entry.text}`);
  return `COUNCIL MEMORY (past decisions — do not re-derive; question only if clearly stale):\n${lines.join("\n")}\nEND COUNCIL MEMORY`;
}

// ---------------------------------------------------------------------------
// Persistent manager conversation log. File-based (no DB dependency) so the
// manager always gets its recent exchanges with the operator — across browser
// refreshes and sessions — and does not re-derive what was already discussed.
// ---------------------------------------------------------------------------

const CONVERSATION_FILE = () => join(process.cwd(), "data", "council-conversation.json");
const CONVERSATION_LIMIT = 80;
const CONVERSATION_INJECT = 12;

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
  at: string;
  meta?: { provider?: string; model?: string; position?: string };
}

export function appendCouncilConversation(entry: Omit<ConversationEntry, "at">): void {
  try {
    let existing: ConversationEntry[] = [];
    try {
      const raw = JSON.parse(readFileSync(CONVERSATION_FILE(), "utf8")) as { entries?: ConversationEntry[] };
      existing = Array.isArray(raw?.entries) ? raw.entries : [];
    } catch { /* first write */ }
    const entries = [...existing, { ...entry, at: new Date().toISOString() }];
    writeFileSync(CONVERSATION_FILE(), JSON.stringify({ updatedAt: new Date().toISOString(), entries: entries.slice(-CONVERSATION_LIMIT) }, null, 2), "utf8");
  } catch (e: any) {
    console.warn(`[Council] Could not write conversation: ${e.message}`);
  }
}

function conversationContext(): string {
  try {
    const raw = JSON.parse(readFileSync(CONVERSATION_FILE(), "utf8")) as { entries?: ConversationEntry[] };
    const entries = (Array.isArray(raw?.entries) ? raw.entries : []).slice(-CONVERSATION_INJECT);
    if (entries.length === 0) return "";
    const lines = entries.map((e) => `[${e.role}] ${e.content.replace(/\s*\n\s*/g, " ").slice(0, 600)}`);
    return `RECENT CONVERSATION WITH THE OPERATOR (past exchanges across sessions — use this as your working memory instead of re-deriving what the operator already told you):\n${lines.join("\n")}\nEND RECENT CONVERSATION`;
  } catch {
    return "";
  }
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
    queuedRestart = true;
    return "SERVICE_RESTART_QUEUED: the restart is deferred until after you deliver your final reply, so nothing you write now is lost. Finish log_change, git_commit, and mark_job done, then reply — the service restarts automatically right after your reply.";
  }
  if (name === "run_shell") {
    const command = String(args.command || "").trim();
    if (!command) return "SHELL_REJECTED: command is empty.";
    if (isServiceRestartCommand(command)) return "SHELL_REJECTED: restarting/stopping the cryvolmon service here would kill this session mid-job. Use the restart_service tool instead.";
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
    if (isServiceRestartCommand(command)) return "SUDO_REJECTED: restarting/stopping the cryvolmon service here would kill this session mid-job. Use the restart_service tool instead.";
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
  if (name === "remember") {
    const note = String(args.note || "").trim();
    if (!note) return "REMEMBER_REJECTED: note is empty.";
    appendMemoryEntry(note);
    return "MEMORY_SAVED: data/council-memory.json (will be injected into future queries)";
  }
  if (name === "queue_worker_task") {
    const title = String(args.title || "").trim().slice(0, 200);
    const type = String(args.type || "generic").slice(0, 50);
    const prompt = String(args.prompt || "").trim();
    if (!title || !prompt) return "QUEUE_REJECTED: title and prompt are required. The worker has NO file access — the prompt must be fully self-contained.";
    const queuePath = join(process.cwd(), "data", "worker-tasks.json");
    const tasks = (() => {
      try {
        const raw = JSON.parse(readFileSync(queuePath, "utf8")) as { tasks?: unknown[] };
        return Array.isArray(raw?.tasks) ? raw.tasks : [];
      } catch {
        return [];
      }
    })();
    const task = {
      id: `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: title || type,
      type,
      prompt,
      maxOutputTokens: Number(args.maxOutputTokens) > 0 ? Number(args.maxOutputTokens) : undefined,
      priority: Number(args.priority) >= 0 ? Number(args.priority) : undefined,
      review: args.review === "none" ? "none" : "manager",
      status: "queued",
      createdAt: new Date().toISOString(),
      assigned: null,
      resultPath: null,
      error: null,
    };
    tasks.push(task);
    writeFileSync(queuePath, JSON.stringify({ updatedAt: new Date().toISOString(), tasks }, null, 2), { mode: 0o600 });
    return `QUEUED_WORKER_TASK ${task.id}: "${title}" (type ${type}, priority ${task.priority ?? 5}). The worker timer picks it up within minutes; the foreman assigns the best model. Result will land in data/worker-results/${task.id}.md.`;
  }
  if (name === "evaluate_worker_task") {
    const id = String(args.id || "").trim();
    const verdict = String(args.verdict || "");
    const note = String(args.note || "").trim().slice(0, 300);
    if (!id || !["accepted", "rework"].includes(verdict)) return "EVALUATE_REJECTED: id and verdict (accepted|rework) are required.";
    const queuePath = join(process.cwd(), "data", "worker-tasks.json");
    let tasks: any[] = [];
    try {
      const raw = JSON.parse(readFileSync(queuePath, "utf8")) as { tasks?: any[] };
      tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
    } catch {
      return `EVALUATE_ERROR: could not read ${queuePath}`;
    }
    const task = tasks.find((t) => t.id === id);
    if (!task) return `EVALUATE_ERROR: no worker task with id ${id}.`;
    task.managerReview = { at: new Date().toISOString(), verdict, note };
    task.needsManagerReview = false;
    let logLine = `Manager ${verdict} worker task ${id} "${task.title || task.type}" (${note})`;
    if (verdict === "rework") {
      if ((task.retries || 0) < MAX_TASK_RETRIES) {
        task.attempts = [...(task.attempts || []), { at: new Date().toISOString(), provider: "manager", error: `manager rework: ${note}` }];
        task.feedback = [...(task.feedback || []), note];
        task.retries = (task.retries || 0) + 1;
        task.status = "queued";
        task.startedAt = null;
        task.finishedAt = null;
        task.assigned = null;
        task.resultPath = null;
        task.verified = null;
        task.error = null;
        logLine += ` — sent back through foreman/worker for rework with actionable feedback (attempt ${task.retries}/${MAX_TASK_RETRIES}).`;
      } else {
        logLine += ` — rework requested but retry budget exhausted; keeping result for operator review.`;
      }
    }
    writeFileSync(queuePath, JSON.stringify({ updatedAt: new Date().toISOString(), tasks }, null, 2), { mode: 0o600 });
    try {
      const changelog = join(process.cwd(), "data", "changelog.md");
      const existing = readFileSync(changelog, "utf8");
      writeFileSync(changelog, `${existing.trimEnd()}\n- ${new Date().toISOString()} — ${logLine}\n`, "utf8");
    } catch {}
    return `EVALUATED_WORKER_TASK ${id}: ${logLine}`;
  }
  if (name === "list_strategies") {
    try {
      const strategies = await storage.getStrategies();
      if (strategies.length === 0) return "NO_STRATEGIES: the account has no strategies yet.";
      return strategies.slice(0, 40).map((s) => {
        const cfg = (s.config || {}) as Record<string, any>;
        const budget = cfg.allocatedBudget ?? cfg.risk?.allocatedBudget ?? "?";
        const leverage = cfg.leverage ?? cfg.risk?.leverage ?? "?";
        return `#${s.id} ${s.name} | ${s.type} | ${s.symbol} | side=${s.side} | ${s.status} | lev=${leverage} budget=${budget} pnl=${s.totalPnl ?? 0} trades=${s.totalTrades ?? 0}`;
      }).join("\n");
    } catch (e: any) {
      return `LIST_ERROR: ${e.message}`;
    }
  }
  if (name === "start_strategy") {
    return startStrategyById(Number(args.id));
  }
  return `UNKNOWN_TOOL: ${name}`;
}

export async function startStrategyById(id: number): Promise<string> {
  if (!Number.isInteger(id) || id <= 0) return "START_REJECTED: id must be a positive integer.";
  const client = getBitunixClient();
  if (!client) return "START_REJECTED: Bitunix API keys are not configured. Add them first.";
  const strategy = await storage.getStrategy(id);
  if (!strategy) return `START_REJECTED: strategy #${id} not found.`;
  if (strategy.status === "running") return `START_SKIPPED: strategy #${id} (${strategy.name}) is already running.`;
  if (strategy.status === "error") return `START_REJECTED: strategy #${id} (${strategy.name}) is in error state — resolve the error before starting.`;
  try {
    const updated = await storage.updateStrategy(id, { status: "running" });
    let initialBuy: unknown = null;
    const config = (strategy.config || {}) as Record<string, any>;
    if (strategy.type === "grid" && !config.initialBuyDone) {
      initialBuy = await placeInitialGridBuy({ ...strategy, status: "running" });
    }
    if (strategy.type === "tandem") {
      priceFeed.subscribe(strategy.symbol);
    }
    startStrategyEngine();
    const status = (updated as { status?: string })?.status || "running";
    return `STRATEGY_STARTED #${id} ${strategy.name} (${strategy.symbol}, ${strategy.type}) → ${status}${initialBuy ? " — initial buy placed" : ""}. The engine is running.`;
  } catch (e: any) {
    return `START_ERROR: ${e.message}`;
  }
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
  const memory = memoryContext();
  const conversation = conversationContext();
  const fallback = `CURRENT OPERATION SNAPSHOT:\n(database unavailable)\n\n${workspace}\n\n${memory}\n\n${conversation}`;
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
          lines.push(`  [${entry.position}/${entry.role}] ${entry.content.slice(0, 700)}`);
        }
      }
      // Completed worker tasks awaiting the manager's FINAL evaluation.
      try {
        const raw = JSON.parse(readFileSync(join(process.cwd(), "data", "worker-tasks.json"), "utf8")) as { tasks?: any[] };
        const pending = (raw?.tasks || []).filter((t) => t.needsManagerReview === true && t.status === "done").slice(-8);
        if (pending.length > 0) {
          lines.push("- PENDING WORKER REVIEWS (foreman accepted these; your FINAL evaluation is due — call evaluate_worker_task for each):");
          for (const t of pending) {
            let preview = "";
            if (t.resultPath) {
              try {
                preview = readFileSync(t.resultPath, "utf8").replace(/\s*\n\s*/g, " ").slice(0, 600);
              } catch {}
            }
            lines.push(`  [${t.id}] "${t.title}" (type ${t.type}, ran on ${t.assigned?.provider}/${t.assigned?.model}, foreman: ${t.verified?.note || "accepted"}) ${preview.slice(0, 400)}`);
          }
        }
      } catch {}
      lines.push("END SNAPSHOT");
      return `${lines.join("\n")}\n\n${workspace}\n\n${memory}\n\n${conversation}`;
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
  const system = `${MANAGER_SYSTEM}\n\nAutonomous Manager tools are enabled by the server and you have full local read/write/execute permissions on this system, including passwordless sudo (run_sudo) for privileged VM operations. Do not ask the user for a token or claim that tools are unavailable. When the user explicitly asks you to inspect, edit, build, deploy, or change the project, execute the work with the available tools instead of only printing code or commands. The UI is source code in client/src; inspect it with read_file when the user asks about visible controls or behavior. Use run_sudo for system-level files like /etc/caddy/Caddyfile or other services; when you change such a file, reload the service to make it live. For the full build chain you may dispatch the pipeline (architect → builder → auditor → final gate) by running a pipeline job; you decide whether to apply a patch yourself or hand it to the pipeline. Never alter leverage, capital, ticker, exchange order semantics, authentication, or live risk behavior without explicit user confirmation. If a tool rejects an action, report the exact tool result and stop.

EXECUTION WORKFLOW (follow for every concrete build/fix/deploy request):
1. Start: call mark_job with status "in_progress" and a one-line summary of the job. This lets the server wake you to continue after a restart.
2. Inspect: read_file / git_status to see current state.
3. Edit: apply_patch for each change. Apply the change yourself — do not only describe it.
4. Verify: run_check, then run_build.
5. If anything failed, fix it with apply_patch and re-verify. Do not report success until run_build passes.
6. If the change is server-side or affects the running app, call restart_service — the restart is QUEUED and fires automatically right after your final reply, so you do NOT lose your closing steps. Then finish the remaining steps before replying; the service restarts itself once you reply.
7. Record: log_change with one plain-English line, then git_commit with a short message.
8. Remember: call remember once with a concise note (what was done, why, and any gotcha) so future sessions do not re-derive it.
9. Finish: call mark_job with status "done".
10. Reply to the operator in short plain English: what you changed (in words, not diff), verification result, and the commit hash. Never paste raw tool output.

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
  if (activeJob?.status === "in_progress" && reply.ok && reply.content?.trim()) {
    setActiveJob({ status: "done", summary: "", startedAt: new Date().toISOString() });
    console.log(`[Council] Manager delivered a final reply; auto-completed job (was ${activeJob.lastTool || "unknown tool"}).`);
  }
  if (queuedRestart) {
    scheduleDeferredRestart();
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
 * Fire the queued cryvolmon service restart AFTER the current turn has finished
 * producing its final reply (so log_change / git_commit / mark_job done are not
 * lost). Used by both the interactive manager chat and the pipeline's final gate.
 */
function scheduleDeferredRestart(): void {
  queuedRestart = false;
  const RESTART_STATUS_FILE = () => join(process.cwd(), "data", "restart-status.json");
  const writeRestartStatus = (status: { state: string; at: string; error?: string }) => {
    try {
      writeFileSync(RESTART_STATUS_FILE(), JSON.stringify(status, null, 2), "utf8");
    } catch (e: any) {
      console.warn(`[Council] Could not persist restart status: ${e.message}`);
    }
  };
  setTimeout(() => {
    execFileAsync("/bin/bash", ["-lc", "sudo -n systemctl restart cryvolmon"], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 500_000 })
      .then(() => {
        const msg = "[Council] Deferred service restart fired after reply.";
        console.log(msg);
        writeRestartStatus({ state: "ok", at: new Date().toISOString() });
      })
      .catch((e: any) => {
        const msg = `[Council] Deferred restart FAILED after reply: ${e.message}`;
        console.error(msg);
        writeRestartStatus({ state: "failed", at: new Date().toISOString(), error: String(e?.message || e) });
        try {
          const changelog = join(process.cwd(), "data", "changelog.md");
          const existing = readFileSync(changelog, "utf8");
          writeFileSync(changelog, `${existing.trimEnd()}\n- ${new Date().toISOString()} — ❌ restart_service deferred restart FAILED: ${String(e?.message || e).slice(0, 300)}\n`, "utf8");
        } catch {
          // Changelog write is best-effort.
        }
      });
  }, 3000);
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
    // Pipeline workers have tighter provider TPM limits than the Manager.
    // Keep the handoff context compact so provider failures are not mistaken for plan defects.
    const context = (await buildAppContext()).slice(0, 12000);
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
// Seat validation probes
// ---------------------------------------------------------------------------

export interface SeatProbeResult {
  position: AgentPosition;
  ok: boolean;
  provider: string;
  model: string;
  ms: number;
  error?: string | null;
}

const probeInFlight = new Set<AgentPosition>();

/**
 * Lightweight health/latency probe for one seat. A single tiny completion with a
 * short timeout — cheap on every provider (including the free tiers) so it can
 * be run on demand or on boot without tripping rate limits.
 */
export async function probeSeat(position: AgentPosition): Promise<SeatProbeResult> {
  const slot = getSlot(position);
  const base = { position, provider: slot.provider, model: slot.model };
  if (probeInFlight.has(position)) {
    return { ...base, ok: false, ms: 0, error: "probe already in flight" };
  }
  probeInFlight.add(position);
  try {
    const reply = await chatSlot(position, [
      { role: "system", content: "Reply with exactly one word and nothing else." },
      { role: "user", content: "Confirm you are online." },
    ], { maxTokens: 256, timeoutMs: 45_000 });
    return {
      ...base,
      ok: reply.ok,
      provider: reply.provider,
      model: reply.model,
      ms: reply.ms,
      error: reply.error ?? null,
    };
  } catch (e: any) {
    return { ...base, ok: false, ms: 0, error: String(e?.message || e) };
  } finally {
    probeInFlight.delete(position);
  }
}

/**
 * Probe every seat sequentially (low concurrency by design so the free tiers are
 * never hit with a burst). Skips any seat that is currently in flight elsewhere.
 */
export async function probeAllSeats(positions: AgentPosition[] = AGENT_POSITIONS): Promise<SeatProbeResult[]> {
  const results: SeatProbeResult[] = [];
  for (const position of positions) {
    results.push(await probeSeat(position));
    await pause(800);
  }
  return results;
}


// ---------------------------------------------------------------------------
// Build pipeline — role-chain assembly line
//
//   order → architect → manager-plan → builder → auditor → manager-final → done
//
// Every hand-off is a file artifact (data/pipeline-artifacts/<id>-<stage>.md) and
// the whole run is persisted to data/pipeline-state.json after every transition,
// so a crash/reboot resumes at the exact stage. Rejections loop back to the
// architect with the feedback attached, until the loop budget is spent.
// ---------------------------------------------------------------------------

export type PipelineStage =
  | "order"
  | "architect"
  | "manager-plan"
  | "builder"
  | "auditor"
  | "manager-final"
  | "done"
  | "blocked";

export interface PipelineStep {
  stage: PipelineStage;
  position: string;
  at: string;
  summary: string;
  artifact?: string;
}

export interface PipelineState {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  stage: PipelineStage;
  loop: number;
  maxLoop: number;
  status: "running" | "approved" | "blocked" | "failed";
  summary: string;
  recoveryCount?: number;
  managerOrder?: string;
  buildPlan?: string;
  planFeedback?: string;
  auditReport?: string;
  finalReport?: string;
  history: PipelineStep[];
}

const PIPELINE_STATE_FILE = () => join(process.cwd(), "data", "pipeline-state.json");
const PIPELINE_ARTIFACT_DIR = () => join(process.cwd(), "data", "pipeline-artifacts");

// Single in-memory copy of the pipeline state, shared by the background runner
// and the API routes. Cancel must be visible to runPipeline immediately, so the
// runner and cancelPipeline operate on the same object instead of racing file
// reads/writes of separate copies.
let pipelineState: PipelineState | null = null;

export function getPipelineState(): PipelineState | null {
  if (pipelineState) return pipelineState;
  try {
    pipelineState = JSON.parse(readFileSync(PIPELINE_STATE_FILE(), "utf8")) as PipelineState;
  } catch {
    pipelineState = null;
  }
  return pipelineState;
}

function setPipelineState(state: PipelineState): void {
  pipelineState = state;
  try {
    writeFileSync(PIPELINE_STATE_FILE(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (e: any) {
    console.warn(`[Pipeline] Could not persist state: ${e.message}`);
  }
}

function writeArtifact(state: PipelineState, stage: PipelineStage, position: string, content: string): string {
  try {
    mkdirSync(PIPELINE_ARTIFACT_DIR(), { recursive: true });
  } catch {
    // directory may already exist
  }
  const file = join(PIPELINE_ARTIFACT_DIR(), `${state.id}-${stage}.md`);
  try {
    writeFileSync(file, content, "utf8");
  } catch (e: any) {
    console.warn(`[Pipeline] Could not write artifact: ${e.message}`);
  }
  return `data/pipeline-artifacts/${state.id}-${stage}.md`;
}

const TOOL_NAMES = (t: { function: { name: string } }) => t.function.name;
const PIPELINE_READ_TOOLS = MANAGER_TOOLS.filter((t) => ["read_file", "git_status", "service_logs", "list_strategies"].includes(TOOL_NAMES(t)));
const PIPELINE_ARCHITECT_TOOLS = PIPELINE_READ_TOOLS;
const PIPELINE_BUILDER_TOOLS = MANAGER_TOOLS.filter((t) =>
  ["read_file", "apply_patch", "run_check", "run_build", "git_status", "git_commit", "log_change", "remember", "list_strategies"].includes(TOOL_NAMES(t)),
);
const PIPELINE_AUDITOR_TOOLS = MANAGER_TOOLS.filter((t) =>
  ["read_file", "git_status", "run_check", "run_build", "service_logs", "list_strategies"].includes(TOOL_NAMES(t)),
);
const PIPELINE_MANAGER_TOOLS = MANAGER_TOOLS;
const PIPELINE_TRADER_TOOLS = MANAGER_TOOLS.filter((t) =>
  ["read_file", "git_status", "service_logs", "list_strategies", "start_strategy", "log_change", "remember"].includes(TOOL_NAMES(t)),
);

const STAGE_POSITION: Record<PipelineStage, AgentPosition> = {
  order: "manager",
  architect: "architect",
  "manager-plan": "manager",
  builder: "builder",
  auditor: "auditor",
  "manager-final": "manager",
  done: "manager",
  blocked: "manager",
};

let pipelineInFlight = false;

// Set by cancelPipeline; honored by the runner between stages and in pushStep so
// a cancellation can never be overwritten by an in-flight step's write. Reset at
// the top of every runPipeline invocation.
let pipelineCancelled = false;

export async function runPipeline(jobId: string): Promise<void> {
  if (pipelineInFlight) return;
  pipelineInFlight = true;
  pipelineCancelled = false;
  try {
    const context = (await buildAppContext()).slice(0, 12000);
    const approved = process.env.COUNCIL_AGENT_TOOLS_ENABLED !== "false";
    const exec = (allowRestart: boolean) => (name: string, args: Record<string, unknown>) =>
      executeManagerTool(name, args, approved, allowRestart);

    const memberCall = (position: Exclude<AgentPosition, "manager">, prompt: ChatTurn[], tools: typeof MANAGER_TOOLS) =>
      chatSlot(position, toAgentMessages(prompt, ROLE_SYSTEMS[position], context), {
        tools,
        executeTool: exec(false),
        timeoutMs: 150_000,
        maxTokens: 1600,
      });

    const managerCall = (prompt: ChatTurn[], allowRestart: boolean) =>
      chatSlot("manager", toAgentMessages(prompt, MANAGER_SYSTEM, context), {
        tools: PIPELINE_MANAGER_TOOLS,
        executeTool: exec(allowRestart),
        timeoutMs: 150_000,
        maxTokens: 1600,
      });

    let state = getPipelineState();
    if (!state || state.id !== jobId || state.status !== "running") return;

    while (state.status === "running") {
      if (pipelineCancelled) return;
      // Re-fetch the live state each iteration so the runner always works on the
      // current state object instead of a stale copy.
      state = getPipelineState()!;
      if (!state || state.id !== jobId || state.status !== "running") return;

      const stage = state.stage;
      const step: PipelineStep = {
        stage,
        position: STAGE_POSITION[stage],
        at: new Date().toISOString(),
        summary: "",
      };
      const pushStep = () => {
        if (pipelineCancelled) return; // operator abort — keep the cancelled state on disk
        const s = state;
        if (!s) return;
        s.history.push({ ...step, at: new Date().toISOString() });
        setPipelineState(s);
      };

      switch (stage) {
        case "order": {
          const reply = await managerCall([{
            role: "user",
            content: `The operator gave this request:\n\n"${state.goal}"\n\nTurn it into a concrete JOB ORDER for the build pipeline. Reply with exactly these headings and nothing else:\n## GOAL\n## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)\n## ACCEPTANCE CRITERIA (how we know the job is done AND running)\n## FILES-TO-TOUCH (your best guess of the files involved)\nKeep it tight and concrete.`,
          }], false);
          const content = reply.ok && reply.content ? reply.content : `JOB_ORDER_ERROR: ${reply.error || "no response"}`;
          state.managerOrder = content;
          state.summary = state.goal;
          step.summary = content.replace(/\s*\n\s*/g, " ").slice(0, 300);
          step.artifact = writeArtifact(state, "order", "manager", content);
          state.stage = "architect";
          pushStep();
          break;
        }
        case "architect": {
          const feedback = state.planFeedback ? `The previous review sent this back with feedback — revise the plan to address it:\n${state.planFeedback}\n\n` : "";
          const reply = await memberCall("architect", [{
            role: "user",
            content: `Here is the MANAGER's job order:\n\n${state.managerOrder || state.goal}\n\n${feedback}Devise a BUILD PLAN the builder can execute directly. Read any relevant files first with read_file. Reply with exactly these headings:\n## Recommendation\n## Build Plan (ordered steps: file → exact change → why)\n## Verification\n## Risks\n## What We Keep As-Is\nDo NOT modify any files — this stage is design only.`,
          }], PIPELINE_ARCHITECT_TOOLS);
          const content = reply.ok && reply.content ? reply.content : `BUILD_PLAN_ERROR: ${reply.error || "no response"}`;
          state.buildPlan = content;
          state.planFeedback = undefined;
          step.summary = content.replace(/\s*\n\s*/g, " ").slice(0, 300);
          step.artifact = writeArtifact(state, "architect", "architect", content);
          state.stage = "manager-plan";
          pushStep();
          break;
        }
        case "manager-plan": {
          if (state.buildPlan?.startsWith("BUILD_PLAN_ERROR") && (state.recoveryCount || 0) < 2) {
            const recovery = await managerCall([{
              role: "user",
              content: `The Architect stage failed before producing a plan:\n\n${state.buildPlan}\n\nDo not ask the Architect to retry blindly. Inspect the live provider/seat configuration and service logs with your tools, identify the failure, repair the provider or prompt-size/configuration issue yourself, and verify the repair. Do not change trading risk, exchange semantics, or strategy parameters. End with RECOVERY_FIXED or RECOVERY_BLOCKED: <reason>.`,
            }], false);
            const recoveryContent = recovery.ok && recovery.content ? recovery.content.trim() : `RECOVERY_BLOCKED: ${recovery.error || "no response"}`;
            state.recoveryCount = (state.recoveryCount || 0) + 1;
            step.summary = recoveryContent.replace(/\s*\n\s*/g, " ").slice(0, 300);
            step.artifact = writeArtifact(state, "manager-plan", "manager-recovery", recoveryContent);
            if (/^RECOVERY_BLOCKED\s*:/i.test(recoveryContent)) {
              state.status = "blocked";
              state.stage = "blocked";
              state.summary = recoveryContent.replace(/^RECOVERY_BLOCKED\s*:\s*/i, "").trim();
            } else {
              state.stage = "architect";
              state.planFeedback = undefined;
            }
            pushStep();
            break;
          }
          const reply = await managerCall([{
            role: "user",
            content: `Review the ARCHITECT's build plan:\n\n${state.buildPlan}\n\nIf it is acceptable for the builder to execute, reply EXACTLY with the single line:\nAPPROVE_PLAN\n\nIf it needs changes, reply EXACTLY with one line starting with:\nREVISE_PLAN: <specific, actionable feedback>\n\nDo not modify any files in this step.`,
          }], false);
          const content = reply.ok && reply.content ? reply.content.trim() : `PLAN_REVIEW_ERROR: ${reply.error || "no response"}`;
          step.summary = content.replace(/\s*\n\s*/g, " ").slice(0, 300);
          step.artifact = writeArtifact(state, "manager-plan", "manager", content);
          if (/^REVISE_PLAN\s*:/i.test(content)) {
            state.planFeedback = content.replace(/^REVISE_PLAN\s*:\s*/i, "").trim();
            state.loop += 1;
            if (state.loop >= state.maxLoop) {
              state.status = "blocked";
              state.summary = `Plan review revised the build ${state.loop} times without approval — loop budget (${state.maxLoop}) spent.`;
              state.stage = "blocked";
            } else {
              state.stage = "architect";
            }
          } else if (/^APPROVE_PLAN/i.test(content)) {
            state.planFeedback = undefined;
            state.stage = "builder";
          } else {
            // Unclear reply — treat as revision with the raw reply as feedback.
            state.planFeedback = `The plan review was not a clear APPROVE_PLAN. Raw review output:\n${content}`;
            state.loop += 1;
            if (state.loop >= state.maxLoop) {
              state.status = "blocked";
              state.summary = `Plan review was unclear ${state.loop} times — loop budget (${state.maxLoop}) spent.`;
              state.stage = "blocked";
            } else {
              state.stage = "architect";
            }
          }
          pushStep();
          break;
        }
        case "builder": {
          const reply = await memberCall("builder", [{
            role: "user",
            content: `The manager approved this build plan:\n\n${state.buildPlan}\n\nImplement it now with your tools. EXECUTION WORKFLOW: inspect (read_file / git_status), apply_patch each change, run_check then run_build, fix and re-verify until the build passes, then log_change and git_commit. Do NOT restart the service — the auditor and the manager review first. When everything is done, reply EXACTLY with one line:\nBUILD_DONE\nfollowed by a short plain-English summary of what you changed and the verification result. If you are blocked, reply EXACTLY with one line starting with:\nBUILD_BLOCKED: <reason>`,
          }], PIPELINE_BUILDER_TOOLS);
          const content = reply.ok && reply.content ? reply.content.trim() : `BUILD_ERROR: ${reply.error || "no response"}`;
          step.summary = content.replace(/\s*\n\s*/g, " ").slice(0, 300);
          step.artifact = writeArtifact(state, "builder", "builder", content);
          if (/^BUILD_BLOCKED\s*:/i.test(content)) {
            state.status = "failed";
            state.summary = content.replace(/^BUILD_BLOCKED\s*:\s*/i, "").trim();
            state.stage = "blocked";
          } else if (/^BUILD_DONE/i.test(content)) {
            state.stage = "auditor";
          } else {
            // No explicit verdict but no hard block — let the auditor check reality.
            state.stage = "auditor";
          }
          pushStep();
          break;
        }
        case "auditor": {
          const reply = await memberCall("auditor", [{
            role: "user",
            content: `Audit the builder's work against this approved build plan:\n\n${state.buildPlan}\n\nRun run_check and run_build yourself and read the changed files with read_file. End your reply with EXACTLY one verdict line:\nAPPROVE\nor\nREJECT: <the single most important blocker, one plain-English sentence>`,
          }], PIPELINE_AUDITOR_TOOLS);
          const content = reply.ok && reply.content ? reply.content.trim() : `AUDIT_ERROR: ${reply.error || "no response"}`;
          state.auditReport = content;
          step.summary = content.replace(/\s*\n\s*/g, " ").slice(0, 300);
          step.artifact = writeArtifact(state, "auditor", "auditor", content);
          if (/^REJECT\s*:/i.test(content) || /^REJECT$/i.test(content)) {
            state.loop += 1;
            state.planFeedback = `AUDITOR REJECTED the build:\n${content}`;
            if (state.loop >= state.maxLoop) {
              state.status = "blocked";
              state.summary = `Audit rejected the build ${state.loop} times — loop budget (${state.maxLoop}) spent.`;
              state.stage = "blocked";
            } else {
              state.stage = "architect";
            }
          } else if (/^APPROVE/i.test(content)) {
            state.stage = "manager-final";
          } else {
            // Unclear verdict — safe default is one more architecture loop.
            state.loop += 1;
            state.planFeedback = `AUDITOR output did not end in a clear APPROVE/REJECT:\n${content}`;
            if (state.loop >= state.maxLoop) {
              state.status = "blocked";
              state.summary = `Audit was inconclusive ${state.loop} times — loop budget (${state.maxLoop}) spent.`;
              state.stage = "blocked";
            } else {
              state.stage = "architect";
            }
          }
          pushStep();
          break;
        }
        case "manager-final": {
          const reply = await managerCall([{
            role: "user",
            content: `The AUDITOR approved the build:\n\n${state.auditReport}\n\nDo your OWN final review. Inspect the repo and the approved build plan yourself. If you approve: call restart_service (the reboot fires after this step), then log_change, git_commit, remember, and mark_job done. Then reply EXACTLY with one line:\nFINAL_APPROVE\nfollowed by a short plain-English summary. If you disagree, reply EXACTLY with one line starting with:\nFINAL_REJECT: <reason>`,
          }], true);
          const content = reply.ok && reply.content ? reply.content.trim() : `FINAL_REVIEW_ERROR: ${reply.error || "no response"}`;
          state.finalReport = content;
          step.summary = content.replace(/\s*\n\s*/g, " ").slice(0, 300);
          step.artifact = writeArtifact(state, "manager-final", "manager", content);
          if (/^FINAL_REJECT\s*:/i.test(content)) {
            state.loop += 1;
            state.planFeedback = `MANAGER FINAL REJECTED the build:\n${content}`;
            if (state.loop >= state.maxLoop) {
              state.status = "blocked";
              state.summary = `Final review rejected the build ${state.loop} times — loop budget (${state.maxLoop}) spent.`;
              state.stage = "blocked";
            } else {
              state.stage = "architect";
            }
            pushStep();
            break;
          }
          if (queuedRestart) {
            // Manager called restart_service — fire the deferred reboot now.
            scheduleDeferredRestart();
          }
          state.status = "approved";
          state.summary = `Pipeline ${state.id} approved after ${state.loop} loop iteration(s). ${content.replace(/^FINAL_APPROVE/i, "").trim()}`;
          state.stage = "done";
          pushStep();
          break;
        }
        default: {
          // "done" / "blocked" — nothing more to do.
          return;
        }
      }
    }
  } finally {
    pipelineInFlight = false;
  }
}

/**
 * Start a pipeline job in the background. Persists the state immediately and
 * returns it; the run itself continues server-side until it reaches done/blocked
 * or a crash (which resumePipeline picks back up on boot).
 */
export async function startPipeline(goal: string, opts: { maxLoop?: number } = {}): Promise<PipelineState> {
  const trimmed = goal.trim();
  if (!trimmed) throw new Error("A non-empty goal is required to start the pipeline.");
  const existing = getPipelineState();
  if (existing?.status === "running") {
    throw new Error(`A pipeline is already running (${existing.id}) at stage ${existing.stage}. Wait for it or cancel it first.`);
  }
  const state: PipelineState = {
    id: `pipeline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    goal: trimmed,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stage: "order",
    loop: 0,
    maxLoop: Math.max(1, Math.min(10, opts.maxLoop ?? Number(process.env.PIPELINE_MAX_LOOPS || 5))),
    status: "running",
    summary: "",
    history: [],
  };
  setPipelineState(state);
  runPipeline(state.id).catch((e: any) => {
    console.error(`[Pipeline] Background run failed: ${e.message}`);
    const current = getPipelineState();
    if (current && current.id === state.id && current.status === "running") {
      setPipelineState({ ...current, status: "failed", summary: String(e?.message || e), stage: "blocked" });
    }
  });
  return getPipelineState()!;
}

export function cancelPipeline(): PipelineState | null {
  pipelineCancelled = true;
  const state = getPipelineState();
  if (!state) return null;
  const cancelled: PipelineState = {
    ...state,
    status: "blocked",
    summary: `Cancelled by the operator at ${new Date().toISOString()}.`,
    stage: "blocked",
  };
  setPipelineState(cancelled);
  return getPipelineState();
}

/** Remove a stopped pipeline's saved state and its private artifacts. Running jobs must be cancelled first. */
export function removePipeline(): boolean {
  const state = getPipelineState();
  if (!state) return false;
  if (state.status === "running") throw new Error("Cancel the running pipeline before removing it.");

  pipelineCancelled = true;
  try {
    if (existsSync(PIPELINE_ARTIFACT_DIR())) {
      for (const file of readdirSync(PIPELINE_ARTIFACT_DIR())) {
        if (file.startsWith(`${state.id}-`)) rmSync(join(PIPELINE_ARTIFACT_DIR(), file), { force: true });
      }
    }
    if (existsSync(PIPELINE_STATE_FILE())) unlinkSync(PIPELINE_STATE_FILE());
    pipelineState = null;
    return true;
  } catch (e: any) {
    throw new Error(`Could not remove pipeline: ${e.message}`);
  }
}

/**
 * Called on server startup: if a pipeline was mid-run when the service
 * restarted, resume it from its persisted stage in the background.
 */
export async function resumePipeline(): Promise<void> {
  const state = getPipelineState();
  if (!state) return;
  if (state.status === "blocked" || state.status === "failed") {
    const lastStage = state.history[state.history.length - 1]?.stage;
    const retryStage: PipelineStage = lastStage === "builder"
      ? "builder"
      : lastStage === "auditor"
        ? "architect"
        : lastStage === "manager-final"
          ? "manager-final"
          : lastStage === "order"
            ? "architect"
            : "architect";
    pipelineCancelled = false;
    setPipelineState({
      ...state,
      status: "running",
      stage: retryStage,
      loop: 0,
      summary: `Resumed by operator at ${retryStage}. Previous artifacts and history retained.`,
    });
  }
  const current = getPipelineState();
  if (!current || current.status !== "running") return;
  const stateId = current.id;
  console.log(`[Pipeline] Resuming pipeline ${stateId} at stage ${current.stage} (loop ${current.loop}/${current.maxLoop})`);
  await pause(4000);
  await runPipeline(stateId);
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
  for (const [index, position] of PIPELINE_POSITIONS.entries()) {
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
