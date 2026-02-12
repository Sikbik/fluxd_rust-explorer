import { Suspense } from "react";
import { BlocksList } from "@/components/blocks/BlocksList";
import { Skeleton } from "@/components/ui/skeleton";
import { ExplorerPageShell } from "@/components/layout/ExplorerPageShell";

export const metadata = {
  title: "Recent Blocks - Flux Explorer",
  description: "Browse recent blocks on the Flux blockchain",
};

function BlocksListSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(10)].map((_, i) => (
        <div
          key={i}
          className="rounded-2xl border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.54),rgba(7,15,34,0.2))] p-4"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-6 w-24" />
            </div>
            <div className="flex items-center gap-4">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function BlocksPage() {
  return (
    <ExplorerPageShell
      eyebrow="Chain Surface"
      title="Recent Blocks"
      description="Browse the latest Flux blocks in a live, high-frequency stream with PoUW confirmation context."
      chips={["Live chain feed", "PoUW confirmations", "Real-time cadence"]}
    >
      <Suspense fallback={<BlocksListSkeleton />}>
        <BlocksList />
      </Suspense>
    </ExplorerPageShell>
  );
}
