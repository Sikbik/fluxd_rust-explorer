import { Suspense } from "react";
import { AddressDetail } from "@/components/address/AddressDetail";
import { Skeleton } from "@/components/ui/skeleton";
import { ExplorerPageShell } from "@/components/layout/ExplorerPageShell";

interface PageProps {
  params: {
    address: string;
  };
}

export default function AddressPage({ params }: PageProps) {
  return (
    <ExplorerPageShell
      eyebrow="Address Telemetry"
      title={`Address ${params.address}`}
      description="Track balance movement, fluxnode activity, and chronological transfer flow for this wallet."
      chips={["Live address stream", "Balance intelligence", "Export-ready history"]}
    >
      <Suspense fallback={<AddressDetailSkeleton />}>
        <AddressDetail address={params.address} />
      </Suspense>
    </ExplorerPageShell>
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
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
