import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export const DEFAULT_RESOURCE_MANAGER_BASE_URL = "https://bfcf8e16-134a-45c0-baa0-2cd6a853bf53-00-3sk70h4mnkimn.spock.replit.dev";

export function useResourceManagerStatus() {
  return useQuery<{ configured: boolean; baseUrl: string; hasKey: boolean; health: { ok: boolean; status: number; body: unknown } }>({
    queryKey: ["/api/resource-manager/status"],
    refetchInterval: 60000,
  });
}

export function useConfigureResourceManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { baseUrl: string; apiKey?: string }) => {
      const response = await apiRequest("POST", "/api/resource-manager/config", {
        baseUrl: payload.baseUrl,
        ...(payload.apiKey ? { apiKey: payload.apiKey } : {}),
      });
      return response.json() as Promise<{
        configured: boolean;
        baseUrl: string;
        hasKey: boolean;
        health: { ok: boolean; status: number; body: unknown };
      }>;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/resource-manager/status"], data);
      queryClient.invalidateQueries({ queryKey: ["/api/resource-manager/status"] });
    },
  });
}
