import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { type CryptoStat } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export function useCryptoStats() {
  return useQuery<CryptoStat[]>({
    queryKey: [api.stats.list.path],
    queryFn: async () => {
      const res = await fetch(api.stats.list.path);
      if (!res.ok) throw new Error("Failed to fetch crypto stats");
      const data = await res.json();
      return api.stats.list.responses[200].parse(data);
    },
    refetchInterval: 60000, // Auto-refresh every minute
  });
}

export function useRefreshStats() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(api.stats.refresh.path, {
        method: api.stats.refresh.method,
      });
      
      if (!res.ok) {
        throw new Error("Failed to refresh data");
      }
      
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.stats.list.path] });
      toast({
        title: "Data Refreshed",
        description: "Latest market volatility data has been loaded.",
      });
    },
    onError: (error) => {
      toast({
        title: "Update Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
