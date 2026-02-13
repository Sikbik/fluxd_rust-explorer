import { keepPreviousData, useQuery, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { getAddressConstellation } from "@/lib/api/address-constellation-client";
import type { AddressConstellationData } from "@/types/address-constellation";

export type AddressConstellationScanMode = "fast" | "deep";

export const addressConstellationKeys = {
  all: ["address-constellation"] as const,
  detail: (address: string, mode: AddressConstellationScanMode = "fast") =>
    [...addressConstellationKeys.all, address, mode] as const,
};

export function useAddressConstellation(
  address: string,
  mode: AddressConstellationScanMode = "fast",
  options?: Omit<
    UseQueryOptions<AddressConstellationData, Error>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<AddressConstellationData, Error> {
  return useQuery<AddressConstellationData, Error>({
    queryKey: addressConstellationKeys.detail(address, mode),
    queryFn: () => getAddressConstellation(address, { mode }),
    enabled: Boolean(address),
    staleTime: 20_000,
    retry: 0,
    placeholderData: keepPreviousData,
    ...options,
  });
}
