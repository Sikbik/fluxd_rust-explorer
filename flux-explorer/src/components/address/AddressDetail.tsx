"use client";

import { useEffect } from "react";
import { useAddress } from "@/lib/api/hooks/useAddress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AddressHeader } from "./AddressHeader";
import { AddressOverview } from "./AddressOverview";
import { AddressConstellation } from "./AddressConstellation";
import { AddressTransactions } from "./AddressTransactions";
import { PollingControls } from "@/components/common/PollingControls";
import { usePolling, POLLING_INTERVALS } from "@/hooks/usePolling";
import { AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getAddressConstellation } from "@/lib/api/address-constellation-client";
import { addressConstellationKeys } from "@/lib/api/hooks/useAddressConstellation";

interface AddressDetailProps {
  address: string;
}

export function AddressDetail({ address }: AddressDetailProps) {
  const queryClient = useQueryClient();

  // Set up polling for address balance updates
  const polling = usePolling({
    interval: POLLING_INTERVALS.NORMAL, // 30 seconds default
    enabled: true,
  });

  const { data: addressInfo, isLoading, error, refetch } = useAddress(address, {
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  // Auto-refresh based on polling controls
  useEffect(() => {
    if (!polling.isPolling) return;

    const intervalId = setInterval(() => {
      polling.refresh();
    }, polling.interval);

    return () => clearInterval(intervalId);
  }, [polling.isPolling, polling.interval, polling.refresh]);

  useEffect(() => {
    if (polling.refreshToken === 0) return;
    refetch({ cancelRefetch: true });
  }, [polling.refreshToken, refetch]);

  useEffect(() => {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return;

    queryClient
      .prefetchQuery({
        queryKey: addressConstellationKeys.detail(normalizedAddress),
        queryFn: () => getAddressConstellation(normalizedAddress),
        staleTime: 20_000,
      })
      .catch(() => {
        // Prefetch is best-effort only.
      });
  }, [address, queryClient]);

  // Connect manual refresh to query refetch
  const handleRefresh = () => {
    polling.refresh();
  };

  if (isLoading) {
    return <AddressDetailSkeleton />;
  }

  if (error) {
    return (
      <Card className="rounded-2xl border border-destructive/60 bg-[linear-gradient(140deg,rgba(55,16,26,0.38),rgba(10,14,30,0.36))]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-5 w-5" />
            Error Loading Address
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            {error.message || "Failed to load address data. Please try again."}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!addressInfo) {
    return (
      <Card className="rounded-2xl border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.46),rgba(7,15,33,0.22))]">
        <CardHeader>
          <CardTitle>Address Not Found</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            The requested address could not be found.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Poll more frequently if there are unconfirmed transactions
  const hasUnconfirmedTxs = addressInfo.unconfirmedTxApperances > 0;
  if (hasUnconfirmedTxs && polling.interval > POLLING_INTERVALS.FREQUENT) {
    polling.setInterval(POLLING_INTERVALS.FREQUENT);
  }

  return (
    <div className="space-y-6">
      {/* Polling Controls */}
      <PollingControls polling={{ ...polling, refresh: handleRefresh }} />

      {/* Address Header with QR Code */}
      <AddressHeader addressInfo={addressInfo} />

      {/* Address Overview Stats */}
      <AddressOverview addressInfo={addressInfo} />

      {/* Address Relationship Constellation */}
      <AddressConstellation
        address={address}
        pollingToken={polling.refreshToken}
      />

      {/* Transaction History */}
      <AddressTransactions
        addressInfo={addressInfo}
        pollingToken={polling.refreshToken}
        pollingInterval={polling.interval}
        pollingActive={polling.isPolling}
      />
    </div>
  );
}

function AddressDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-48 w-full" />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
      <Skeleton className="h-[460px] w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
