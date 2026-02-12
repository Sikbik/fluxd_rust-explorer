"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { FluxAPI } from "@/lib/api";
import { ExplorerPageShell } from "@/components/layout/ExplorerPageShell";

/**
 * Universal search page that intelligently routes to the correct page
 * Handles ambiguous 64-character hex strings by checking if they're transactions or blocks
 */
export default function SearchPage() {
  const router = useRouter();
  const params = useParams();
  const query = params.query as string;

  useEffect(() => {
    async function resolveSearch() {
      if (!query) {
        router.replace("/");
        return;
      }

      const trimmedQuery = query.trim();

      // Number: block height
      if (/^[0-9]+$/.test(trimmedQuery)) {
        router.replace(`/block/${trimmedQuery}`);
        return;
      }

      // Address
      if (trimmedQuery.startsWith("t1") || trimmedQuery.startsWith("t3")) {
        router.replace(`/address/${trimmedQuery}`);
        return;
      }

      // 64-character hex: could be transaction or block hash
      if (/^[a-fA-F0-9]{64}$/.test(trimmedQuery)) {
        try {
          // Try as transaction first (more common)
          await FluxAPI.getTransaction(trimmedQuery);
          router.replace(`/tx/${trimmedQuery}`);
          return;
        } catch {
          // If transaction fails, try as block hash
          try {
            await FluxAPI.getBlock(trimmedQuery);
            router.replace(`/block/${trimmedQuery}`);
            return;
          } catch {
            // Neither worked - show error
            router.replace(`/tx/${trimmedQuery}`);
            return;
          }
        }
      }

      // Default: try as transaction
      router.replace(`/tx/${trimmedQuery}`);
    }

    resolveSearch();
  }, [query, router]);

  return (
    <ExplorerPageShell
      eyebrow="Resolver"
      title="Search Routing"
      description="Detecting whether your query is a block, transaction, or address and redirecting to the correct view."
      chips={["Unified query engine", "Fast route resolution"]}
    >
      <div className="flex min-h-[320px] items-center justify-center">
        <div className="rounded-2xl border border-white/[0.1] bg-[linear-gradient(140deg,rgba(8,20,42,0.58),rgba(7,15,34,0.2))] px-8 py-10 text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-[var(--flux-cyan)]" />
          <p className="text-[var(--flux-text-secondary)]">Searching...</p>
          <p className="mt-1 text-xs uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
            Query: {query}
          </p>
        </div>
      </div>
    </ExplorerPageShell>
  );
}
