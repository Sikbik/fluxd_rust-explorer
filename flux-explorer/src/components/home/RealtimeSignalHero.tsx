"use client";

import Link from "next/link";
import { SearchBar } from "@/components/SearchBar";
import { useHomeSnapshot } from "@/lib/api/hooks/useHomeSnapshot";
import { useDashboardStats } from "@/lib/api/hooks/useDashboardStats";
import { useFluxSupply } from "@/lib/api/hooks/useFluxSupply";
import {
  useArcaneAdoption,
  useFluxInstancesCount,
  useFluxNodeCount,
} from "@/lib/api/hooks/useFluxStats";
import type { BlockSummary } from "@/types/flux-api";

type MetricSignal = {
  id: string;
  label: string;
  value: string;
  detail: string;
  tint: string;
};

const BLOCK_TONES = [
  {
    edge: "rgba(88, 239, 255, 0.92)",
    glow: "rgba(88, 239, 255, 0.35)",
    core: "rgba(12, 37, 69, 0.9)",
  },
  {
    edge: "rgba(190, 128, 255, 0.9)",
    glow: "rgba(190, 128, 255, 0.35)",
    core: "rgba(28, 20, 68, 0.9)",
  },
  {
    edge: "rgba(112, 255, 186, 0.9)",
    glow: "rgba(112, 255, 186, 0.35)",
    core: "rgba(16, 42, 45, 0.9)",
  },
  {
    edge: "rgba(255, 182, 92, 0.9)",
    glow: "rgba(255, 182, 92, 0.35)",
    core: "rgba(52, 34, 22, 0.9)",
  },
];

const BLOCK_POSITIONS = [
  { left: 10, top: 50 },
  { left: 29, top: 43 },
  { left: 48, top: 54 },
  { left: 67, top: 44 },
  { left: 86, top: 52 },
];

function formatInteger(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.trunc(value).toLocaleString("en-US");
}

function formatCompact(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: digits,
  }).format(value);
}

function formatMillions(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatTimeAgo(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return "—";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - Math.trunc(timestamp));
  if (diff < 60) return `${diff}s`;
  const minutes = Math.floor(diff / 60);
  const seconds = diff % 60;
  return `${minutes}m ${seconds}s`;
}

function createSignalWave(seedText: string): number[] {
  let hash = 0;
  for (let index = 0; index < seedText.length; index += 1) {
    hash = (hash * 31 + seedText.charCodeAt(index)) % 9973;
  }

  return Array.from({ length: 8 }, (_, index) => 24 + ((hash + index * 19) % 56));
}

