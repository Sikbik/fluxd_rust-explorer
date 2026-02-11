"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { getRewardLabel } from "@/lib/block-rewards";
import type { BlockSummary } from "@/types/flux-api";

type MetricSignal = {
  id: string;
  label: string;
  value: string;
  detail: string;
  tint: string;
};

type PacketStage = "historical" | "current" | "future";

type RailPacket = {
  key: string;
  height: number;
  slot: number;
  stage: PacketStage;
  mined: boolean;
  hash: string | null;
  timestamp: number | null;
  totalTx: number;
  normalTx: number;
  fluxnodeTx: number;
};

type TxEstimate = {
  total: number;
  normal: number;
  fluxnode: number;
};

const SLOT_COUNT = 7;
const CENTER_SLOT = 3;
const SHIFT_SETTLE_MS = 32;
const RAIL_LEFT_BY_SLOT: Record<number, number> = {
  [-1]: -8,
  [0]: 8,
  [1]: 22,
  [2]: 36,
  [3]: 50,
  [4]: 64,
  [5]: 78,
  [6]: 92,
  [7]: 108,
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

function buildBlockMap(blocks: BlockSummary[]): Map<number, BlockSummary> {
  const blockMap = new Map<number, BlockSummary>();
  for (const block of blocks) {
    blockMap.set(block.height, block);
  }
  return blockMap;
}

function estimatePerBlockTransactions(blocks: BlockSummary[]): TxEstimate {
  if (blocks.length === 0) {
    return { total: 12, normal: 1, fluxnode: 11 };
  }

  let totalTx = 0;
  let totalNormal = 0;

  for (const block of blocks.slice(0, 8)) {
    const normal = block.regularTxCount ?? block.txlength ?? 1;
    const fluxnode = block.nodeConfirmationCount ?? Math.max(0, normal - 1);
    const total = block.txlength ?? normal + fluxnode;
    totalTx += total;
    totalNormal += normal;
  }

  const divisor = Math.max(1, Math.min(8, blocks.length));
  const estimatedTotal = Math.max(2, Math.round(totalTx / divisor));
  const estimatedNormal = Math.max(1, Math.round(totalNormal / divisor));
  const estimatedFluxnode = Math.max(0, estimatedTotal - estimatedNormal);

  return {
    total: estimatedTotal,
    normal: estimatedNormal,
    fluxnode: estimatedFluxnode,
  };
}

function slotToLeftPercent(slot: number): number {
  return RAIL_LEFT_BY_SLOT[slot] ?? 50;
}

function packetStageForHeight(height: number, tipHeight: number): PacketStage {
  if (height < tipHeight) return "historical";
  if (height === tipHeight) return "current";
  return "future";
}

function packetFromHeight(
  height: number,
  slot: number,
  tipHeight: number,
  blockMap: Map<number, BlockSummary>,
  txEstimate: TxEstimate
): RailPacket {
  const block = blockMap.get(height);
  const stage = packetStageForHeight(height, tipHeight);
  const fallbackNormal = txEstimate.normal;
  const fallbackFluxnode = txEstimate.fluxnode;
  const fallbackTotal = txEstimate.total;

  const normalTx = block?.regularTxCount ?? (stage === "future" ? fallbackNormal : 0);
  const fluxnodeTx = block?.nodeConfirmationCount ?? (stage === "future" ? fallbackFluxnode : 0);
  const totalTx = block?.txlength ?? Math.max(normalTx + fluxnodeTx, fallbackTotal);

  return {
    key: `packet-${height}`,
    height,
    slot,
    stage,
    mined: Boolean(block),
    hash: block?.hash ?? null,
    timestamp: block?.time ?? null,
    totalTx,
    normalTx,
    fluxnodeTx,
  };
}

function seedPackets(
  tipHeight: number,
  blockMap: Map<number, BlockSummary>,
  txEstimate: TxEstimate
): RailPacket[] {
  const packets: RailPacket[] = [];
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const height = tipHeight + (slot - CENTER_SLOT);
    packets.push(packetFromHeight(height, slot, tipHeight, blockMap, txEstimate));
  }
  return packets;
}

