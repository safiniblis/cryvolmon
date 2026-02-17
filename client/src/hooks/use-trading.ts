import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Strategy, TradeLogEntry } from "@shared/schema";

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

export function useCreateStrategy() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/strategies", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Strategy Created", description: "Your trading strategy has been saved." });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
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

export function useManualTrade() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      symbol: string;
      side: string;
      quantity: number;
      orderType: string;
      price?: number;
      leverage?: number;
    }) => {
      const res = await apiRequest("POST", "/api/trade", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/account"] });
      toast({ title: "Trade Executed", description: "Your order has been placed." });
    },
    onError: (e: Error) => {
      toast({ title: "Trade Failed", description: e.message, variant: "destructive" });
    },
  });
}
