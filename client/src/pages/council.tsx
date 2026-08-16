import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft, Send, Users, Loader2, RotateCcw, Sparkles, AlertTriangle,
  KeyRound, CheckCircle2, Pencil, X, Bot, ShieldCheck, WifiOff, FileCode, Plus, Copy, Check,
  Hammer, ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useStrategies } from "@/hooks/use-trading";
import {
  useCouncilStatus, useBindAgents, useCouncilChat, useStrategyTune,
  useStrategyResetManaged, useReadFile, useWriteFile,
  useCouncilArchive, useWorkerStatus, useWorkerResult,
  loadLocalAgents, saveLocalAgents, loadLocalPrompts, saveLocalPrompts,
  type AgentPosition, type AgentProvider, type AgentSlotView,
  type CouncilChatResult, type MemberResult, type TuneResult, DEFAULT_SLOTS,
} from "@/hooks/use-council";
import { cn } from "@/lib/utils";
import { MANAGER_BASE_URL, MANAGER_MODEL } from "@shared/council-config";

interface ChatEntry { role: "user" | "assistant"; content: string; result?: CouncilChatResult; }

const POSITION_COLORS: Record<string, string> = {
  manager: "border-violet-500/40 bg-violet-500/5", critic: "border-rose-500/40 bg-rose-500/5",
  architect: "border-blue-500/40 bg-blue-500/5", auditor: "border-amber-500/40 bg-amber-500/5",
  strategist: "border-emerald-500/40 bg-emerald-500/5",
};

