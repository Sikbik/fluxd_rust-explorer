import { Suspense } from "react";
import { TransactionDetail } from "@/components/transaction/TransactionDetail";
import { Skeleton } from "@/components/ui/skeleton";
import { ExplorerPageShell } from "@/components/layout/ExplorerPageShell";

interface PageProps {
  params: {
    txid: string;
  };
}

export default function TransactionPage({ params }: PageProps) {
  const txLabel = `${params.txid.slice(0, 14)}...${params.txid.slice(-8)}`;

  return (
    <ExplorerPageShell
      eyebrow="Transaction Trace"
      title={`Transaction ${txLabel}`}
      description="Analyze signatures, inputs, outputs, fees, and raw wire data for a single transaction."
      chips={["Forensic transaction view", "Input/output breakdown", "Raw data + structure"]}
    >
      <Suspense fallback={<TransactionDetailSkeleton />}>
        <TransactionDetail txid={params.txid} />
      </Suspense>
    </ExplorerPageShell>
  );
}

function TransactionDetailSkeleton() {
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
