import { useQuery } from "@tanstack/react-query";

import { FluxAPI } from "@/lib/api/client";
import type { HomeSnapshot } from "@/types/flux-api";

export function useHomeSnapshot() {
  return useQuery<HomeSnapshot, Error>({
    queryKey: ["home-snapshot"],
    queryFn: () => FluxAPI.getHomeSnapshot(),
    staleTime: 2 * 1000,
    refetchInterval: 2 * 1000,
    refetchIntervalInBackground: true,
    retry: false,
    placeholderData: (previousData) => previousData,
  });
}
