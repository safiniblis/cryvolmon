import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { MANAGER_BASE_URL, MANAGER_MODEL, MANAGER_PROVIDER } from "@shared/council-config";

export type AgentPosition = "manager" | "critic" | "architect" | "auditor" | "strategist";
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
  mode: "manager" | "council" | "agent";
  position?: AgentPosition;
  configured?: boolean;
  context?: string;
  slots?: AgentSlotView[];
  reply?: ManagerReply;
  members?: MemberResult[];
  synthesis?: MemberResult;
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
    position: "manager", role: "Decision & orchestration", title: "Manager / Builder",
    description: "OpenCode Go. GPT 5.6 Luna lead agent: delegates, cross-examines, delivers decisions.",
    provider: MANAGER_PROVIDER, baseUrl: MANAGER_BASE_URL, model: MANAGER_MODEL,
    hasKey: false, keyName: "OPENCODE_API_KEY", configured: false, lastError: null,
  },
  {
    position: "critic", role: "Adversarial risk review", title: "Critic",
    description: "Groq. Pokes holes — edge cases, failure paths, worst case.",
    provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile",
    hasKey: true, keyName: "DEEPSEEK_API_KEY", configured: true, lastError: null,
  },
  {
    position: "architect", role: "Structure & parameter design", title: "Architect",
    description: "Abacus RouteLLM Claude Sonnet 5. Permanent architecture and parameter-design seat.",
    provider: "abacus", baseUrl: "https://routellm.abacus.ai/v1", model: "claude-sonnet-5",
    hasKey: false, keyName: "HYPERBOLIC_API_KEY", configured: false, lastError: null,
  },
  {
    position: "auditor", role: "Health & rot scan", title: "Auditor",
    description: "OpenRouter free pool. Flags dead weight, config drift, over-leverage.",
    provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free",
    hasKey: false, keyName: "NEMOTRON_API_KEY", configured: false, lastError: null,
  },
  {
    position: "strategist", role: "Market read & proposals", title: "Strategist",
    description: "OpenCode free Big Pickle. Fast market/parameter read — concrete proposals.",
    provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", model: "big-pickle",
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
      mode: "manager" | "council" | "agent";
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
