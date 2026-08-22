/**
 * task-decomposer.ts
 *
 * Symbolic/neural split for the cryvolmon pipeline.
 *
 * PROBLEM: free/quantized models fed a whole build plan + full app context in
 * one shot degrade badly (truncated output, malformed markdown, "hitting max",
 * silent drops). The fix is not a bigger model — it's smaller, bounded asks.
 *
 * SYMBOLIC (this file, no LLM calls): decompose a build plan into atomic file
 * packets, slice context down to just what a packet needs, validate neural
 * output against a strict schema, retry ONLY the failed packet, and merge
 * results back into one artifact.
 *
 * NEURAL (external API via chatSlot): one packet in, one packet out. Small,
 * structured, bounded — the thing small/free models are actually good at.
 *
 * Wiring: replace the single big `memberCall("builder", ...)` in the
 * "builder" stage of runPipeline with `runBuilderPackets(...)`. Everything
 * else in council.ts (loop budget, artifact writing, auditor/manager stages)
 * stays the same.
 */

import { z } from "zod";
import { resolve } from "node:path";
import { chatSlot, type AgentPosition, type AgentMessage, type AgentToolDefinition, type AgentToolExecutor } from "./agent-providers";

// ---------------------------------------------------------------------------
// Packet types
// ---------------------------------------------------------------------------

export interface TaskPacket {
  id: string;
  file: string;
  change: string;
  why: string;
}

/** Strict schema a neural reply MUST satisfy. Anything else is a validation
 *  failure — retried locally, never passed downstream unvalidated. */
export const PacketResultSchema = z.object({
  status: z.enum(["done", "blocked"]),
  file: z.string().min(1),
  patch: z.string().optional(),   // present when status === "done"
  reason: z.string().optional(),  // present when status === "blocked"
}).refine(
  (r) => (r.status === "done" ? !!r.patch : !!r.reason),
  { message: "done requires patch; blocked requires reason" },
);
export type PacketResult = z.infer<typeof PacketResultSchema>;

