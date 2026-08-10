import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Strategy, TradeLogEntry } from "@shared/schema";

export function useVolatilityScores() {
  return useQuery<{
    symbol: string;
    name: string;
    score: number;
    swings1to5: number;
    largeSwingsUp: number;
    largeSwingsDown: number;
    riskGauge: number;
    currentPrice: number;
    bitunixSymbol: string;
    score4h: number;
    priceChange24h: number;
  }[]>({
    queryKey: ["/api/volatility/scores"],
    refetchInterval: 60000,
  });
}

export function useSimulation() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: { symbol?: string; feeRate?: number; amountPerGrid?: number }) => {
      const res = await apiRequest("POST", "/api/grid/simulate", data);
      return res.json();
    },
    onError: (e: Error) => {
      toast({ title: "Simulation Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useTandemSimulation() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: { symbol?: string; totalCapital?: number; leverage?: number; feeRate?: number; feeMultiplier?: number; days?: number }) => {
      const res = await apiRequest("POST", "/api/tandem/simulate", data);
      return res.json();
    },
    onError: (e: Error) => {
      toast({ title: "Tandem Simulation Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useQuickStart() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: { amount: number; symbol?: string; twinMode?: boolean; twinGapPct?: number }) => {
      const res = await apiRequest("POST", "/api/strategies/quickstart", data);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({
        title: "Strategy Started",
        description: `Started ${data.selectedPair} (${data.pairName}) with volatility score ${data.volatilityScore}`,
      });
    },
    onError: (e: Error) => {
      toast({ title: "Quick Start Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useConnectionStatus() {
  return useQuery<{ connected: boolean; message: string }>({
    queryKey: ["/api/connection"],
    refetchInterval: 30000,
  });
}

export function useAccount() {
  return useQuery<{
    balances: any[];
    positions: any[];
    connected: boolean;
  }>({
    queryKey: ["/api/account"],
    refetchInterval: 15000,
  });
}

export function useStrategies() {
  return useQuery<Strategy[]>({
    queryKey: ["/api/strategies"],
    refetchInterval: 10000,
  });
}

export function useStartStrategy() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/start`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Strategy Started", description: "The strategy is now actively trading." });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });
}

export function useStopStrategy() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/stop`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Strategy Stopped" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });
}

export function useDeleteStrategy() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/strategies/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Strategy Deleted" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });
}

export function useUpdateStrategyConfig() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, config }: { id: number; config: Record<string, any> }) => {
      const res = await apiRequest("PATCH", `/api/strategies/${id}`, { config });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Config Updated" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });
}

export function useTradeLogs(strategyId?: number) {
  const key = strategyId ? ["/api/trades", String(strategyId)] : ["/api/trades"];
  return useQuery<TradeLogEntry[]>({
    queryKey: key,
    queryFn: async () => {
      const url = strategyId ? `/api/trades?strategyId=${strategyId}` : "/api/trades";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch trade logs");
      return res.json();
    },
    refetchInterval: 10000,
  });
}

export function useGridCalculator() {
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: { symbol: string; feeRate?: number }) => {
      const res = await apiRequest("POST", "/api/grid/calculate", {
        symbol: data.symbol,
        feeRate: data.feeRate || 0.0006,
      });
      return res.json();
    },
    onError: (e: Error) => {
      toast({ title: "Calculation Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useMarginInfo(strategyId: number, enabled: boolean) {
  return useQuery<{
    removableOrders: number;
    removableMargin: number;
    currentPrice: number;
    lowestBuyPrice: number | null;
    bandLow: number;
    needsExtension: boolean;
    uncoveredLevels: number;
  }>({
    queryKey: ["/api/strategies", strategyId, "margin-info"],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/${strategyId}/margin-info`);
      if (!res.ok) throw new Error("Failed to fetch margin info");
      return res.json();
    },
    enabled,
    refetchInterval: 10000,
  });
}

export function useExtendOrders() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/extend-orders`);
      return res.json();
    },
    onSuccess: (data, id) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategies", id, "margin-info"] });
      queryClient.invalidateQueries({ queryKey: ["/api/account"] });
      toast({ title: "Orders Extended", description: data.message });
    },
    onError: (e: Error) => {
      toast({ title: "Extend Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useAddMargin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, amount }: { id: number; amount: number }) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/add-margin`, { amount });
      return res.json();
    },
    onSuccess: (data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategies", id, "margin-info"] });
      queryClient.invalidateQueries({ queryKey: ["/api/account"] });
      if (data.success === false) {
        toast({ title: "Add Margin Failed", description: data.message, variant: "destructive" });
      } else {
        toast({ title: "Margin Added", description: data.message });
      }
    },
    onError: (e: Error) => {
      toast({ title: "Add Margin Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useRemoveMargin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, count }: { id: number; count: number }) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/remove-margin`, { count });
      return res.json();
    },
    onSuccess: (data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategies", id, "margin-info"] });
      queryClient.invalidateQueries({ queryKey: ["/api/account"] });
      toast({ title: "Margin Removed", description: data.message });
    },
    onError: (e: Error) => {
      toast({ title: "Remove Margin Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useManualRotation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, newSymbol }: { id: number; newSymbol: string }) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/rotate`, { newSymbol });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/account"] });
      toast({ title: "Rotation Started", description: data.message });
    },
    onError: (e: Error) => {
      toast({ title: "Rotation Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useTandemStart() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: { symbol: string; totalCapital: number; leverage: number; rotationEnabled?: boolean }) => {
      const res = await apiRequest("POST", "/api/strategies/tandem-start", data);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Tandem Started", description: `${data.symbol} tandem L/S running at ${data.config?.leverage}x` });
    },
    onError: (e: Error) => {
      toast({ title: "Tandem Start Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useGoldLongStart() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: { symbol: string; baseCapital: number; leverage: number }) => {
      const res = await apiRequest("POST", "/api/strategies/gold-long-start", data);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Gold Long Started", description: `${data.symbol} long opened at ${data.config?.leverage}x` });
    },
    onError: (e: Error) => {
      toast({ title: "Gold Long Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function useHedgePairStart() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: { symbol: string; capitalPerSide: number; leverage: number; autoRestart?: boolean; trailingPct?: number }) => {
      const res = await apiRequest("POST", "/api/strategies/hedge-pair-start", data);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Hedge Pair Started", description: `${data.symbol} L+S opened at ${data.config?.leverage}x` });
    },
    onError: (e: Error) => {
      toast({ title: "Hedge Pair Failed", description: e.message, variant: "destructive" });
    },
  });
}

export function usePairInfo(symbol: string) {
  return useQuery({
    queryKey: ["/api/pair-info", symbol],
    enabled: !!symbol && symbol.length >= 4,
    staleTime: 60000,
  });
}

export function useEmergencyStop() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/emergency-stop");
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/account"] });
      toast({ title: "Emergency Stop", description: data.message });
    },
    onError: (e: Error) => {
      toast({ title: "Emergency Stop Failed", description: e.message, variant: "destructive" });
    },
  });
}