const PROVIDER_OPTIONS: { value: AgentProvider; label: string; defaultModel: string; defaultBaseUrl: string }[] = [
  { value: "opencode", label: `OpenCode Go (${MANAGER_MODEL})`, defaultModel: MANAGER_MODEL, defaultBaseUrl: MANAGER_BASE_URL },
  { value: "abacus", label: "Abacus RouteLLM", defaultModel: "gpt-5.6-luna", defaultBaseUrl: "https://routellm.abacus.ai/v1" },
  { value: "deepseek", label: "DeepSeek", defaultModel: "deepseek-chat", defaultBaseUrl: "https://api.deepseek.com" },
  { value: "groq", label: "Groq", defaultModel: "llama-3.3-70b-versatile", defaultBaseUrl: "https://api.groq.com/openai/v1" },
  { value: "cerebras", label: "Cerebras", defaultModel: "gpt-oss-120b", defaultBaseUrl: "https://api.cerebras.ai/v1" },
  { value: "openrouter", label: "OpenRouter Free Pool", defaultModel: "openrouter/free", defaultBaseUrl: "https://openrouter.ai/api/v1" },
  { value: "hyperbolic", label: "Hyperbolic (hy3)", defaultModel: "hy3", defaultBaseUrl: "https://api.hyperbolic.xyz/v1" },
  { value: "nemotron", label: "NVIDIA Nemotron (legacy)", defaultModel: "nvidia/llama-3.3-nemotron-super-70b", defaultBaseUrl: "https://integrate.api.nvidia.com/v1" },
  { value: "nvidia", label: "NVIDIA NIM", defaultModel: "openai/gpt-oss-120b", defaultBaseUrl: "https://integrate.api.nvidia.com/v1" },
  { value: "sambanova", label: "SambaNova", defaultModel: "Meta-Llama-3.3-70B-Instruct", defaultBaseUrl: "https://api.sambanova.ai/v1" },
  { value: "mistral", label: "Mistral (free)", defaultModel: "mistral-small-4", defaultBaseUrl: "https://api.mistral.ai/v1" },
  { value: "hf", label: "HuggingFace Router", defaultModel: "meta-llama/Llama-3.3-70B-Instruct", defaultBaseUrl: "https://router.huggingface.co/v1" },
  { value: "gemini", label: "Google Gemini (free)", defaultModel: "gemini-3.5-flash", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { value: "ovh", label: "OVHcloud (keyless)", defaultModel: "gpt-oss-20b", defaultBaseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1" },
  { value: "local", label: "Local Ollama (qwen3:4b)", defaultModel: "qwen3:4b", defaultBaseUrl: "http://127.0.0.1:11434/v1" },
];

const MODEL_OPTIONS: Record<AgentProvider, string[]> = {
  opencode: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "big-pickle"],
  abacus: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "claude-opus-5", "claude-sonnet-5", "deepseek-ai/DeepSeek-V4-Pro", "grok-4.5"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-20b", "openai/gpt-oss-120b"],
  cerebras: ["gpt-oss-120b"],
  openrouter: ["openrouter/free", "nvidia/nemotron-3.5-lightning:free", "openai/gpt-oss-20b:free", "google/gemma-4-26b-a4b-it:free", "liquid/lfm-2.5-2.6b:free", "poolside/laguna-s-2.1:free", "inclusionai/ling-3.0-tiny:free"],
  hyperbolic: ["hy3"],
  nemotron: ["nvidia/llama-3.3-nemotron-super-70b"],
  nvidia: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-nano-30b-a3b", "nvidia/llama-3.1-nemotron-ultra-253b-v1", "meta/llama-3.3-70b-instruct"],
  sambanova: ["Meta-Llama-3.3-70B-Instruct", "DeepSeek-V3.1"],
  mistral: ["mistral-small-4", "mistral-large-3", "ministral-8b", "codestral"],
  hf: ["meta-llama/Llama-3.3-70B-Instruct", "meta-llama/Llama-3.1-8B-Instruct", "Qwen/Qwen2.5-7B-Instruct"],
  gemini: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  ovh: ["gpt-oss-20b", "gpt-oss-120b", "Qwen3.5-397B-A17B", "Qwen3.6-27B", "Qwen3-32B", "Qwen3-Coder-30B-A3B-Instruct", "Meta-Llama-3_3-70B-Instruct", "Mistral-Small-3.2-24B-Instruct-2506"],
  local: ["qwen3:4b", "qwen2.5:3b", "phi4-mini", "gemma3:4b"],
};

const MANAGER_CHOICES = [
  { id: "opencode:gpt-5.6-luna", label: "OpenCode Go · GPT 5.6 Luna", provider: "opencode" as AgentProvider, model: "gpt-5.6-luna", baseUrl: MANAGER_BASE_URL },
  { id: "abacus:gpt-5.6-luna", label: "Abacus · GPT 5.6 Luna", provider: "abacus" as AgentProvider, model: "gpt-5.6-luna", baseUrl: "https://routellm.abacus.ai/v1" },
  { id: "abacus:claude-opus-5", label: "Abacus · Claude Opus 5", provider: "abacus" as AgentProvider, model: "claude-opus-5", baseUrl: "https://routellm.abacus.ai/v1" },
  { id: "abacus:claude-sonnet-5", label: "Abacus · Claude Sonnet 5", provider: "abacus" as AgentProvider, model: "claude-sonnet-5", baseUrl: "https://routellm.abacus.ai/v1" },
  { id: "groq:llama-3.3-70b-versatile", label: "Groq · Llama 3.3 70B", provider: "groq" as AgentProvider, model: "llama-3.3-70b-versatile", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "cerebras:gpt-oss-120b", label: "Cerebras · GPT OSS 120B", provider: "cerebras" as AgentProvider, model: "gpt-oss-120b", baseUrl: "https://api.cerebras.ai/v1" },
  { id: "openrouter:free", label: "OpenRouter · Free Pool", provider: "openrouter" as AgentProvider, model: "openrouter/free", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "deepseek:chat", label: "DeepSeek · Chat", provider: "deepseek" as AgentProvider, model: "deepseek-chat", baseUrl: "https://api.deepseek.com" },
  { id: "hyperbolic:hy3", label: "Hyperbolic · Hy3", provider: "hyperbolic" as AgentProvider, model: "hy3", baseUrl: "https://api.hyperbolic.xyz/v1" },
  { id: "nemotron:super", label: "NVIDIA · Nemotron", provider: "nemotron" as AgentProvider, model: "nvidia/llama-3.3-nemotron-super-70b", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "nvidia:gpt-oss-20b", label: "NVIDIA NIM · GPT OSS 20B", provider: "nvidia" as AgentProvider, model: "openai/gpt-oss-20b", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "nvidia:nemotron-3-ultra", label: "NVIDIA NIM · Nemotron 3 Ultra", provider: "nvidia" as AgentProvider, model: "nvidia/nemotron-3-ultra-550b-a55b", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "ovh:gpt-oss-20b", label: "OVH (keyless) · GPT OSS 20B", provider: "ovh" as AgentProvider, model: "gpt-oss-20b", baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1" },
];

const POSITION_COPY: Record<AgentPosition, string> = {
  manager: "Manager / Builder", critic: "Critic", architect: "Architect", auditor: "Auditor", strategist: "Strategist",
};

interface EditState { provider: AgentProvider; baseUrl: string; model: string; apiKey: string; prompt: string; }

function MemberCard({ member, busy }: { member: MemberResult; busy?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!member.content) return;
    await navigator.clipboard.writeText(member.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Card className={cn("p-4 border min-h-[90px]", POSITION_COLORS[member.position] || "border-border/40")}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="uppercase text-[10px] tracking-wider">{member.title}</Badge>
          {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-1">
          {member.content && <Button variant="ghost" size="icon" className="h-6 w-6" onClick={copy} title="Copy full response">{copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}</Button>}
          <span className="text-[10px] font-mono text-muted-foreground">{member.provider}/{member.model}</span>
        </div>
      </div>
      {busy ? <p className="text-xs text-muted-foreground italic">deliberating…</p>
       : member.ok && member.content
         ? <>
             <pre className={`whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90 overflow-y-auto ${expanded ? "max-h-[70vh]" : "max-h-[300px]"}`}>{member.content}</pre>
             <Button variant="ghost" size="sm" className="h-6 px-1 text-[10px]" onClick={() => setExpanded(!expanded)}>{expanded ? "Collapse" : "Expand full response"}</Button>
           </>
        : <p className="text-xs text-destructive">Failed: {member.error || "no response"}</p>}
    </Card>
  );
}

function CouncilReply({ result }: { result: CouncilChatResult }) {
  const members = result.members || [];
  return (<div className="space-y-2 mt-2">
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">{members.map(m => <MemberCard key={m.position} member={m} />)}</div>
    {result.synthesis && (
      <Card className="p-4 border-primary/50 bg-primary/5">
        <div className="flex items-center gap-2 mb-2"><Sparkles className="h-3.5 w-3.5 text-primary" /><span className="text-xs font-semibold uppercase tracking-wider">Manager — Decision ({result.synthesis.model})</span></div>
        {result.synthesis.ok && result.synthesis.content
          ? <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/95">{result.synthesis.content}</pre>
          : <p className="text-xs text-destructive">Synthesis failed: {result.synthesis.error}</p>}
      </Card>)}
  </div>);
}

function TuneResultView({ result }: { result: TuneResult }) {
  return (<div className="space-y-3 mt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Badge variant={result.configApplied ? "default" : "secondary"}>{result.configApplied ? "Applied" : "No changes"}</Badge>
      <Badge variant="outline">#{result.strategyId} {result.symbol}</Badge>
    </div>
    <div className="rounded-lg border border-border/50 overflow-hidden"><table className="w-full text-xs">
      <thead><tr className="border-b border-border/50 bg-muted/20"><th className="text-left px-3 py-2 font-mono">Parameter</th><th className="text-right px-3 py-2 font-mono">Before</th><th className="text-right px-3 py-2 font-mono">After</th></tr></thead>
      <tbody>{Object.entries(result.merged).map(([k, v]) => {
        const b = result.before[k]; const isChanged = b !== v;
        return <tr key={k} className="border-b border-border/30 last:border-0"><td className="px-3 py-1.5 font-mono">{k}</td><td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{b}</td><td className={cn("px-3 py-1.5 text-right font-mono", isChanged && "text-emerald-400 font-semibold")}>{isChanged ? `${b} → ${(v as number).toFixed(4)}` : v}</td></tr>;
      })}</tbody>
    </table></div>
    {result.notes.length > 0 && <ul className="space-y-1">{result.notes.map((n,i)=><li key={i} className="text-xs text-muted-foreground list-disc list-inside">{n}</li>)}</ul>}
  </div>);
}

function SlotCard({
  slot, editing, onToggleEdit, onSave, saving, localPrompts,
}: {
  slot: AgentSlotView; editing: boolean; onToggleEdit: () => void;
  onSave: (e: EditState) => void; saving: boolean; localPrompts: Record<string, string>;
}) {
  const [provider, setProvider] = useState<AgentProvider>(slot.provider);
  const [model, setModel] = useState(slot.model);
  const [baseUrl, setBaseUrl] = useState(slot.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState(localPrompts[slot.position] || "");
  const modelOptions = Array.from(new Set([...(MODEL_OPTIONS[provider] || []), model]));
  const wasEditingRef = useRef(false);

  useEffect(() => {
    if (editing && !wasEditingRef.current) {
      setProvider(slot.provider);
      setModel(slot.model);
      setBaseUrl(slot.baseUrl);
      setApiKey("");
      setPrompt(localPrompts[slot.position] || "");
    }
    wasEditingRef.current = editing;
  }, [editing, slot, localPrompts]);

  return (
    <Card className={cn("p-4 border", POSITION_COLORS[slot.position])}>
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <div className="flex items-center gap-2"><span className="text-xs font-bold uppercase tracking-wider">{slot.title}</span><span className="text-[10px] font-mono text-muted-foreground truncate">{slot.role}</span></div>
          <p className="text-[11px] text-muted-foreground leading-snug">{slot.description}</p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onToggleEdit}>{editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}</Button>
      </div>
      {editing ? (
        <div className="mt-3 space-y-2">
          <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none" value={provider} onChange={e => { const v = e.target.value as AgentProvider; setProvider(v); const d = PROVIDER_OPTIONS.find(p => p.value === v); if (d) { setModel(d.defaultModel); setBaseUrl(d.defaultBaseUrl); } }}>
            {PROVIDER_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
           <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none" value={model} onChange={e => setModel(e.target.value)}>
             {modelOptions.map(option => <option key={option} value={option}>{option}</option>)}
           </select>
          <Input value={baseUrl} placeholder="Base URL" onChange={e => setBaseUrl(e.target.value)} className="h-9" />
          <Input type="password" value={apiKey} placeholder={slot.hasKey ? "•••••••• (leave blank to keep)" : "API key"} onChange={e => setApiKey(e.target.value)} className="h-9" />
          <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[60px]" placeholder="System prompt override… (blank = default role prompt)" value={prompt} onChange={e => setPrompt(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" disabled={saving || !model || !baseUrl} onClick={() => onSave({ provider, baseUrl, model, apiKey, prompt })}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}Save
            </Button>
            {slot.hasKey && <Button size="sm" variant="outline" onClick={() => onSave({ provider, baseUrl, model, apiKey: "", prompt })}><KeyRound className="h-3.5 w-3.5 mr-1" />Clear key</Button>}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <Badge variant={slot.configured ? "default" : "outline"}>
            {slot.configured ? <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-400" /> : <AlertTriangle className="h-3 w-3 mr-1 text-amber-400" />}
            {slot.configured ? "Ready" : "No key"}
          </Badge>
          <Badge variant="secondary">{slot.provider} / <span className="font-mono">{slot.model}</span></Badge>
          {slot.lastError ? <span className="text-rose-400 truncate w-full" title={slot.lastError}>{slot.lastError}</span>
            : <span className="text-muted-foreground truncate font-mono">{slot.baseUrl}</span>}
          {localPrompts[slot.position] && <span className="text-[10px] text-violet-400 italic">custom prompt</span>}
        </div>
      )}
    </Card>
  );
}

const LANES: Array<{ key: string; label: string; color: string; dot: string; phases: string[] }> = [
  { key: "handedoff", label: "Handed off", color: "text-sky-300 border-sky-500/30 bg-sky-500/10",        dot: "bg-sky-400",     phases: ["queued"] },
  { key: "working",   label: "Working",    color: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10", dot: "bg-emerald-400", phases: ["running", "rework"] },
  { key: "review",    label: "Review",     color: "text-violet-300 border-violet-500/30 bg-violet-500/10",  dot: "bg-violet-400",  phases: ["review"] },
  { key: "closed",    label: "Closed",     color: "text-muted-foreground border-border/40 bg-muted/20",     dot: "bg-emerald-500/50", phases: ["closed"] },
];

function age(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60 ? `${mins % 60}m` : ""}`;
}

function WorkerTaskResult({ id, open }: { id: string; open: boolean }) {
  const result = useWorkerResult(id, open);
  if (!open) return null;
  if (result.isLoading) return <div className="mt-1 h-8 animate-pulse bg-muted/20 rounded" />;
  if (result.isError) return <p className="mt-1 text-[9px] text-red-300">{(result.error as Error).message}</p>;
  return (
    <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[9px] leading-relaxed text-muted-foreground border-t border-border/30 pt-1">
      {result.data?.content || ""}
    </pre>
  );
}

function WorkerPanel() {
  const { data } = useWorkerStatus();
  const counts = data?.counts || {};
  const recent = data?.recent || [];
  const [open, setOpen] = useState<string | null>(null);
  const openTask = recent.find((t) => t.id === open) || null;

  return (
    <Card>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-xs flex items-center gap-1.5"><ListChecks className="h-3.5 w-3.5 text-emerald-400" />Foreman & Workers</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 space-y-2">
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1 min-w-0">
            <Sparkles className="h-3 w-3 shrink-0 text-sky-400" />
            <span className="truncate">{data?.foreman ? `Foreman: ${data.foreman.provider}/${data.foreman.model}` : "Foreman: idle"}</span>
          </span>
          <span className="flex items-center gap-1 shrink-0">
            <Hammer className="h-3 w-3 text-emerald-400" />
            {data?.worker ? data.worker.model : "no worker"}
          </span>
        </div>

        <div className="grid grid-cols-4 gap-1">
          {LANES.map((lane) => {
            const laneCount = lane.phases.reduce((s, p) => s + (counts[p] || 0), 0);
            const items = recent.filter((t) => lane.phases.includes(t.phase)).slice(0, 3);
            const hidden = Math.max(0, laneCount - items.length);
            return (
              <div key={lane.key} className="flex flex-col gap-1 min-w-0">
                <div className={cn("flex items-center justify-between rounded border px-1 py-0.5 text-[8px] uppercase tracking-wide", lane.color)}>
                  <span className="truncate">{lane.label}</span>
                  <span className="font-bold">{laneCount}</span>
                </div>
                {items.map((t) => (
                  <div key={t.id} className="rounded border border-border/25 bg-card/20 px-1 py-0.5 cursor-pointer hover:border-border/50" onClick={() => setOpen(open === t.id ? null : t.id)}>
                    <div className="flex items-center gap-0.5 min-w-0">
                      <span className={cn("inline-block h-1 w-1 rounded-full shrink-0", lane.dot, t.phase === "running" && "animate-pulse")} />
                      <span className="truncate text-[9px] font-medium leading-tight">{t.title}</span>
                    </div>
                    <div className="flex items-center justify-between gap-1 text-[8px] text-muted-foreground">
                      <span className="flex items-center gap-0.5 min-w-0 truncate font-mono">
                        #{t.id.slice(-6)}
                        {t.phase === "rework" && <RotateCcw className="h-2 w-2 shrink-0 text-orange-400" />}
                      </span>
                      <span className="shrink-0">
                        {t.phase === "running"
                          ? <Loader2 className="h-2 w-2 animate-spin text-emerald-400" />
                          : t.assigned?.model ? t.assigned.model.split("/").pop()?.slice(0, 10) : age(t.createdAt)}
                      </span>
                    </div>
                  </div>
                ))}
                {hidden > 0 && <p className="text-[8px] text-muted-foreground/60 text-center">+{hidden}</p>}
              </div>
            );
          })}
        </div>

        {counts.failed > 0 && <p className="text-[9px] text-red-300">Failed {counts.failed} — see queue for errors.</p>}

        {openTask && (
          <div className="rounded border border-border/30 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[9px] font-medium">{openTask.title}</span>
              <Button variant="ghost" size="sm" className="h-4 w-4 p-0 shrink-0" onClick={() => setOpen(null)}><X className="h-2.5 w-2.5" /></Button>
            </div>
            <WorkerTaskResult id={openTask.id} open />
          </div>
        )}

        {recent.length === 0 && <p className="text-[10px] text-muted-foreground">Queue empty — no work delegated.</p>}
      </CardContent>
    </Card>
  );
}

export default function CouncilPage() {
  const { data: status, slots, isOffline } = useCouncilStatus();
  const binder = useBindAgents();
  const strategiesQuery = useStrategies();
  const chat = useCouncilChat();
  const tune = useStrategyTune();
  const reset = useStrategyResetManaged();
  const readFile = useReadFile();
  const writeFile = useWriteFile();
  const archive = useCouncilArchive();

  const [mode, setMode] = useState<"manager" | "council" | "agent">("manager");
  const [agentPosition, setAgentPosition] = useState<AgentPosition>("architect");
  const [managerChoice, setManagerChoice] = useState("opencode:gpt-5.6-luna");
  const [messageChannels, setMessageChannels] = useState<Record<string, ChatEntry[]>>({});
  const [input, setInput] = useState("");
  const [targetId, setTargetId] = useState<number | "">("");
  const [editing, setEditing] = useState<AgentPosition | null>(null);
  const [localPrompts, setLocalPrompts] = useState<Record<string, string>>({});
  const [attachedPath, setAttachedPath] = useState("");
  const [showFileAttach, setShowFileAttach] = useState(false);
  const [editPath, setEditPath] = useState("");
  const [editContent, setEditContent] = useState("");
  const [writeToken, setWriteToken] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const boundLocalRef = useRef(false);

  const readyCount = slots.filter(s => s.configured).length;
  const channelKey = mode === "agent" ? `agent:${agentPosition}` : mode;
  const messages = messageChannels[channelKey] || [];
  const appendMessage = (entry: ChatEntry) => {
    setMessageChannels(prev => ({ ...prev, [channelKey]: [...(prev[channelKey] || []), entry] }));
  };

  useEffect(() => { setLocalPrompts(loadLocalPrompts()); }, []);

  useEffect(() => {
    if (!status) return;
    const manager = slots.find(slot => slot.position === "manager");
    const match = manager && MANAGER_CHOICES.find(choice => choice.provider === manager.provider && choice.model === manager.model);
    if (match) setManagerChoice(match.id);
  }, [slots]);

  useEffect(() => {
    if (boundLocalRef.current) return;
    const local = loadLocalAgents().filter(slot => slot.position !== "manager");
    if (local.length > 0) { boundLocalRef.current = true; binder.mutate(local); }
    else boundLocalRef.current = true;
  }, []);

  const saveSlot = (position: AgentPosition, edit: EditState) => {
    const next = { position, provider: edit.provider, baseUrl: edit.baseUrl, model: edit.model, apiKey: edit.apiKey };
    saveLocalAgents([...loadLocalAgents().filter(l => l.position !== position), next]);
    const nextPrompts = { ...loadLocalPrompts(), [position]: edit.prompt };
    saveLocalPrompts(nextPrompts);
    setLocalPrompts(nextPrompts);
    binder.mutate([next], { onSuccess: () => setEditing(null) });
  };

  const attachFile = async () => {
    const p = attachedPath.trim();
    if (!p) return;
    try {
      const f = await readFile.mutateAsync(p);
      setInput(prev => prev + `\n\n[FILE: ${f.path}]\n${f.content.slice(0, 8000)}`);
      setAttachedPath("");
      setShowFileAttach(false);
    } catch { setInput(prev => prev + `\n\n@file ${p}`); }
  };

  const tunable = useMemo(() => {
    const list = strategiesQuery.data || [];
    const running = list.filter(s => s.status === "running");
    const grids = list.filter(s => s.type === "grid" || s.type === "tandem");
    const runningGrids = grids.filter(s => s.status === "running");
    return runningGrids.length > 0 ? runningGrids : grids;
  }, [strategiesQuery.data]);

  const busy = chat.isPending || tune.isPending || reset.isPending || binder.isPending || readFile.isPending || writeFile.isPending;

  const applyEdit = async () => {
    if (!editPath.trim() || !editContent || !writeToken) return;
    await writeFile.mutateAsync({ path: editPath.trim(), content: editContent, token: writeToken });
    setEditContent("");
  };

  const changeManager = (id: string) => {
    const choice = MANAGER_CHOICES.find(item => item.id === id);
    if (!choice) return;
    setManagerChoice(id);
    const local = loadLocalAgents().filter(slot => slot.position !== "manager");
    saveLocalAgents([...local, { position: "manager", provider: choice.provider, model: choice.model, baseUrl: choice.baseUrl }]);
    binder.mutate([{ position: "manager", provider: choice.provider, model: choice.model, baseUrl: choice.baseUrl }]);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: { role: "user" | "assistant"; content: string }[] = messages
      .slice(-40)
      .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
    appendMessage({ role: "user", content: text });
    setInput("");
    try {
      const result = await chat.mutateAsync({ message: text, mode, position: mode === "agent" ? agentPosition : undefined, toolsToken: mode === "manager" ? writeToken : undefined, history });
      const main = result.mode === "council" ? result.synthesis : result.reply;
      const content = (main?.ok && main.content) || "No response." + (main?.error ? ` (${main.error})` : "");
      appendMessage({ role: "assistant", content, result });
    } catch (e: any) { appendMessage({ role: "assistant", content: `Request failed: ${e.message}` }); }
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  };

  return (
    <div className="min-h-screen w-full bg-[#0a0f1e] text-foreground p-3 sm:p-6 relative overflow-x-hidden">
      <div className="absolute top-0 left-0 w-full h-[300px] bg-gradient-to-b from-violet-900/10 to-transparent pointer-events-none" />
      <div className="max-w-7xl mx-auto relative z-10 space-y-4">
        <header className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Users className="h-6 w-6 text-violet-400" /><h1 className="text-xl font-extrabold">AI Council</h1>
            <Badge variant="secondary" className="ml-1">{readyCount}/5 slots ready</Badge>
          </div>
          <div className="flex items-center gap-2">
            {isOffline ? <span className="flex items-center gap-1.5 text-xs text-amber-400"><WifiOff className="h-3.5 w-3.5" /> Server offline — slots are readonly</span>
             : readyCount > 0 ? <span className="flex items-center gap-1.5 text-xs text-emerald-400"><ShieldCheck className="h-3.5 w-3.5" />{readyCount} agents wired</span>
             : <span className="flex items-center gap-1.5 text-xs text-amber-400"><AlertTriangle className="h-3.5 w-3.5" />Click a slot to configure keys</span>}
            <Link href="/trading"><Button variant="outline" size="sm"><ArrowLeft className="h-3 w-3 mr-1" />Trading</Button></Link>
          </div>
        </header>

        {/* 5-slot roster */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          {slots.map(slot => (
            <SlotCard key={slot.position} slot={slot}
              editing={editing === slot.position}
              onToggleEdit={() => setEditing(editing === slot.position ? null : slot.position)}
              onSave={edit => saveSlot(slot.position, edit)}
              saving={binder.isPending && editing === slot.position}
              localPrompts={localPrompts} />
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Chat */}
          <div className="lg:col-span-2 flex flex-col gap-3">
            <Card className="flex flex-col h-[62vh] min-h-[420px]">
              <CardHeader className="py-3 px-4 border-b border-border/40">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-sm">Ask the team</CardTitle>
                  <select className="h-7 max-w-[240px] rounded-md border border-input bg-background px-2 text-[11px]" value={mode === "council" ? "council" : mode === "agent" ? agentPosition : "manager"} onChange={e => {
                    const target = e.target.value;
                    if (target === "council") setMode("council");
                    else if (target === "manager") setMode("manager");
                    else { setMode("agent"); setAgentPosition(target as AgentPosition); }
                  }} disabled={busy} title="Choose who to ask">
                    <option value="manager">Manager</option>
                    <option value="critic">Critic</option>
                    <option value="architect">Architect</option>
                    <option value="auditor">Auditor</option>
                    <option value="strategist">Strategist</option>
                    <option value="council">Council</option>
                  </select>
                  <select className="h-7 max-w-[220px] rounded-md border border-input bg-background px-2 text-[11px]" value={managerChoice} onChange={e => changeManager(e.target.value)} disabled={busy} title="Change Manager provider/model">
                    {MANAGER_CHOICES.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
                  </select>
                </div>
                <CardDescription className="text-xs">
                   {mode === "manager" ? `Manager (${MANAGER_CHOICES.find(choice => choice.id === managerChoice)?.label || MANAGER_MODEL}) with live operation snapshot.` : mode === "agent" ? "Ask one specialist directly with live operation and workspace context." : "Critic · Architect · Auditor · Strategist debate → Manager decides."}
                  {isOffline && " (chat needs the server running)"}
                </CardDescription>
              </CardHeader>

              <CardContent className="flex-1 overflow-y-auto space-y-3 py-4" ref={scrollRef}>
                {messages.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-muted-foreground">
                    <Users className="h-10 w-10 opacity-30" />
                    <p className="text-sm">Query the manager · builder · council.</p>
                    <p className="text-xs opacity-70">Use <code className="text-violet-300">@file path</code> to inject source files as context. Attach files with the 📎 button.</p>
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={cn("max-w-[92%] rounded-xl px-3 py-2 border", m.role === "user" ? "border-primary/40 bg-primary/10" : "border-border/40 bg-muted/20")}>
                      {m.role === "assistant" && <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{m.result?.mode === "council" ? `Council → ${m.result.synthesis?.model || "manager"}` : m.result?.mode === "agent" ? `${m.result.position || "agent"} → ${m.result.reply?.model || "agent"}` : "Manager"}</div>}
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{m.content}</pre>
                      {m.result?.mode === "council" && <CouncilReply result={m.result} />}
                    </div>
                  </div>
                ))}
                {chat.isPending && (
                  <div className="flex justify-start"><div className="max-w-[92%] rounded-xl px-4 py-3 border border-border/40 bg-muted/20 space-y-2">
                    {mode === "council" ? (<>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {(["critic","architect","auditor","strategist"] as const).map(p => (
                          <MemberCard key={p} busy member={{ position: p, role: p, title: POSITION_COPY[p], provider: slots.find(s => s.position === p)?.provider || "?", model: slots.find(s => s.position === p)?.model || "…", ok: false, content: null, ms: 0 }} />
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground italic flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Manager synthesizing decision…</p>
                    </>) : (<p className="text-xs text-muted-foreground italic flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />{mode === "agent" ? `${agentPosition} thinking…` : "Manager thinking…"}</p>)}
                  </div></div>
                )}
              </CardContent>

              <CardFooter className="p-3 border-t border-border/40 flex-col gap-2">
                {showFileAttach && (
                  <div className="flex items-center gap-2 w-full">
                    <Input value={attachedPath} placeholder="File path (e.g. server/routes.ts)" className="h-8 text-xs" onChange={e => setAttachedPath(e.target.value)} onKeyDown={e => { if (e.key === "Enter") attachFile(); }} />
                    <Button size="sm" onClick={attachFile} disabled={readFile.isPending || !attachedPath.trim()}><FileCode className="h-3.5 w-3.5 mr-1" />Inject</Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowFileAttach(false)}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                )}
                <div className="flex items-center gap-2 w-full">
                  <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => setShowFileAttach(true)} title="Attach file context"><Plus className="h-4 w-4" /></Button>
                  <Input value={input} placeholder={readyCount === 0 ? "Configure an agent slot first" : mode === "manager" ? "Message the manager… use @file path for code context" : "Ask the council… use @file path for code context"} disabled={busy || readyCount === 0} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) send(); }} />
                  <Button size="icon" onClick={send} disabled={busy || readyCount === 0 || !input.trim()}><Send className="h-4 w-4" /></Button>
                </div>
              </CardFooter>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <WorkerPanel />

            <Card>
              <CardHeader className="py-3 px-4"><CardTitle className="text-sm flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-400" />Strategy Tuner</CardTitle>
                <CardDescription className="text-xs">Council debates managed params now and every 4 hours while the strategy runs. It applies the median; ticker, leverage, and capital stay locked. Tandem L/S weighting may be tuned.</CardDescription></CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={targetId} disabled={busy} onChange={e => setTargetId(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">Select a strategy…</option>
                  {tunable.map(s => <option key={s.id} value={s.id}>#{s.id} {s.name} · {s.symbol} · {s.status}</option>)}
                </select>
                <div className="flex gap-2">
                  <Button size="sm" className="flex-1" disabled={targetId === "" || tune.isPending} onClick={() => tune.mutate(Number(targetId))}>
                     {tune.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}Run Debate + Enable 4h</Button>
                  <Button size="sm" variant="outline" disabled={targetId === "" || reset.isPending} onClick={() => reset.mutate(Number(targetId))}><RotateCcw className="h-3.5 w-3.5" /></Button>
                </div>
                {tune.isPending && <p className="text-xs text-muted-foreground italic flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Council debating parameters…</p>}
                {tune.data && <TuneResultView result={tune.data} />}
                {reset.data && <p className="text-xs text-emerald-400">Managed params reset to presets.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-sm">Council Archive</CardTitle>
                <CardDescription className="text-xs">Persisted Manager and specialist messages from the VM. The archive survives browser refreshes and mobile sessions.</CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2 max-h-[420px] overflow-y-auto">
                {(archive.data || []).map(entry => (
                  <div key={entry.id} className="rounded border border-border/30 bg-card/20 p-2">
                    <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span className="uppercase">{entry.position} · {entry.role}</span>
                      <span>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : ""}</span>
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{entry.content}</pre>
                  </div>
                ))}
                {archive.data?.length === 0 && <p className="text-xs text-muted-foreground">No archived messages yet.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Editing files</CardTitle></CardHeader>
              <CardContent className="px-4 pb-4 space-y-2 text-xs text-muted-foreground">
                <p>Click <span className="inline-flex items-center"><Plus className="h-3 w-3 mx-0.5" /></span> next to the input to attach source files as context before sending a message. The agents receive the file content and can review it.</p>
                <p>Type <code className="font-mono text-violet-300">@file server/routes.ts</code> in your message to auto-attach. The server reads the file and injects its contents into the agent prompt.</p>
                 <p>API keys are never stored in browser storage. They are held in server memory for the session or loaded from server environment/auth configuration.</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-sm">Approved File Edit</CardTitle>
                <CardDescription className="text-xs">Paste a reviewed Council change here. Nothing is written without the approval token.</CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                <Input value={editPath} onChange={e => setEditPath(e.target.value)} placeholder="Path, e.g. server/routes.ts" className="h-8 text-xs" />
                <textarea value={editContent} onChange={e => setEditContent(e.target.value)} placeholder="Full approved file contents" className="w-full min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono" />
                <Input type="password" value={writeToken} onChange={e => setWriteToken(e.target.value)} placeholder="Approval token for Manager tools / file edits" className="h-8 text-xs" />
                <Button size="sm" className="w-full" disabled={busy || !editPath.trim() || !editContent || !writeToken} onClick={applyEdit}>
                  {writeFile.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}Apply Approved Edit
                </Button>
                {writeFile.isError && <p className="text-xs text-destructive">{(writeFile.error as Error).message}</p>}
                {writeFile.isSuccess && <p className="text-xs text-emerald-400">File written successfully.</p>}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
