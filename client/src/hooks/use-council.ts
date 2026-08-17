import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { MANAGER_BASE_URL, MANAGER_MODEL, MANAGER_PROVIDER } from "@shared/council-config";

export type AgentPosition = "manager" | "architect" | "builder" | "auditor" | "trader";
export type AgentProvider = "opencode" | "abacus" | "deepseek" | "groq" | "cerebras" | "openrouter" | "hyperbolic" | "nemotron" | "nvidia" | "sambanova" | "mistral" | "hf" | "gemini" | "ovh" | "local";

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

export interface CouncilStatus {
  configured: boolean;
  slots: AgentSlotView[];
}

export interface MemberResult {
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
  mode: "manager" | "agent";
  position?: AgentPosition;
  configured?: boolean;
  context?: string;
  slots?: AgentSlotView[];
  reply?: ManagerReply;
}

export interface TuneResult {
  strategyId: number;
  symbol: string;
  status: string;
  configApplied: boolean;
  before: Record<string, number>;
  merged: Record<string, number>;
  bounds: Record<string, [number, number]>;
  members: MemberResult[];
  notes: string[];
}

/** Static fallback when the server is offline — the page still works. */
export const DEFAULT_SLOTS: AgentSlotView[] = [
  {
    position: "manager", role: "Orchestration & final gate", title: "Manager",
    description: "OpenCode Go. GPT 5.6 Luna lead agent: writes the job order, gates each hand-off, and reboots after the audit.",
    provider: MANAGER_PROVIDER, baseUrl: MANAGER_BASE_URL, model: MANAGER_MODEL,
    hasKey: false, keyName: "OPENCODE_API_KEY", configured: false, lastError: null,
  },
  {
    position: "architect", role: "Build-plan design", title: "Architect",
    description: "DeepSeek Chat. Devises the build plan before any code is written.",
    provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat",
    hasKey: true, keyName: "DEEPSEEK_API_KEY", configured: true, lastError: null,
  },
  {
    position: "builder", role: "Implementation & verification", title: "Builder",
    description: "Groq GPT OSS 120B. Implements the approved plan, verifies with run_check/run_build, commits.",
    provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b",
    hasKey: false, keyName: "HYPERBOLIC_API_KEY", configured: false, lastError: null,
  },
  {
    position: "auditor", role: "Quality & risk audit", title: "Auditor",
    description: "NVIDIA Nemotron. Audits the implementation against the plan; APPROVE or REJECT.",
    provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", model: "nvidia/nemotron-3-super-120b-a12b",
    hasKey: false, keyName: "NVIDIA_API_KEY", configured: false, lastError: null,
  },
  {
    position: "trader", role: "Strategy launch & market read", title: "Trader",
    description: "Groq. Starts completed strategies; reads market/account state. (Autonomous open/close coming.)",
    provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile",
    hasKey: false, keyName: "GROQ_API_KEY", configured: false, lastError: null,
  },
];

export function useCouncilStatus() {
  const query = useQuery<CouncilStatus>({
    queryKey: ["/api/council/status"],
    refetchInterval: 60000,
    retry: 1,
  });
  return {
    ...query,
    slots: query.data?.slots ?? DEFAULT_SLOTS,
    isOffline: query.isError || !query.data,
  };
}

export function useCouncilArchive() {
  return useQuery<Array<{
    id: number;
    sessionId: string;
    mode: string;
    position: string;
    role: string;
    provider: string | null;
    model: string | null;
    content: string;
    metadata: Record<string, unknown> | null;
    createdAt: string | null;
  }>>({
    queryKey: ["/api/council/archive"],
    refetchInterval: 30000,
  });
}

export function useWorkerStatus() {
  return useQuery<{
    updatedAt: string;
    counts: Record<string, number>;
    foreman: { provider: string; model: string } | null;
    worker: { provider: string; model: string } | null;
    runningTask: { id: string; title: string } | null;
    recent: Array<{
      id: string;
      title: string;
      type: string;
      status: string;
      phase: string;
      retries: number;
      createdAt: string;
      finishedAt: string | null;
      assigned: { provider: string; model: string } | null;
      foreman: { provider: string; model: string } | null;
      verified: { by: string; accept: boolean; note: string } | null;
      needsManagerReview: boolean | null;
      resultPath: string | null;
      error: string | null;
    }>;
  }>({
    queryKey: ["/api/worker/status"],
    refetchInterval: 30000,
  });
}