function hydratePackets(
  packets: RailPacket[],
  tipHeight: number,
  blockMap: Map<number, BlockSummary>,
  txEstimate: TxEstimate
): RailPacket[] {
  return packets
    .map((packet) => {
      const refreshed = packetFromHeight(
        packet.height,
        packet.slot,
        tipHeight,
        blockMap,
        txEstimate
      );
      return {
        ...packet,
        stage: refreshed.stage,
        mined: refreshed.mined,
        hash: refreshed.hash,
        timestamp: refreshed.timestamp,
        totalTx: refreshed.totalTx,
        normalTx: refreshed.normalTx,
        fluxnodeTx: refreshed.fluxnodeTx,
      };
    })
    .sort((first, second) => first.slot - second.slot);
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

function RailPacketNode({
  packet,
  tipHeight,
  tipTime,
  avgBlockTimeSeconds,
  nowSeconds,
}: {
  packet: RailPacket;
  tipHeight: number | null;
  tipTime: number | null;
  avgBlockTimeSeconds: number;
  nowSeconds: number;
}) {
  const tone = BLOCK_TONES[Math.abs(packet.height) % BLOCK_TONES.length];
  const isCurrent = packet.stage === "current";
  const isFuture = packet.stage === "future";
  const nodeSize = isCurrent ? 84 : 70;

  const etaSeconds = (() => {
    if (!isFuture || tipHeight == null) return null;
    const blocksAhead = packet.height - tipHeight;
    if (blocksAhead <= 0) return null;
    const rawEta = blocksAhead * avgBlockTimeSeconds;
    if (tipTime == null || !Number.isFinite(tipTime)) {
      return Math.max(1, Math.round(rawEta));
    }
    const elapsed = nowSeconds - tipTime;
    return Math.max(1, Math.round(rawEta - elapsed));
  })();

  const packetLabel = isFuture
    ? `Projected #${packet.height.toLocaleString()}`
    : `Block #${packet.height.toLocaleString()}`;

  return (
    <Link
      href={isFuture ? "/blocks" : `/block/${packet.height}`}
      className="group absolute top-1/2 z-20 -translate-y-1/2 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--flux-cyan)] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgba(3,8,20,0.9)]"
      style={{
        left: `${slotToLeftPercent(packet.slot)}%`,
        opacity: packet.slot < 0 || packet.slot > SLOT_COUNT - 1 ? 0 : 1,
        transition:
          "left 760ms cubic-bezier(0.22,1,0.36,1), opacity 480ms cubic-bezier(0.16,1,0.3,1)",
      }}
    >
      <div
        className="relative"
        style={{ width: `${nodeSize}px`, height: `${nodeSize}px` }}
      >
        <div
          className="absolute inset-0 rotate-45 rounded-[20px] border transition-transform duration-300 group-hover:scale-110"
          style={{
            borderColor: tone.edge,
            background: `linear-gradient(135deg, rgba(255,255,255,0.18), ${tone.core})`,
            boxShadow: `0 0 20px ${tone.glow}`,
            animation:
              packet.slot >= 6 && isFuture
                ? "flux-packet-charge 900ms cubic-bezier(0.22,1,0.36,1)"
                : undefined,
          }}
        />
        <div
          className="absolute inset-[23%] rotate-45 rounded-lg border"
          style={{ borderColor: "rgba(255,255,255,0.7)" }}
        />
        <div
          className="absolute inset-0 rotate-45 rounded-[20px] opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100"
          style={{ background: tone.glow }}
        />
        <span
          className="absolute left-1/2 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-gradient-to-b from-white via-white/30 to-transparent opacity-0 group-hover:opacity-100"
          style={{ animation: "flux-spark-zap 900ms ease-in-out infinite" }}
        />
      </div>

      <div className="mt-2 text-center font-mono text-[11px] text-white/90 drop-shadow-[0_0_8px_rgba(56,232,255,0.35)]">
        #{packet.height.toLocaleString()}
      </div>

      <div className="pointer-events-none absolute left-1/2 top-0 z-30 hidden w-60 -translate-x-1/2 -translate-y-[118%] rounded-2xl border border-white/15 bg-[linear-gradient(160deg,rgba(4,16,34,0.95),rgba(10,12,28,0.92))] p-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100 sm:block">
        <p className="font-mono text-xs text-[var(--flux-cyan)]">{packetLabel}</p>
        <div className="mt-2 space-y-1.5 text-[11px] text-[var(--flux-text-secondary)]">
          <div className="flex items-center justify-between">
            <span>Total TX</span>
            <span className="font-mono text-white">{formatInteger(packet.totalTx)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Normal</span>
            <span className="font-mono text-white">{formatInteger(packet.normalTx)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Fluxnode</span>
            <span className="font-mono text-white">{formatInteger(packet.fluxnodeTx)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>{isFuture ? "ETA" : "Age"}</span>
            <span className="font-mono text-white">
              {isFuture
                ? `${formatInteger(etaSeconds)}s`
                : `${formatTimeAgo(packet.timestamp)} ago`}
            </span>
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

  const [railPackets, setRailPackets] = useState<RailPacket[]>([]);
  const [railPulseToken, setRailPulseToken] = useState(0);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  const previousTipHeightRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    return () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
      }
    };
  }, []);

  const latestBlocks = useMemo(
    () => homeSnapshot?.latestBlocks ?? [],
    [homeSnapshot?.latestBlocks]
  );
  const blockMap = useMemo(() => buildBlockMap(latestBlocks), [latestBlocks]);
  const txEstimate = useMemo(
    () => estimatePerBlockTransactions(latestBlocks),
    [latestBlocks]
  );

  const tipHeight = homeSnapshot?.tipHeight ?? latestBlocks[0]?.height ?? null;
  const tipTime = homeSnapshot?.tipTime ?? latestBlocks[0]?.time ?? null;
  const avgBlockTimeSeconds = Math.max(5, dashboardStats?.averages.blockTimeSeconds ?? 30);

  useEffect(() => {
    if (tipHeight == null) {
      return;
    }

    const previousTipHeight = previousTipHeightRef.current;
    if (previousTipHeight == null || railPackets.length === 0) {
      setRailPackets(seedPackets(tipHeight, blockMap, txEstimate));
      previousTipHeightRef.current = tipHeight;
      return;
    }

    if (tipHeight <= previousTipHeight) {
      setRailPackets((current) =>
        hydratePackets(current, tipHeight, blockMap, txEstimate)
      );
      previousTipHeightRef.current = tipHeight;
      return;
    }

    if (tipHeight - previousTipHeight !== 1) {
      setRailPackets(seedPackets(tipHeight, blockMap, txEstimate));
      previousTipHeightRef.current = tipHeight;
      setRailPulseToken((current) => current + 1);
      return;
    }

    setRailPulseToken((current) => current + 1);

    setRailPackets((current) => {
      const shifted = current.map((packet) => ({
        ...packet,
        slot: packet.slot - 1,
      }));
      const maxHeight = Math.max(
        tipHeight + (SLOT_COUNT - CENTER_SLOT - 1),
        ...shifted.map((packet) => packet.height)
      );
      const incomingHeight = maxHeight + 1;
      const incomingFuture = packetFromHeight(
        incomingHeight,
        7,
        tipHeight,
        blockMap,
        txEstimate
      );
      incomingFuture.mined = false;
      incomingFuture.hash = null;
      incomingFuture.timestamp = null;
      incomingFuture.stage = "future";

      return [...shifted, incomingFuture];
    });

    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
    }

    settleTimerRef.current = setTimeout(() => {
      setRailPackets((current) => {
        const settled = current
          .filter((packet) => packet.slot >= 0)
          .map((packet) => ({
            ...packet,
            slot: packet.slot === 7 ? 6 : packet.slot,
          }));
        return hydratePackets(settled, tipHeight, blockMap, txEstimate);
      });
    }, SHIFT_SETTLE_MS);

    previousTipHeightRef.current = tipHeight;
  }, [blockMap, railPackets.length, tipHeight, txEstimate]);

  const isWarmingUp = homeSnapshot?.warmingUp === true || homeSnapshot?.degraded === true;
  const retryAfter = Math.max(1, homeSnapshot?.retryAfterSeconds ?? 3);
  const latestReward = homeSnapshot?.dashboard?.latestRewards?.[0] ?? null;

  const tx24h = dashboardStats?.transactions24h ?? null;
  const tx24hNormal = dashboardStats?.transactions24hNormal ?? null;
  const tx24hFluxnode = dashboardStats?.transactions24hFluxnode ?? null;

  const metrics: MetricSignal[] = [
    {
      id: "height",
      label: "Block Height",
      value: formatInteger(tipHeight),
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
        ? `${formatInteger(arcaneAdoption.arcane)} / ${formatInteger(
            arcaneAdoption.total
          )} nodes`
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
          ? `Normal ${formatCompact(tx24hNormal)} · Fluxnode ${formatCompact(
              tx24hFluxnode
            )}`
          : "Normal + Fluxnode flow",
      tint: "190, 128, 255",
    },
    {
      id: "block-time",
      label: "Avg Block Time",
      value: `${avgBlockTimeSeconds.toFixed(1)}s`,
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
  const blockFeed = latestBlocks.slice(0, 10);

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
            Observe decentralized compute in real time. Future blocks roll in on the right,
            settle at center once mined, and move left as history.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-[11px] uppercase tracking-[0.22em] text-[var(--flux-text-muted)]">
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--flux-green)] shadow-[0_0_14px_rgba(34,197,94,0.9)]" />
              Live Network
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--flux-cyan)] shadow-[0_0_14px_rgba(56,232,255,0.9)]" />
              Block Queue Simulation
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
            <div
              key={railPulseToken}
              className="pointer-events-none absolute inset-x-[-15%] top-1/2 h-12 -translate-y-1/2 opacity-0 blur-sm"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(200,255,255,0.92), rgba(206,164,255,0.86), transparent)",
                animation: "flux-rail-burst 850ms ease-out",
              }}
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

            {railPackets.length > 0 ? (
              railPackets.map((packet) => (
                <RailPacketNode
                  key={packet.key}
                  packet={packet}
                  tipHeight={tipHeight}
                  tipTime={tipTime}
                  avgBlockTimeSeconds={avgBlockTimeSeconds}
                  nowSeconds={nowSeconds}
                />
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

        <div className="mt-8 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="rounded-[22px] border border-white/10 bg-[linear-gradient(160deg,rgba(5,18,38,0.86),rgba(8,9,24,0.9))] p-4 sm:p-5">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.28em] text-[var(--flux-text-dim)]">
                  Stream
                </p>
                <h3 className="mt-1 text-lg font-bold text-white sm:text-xl">
                  Live Block Feed
                </h3>
              </div>
              <Link href="/blocks" className="text-xs uppercase tracking-[0.2em] text-[var(--flux-cyan)]">
                View All
              </Link>
            </div>
            <div className="space-y-2">
              {blockFeed.length > 0 ? (
                blockFeed.map((block) => {
                  const normalTx = block.regularTxCount ?? block.txlength ?? 0;
                  const fluxnodeTx = block.nodeConfirmationCount ?? 0;
                  return (
                    <Link
                      key={block.hash}
                      href={`/block/${block.height}`}
                      className="group grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-white/10 bg-[rgba(7,13,33,0.7)] px-3 py-2 transition-[border-color,transform] hover:-translate-y-[1px] hover:border-white/30"
                    >
                      <span className="h-2.5 w-2.5 rounded-full bg-[var(--flux-cyan)] shadow-[0_0_12px_rgba(56,232,255,0.9)]" />
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm text-white">
                          #{block.height.toLocaleString()}
                        </p>
                        <p className="truncate text-[11px] text-[var(--flux-text-muted)]">
                          {block.hash.slice(0, 14)}…{block.hash.slice(-8)}
                        </p>
                      </div>
                      <div className="text-right text-[11px] text-[var(--flux-text-secondary)]">
                        <p>{formatInteger(normalTx)} normal</p>
                        <p>{formatInteger(fluxnodeTx)} fluxnode</p>
                      </div>
                    </Link>
                  );
                })
              ) : (
                <div className="rounded-xl border border-white/10 bg-[rgba(7,13,33,0.6)] px-4 py-5 text-sm text-[var(--flux-text-muted)]">
                  Waiting for live block feed…
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[22px] border border-white/10 bg-[linear-gradient(160deg,rgba(15,20,45,0.86),rgba(8,9,24,0.9))] p-4 sm:p-5">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.28em] text-[var(--flux-text-dim)]">
                  Rewards
                </p>
                <h3 className="mt-1 text-lg font-bold text-white sm:text-xl">
                  Reward Dispatch
                </h3>
              </div>
              {latestReward ? (
                <Link href={`/block/${latestReward.hash}`} className="text-xs uppercase tracking-[0.2em] text-[var(--flux-cyan)]">
                  View Block
                </Link>
              ) : null}
            </div>

            {latestReward ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-white/10 bg-[rgba(6,15,35,0.75)] px-3 py-2">
                  <p className="font-mono text-sm text-white">
                    Block #{latestReward.height.toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-[var(--flux-text-muted)]">
                    Total reward {latestReward.totalReward.toFixed(2)} FLUX
                  </p>
                </div>

                {latestReward.outputs
                  .filter((output) => output.value > 0)
                  .slice(0, 5)
                  .map((output, outputIndex) => {
                    const rewardLabel = getRewardLabel(output.value, latestReward.height);
                    const address = output.address ?? "unknown";
                    return (
                      <Link
                        key={`${latestReward.height}-${outputIndex}-${address}`}
                        href={address === "unknown" ? "/blocks" : `/address/${address}`}
                        className="group flex items-center justify-between rounded-xl border border-white/10 bg-[rgba(6,12,30,0.68)] px-3 py-2 transition-colors hover:border-white/30"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[11px] uppercase tracking-[0.18em] text-[var(--flux-text-muted)]">
                            {rewardLabel.type}
                          </p>
                          <p className="truncate font-mono text-xs text-white">
                            {address.slice(0, 12)}…{address.slice(-8)}
                          </p>
                        </div>
                        <p className="font-mono text-xs text-[var(--flux-cyan)]">
                          {output.value.toFixed(8)}
                        </p>
                      </Link>
                    );
                  })}
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-[rgba(6,12,30,0.62)] px-4 py-5 text-sm text-[var(--flux-text-muted)]">
                Reward data is syncing…
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
