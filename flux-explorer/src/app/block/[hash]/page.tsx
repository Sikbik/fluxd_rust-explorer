import { Suspense } from "react";
import { BlockDetail } from "@/components/block/BlockDetail";
import { Skeleton } from "@/components/ui/skeleton";
import { ExplorerPageShell } from "@/components/layout/ExplorerPageShell";

interface PageProps {
  params: {
    hash: string;
  };
}

export default function BlockPage({ params }: PageProps) {
  const isHeightQuery = /^[0-9]+$/.test(params.hash);
  const blockLabel = isHeightQuery
    ? `#${Number(params.hash).toLocaleString()}`
    : `${params.hash.slice(0, 14)}...${params.hash.slice(-8)}`;

  return (
    <ExplorerPageShell
      eyebrow="Block Inspector"
      title={`Block ${blockLabel}`}
      description="Deep inspection of block composition, transactions, and confirmation telemetry."
      chips={["Detailed block decode", "FluxNode messages", "Raw chain evidence"]}
    >
      <Suspense fallback={<BlockDetailSkeleton />}>
        <BlockDetail hashOrHeight={params.hash} />
      </Suspense>
    </ExplorerPageShell>
  );
}

function BlockDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-6">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}
