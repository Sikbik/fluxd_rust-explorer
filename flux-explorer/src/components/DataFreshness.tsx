"use client";

import { useMemo } from "react";
import { useNetworkStatus } from "@/lib/api/hooks";

function formatAgeSeconds(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return "-";
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s`;
  if (ageSeconds < 60 * 60) return `${Math.floor(ageSeconds / 60)}m`;
  return `${Math.floor(ageSeconds / 3600)}h`;
}

export function DataFreshness() {
  const { data, isLoading, isError } = useNetworkStatus();

  const { label, title } = useMemo(() => {
    if (isLoading) return { label: "…", title: "Loading status" };
    if (isError || !data) return { label: "?", title: "Status unavailable" };

    const iso = data.indexer?.generatedAt ?? data.indexer?.lastSyncTime;
    if (!iso) return { label: "-", title: "No freshness timestamp" };

    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return { label: "-", title: `Bad timestamp: ${iso}` };

    const ageSeconds = (Date.now() - ts) / 1000;
    const age = formatAgeSeconds(ageSeconds);

    return { label: age, title: `Data age: ${age} (generated at ${iso})` };
  }, [data, isLoading, isError]);

  return (
    <div
      className="hidden lg:flex items-center px-3 py-1.5 rounded-lg bg-white/5 border border-[var(--flux-border)] text-xs text-[var(--flux-text-muted)]"
      title={title}
    >
      <span className="mr-2">Fresh:</span>
      <span className="font-medium text-[var(--flux-text-secondary)]">{label}</span>
    </div>
  );
}