export interface PacketOutcome {
  packet: TaskPacket;
  result: PacketResult | null;
  attempts: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// SYMBOLIC: decompose a build plan into atomic packets — no LLM involved.
// Expects the architect's existing "## Build Plan (ordered steps: file →
// exact change → why)" heading and bullet format already used in council.ts.
// ---------------------------------------------------------------------------

export function decomposeBuildPlan(buildPlan: string): TaskPacket[] {
  const section = buildPlan.split(/^##\s*Build Plan/im)[1]?.split(/^##\s/m)[0] ?? "";
  // The heading line often has trailing parenthetical text like
  // "(ordered steps: file → exact change → why)" which leaks into the section
  // after the split. Skip it.
  const lines = section.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !/^\(/.test(l));

  const packets: TaskPacket[] = [];
  let n = 0;
  for (const line of lines) {
    // Only parse lines that contain a → or -> separator — these are the actual
    // packet definitions. Continuation lines (indented *Why:*, verification
    // steps, etc.) lack the separator and must be skipped to avoid creating
    // garbage packets from sub-bullets. Also skip markdown headings (# lines)
    // which sometimes contain → in their title text.
    const cleaned = line.replace(/^[-*\d.)\s]+/, "");
    if (/^#/.test(cleaned)) continue;
    if (!/→|->/.test(cleaned)) continue;
    const parts = cleaned.split(/→|->/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    n += 1;
    packets.push({
      id: `pkt-${n}`,
      file: parts[0] || "unspecified",
      change: parts[1] || cleaned,
      why: parts[2] || "",
    });
  }
  // Fallback: if no structured bullets were found (trivial tasks may not produce
  // a formal build plan), treat the entire plan as a single packet instead of
  // silently returning zero packets which would cause aggregatePacketOutcomes
  // to report ok:true on an empty set (vacuous truth bug).
  if (packets.length === 0 && buildPlan.trim().length > 0) {
    packets.push({
      id: "pkt-1",
      file: "unspecified",
      change: buildPlan.trim().slice(0, 500),
      why: "full plan (no structured bullets found)",
    });
  }
  return packets;
}

/** Local context slice: keep only lines that mention the packet's file (plus
 *  a small window), instead of forwarding the full app-context blob. Cuts
 *  the tokens a free model has to parse before it ever starts reasoning. */
export function contextForPacket(packet: TaskPacket, fullContext: string, windowLines = 6): string {
  const lines = fullContext.split("\n");
  const hits: number[] = [];
  lines.forEach((l, i) => { if (l.includes(packet.file)) hits.push(i); });
  if (hits.length === 0) return `(no matching context found for ${packet.file})`;

  const keep = new Set<number>();
  for (const h of hits) {
    for (let i = Math.max(0, h - windowLines); i <= Math.min(lines.length - 1, h + windowLines); i++) keep.add(i);
  }
  return Array.from(keep).sort((a, b) => a - b).map((i) => lines[i]).join("\n").slice(0, 3000);
}

// ---------------------------------------------------------------------------
// NEURAL: one bounded call per packet, with local-only retry on the SAME
// packet (never re-runs the whole stage).  When tools are provided the call
// uses the full tool loop; otherwise it expects a strict JSON reply.
// ---------------------------------------------------------------------------

function packetPrompt(packet: TaskPacket, context: string, withTools: boolean): AgentMessage[] {
  if (withTools) {
    // Builder packets: the model has tools (apply_patch, run_check, etc.)
    // and should use them to implement the change, then report done/blocked.
    const system = `You are the Builder agent. You process exactly ONE small task packet.
EXECUTION WORKFLOW for this single packet:
1. read_file the target file to understand current state.
2. apply_patch to make the exact change described below.
3. run_check to verify no type errors.
4. If check fails, fix and re-run until it passes.
5. Do NOT run_build (the auditor will do that).
6. Do NOT restart the service.
7. When done, reply with EXACTLY:\nBUILD_DONE <one sentence summary>
If you cannot make the change, reply with EXACTLY:\nBUILD_BLOCKED: <one sentence reason>`;

    const user = `FILE: ${packet.file}
CHANGE: ${packet.change}
WHY: ${packet.why}
CURRENT_UTC_TIME: ${new Date().toISOString()}

RELEVANT CONTEXT (already narrowed to this file — do not ask for more):
${context}`;

    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  // Architect/auditor packets: text-only, strict JSON response.
  const system = `You process exactly ONE small task packet. Reply with ONLY one flat JSON object, no markdown, no prose outside the JSON.
Schema:
{"status":"done","file":"<path>","patch":"<the exact change as a unified diff or replacement snippet>"}
or
{"status":"blocked","file":"<path>","reason":"<one sentence>"}
Nothing else. No headings, no explanation outside the JSON object.`;

  const user = `FILE: ${packet.file}
CHANGE: ${packet.change}
WHY: ${packet.why}

RELEVANT CONTEXT (already narrowed to this file — do not ask for more):
${context}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parsePacketResult(raw: string | null): PacketResult | null {
  if (!raw) return null;
  // Small models sometimes wrap JSON in fences or add a stray sentence —
  // extract the first {...} block before validating.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const result = PacketResultSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Parse a builder-style BUILD_DONE / BUILD_BLOCKED reply into a PacketResult.
 *  Searches anywhere in the content — small models often prepend prose before
 *  the required marker.  If tools ran but no marker is found, returns "done"
 *  anyway (the tools already did the work server-side). */
function parseBuilderReply(raw: string | null, packet: TaskPacket, toolRan = false): PacketResult | null {
  if (!raw) return toolRan ? { status: "done", file: packet.file, patch: "(tools executed, no model summary)" } : null;
  // Explicit BLOCKED is always honoured — the model is saying it can't do it.
  const blocked = raw.match(/BUILD_BLOCKED:\s*(.+)/i);
  if (blocked) {
    return { status: "blocked", file: packet.file, reason: blocked[1].trim() };
  }
  if (/BUILD_DONE/i.test(raw)) {
    return { status: "done", file: packet.file, patch: raw };
  }
  // No explicit marker — if tools actually ran and succeeded, treat as done.
  if (toolRan) {
    return { status: "done", file: packet.file, patch: raw.slice(0, 500) };
  }
  return null;
}

export async function runPacket(
  position: Exclude<AgentPosition, "manager">,
  packet: TaskPacket,
  context: string,
  opts: {
    maxTokens?: number;
    timeoutMs?: number;
    maxRetries?: number;
    tools?: AgentToolDefinition[];
    executeTool?: AgentToolExecutor;
  } = {},
): Promise<PacketOutcome> {
  const maxRetries = opts.maxRetries ?? 2;
  const maxTokens = opts.maxTokens ?? 400; // packets are small by design
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const withTools = !!(opts.tools && opts.executeTool);

  // Tool-control wrapper: for builder packets, apply_patch is only allowed to
  // touch the file declared in the packet.  Any other path returns a rejection
  // string instead of silently writing.  Read-only tools (read_file, git_status,
  // etc.) pass through unmodified.  Skip the guard for fallback packets where
  // the file is "unspecified" — those come from decomposeBuildPlan returning 0
  // structured packets, and the model needs freedom to pick the right target.
  const allowedFile = packet.file === "unspecified" ? null : resolve(packet.file);
  const guardedExecute: AgentToolExecutor | undefined = withTools
    ? async (name: string, args: Record<string, unknown>) => {
        if (name === "apply_patch" && allowedFile) {
          const target = resolve(String(args.path || ""));
          if (target !== allowedFile) {
            return `PATCH_REJECTED: packet ${packet.id} is scoped to ${packet.file} — cannot apply patch to ${args.path}`;
          }
        }
        return opts.executeTool!(name, args);
      }
    : undefined;

  let lastError = "no attempt made";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const reply = await chatSlot(position, packetPrompt(packet, context, withTools), {
      maxTokens,
      timeoutMs,
      tools: opts.tools,
      executeTool: guardedExecute,
    });
    if (!reply.ok) {
      lastError = reply.error || "provider error";
      continue;
    }
    const parsed = withTools
      ? parseBuilderReply(reply.content, packet, (reply.toolCalls ?? 0) > 0)
      : parsePacketResult(reply.content);
    if (parsed) return { packet, result: parsed, attempts: attempt };
    lastError = "response did not match the expected schema";
    // loop again — retry is scoped to THIS packet only, not the pipeline stage
  }
  return { packet, result: null, attempts: maxRetries, error: lastError };
}

/** Runs packets with bounded concurrency (small models + free-tier rate
 *  limits do not benefit from full parallelism, but serial-only wastes the
 *  round-trip latency budget). 2 is safer for tool-using packets (each
 *  packet may do multiple tool rounds). */
export async function runPacketQueue(
  position: Exclude<AgentPosition, "manager">,
  packets: TaskPacket[],
  fullContext: string,
  opts: {
    maxTokens?: number;
    timeoutMs?: number;
    maxRetries?: number;
    concurrency?: number;
    tools?: AgentToolDefinition[];
    executeTool?: AgentToolExecutor;
  } = {},
): Promise<PacketOutcome[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? (opts.tools ? 2 : 3), packets.length || 1));
  const queue = [...packets];
  const outcomes: PacketOutcome[] = [];

  async function worker() {
    while (queue.length > 0) {
      const packet = queue.shift();
      if (!packet) return;
      const ctx = contextForPacket(packet, fullContext);
      outcomes.push(await runPacket(position, packet, ctx, opts));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return outcomes;
}

// ---------------------------------------------------------------------------
// SYMBOLIC: merge packet outcomes into one artifact — no LLM involved.
// This is what replaces the single giant "BUILD_DONE" / "BUILD_BLOCKED"
// freeform reply in the current builder stage.
// ---------------------------------------------------------------------------

export function aggregatePacketOutcomes(outcomes: PacketOutcome[]): {
  ok: boolean;
  summary: string;
  done: PacketOutcome[];
  blocked: PacketOutcome[];
  failed: PacketOutcome[];
} {
  const done = outcomes.filter((o) => o.result?.status === "done");
  const blocked = outcomes.filter((o) => o.result?.status === "blocked");
  const failed = outcomes.filter((o) => !o.result);

  const lines: string[] = [];
  lines.push(`${done.length}/${outcomes.length} packets done, ${blocked.length} blocked, ${failed.length} failed validation.`);
  for (const o of done) lines.push(`\u2714 ${o.packet.file} \u2014 ${o.packet.change}`);
  for (const o of blocked) lines.push(`\u2718 ${o.packet.file} \u2014 blocked: ${o.result?.reason}`);
  for (const o of failed) lines.push(`\u26a0 ${o.packet.file} \u2014 no valid response after ${o.attempts} attempt(s): ${o.error}`);

  return { ok: outcomes.length > 0 && blocked.length === 0 && failed.length === 0, summary: lines.join("\n"), done, blocked, failed };
}