function MetricSignalTile({ metric, index }: { metric: MetricSignal; index: number }) {
  const wave = createSignalWave(`${metric.id}:${metric.value}:${metric.detail}`);
  const topAccent = `linear-gradient(90deg, transparent 0%, rgba(${metric.tint}, 0.95) 40%, transparent 100%)`;

  return (
    <div
      className="group relative isolate overflow-hidden rounded-[18px] border border-white/10 bg-[linear-gradient(140deg,rgba(5,18,38,0.9),rgba(8,10,30,0.92))] px-4 py-3 transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-1 hover:border-white/25 hover:shadow-[0_10px_35px_rgba(0,0,0,0.35)]"
      style={{
        animation: "flux-rise-in 520ms cubic-bezier(0.16,1,0.3,1) both",
        animationDelay: `${index * 70}ms`,
        clipPath:
          "polygon(0 10px,10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%)",
      }}
    >
      <div
        className="absolute inset-x-0 top-0 h-px opacity-80"
        style={{ background: topAccent }}
      />
      <div
        className="absolute -inset-y-4 -left-16 w-24 opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `rgba(${metric.tint}, 0.45)` }}
      />

      <div className="relative">
        <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--flux-text-dim)]">
          {metric.label}
        </p>
        <p className="mt-1 font-mono text-xl font-semibold text-white">{metric.value}</p>
        <p className="mt-1 text-[11px] text-[var(--flux-text-muted)]">{metric.detail}</p>
        <div className="mt-2.5 flex h-8 items-end gap-1 opacity-75 transition-opacity group-hover:opacity-100">
          {wave.map((height, waveIndex) => (
            <span
              key={`${metric.id}-${waveIndex}`}
              className="w-1 rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.9),rgba(255,255,255,0.2))]"
              style={{
                height: `${height}%`,
                boxShadow: `0 0 10px rgba(${metric.tint}, 0.45)`,
                animation: "flux-wave-pulse 1600ms ease-in-out infinite",
                animationDelay: `${waveIndex * 90}ms`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function HeroBlockNode({ block, index }: { block: BlockSummary; index: number }) {
  const tone = BLOCK_TONES[index % BLOCK_TONES.length];
  const position = BLOCK_POSITIONS[index % BLOCK_POSITIONS.length];
  const normalTx = block.regularTxCount ?? block.txlength ?? 0;
  const fluxnodeTx = block.nodeConfirmationCount ?? 0;
  const totalTx = block.txlength ?? normalTx + fluxnodeTx;

  return (
    <Link
      href={`/block/${block.height}`}
      className="group absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--flux-cyan)] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgba(3,8,20,0.9)]"
      style={{
        left: `${position.left}%`,
        top: `${position.top}%`,
        animation: "flux-block-stream 6.6s cubic-bezier(0.32,0.02,0.2,1) infinite",
        animationDelay: `${index * 360}ms`,
      }}
    >
      <div className="relative h-16 w-16 sm:h-20 sm:w-20">
        <div
          className="absolute inset-0 rotate-45 rounded-2xl border transition-transform duration-300 group-hover:scale-110"
          style={{
            borderColor: tone.edge,
            background: `linear-gradient(135deg, rgba(255,255,255,0.18), ${tone.core})`,
            boxShadow: `0 0 18px ${tone.glow}`,
          }}
        />
        <div
          className="absolute inset-[24%] rotate-45 rounded-lg border"
          style={{ borderColor: "rgba(255,255,255,0.7)" }}
        />
        <div
          className="absolute inset-0 rotate-45 rounded-2xl opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100"
          style={{ background: tone.glow }}
        />
        <span
          className="absolute left-1/2 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-gradient-to-b from-white via-white/30 to-transparent opacity-0 group-hover:opacity-100"
          style={{ animation: "flux-spark-zap 900ms ease-in-out infinite" }}
        />
      </div>

      <div className="mt-2 text-center font-mono text-[11px] text-white/90 drop-shadow-[0_0_8px_rgba(56,232,255,0.35)]">
        #{block.height.toLocaleString()}
      </div>

      <div className="pointer-events-none absolute left-1/2 top-0 z-30 hidden w-56 -translate-x-1/2 -translate-y-[115%] rounded-2xl border border-white/15 bg-[linear-gradient(160deg,rgba(4,16,34,0.95),rgba(10,12,28,0.92))] p-3 opacity-0 transition-[opacity,transform] duration-300 group-hover:opacity-100 sm:block">
        <p className="font-mono text-xs text-[var(--flux-cyan)]">
          Block #{block.height.toLocaleString()}
        </p>
        <div className="mt-2 space-y-1.5 text-[11px] text-[var(--flux-text-secondary)]">
          <div className="flex items-center justify-between">
            <span>Total TX</span>
            <span className="font-mono text-white">{formatInteger(totalTx)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Normal</span>
            <span className="font-mono text-white">{formatInteger(normalTx)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Fluxnode</span>
            <span className="font-mono text-white">{formatInteger(fluxnodeTx)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Age</span>
            <span className="font-mono text-white">{formatTimeAgo(block.time)} ago</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Size</span>
            <span className="font-mono text-white">{(block.size / 1024).toFixed(1)} KB</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

export function RealtimeSignalHero() {
  const { data: homeSnapshot, isLoading: homeLoading } = useHomeSnapshot();
  const { data: dashboardStats } = useDashboardStats();
  const { data: supplyStats } = useFluxSupply();
  const { data: nodeCount } = useFluxNodeCount();
  const { data: instancesCount } = useFluxInstancesCount();
  const { data: arcaneAdoption } = useArcaneAdoption();

  const latestBlocks = (homeSnapshot?.latestBlocks ?? []).slice(0, 5);
  const isWarmingUp = homeSnapshot?.warmingUp === true || homeSnapshot?.degraded === true;
  const retryAfter = Math.max(1, homeSnapshot?.retryAfterSeconds ?? 3);

  const tx24h = dashboardStats?.transactions24h ?? null;
  const tx24hNormal = dashboardStats?.transactions24hNormal ?? null;
  const tx24hFluxnode = dashboardStats?.transactions24hFluxnode ?? null;
  const blockTimeSeconds = dashboardStats?.averages.blockTimeSeconds ?? null;

  const metrics: MetricSignal[] = [
    {
      id: "height",
      label: "Block Height",
      value: formatInteger(homeSnapshot?.tipHeight),
      detail: "Current chain position",
      tint: "88, 239, 255",
    },
    {
      id: "nodes",
      label: "PoUW Nodes",
      value: formatInteger(nodeCount?.total),
      detail: "Enabled FluxNodes",
      tint: "112, 255, 186",
    },
    {
      id: "instances",
      label: "App Instances",
      value: formatInteger(instancesCount),
      detail: "Active workloads",
      tint: "190, 128, 255",
    },
    {
      id: "arcane",
      label: "ArcaneOS",
      value: arcaneAdoption ? `${arcaneAdoption.percentage.toFixed(1)}%` : "—",
      detail: arcaneAdoption
        ? `${formatInteger(arcaneAdoption.arcane)} / ${formatInteger(arcaneAdoption.total)} nodes`
        : "Node rollout mix",
      tint: "255, 182, 92",
    },
    {
      id: "supply",
      label: "Circulating",
      value: formatMillions(supplyStats?.circulatingSupply),
      detail: "FLUX in market",
      tint: "88, 239, 255",
    },
    {
      id: "tx",
      label: "Transactions · 24h",
      value: formatCompact(tx24h),
      detail:
        tx24hNormal != null && tx24hFluxnode != null
          ? `Normal ${formatCompact(tx24hNormal)} · Fluxnode ${formatCompact(tx24hFluxnode)}`
          : "Normal + Fluxnode flow",
      tint: "190, 128, 255",
    },
    {
      id: "block-time",
      label: "Avg Block Time",
      value: blockTimeSeconds != null ? `${blockTimeSeconds.toFixed(1)}s` : "—",
      detail: "Target 30 seconds",
      tint: "112, 255, 186",
    },
    {
      id: "supply-cap",
      label: "Max Supply",
      value: formatMillions(supplyStats?.maxSupply),
      detail: "Total eventual issuance",
      tint: "255, 182, 92",
    },
  ];

  const sparkOffsets = [6, 14, 22, 35, 47, 59, 71, 84, 92];

  return (
    <section className="relative isolate overflow-hidden rounded-[34px] border border-white/10 px-4 py-8 sm:px-8 sm:py-10 md:px-10 md:py-12">
      <div className="absolute inset-0 bg-[radial-gradient(120%_140%_at_50%_-20%,rgba(83,240,255,0.2),transparent_50%),radial-gradient(130%_90%_at_100%_0%,rgba(183,121,255,0.25),transparent_45%),linear-gradient(180deg,rgba(4,10,23,0.95)_0%,rgba(3,7,19,0.98)_100%)]" />
      <div className="flux-home-grid-motion absolute inset-0 opacity-70" />
      <div className="absolute inset-0 bg-[radial-gradient(70%_60%_at_50%_100%,rgba(23,140,255,0.14),transparent_70%)]" />

      <div className="relative z-10">
        <div className="mx-auto max-w-5xl text-center">
          <h1 className="text-4xl font-black uppercase tracking-[0.18em] text-white drop-shadow-[0_0_22px_rgba(88,239,255,0.45)] sm:text-5xl lg:text-6xl">
            Flux Explorer
          </h1>
          <p className="mx-auto mt-4 max-w-3xl text-sm text-[var(--flux-text-secondary)] sm:text-base">
            Observe decentralized compute in real time. Hover live block packets to inspect
            transaction flow and network cadence as it streams across the PoUW rail.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-[11px] uppercase tracking-[0.22em] text-[var(--flux-text-muted)]">
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--flux-green)] shadow-[0_0_14px_rgba(34,197,94,0.9)]" />
              Live Network
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--flux-cyan)] shadow-[0_0_14px_rgba(56,232,255,0.9)]" />
              Sub-Second Refresh
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--flux-purple)] shadow-[0_0_14px_rgba(168,85,247,0.9)]" />
              Decentralized Cloud
            </span>
          </div>
          <div className="mt-7 flex justify-center">
            <SearchBar />
          </div>
        </div>

        <div className="relative mt-10 overflow-hidden rounded-[26px] border border-white/10 bg-[linear-gradient(180deg,rgba(7,18,40,0.84),rgba(3,8,20,0.92))] px-3 py-8 sm:px-6 sm:py-10">
          <div className="absolute inset-0 bg-[radial-gradient(80%_100%_at_50%_50%,rgba(83,240,255,0.09),transparent_70%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(125deg,rgba(255,255,255,0.06)_0%,transparent_30%,rgba(255,255,255,0.04)_60%,transparent_100%)] opacity-30" />

          <div className="relative h-[220px] sm:h-[260px] md:h-[300px]">
            <div className="absolute inset-x-[-8%] top-1/2 h-[2px] -translate-y-1/2 bg-[linear-gradient(90deg,transparent_0%,rgba(88,239,255,0.9)_20%,rgba(238,170,255,0.95)_50%,rgba(88,239,255,0.9)_80%,transparent_100%)]" />
            <div
              className="absolute inset-x-[-12%] top-1/2 h-7 -translate-y-1/2 bg-[linear-gradient(90deg,transparent,rgba(88,239,255,0.45),rgba(238,170,255,0.5),rgba(88,239,255,0.45),transparent)] blur-md"
              style={{ animation: "flux-energy-slide 2.3s linear infinite" }}
            />
            <div className="absolute inset-x-[6%] top-[58%] h-24 rounded-[100%] border-t border-white/25 opacity-65" style={{ animation: "flux-arc-breathe 3.4s ease-in-out infinite" }} />
            <div className="absolute inset-x-[18%] top-[42%] h-20 rounded-[100%] border-t border-white/15 opacity-45" style={{ animation: "flux-arc-breathe 3s ease-in-out infinite 800ms" }} />

            {sparkOffsets.map((offset, index) => (
              <span
                key={`spark-${offset}`}
                className="absolute w-px bg-gradient-to-b from-white via-white/60 to-transparent"
                style={{
                  left: `${offset}%`,
                  top: "50%",
                  height: `${20 + (index % 3) * 12}px`,
                  opacity: 0.75,
                  animation: "flux-spark-zap 1.3s ease-in-out infinite",
                  animationDelay: `${index * 160}ms`,
                }}
              />
            ))}

            {latestBlocks.length > 0 ? (
              latestBlocks.map((block, index) => (
                <HeroBlockNode key={block.hash} block={block} index={index} />
              ))
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="rounded-2xl border border-white/15 bg-[rgba(5,12,28,0.8)] px-5 py-4 text-center text-sm text-[var(--flux-text-secondary)]">
                  <p>{homeSnapshot?.message ?? "Synchronizing live block stream"}</p>
                  {isWarmingUp ? (
                    <p className="mt-1 text-xs text-[var(--flux-text-muted)]">
                      Retrying every {retryAfter}s
                    </p>
                  ) : null}
                  {homeLoading ? (
                    <p className="mt-1 text-xs text-[var(--flux-text-muted)]">Loading signal…</p>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric, index) => (
            <MetricSignalTile key={metric.id} metric={metric} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
