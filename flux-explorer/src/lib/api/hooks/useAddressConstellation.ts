import { useQuery, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { getAddressConstellation } from "@/lib/api/address-constellation-client";
import type { AddressConstellationData } from "@/types/address-constellation";

export const addressConstellationKeys = {
  all: ["address-constellation"] as const,
  detail: (address: string) =>
    [...addressConstellationKeys.all, address] as const,
};

export function useAddressConstellation(
  address: string,
  options?: Omit<
    UseQueryOptions<AddressConstellationData, Error>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<AddressConstellationData, Error> {
  return useQuery<AddressConstellationData, Error>({
    queryKey: addressConstellationKeys.detail(address),
    queryFn: () => getAddressConstellation(address),
    enabled: Boolean(address),
    staleTime: 20_000,
    retry: 0,
    ...options,
  });
}