export function useWorkerResult(id: string, enabled: boolean) {
  return useQuery<{ content: string }>({
    queryKey: [`/api/worker/tasks/${id}/result`],
    enabled,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/worker/tasks/${id}/result`);
      return { content: await res.text() };
    },
  });
}

export function useBindAgents() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slots: { position: AgentPosition; provider?: AgentProvider; baseUrl?: string; model?: string; apiKey?: string }[]) => {
      const res = await apiRequest("POST", "/api/council/agents", { slots });
      return (await res.json()) as { slots: AgentSlotView[] };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/council/status"] });
    },
  });
}

export function useCouncilChat() {
  return useMutation({
    mutationFn: async (payload: {
      message: string;
      mode: "manager" | "agent";
      position?: AgentPosition;
      toolsToken?: string;
      history: { role: "user" | "assistant"; content: string }[];
    }) => {
      const res = await apiRequest("POST", "/api/council/chat", payload);
      return (await res.json()) as CouncilChatResult;
    },
  });
}

export function useReadFile() {
  return useMutation({
    mutationFn: async (path: string) => {
      const res = await apiRequest("GET", `/api/council/file?path=${encodeURIComponent(path)}`);
      return (await res.json()) as { path: string; content: string };
    },
  });
}

export function useWriteFile() {
  return useMutation({
    mutationFn: async (payload: { path: string; content: string; token: string }) => {
      const { token, ...body } = payload;
      const res = await apiRequest("POST", "/api/council/file", body, {
        "x-council-write-token": token,
      });
      return (await res.json()) as { path: string; ok: boolean };
    },
  });
}

const LOCAL_KEY = "council.agent.config.v1";
const PROMPTS_KEY = "council.agent.prompts.v1";

export function loadLocalAgents(): { position: AgentPosition; provider?: AgentProvider; baseUrl?: string; model?: string; apiKey?: string }[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as { position: AgentPosition; provider?: AgentProvider; baseUrl?: string; model?: string; apiKey?: string }[]) : [];
    const safeSlots = parsed.map(({ apiKey: _apiKey, ...slot }) => slot);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(safeSlots));
    return safeSlots;
  } catch { return []; }
}

export function saveLocalAgents(slots: { position: AgentPosition; provider?: AgentProvider; baseUrl?: string; model?: string; apiKey?: string }[]): void {
  const safeSlots = slots.map(({ apiKey: _apiKey, ...slot }) => slot);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(safeSlots));
}

export function loadLocalPrompts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PROMPTS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}

export function saveLocalPrompts(prompts: Record<string, string>): void {
  localStorage.setItem(PROMPTS_KEY, JSON.stringify(prompts));
}

export function useStrategyTune() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/council-tune`);
      return (await res.json()) as TuneResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
    },
  });
}

export function useStrategyResetManaged() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/council-reset`);
      return (await res.json()) as { strategyId: number; reset: Record<string, number> };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
    },
  });
}

// --- Build pipeline (role-chain assembly line) ---

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
  managerOrder?: string;
  buildPlan?: string;
  planFeedback?: string;
  auditReport?: string;
  finalReport?: string;
  history: PipelineStep[];
}

export function usePipelineStatus() {
  return useQuery<PipelineState | null>({
    queryKey: ["/api/pipeline/status"],
    refetchInterval: 5000,
    retry: 1,
  });
}

export function usePipelineRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { goal: string; maxLoop?: number }) => {
      const res = await apiRequest("POST", "/api/pipeline/run", payload);
      return (await res.json()) as { ok: boolean; state: PipelineState };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline/status"] });
    },
  });
}

export function usePipelineCancel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/pipeline/cancel", {});
      return (await res.json()) as { ok: boolean; state: PipelineState | null };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline/status"] });
    },
  });
}

export function usePipelineRemove() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/pipeline");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/pipeline/status"] }),
  });
}

export function usePipelineResume() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/pipeline/resume", {});
      return (await res.json()) as { ok: boolean; resumed: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline/status"] });
    },
  });
}
