"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { getExpectedBlockReward, getRewardLabel } from "@/lib/block-rewards";
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
const SHIFT_SETTLE_MS = 34;
const FAST_STEP_SETTLE_MS = 44;
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
const RAIL_LEFT_BY_SLOT_COMPACT: Record<number, number> = {
  [-1]: -14,
  [0]: 4,
  [1]: 18,
  [2]: 34,
  [3]: 50,
  [4]: 66,
  [5]: 82,
  [6]: 96,
  [7]: 112,
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
  if (value == null || !Number.isFinite(value)) return "-";
  return Math.trunc(value).toLocaleString("en-US");
}

function formatCompact(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: digits,
  }).format(value);
}

function formatMillions(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatTimeAgo(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return "-";
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

function slotToLeftPercent(slot: number, compactMode: boolean): number {
  if (compactMode) {
    return RAIL_LEFT_BY_SLOT_COMPACT[slot] ?? 50;
  }
  return RAIL_LEFT_BY_SLOT[slot] ?? 50;
}

function tooltipAnchorClassForSlot(slot: number): string {
  if (slot <= 1) return "left-0 translate-x-0 origin-left";
  if (slot >= SLOT_COUNT - 2) return "right-0 translate-x-0 origin-right";
  return "left-1/2 -translate-x-1/2 origin-center";
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

function ensureCenteredTipPacket(
  packets: RailPacket[],
  tipHeight: number,
  blockMap: Map<number, BlockSummary>,
  txEstimate: TxEstimate
): RailPacket[] {
  const hasCenteredTip = packets.some(
    (packet) => packet.height === tipHeight && packet.slot === CENTER_SLOT
  );
  const hasValidShape =
    packets.length === SLOT_COUNT &&
    packets.every((packet) => packet.slot >= 0 && packet.slot <= SLOT_COUNT - 1);
  if (hasCenteredTip && hasValidShape) {
    return packets;
  }
  return seedPackets(tipHeight, blockMap, txEstimate);
}

function stepPackets(
  packets: RailPacket[],
  displayTipHeight: number,
  blockMap: Map<number, BlockSummary>,
  txEstimate: TxEstimate
): RailPacket[] {
  const shifted = packets.map((packet) =>
    packetFromHeight(
      packet.height,
      packet.slot - 1,
      displayTipHeight,
      blockMap,
      txEstimate
    )
  );

  const incomingHeight = Math.max(
    displayTipHeight + (SLOT_COUNT - CENTER_SLOT),
    ...shifted.map((packet) => packet.height)
  );

  const incomingFuture = packetFromHeight(
    incomingHeight,
    SLOT_COUNT,
    displayTipHeight,
    blockMap,
    txEstimate
  );

  incomingFuture.mined = false;
  incomingFuture.hash = null;
  incomingFuture.timestamp = null;
  incomingFuture.stage = "future";

  return [...shifted, incomingFuture];
}

function settlePackets(
  packets: RailPacket[],
  displayTipHeight: number,
  blockMap: Map<number, BlockSummary>,
  txEstimate: TxEstimate
): RailPacket[] {
  const settled = packets
    .filter((packet) => packet.slot >= 0)
    .map((packet) => ({
      ...packet,
      slot: packet.slot === SLOT_COUNT ? SLOT_COUNT - 1 : packet.slot,
    }));

  const hydrated = hydratePackets(settled, displayTipHeight, blockMap, txEstimate);
  return ensureCenteredTipPacket(hydrated, displayTipHeight, blockMap, txEstimate);
}

function MetricSignalTile({ metric, index }: { metric: MetricSignal; index: number }) {
  const wave = createSignalWave(`${metric.id}:${metric.value}:${metric.detail}`);
  const topAccent = `linear-gradient(90deg, transparent 0%, rgba(${metric.tint}, 0.95) 40%, transparent 100%)`;

  return (
    <div
      className="group relative isolate overflow-hidden rounded-[16px] border border-white/[0.08] bg-[linear-gradient(120deg,rgba(7,20,43,0.3),rgba(6,14,32,0.08)_68%,transparent)] px-3 py-2.5 sm:px-3.5 sm:py-3 transition-[transform,opacity,border-color,background] duration-300 hover:-translate-y-[1px] hover:border-[rgba(107,245,255,0.26)] hover:bg-[linear-gradient(120deg,rgba(9,28,57,0.42),rgba(8,18,39,0.14)_70%,transparent)]"
      style={{
        animation: "flux-rise-in 520ms cubic-bezier(0.16,1,0.3,1) both",
        animationDelay: `${index * 70}ms`,
      }}
    >
      <div
        className="absolute inset-x-0 top-0 h-px opacity-80"
        style={{ background: topAccent }}
      />
      <div className="absolute inset-y-2 left-0 w-px bg-white/8" />
      <div
        className="absolute -inset-y-4 -left-10 w-20 opacity-28 blur-2xl transition-opacity duration-300 group-hover:opacity-90"
        style={{ background: `rgba(${metric.tint}, 0.45)` }}
      />

      <div className="relative grid grid-cols-[1fr_auto] items-end gap-3">
        <div>
          <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)] sm:text-[10px] sm:tracking-[0.2em]">
            {metric.label}
          </p>
          <p className="mt-0.5 font-mono text-base font-semibold text-white sm:text-lg">{metric.value}</p>
          <p className="mt-0.5 text-[10px] text-[var(--flux-text-muted)] sm:text-[11px]">{metric.detail}</p>
        </div>
        <div className="flex h-8 min-w-[36px] items-end justify-end gap-1 opacity-75 transition-opacity group-hover:opacity-100">
          {wave.map((height, waveIndex) => (
            <span
              key={`${metric.id}-${waveIndex}`}
              className="w-[3px] rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.9),rgba(255,255,255,0.2))]"
              style={{
                height: `${Math.max(20, height - 8)}%`,
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
  compactMode,
}: {
  packet: RailPacket;
  tipHeight: number | null;
  tipTime: number | null;
  avgBlockTimeSeconds: number;
  nowSeconds: number;
  compactMode: boolean;
}) {
  const tone = BLOCK_TONES[Math.abs(packet.height) % BLOCK_TONES.length];
  const isCurrent = packet.stage === "current";
  const isFuture = packet.stage === "future";
  const isHistorical = packet.stage === "historical";
  const isCompressedSlot =
    compactMode && (packet.slot < 1 || packet.slot > SLOT_COUNT - 2);
  const compactDistanceFromCenter = Math.abs(packet.slot - CENTER_SLOT);
  const nodeSize = compactMode ? (isCurrent ? 58 : 38) : isCurrent ? 106 : 66;
  const tooltipAnchorClass = tooltipAnchorClassForSlot(packet.slot);
  const showCompactMeta = !compactMode || isCurrent || compactDistanceFromCenter <= 1;

  const etaSeconds = (() => {
    if (tipHeight == null) return null;
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
  const timelineLabel = (() => {
    if (tipHeight == null) return "syncing";
    const offsetBlocks = packet.height - tipHeight;
    if (compactMode) {
      if (offsetBlocks > 0) return `T+${formatInteger(etaSeconds)}s`;
      if (offsetBlocks === 0) return "LIVE";
      if (packet.timestamp != null) {
        return `-${formatTimeAgo(packet.timestamp).replace(/\s+/g, "")}`;
      }
      return `-${Math.abs(Math.round(offsetBlocks * avgBlockTimeSeconds))}s`;
    }
    if (offsetBlocks > 0) return `ETA ${formatInteger(etaSeconds)}s`;
    if (offsetBlocks === 0) return "LIVE TIP";
    if (packet.timestamp != null) return `${formatTimeAgo(packet.timestamp)} ago`;
    return `${Math.abs(Math.round(offsetBlocks * avgBlockTimeSeconds))}s ago`;
  })();

  return (
    <Link
      href={isFuture ? "/blocks" : `/block/${packet.height}`}
      className="group absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--flux-cyan)] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgba(3,8,20,0.9)]"
      style={{
        left: `${slotToLeftPercent(packet.slot, compactMode)}%`,
        opacity:
          packet.slot < 0 || packet.slot > SLOT_COUNT - 1 || isCompressedSlot ? 0 : 1,
        transition:
          "left 720ms cubic-bezier(0.22,1,0.36,1), opacity 430ms cubic-bezier(0.16,1,0.3,1)",
      }}
    >
      <div
        className="relative"
        style={{ width: `${nodeSize}px`, height: `${nodeSize}px` }}
      >
        {isCurrent ? (
          <>
            <span className="pointer-events-none absolute inset-[-48%] rounded-full bg-[radial-gradient(circle,rgba(86,244,255,0.34),rgba(86,244,255,0.06)_44%,transparent_72%)] blur-[2px]" style={{ animation: "flux-arc-breathe 2.6s ease-in-out infinite" }} />
            <span className="pointer-events-none absolute inset-[-28%] rounded-full border border-[rgba(130,250,255,0.42)] blur-[1px]" />
            <span className="pointer-events-none absolute inset-[-38%] rounded-full border border-[rgba(198,146,255,0.35)] opacity-70" style={{ animation: "flux-pulse 1700ms ease-in-out infinite" }} />
          </>
        ) : null}
        <div
          className="absolute inset-0 rotate-45 rounded-[20px] border transition-transform duration-300 group-hover:scale-110"
          style={{
            borderColor: tone.edge,
            background: `radial-gradient(circle at 30% 30%, rgba(255,255,255,0.28), transparent 50%), linear-gradient(135deg, rgba(255,255,255,0.14), ${tone.core})`,
            boxShadow: isCurrent
              ? `0 0 26px ${tone.glow}, 0 0 42px rgba(133, 244, 255, 0.34)`
              : `0 0 18px ${tone.glow}`,
            animation:
              packet.slot >= 6 && isFuture
                ? "flux-packet-charge 860ms cubic-bezier(0.22,1,0.36,1)"
                : undefined,
          }}
        />
        <div
          className="absolute inset-[23%] rotate-45 rounded-lg border"
          style={{ borderColor: "rgba(255,255,255,0.6)" }}
        />
        <div
          className="pointer-events-none absolute inset-[30%] rotate-45 rounded-md border opacity-65"
          style={{ borderColor: "rgba(255,255,255,0.35)" }}
        />
        <div
          className="absolute inset-0 rotate-45 rounded-[20px] opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100"
          style={{ background: tone.glow }}
        />
        {isFuture ? (
          <>
            <span
              className="pointer-events-none absolute -right-2 top-1/2 h-8 w-px -translate-y-1/2 bg-gradient-to-b from-transparent via-white to-transparent opacity-80"
              style={{ animation: "flux-electric-spike 640ms ease-out" }}
            />
            <span
              className="pointer-events-none absolute -left-1.5 top-[44%] h-6 w-px -translate-y-1/2 bg-gradient-to-b from-transparent via-cyan-200 to-transparent opacity-70"
              style={{ animation: "flux-electric-spike 760ms ease-out" }}
            />
          </>
        ) : null}
        <span
          className="absolute left-1/2 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-gradient-to-b from-white via-white/30 to-transparent opacity-0 group-hover:opacity-100"
          style={{ animation: "flux-spark-zap 900ms ease-in-out infinite" }}
        />
      </div>

      {showCompactMeta ? (
        <>
          <div
            className={`mt-2 text-center font-mono text-white/90 drop-shadow-[0_0_8px_rgba(56,232,255,0.35)] ${
              compactMode ? "text-[7px]" : "text-[11px]"
            }`}
          >
            {compactMode ? `#${packet.height}` : `#${packet.height.toLocaleString()}`}
          </div>
          <div
            className={`pointer-events-none mt-1 rounded-full border text-center font-mono uppercase ${
              compactMode ? "px-1.5 py-[2px] text-[6px] tracking-[0.1em]" : "px-2 py-0.5 text-[9px] tracking-[0.14em]"
            } ${
              isCurrent
                ? "border-[rgba(56,232,255,0.5)] bg-[rgba(13,39,66,0.8)] text-[var(--flux-cyan)]"
                : isFuture
                ? "border-[rgba(168,85,247,0.42)] bg-[rgba(25,20,50,0.74)] text-[rgb(202,163,255)]"
                : "border-white/20 bg-[rgba(9,16,36,0.65)] text-white/70"
            }`}
          >
            {timelineLabel}
          </div>
        </>
      ) : null}
      {isCurrent ? (
        <div className="pointer-events-none absolute left-1/2 top-[-24px] -translate-x-1/2 rounded-full border border-[rgba(56,232,255,0.45)] bg-[rgba(4,18,38,0.88)] px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] text-[var(--flux-cyan)]">
          Current
        </div>
      ) : null}

      <div
        className={`pointer-events-none absolute top-0 z-50 hidden w-52 -translate-y-[116%] rounded-2xl border border-white/15 bg-[linear-gradient(160deg,rgba(4,16,34,0.95),rgba(10,12,28,0.92))] p-3 opacity-0 transition-[opacity,transform] duration-300 group-hover:-translate-y-[124%] group-hover:opacity-100 sm:block md:w-60 ${tooltipAnchorClass}`}
      >
        <p className="font-mono text-xs text-[var(--flux-cyan)]">{packetLabel}</p>
        <div className="mt-2 space-y-1.5 text-[11px] text-[var(--flux-text-secondary)]">
          <div className="flex items-center justify-between">
            <span>Total TX</span>
            <span className="font-mono text-white">
              {isFuture ? "-" : formatInteger(packet.totalTx)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Normal</span>
            <span className="font-mono text-white">
              {isFuture ? "-" : formatInteger(packet.normalTx)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Fluxnode</span>
            <span className="font-mono text-white">
              {isFuture ? "-" : formatInteger(packet.fluxnodeTx)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>{isFuture ? "ETA" : "Age"}</span>
            <span className="font-mono text-white">
              {isFuture ? `${formatInteger(etaSeconds)}s` : `${formatTimeAgo(packet.timestamp)} ago`}
            </span>
          </div>
          {isHistorical ? (
            <div className="flex items-center justify-between">
              <span>Status</span>
              <span className="font-mono text-white/80">Archived</span>
            </div>
          ) : null}
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
  const [compactMode, setCompactMode] = useState(false);

  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayTipRef = useRef<number | null>(null);
  const targetTipRef = useRef<number | null>(null);
  const steppingRef = useRef(false);
  const blockMapRef = useRef<Map<number, BlockSummary>>(new Map());
  const txEstimateRef = useRef<TxEstimate>({ total: 12, normal: 1, fluxnode: 11 });

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const syncViewport = () => {
      setCompactMode(window.innerWidth < 640);
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  useEffect(() => {
    return () => {
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const recenterToTargetTip = () => {
      if (document.visibilityState === "hidden") return;
      const targetTip = targetTipRef.current;
      if (targetTip == null) return;
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
      }
      steppingRef.current = false;
      displayTipRef.current = targetTip;
      setRailPackets(
        seedPackets(targetTip, blockMapRef.current, txEstimateRef.current)
      );
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        recenterToTargetTip();
      }
    };

    window.addEventListener("focus", recenterToTargetTip);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", recenterToTargetTip);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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

  useEffect(() => {
    blockMapRef.current = blockMap;
    txEstimateRef.current = txEstimate;
  }, [blockMap, txEstimate]);

  const tipHeight = homeSnapshot?.tipHeight ?? latestBlocks[0]?.height ?? null;
  const tipTime = homeSnapshot?.tipTime ?? latestBlocks[0]?.time ?? null;
  const avgBlockTimeSeconds = Math.max(5, dashboardStats?.averages.blockTimeSeconds ?? 30);

  const startStepQueue = useCallback(() => {
    if (steppingRef.current) return;
    steppingRef.current = true;

    const runStep = () => {
      const displayTip = displayTipRef.current;
      const targetTip = targetTipRef.current;
      const currentBlockMap = blockMapRef.current;
      const currentTxEstimate = txEstimateRef.current;

      if (displayTip == null || targetTip == null) {
        steppingRef.current = false;
        return;
      }

      if (targetTip <= displayTip) {
        setRailPackets((current) => {
          const hydrated = hydratePackets(
            current,
            displayTip,
            currentBlockMap,
            currentTxEstimate
          );
          return ensureCenteredTipPacket(
            hydrated,
            displayTip,
            currentBlockMap,
            currentTxEstimate
          );
        });
        steppingRef.current = false;
        return;
      }

      const nextTip = displayTip + 1;
      const backlog = targetTip - nextTip;
      const settleMs = backlog > 3 ? FAST_STEP_SETTLE_MS : SHIFT_SETTLE_MS;

      setRailPulseToken((current) => current + 1);
      setRailPackets((current) =>
        stepPackets(current, nextTip, currentBlockMap, currentTxEstimate)
      );

      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
      }

      animationTimerRef.current = setTimeout(() => {
        setRailPackets((current) =>
          settlePackets(current, nextTip, currentBlockMap, currentTxEstimate)
        );
        displayTipRef.current = nextTip;
        runStep();
      }, settleMs);
    };

    runStep();
  }, []);

  useEffect(() => {
    if (tipHeight == null) return;

    targetTipRef.current = tipHeight;

    if (displayTipRef.current == null || railPackets.length === 0) {
      displayTipRef.current = tipHeight;
      setRailPackets(seedPackets(tipHeight, blockMap, txEstimate));
      return;
    }

    if (tipHeight < displayTipRef.current) {
      displayTipRef.current = tipHeight;
      setRailPackets(seedPackets(tipHeight, blockMap, txEstimate));
      return;
    }

    setRailPackets((current) => {
      const activeTip = displayTipRef.current ?? tipHeight;
      const hydrated = hydratePackets(current, activeTip, blockMap, txEstimate);
      return ensureCenteredTipPacket(hydrated, activeTip, blockMap, txEstimate);
    });

    if (tipHeight > (displayTipRef.current ?? tipHeight)) {
      startStepQueue();
    }
  }, [tipHeight, blockMap, txEstimate, railPackets.length, startStepQueue]);

  const isWarmingUp = homeSnapshot?.warmingUp === true || homeSnapshot?.degraded === true;
  const retryAfter = Math.max(1, homeSnapshot?.retryAfterSeconds ?? 3);
  const latestReward = homeSnapshot?.dashboard?.latestRewards?.[0] ?? null;
  const rewardOutputs = latestReward?.outputs.filter((output) => output.value > 0).slice(0, 8) ?? [];
  const rewardDispatchStats = (() => {
    if (!latestReward) return null;
    const outputs = latestReward.outputs.filter((output) => output.value > 0);
    if (outputs.length === 0) {
      return {
        outputCount: 0,
        largest: 0,
        smallest: 0,
        age: "syncing",
      };
    }
    const sorted = [...outputs].sort((first, second) => second.value - first.value);
    return {
      outputCount: outputs.length,
      largest: sorted[0]?.value ?? 0,
      smallest: sorted[sorted.length - 1]?.value ?? 0,
      age: `${formatTimeAgo(latestReward.timestamp)} ago`,
    };
  })();
  const rewardSplit = (() => {
    if (!latestReward) return [];
    const grouped = new Map<string, number>();
    for (const output of latestReward.outputs) {
      if (output.value <= 0) continue;
      const type = getRewardLabel(output.value, latestReward.height).type;
      grouped.set(type, (grouped.get(type) ?? 0) + output.value);
    }
    const safeTotal =
      latestReward.totalReward > 0
        ? latestReward.totalReward
        : Array.from(grouped.values()).reduce((sum, value) => sum + value, 0);
    return Array.from(grouped.entries())
      .map(([type, value]) => ({
        type,
        value,
        percent: safeTotal > 0 ? (value / safeTotal) * 100 : 0,
      }))
      .sort((first, second) => second.value - first.value);
  })();
  const rewardHistory = homeSnapshot?.dashboard?.latestRewards?.slice(0, 6) ?? [];
  const rewardFeeProfile = (() => {
    if (rewardHistory.length === 0) return null;
    const points = rewardHistory.map((item) => {
      const baseReward = getExpectedBlockReward(item.height);
      const feeReward = Math.max(0, item.totalReward - baseReward);
      return {
        hash: item.hash,
        height: item.height,
        totalReward: item.totalReward,
        baseReward,
        feeReward,
      };
    });
    const current = points[0];
    if (!current) return null;
    const feeValues = points.map((point) => point.feeReward);
    const averageFee =
      feeValues.reduce((sum, value) => sum + value, 0) / feeValues.length;
    const maxFee = Math.max(0.0001, ...feeValues);
    const feeShare = current.totalReward > 0
      ? (current.feeReward / current.totalReward) * 100
      : 0;
    return {
      currentFee: current.feeReward,
      baseReward: current.baseReward,
      averageFee,
      maxFee,
      feeShare,
      points: points.map((point) => ({
        hash: point.hash,
        height: point.height,
        feeReward: point.feeReward,
        ratio: point.feeReward / maxFee,
      })),
    };
  })();

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
      value: arcaneAdoption ? `${arcaneAdoption.percentage.toFixed(1)}%` : "-",
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
  const visibleSparkOffsets = compactMode
    ? sparkOffsets.filter((_, index) => index % 2 === 0)
    : sparkOffsets;
  const trajectoryCue = compactMode
    ? {
        width: "28%",
        bandHeightPx: 12,
        beamHeightPx: 84,
        opacity: 0.52,
        outboundDuration: "2.9s",
        inboundDuration: "2.7s",
      }
    : {
        width: "34%",
        bandHeightPx: 18,
        beamHeightPx: 126,
        opacity: 1,
        outboundDuration: "2.4s",
        inboundDuration: "2.2s",
      };
  const blockFeed = latestBlocks.slice(0, 8);
  const feedPulse = (() => {
    if (blockFeed.length === 0) return null;
    const bars = blockFeed.map((block, index) => {
      const fluxnodeTx = Math.max(0, block.nodeConfirmationCount ?? 0);
      const normalTx = Math.max(
        0,
        block.regularTxCount ?? Math.max(0, (block.txlength ?? 0) - fluxnodeTx)
      );
      const totalTx = Math.max(0, block.txlength ?? normalTx + fluxnodeTx);
      return {
        key: block.hash,
        totalTx,
        normalTx,
        fluxnodeTx,
        tone: BLOCK_TONES[(block.height + index) % BLOCK_TONES.length],
      };
    });
    const totalTx = bars.reduce((sum, bar) => sum + bar.totalTx, 0);
    const normalTx = bars.reduce((sum, bar) => sum + bar.normalTx, 0);
    const fluxnodeTx = bars.reduce((sum, bar) => sum + bar.fluxnodeTx, 0);
    const maxTotal = Math.max(1, ...bars.map((bar) => bar.totalTx));
    const newest = blockFeed[0]?.time ?? null;
    const oldest = blockFeed[blockFeed.length - 1]?.time ?? null;
    const feedWindowSeconds =
      newest != null && oldest != null ? Math.max(0, newest - oldest) : null;
    return {
      bars,
      totalTx,
      normalTx,
      fluxnodeTx,
      normalRatio: totalTx > 0 ? (normalTx / totalTx) * 100 : 0,
      fluxnodeRatio: totalTx > 0 ? (fluxnodeTx / totalTx) * 100 : 0,
      maxTotal,
      feedWindowSeconds,
    };
  })();
  const currentPacket =
    railPackets.find((packet) => packet.stage === "current") ?? railPackets[CENTER_SLOT] ?? null;
  const railLeftTelemetry = [
    { id: "tip", label: "Tip Height", value: formatInteger(tipHeight) },
    { id: "avg", label: "Avg Block", value: `${avgBlockTimeSeconds.toFixed(1)}s` },
  ];
  const railRightTelemetry = [
    { id: "tx24h", label: "24h TX", value: formatCompact(tx24h) },
    { id: "nodes", label: "PoUW Nodes", value: formatInteger(nodeCount?.total) },
  ];

  return (
    <section className="relative isolate overflow-visible rounded-[40px] px-3 py-8 sm:px-6 sm:py-10 md:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 rounded-[40px] bg-[linear-gradient(180deg,rgba(3,9,25,0.82),rgba(2,8,22,0.96))]" />
      <div className="pointer-events-none absolute inset-0 rounded-[40px] bg-[radial-gradient(120%_120%_at_50%_-25%,rgba(83,240,255,0.26),transparent_52%),radial-gradient(110%_90%_at_100%_0%,rgba(183,121,255,0.3),transparent_46%),radial-gradient(100%_80%_at_0%_100%,rgba(47,154,255,0.2),transparent_52%)]" />
      <div className="pointer-events-none absolute inset-0 rounded-[40px] flux-home-grid-motion opacity-55" />
      <div className="pointer-events-none absolute inset-y-[18%] -left-[13%] hidden w-[22%] rounded-full bg-[radial-gradient(circle,rgba(56,232,255,0.14),transparent_72%)] blur-3xl xl:block" />
      <div className="pointer-events-none absolute inset-y-[12%] -right-[12%] hidden w-[22%] rounded-full bg-[radial-gradient(circle,rgba(183,121,255,0.16),transparent_72%)] blur-3xl xl:block" />
      <div className="pointer-events-none absolute left-0 top-[24%] hidden h-[52%] w-px bg-gradient-to-b from-transparent via-white/40 to-transparent xl:block" />
      <div className="pointer-events-none absolute right-0 top-[24%] hidden h-[52%] w-px bg-gradient-to-b from-transparent via-white/40 to-transparent xl:block" />
      <div className="pointer-events-none absolute inset-y-[34%] left-0 hidden w-[12%] bg-[linear-gradient(90deg,rgba(56,232,255,0.22),transparent)] blur-2xl xl:block" />
      <div className="pointer-events-none absolute inset-y-[34%] right-0 hidden w-[12%] bg-[linear-gradient(270deg,rgba(168,85,247,0.22),transparent)] blur-2xl xl:block" />

      <div className="relative z-20">
        <div className="mx-auto max-w-5xl text-center">
          <h1
            className="bg-[linear-gradient(118deg,#f8fcff_12%,#87f6ff_40%,#dbc4ff_74%,#f9fcff_100%)] bg-clip-text text-[2rem] font-black uppercase tracking-[0.1em] text-transparent drop-shadow-[0_0_22px_rgba(88,239,255,0.38)] sm:text-5xl sm:tracking-[0.14em] lg:text-6xl"
            style={{ animation: "flux-rise-in 640ms cubic-bezier(0.16,1,0.3,1) both" }}
          >
            Flux Explorer
          </h1>
          <p
            className="mx-auto mt-4 max-w-3xl text-sm text-[var(--flux-text-secondary)] sm:text-base"
            style={{
              animation: "flux-rise-in 700ms cubic-bezier(0.16,1,0.3,1) both",
              animationDelay: "120ms",
            }}
          >
            Observe decentralized compute in real time. Incoming blocks charge from the right,
            settle as current tip, then drift left as verified history.
          </p>
          <div
            className="mt-4 text-xs uppercase tracking-[0.16em] text-[var(--flux-text-muted)] sm:mt-5 sm:text-[11px] sm:tracking-[0.22em]"
            style={{
              animation: "flux-rise-in 760ms cubic-bezier(0.16,1,0.3,1) both",
              animationDelay: "180ms",
            }}
          >
            {currentPacket ? (
              <span
                className="inline-flex items-center gap-2 rounded-full border border-[rgba(56,232,255,0.35)] bg-[rgba(7,19,40,0.68)] px-3 py-1 font-mono text-[var(--flux-cyan)]"
                style={{ animation: "flux-chip-pulse 2100ms ease-in-out infinite" }}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--flux-cyan)] shadow-[0_0_10px_rgba(56,232,255,0.95)]" />
                Current tip #{currentPacket.height.toLocaleString()}
              </span>
            ) : null}
          </div>
          <div
            className="mt-6 flex flex-wrap items-center justify-center gap-3 text-[10px] uppercase tracking-[0.2em] text-[var(--flux-text-muted)] sm:gap-4 sm:text-[11px]"
            style={{
              animation: "flux-rise-in 840ms cubic-bezier(0.16,1,0.3,1) both",
              animationDelay: "220ms",
            }}
          >
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--flux-green)] shadow-[0_0_14px_rgba(34,197,94,0.9)]" />
              Live Network
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--flux-cyan)] shadow-[0_0_14px_rgba(56,232,255,0.9)]" />
              Sequential Block Queue
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[var(--flux-purple)] shadow-[0_0_14px_rgba(168,85,247,0.9)]" />
              Decentralized Cloud
            </span>
          </div>
          <div
            className="mx-auto mt-6 w-full max-w-4xl sm:mt-7"
            style={{
              animation: "flux-rise-in 920ms cubic-bezier(0.16,1,0.3,1) both",
              animationDelay: "280ms",
            }}
          >
            <SearchBar />
          </div>
        </div>

        <div className="relative mt-8 px-0 py-7 sm:mt-10 sm:py-10">
          <div className="pointer-events-none absolute inset-x-[-16%] top-[12%] h-[84%] bg-[radial-gradient(70%_90%_at_50%_40%,rgba(63,210,255,0.2),transparent_78%)] blur-2xl" />
          <div className="pointer-events-none absolute inset-x-[-14%] top-[20%] h-[70%] bg-[linear-gradient(95deg,rgba(56,232,255,0.08),rgba(183,121,255,0.08),rgba(56,232,255,0.08))] blur-xl" />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(120,200,255,0.09),transparent)]" style={{ animation: "flux-energy-slide 4.6s linear infinite" }} />
          <div className="pointer-events-none absolute inset-x-[-10%] top-1/2 h-[2px] -translate-y-1/2 bg-[linear-gradient(90deg,transparent_0%,rgba(88,239,255,0.92)_20%,rgba(238,170,255,0.95)_50%,rgba(88,239,255,0.92)_80%,transparent_100%)]" />
          <div className="pointer-events-none absolute inset-x-[-12%] top-1/2 h-8 -translate-y-1/2 bg-[linear-gradient(90deg,transparent,rgba(88,239,255,0.5),rgba(238,170,255,0.54),rgba(88,239,255,0.5),transparent)] blur-md" style={{ animation: "flux-energy-slide 2.2s linear infinite" }} />
          <div
            className="pointer-events-none absolute right-1/2 top-1/2 -translate-y-1/2 bg-[linear-gradient(90deg,transparent,rgba(98,244,255,0.78),rgba(199,151,255,0.45),transparent)] blur-[0.5px] sm:blur-[1px]"
            style={{
              width: trajectoryCue.width,
              height: `${trajectoryCue.bandHeightPx}px`,
              opacity: trajectoryCue.opacity,
              animation: `flux-center-outbound ${trajectoryCue.outboundDuration} ease-in-out infinite`,
            }}
          />
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-y-1/2 bg-[linear-gradient(90deg,transparent,rgba(199,151,255,0.45),rgba(98,244,255,0.78),transparent)] blur-[0.5px] sm:blur-[1px]"
            style={{
              width: trajectoryCue.width,
              height: `${trajectoryCue.bandHeightPx}px`,
              opacity: trajectoryCue.opacity,
              animation: `flux-center-inbound ${trajectoryCue.inboundDuration} ease-in-out infinite`,
            }}
          />
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 w-px -translate-x-1/2 -translate-y-1/2 bg-[linear-gradient(180deg,transparent,rgba(112,247,255,0.7),transparent)]"
            style={{
              height: `${trajectoryCue.beamHeightPx}px`,
              opacity: compactMode ? 0.44 : 0.7,
            }}
          />
          <div
            key={railPulseToken}
            className="pointer-events-none absolute inset-x-[-15%] top-1/2 h-16 -translate-y-1/2 opacity-0 blur-[3px]"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(220,255,255,0.95), rgba(218,173,255,0.9), transparent)",
              animation: "flux-rail-burst 820ms ease-out",
            }}
          />
          <div className="pointer-events-none absolute inset-x-[7%] top-[58%] h-24 rounded-[100%] border-t border-white/25 opacity-70" style={{ animation: "flux-arc-breathe 3.4s ease-in-out infinite" }} />
          <div className="pointer-events-none absolute inset-x-[18%] top-[43%] h-20 rounded-[100%] border-t border-white/15 opacity-45" style={{ animation: "flux-arc-breathe 3s ease-in-out infinite 800ms" }} />

          <div className="relative h-[260px] overflow-visible sm:h-[296px]">
            {visibleSparkOffsets.map((offset, index) => (
              <span
                key={`spark-${offset}`}
                className="absolute w-px bg-gradient-to-b from-white via-white/60 to-transparent"
                style={{
                  left: `${offset}%`,
                  top: "50%",
                  height: `${18 + (index % 3) * 11}px`,
                  opacity: 0.72,
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
                  compactMode={compactMode}
                />
              ))
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="rounded-2xl border border-white/15 bg-[rgba(5,12,28,0.8)] px-4 py-3 text-center text-sm text-[var(--flux-text-secondary)] sm:px-5 sm:py-4">
                  <p>{homeSnapshot?.message ?? "Synchronizing live block stream"}</p>
                  {isWarmingUp ? (
                    <p className="mt-1 text-xs text-[var(--flux-text-muted)]">
                      Retrying every {retryAfter}s
                    </p>
                  ) : null}
                  {homeLoading ? (
                    <p className="mt-1 text-xs text-[var(--flux-text-muted)]">Loading signal...</p>
                  ) : null}
                </div>
              </div>
            )}

            <div className="pointer-events-none absolute inset-x-3 bottom-2 hidden items-end justify-between text-[10px] uppercase tracking-[0.14em] text-white/45 sm:flex">
              <div className="space-y-1">
                {railLeftTelemetry.map((item) => (
                  <p key={item.id} className="font-mono">
                    <span className="text-white/35">{item.label}</span>{" "}
                    <span className="text-[var(--flux-cyan)]">{item.value}</span>
                  </p>
                ))}
              </div>
              <div className="space-y-1 text-right">
                {railRightTelemetry.map((item) => (
                  <p key={item.id} className="font-mono">
                    <span className="text-white/35">{item.label}</span>{" "}
                    <span className="text-[rgb(202,163,255)]">{item.value}</span>
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 space-y-5">
          <div className="relative overflow-hidden rounded-[30px] border border-white/[0.08] bg-[linear-gradient(100deg,rgba(5,17,39,0.32)_0%,rgba(5,12,30,0.16)_50%,rgba(7,16,36,0.32)_100%)] px-3 py-3 backdrop-blur-[1.5px] sm:px-5 sm:py-4">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <div className="absolute inset-0 bg-[radial-gradient(70%_120%_at_25%_0%,rgba(56,232,255,0.12),transparent_72%),radial-gradient(80%_120%_at_100%_100%,rgba(168,85,247,0.14),transparent_76%)]" />
            <div
              className="absolute inset-[-18%] bg-[linear-gradient(110deg,rgba(56,232,255,0.14),transparent_42%,rgba(168,85,247,0.14),transparent_78%)] mix-blend-screen opacity-45"
              style={{ animation: "flux-river-drift 16s ease-in-out infinite" }}
            />

            <div className="relative mb-2.5 flex items-end justify-between gap-3 sm:mb-3">
              <div>
                <p className="text-[9px] uppercase tracking-[0.2em] text-[var(--flux-text-dim)] sm:text-[10px] sm:tracking-[0.22em]">
                  Execution River
                </p>
                <h3 className="mt-1 text-[15px] font-semibold text-white sm:text-lg">
                  Feed Stream + Reward Dispatch
                </h3>
              </div>
            </div>

            <div className="relative grid gap-4 sm:gap-5 lg:grid-cols-2">
              <div className="relative h-full overflow-hidden rounded-[22px] border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.34),rgba(5,13,30,0.08))] px-3 py-2.5 sm:px-3.5">
                <div className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
                <div className="mb-2.5 flex items-end justify-between">
                  <p className="text-[9px] uppercase tracking-[0.18em] text-[var(--flux-text-dim)] sm:text-[10px] sm:tracking-[0.2em]">
                    Live Chain + Feed Stream
                  </p>
                  <Link href="/blocks" className="text-[11px] uppercase tracking-[0.18em] text-[var(--flux-cyan)]">
                    View All
                  </Link>
                </div>
                {feedPulse ? (
                  <div className="relative mb-2.5 overflow-hidden rounded-lg border border-white/[0.08] bg-[linear-gradient(132deg,rgba(10,22,44,0.46),rgba(7,15,33,0.22))] px-2.5 py-2">
                    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(95%_140%_at_0%_0%,rgba(56,232,255,0.12),transparent_60%),radial-gradient(95%_140%_at_100%_100%,rgba(168,85,247,0.14),transparent_64%)]" />
                    <div className="relative grid gap-2.5 sm:grid-cols-[1.05fr_0.95fr]">
                      <div>
                        <p className="text-[9px] uppercase tracking-[0.16em] text-[var(--flux-text-dim)]">
                          Feed Mix
                        </p>
                        <div className="mt-1.5 space-y-1.5">
                          <div>
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="font-mono uppercase tracking-[0.08em] text-white/75">
                                Normal
                              </span>
                              <span className="font-mono text-[var(--flux-cyan)]">
                                {feedPulse.normalRatio.toFixed(1)}%
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                              <div
                                className="h-full rounded-full bg-[linear-gradient(90deg,rgba(56,232,255,0.9),rgba(99,210,255,0.75))]"
                                style={{ width: `${Math.max(4, feedPulse.normalRatio)}%` }}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="font-mono uppercase tracking-[0.08em] text-white/75">
                                Fluxnode
                              </span>
                              <span className="font-mono text-[rgb(202,163,255)]">
                                {feedPulse.fluxnodeRatio.toFixed(1)}%
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                              <div
                                className="h-full rounded-full bg-[linear-gradient(90deg,rgba(168,85,247,0.9),rgba(238,170,255,0.75))]"
                                style={{ width: `${Math.max(4, feedPulse.fluxnodeRatio)}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="rounded-md border border-white/[0.08] bg-[linear-gradient(140deg,rgba(11,34,62,0.24),rgba(8,20,42,0.08))] px-2 py-1.5 backdrop-blur-[1px]">
                        <p className="text-[9px] uppercase tracking-[0.16em] text-[var(--flux-text-dim)]">
                          Throughput Wave
                        </p>
                        <div className="mt-1.5 flex h-8 items-end gap-1">
                          {feedPulse.bars.map((bar, barIndex) => (
                            <span
                              key={`${bar.key}-bar`}
                              className="w-[5px] rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0.15))]"
                              style={{
                                height: `${Math.max(20, Math.round((bar.totalTx / feedPulse.maxTotal) * 100))}%`,
                                boxShadow: `0 0 10px ${bar.tone.glow}`,
                                animation: "flux-wave-pulse 1400ms ease-in-out infinite",
                                animationDelay: `${barIndex * 90}ms`,
                              }}
                            />
                          ))}
                        </div>
                        <p className="mt-1 font-mono text-[10px] text-[var(--flux-text-secondary)]">
                          {formatInteger(feedPulse.totalTx)} tx / {formatInteger(blockFeed.length)} blocks
                        </p>
                        <p className="font-mono text-[10px] text-[var(--flux-cyan)]">
                          Window{" "}
                          {feedPulse.feedWindowSeconds != null
                            ? `${formatInteger(feedPulse.feedWindowSeconds)}s`
                            : "syncing"}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="grid gap-1.5">
                  {blockFeed.length > 0 ? (
                    blockFeed.map((block, rowIndex) => {
                      const fluxnodeTx = Math.max(0, block.nodeConfirmationCount ?? 0);
                      const normalTx = Math.max(
                        0,
                        block.regularTxCount ?? Math.max(0, (block.txlength ?? 0) - fluxnodeTx)
                      );
                      const totalTx = Math.max(1, block.txlength ?? normalTx + fluxnodeTx);
                      const normalShare = Math.max(
                        0,
                        Math.min(100, (normalTx / totalTx) * 100)
                      );
                      const fluxnodeShare = Math.max(
                        0,
                        Math.min(100, (fluxnodeTx / totalTx) * 100)
                      );
                      const ageLabel =
                        block.time != null ? `${formatTimeAgo(block.time)} ago` : "syncing";
                      return (
                        <Link
                          key={block.hash}
                          href={`/block/${block.height}`}
                          className="group relative grid grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-[transform,color] hover:translate-x-1"
                        >
                          {rowIndex > 0 ? (
                            <span className="pointer-events-none absolute inset-x-2 top-0 h-px bg-white/8" />
                          ) : null}
                          <span className="h-2 w-2 rounded-full bg-[var(--flux-cyan)] shadow-[0_0_12px_rgba(56,232,255,0.95)]" />
                          <div className="min-w-0">
                            <p className="truncate font-mono text-xs text-white sm:text-sm">
                              #{block.height.toLocaleString()}
                            </p>
                            <p className="truncate text-[10px] text-[var(--flux-text-muted)] sm:text-[11px]">
                              {block.hash.slice(0, 14)}...{block.hash.slice(-8)}
                            </p>
                            <div className="mt-1 flex items-center gap-1.5">
                              <div className="relative h-1.5 min-w-[98px] flex-1 overflow-hidden rounded-full border border-white/10 bg-white/10">
                                <span
                                  className="absolute inset-y-0 left-0 bg-[linear-gradient(90deg,rgba(56,232,255,0.95),rgba(99,210,255,0.72))]"
                                  style={{ width: `${Math.max(4, normalShare)}%` }}
                                />
                                <span
                                  className="absolute inset-y-0 right-0 bg-[linear-gradient(90deg,rgba(168,85,247,0.86),rgba(238,170,255,0.72))]"
                                  style={{ width: `${Math.max(4, fluxnodeShare)}%` }}
                                />
                                <span
                                  key={`${block.hash}-seam-${railPulseToken}`}
                                  className="pointer-events-none absolute inset-y-[-1px] w-4 rounded-full bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.85),transparent)] opacity-0"
                                  style={{
                                    left: `${Math.max(0, Math.min(96, normalShare))}%`,
                                    transform: "translateX(-50%)",
                                    animation: "flux-feed-seam-burst 760ms cubic-bezier(0.16,1,0.3,1)",
                                  }}
                                />
                              </div>
                              <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-white/50">
                                {formatInteger(totalTx)} tx
                              </span>
                            </div>
                            <p className="mt-0.5 font-mono text-[9px] text-white/45">
                              {normalShare.toFixed(0)}% normal · {fluxnodeShare.toFixed(0)}% fluxnode
                            </p>
                          </div>
                          <div className="text-right text-[10px] text-[var(--flux-text-secondary)] sm:text-[11px]">
                            <p className="font-mono text-[var(--flux-cyan)]">{ageLabel}</p>
                            <p>{formatInteger(normalTx)} normal</p>
                            <p>{formatInteger(fluxnodeTx)} fluxnode</p>
                          </div>
                        </Link>
                      );
                    })
                  ) : (
                    <div className="px-2 py-3 text-sm text-[var(--flux-text-muted)]">
                      Waiting for live block feed...
                    </div>
                  )}
                </div>
              </div>

              <div className="relative h-full overflow-hidden rounded-[22px] border border-white/[0.08] bg-[linear-gradient(145deg,rgba(7,18,39,0.34),rgba(7,15,34,0.08))] px-3 py-3 sm:px-3.5 sm:py-3.5">
                <div className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
                <div className="mb-3 flex items-end justify-between gap-2">
                  <p className="text-[9px] uppercase tracking-[0.18em] text-[var(--flux-text-dim)] sm:text-[10px] sm:tracking-[0.2em]">
                    Reward Dispatch
                  </p>
                  {latestReward ? (
                    <Link href={`/block/${latestReward.hash}`} className="text-[11px] uppercase tracking-[0.18em] text-[var(--flux-cyan)]">
                      View Block
                    </Link>
                  ) : null}
                </div>
                {latestReward ? (
                  <div className="flex h-full min-h-[372px] flex-col gap-3.5">
                    <div className="rounded-[18px] border border-white/[0.07] bg-[linear-gradient(140deg,rgba(8,16,36,0.46),rgba(8,16,36,0.22))] px-3 py-3">
                      <p className="font-mono text-sm text-white">
                        Block #{latestReward.height.toLocaleString()}
                      </p>
                      <p className="mt-1.5 text-xs text-[var(--flux-text-muted)]">
                        Total reward {latestReward.totalReward.toFixed(2)} FLUX
                      </p>
                    </div>

                    <div className="relative flex-1 overflow-hidden rounded-[24px] border border-white/[0.06] bg-[linear-gradient(145deg,rgba(8,16,36,0.38),rgba(8,16,36,0.12))] px-3 py-3 sm:px-3.5 sm:py-3.5">
                      <div className="pointer-events-none absolute inset-y-4 left-1/2 hidden w-px bg-gradient-to-b from-transparent via-white/22 to-transparent xl:block" />
                      <div className="grid h-full gap-3.5 xl:grid-cols-[1.06fr_0.94fr]">
                        <div className="flex h-full min-h-[324px] flex-col xl:pr-2.5">
                          <div>
                            <p className="px-1 text-[9px] uppercase tracking-[0.18em] text-[var(--flux-text-dim)] sm:text-[10px] sm:tracking-[0.2em]">
                              Output Lanes
                            </p>
                            <div className="mt-3.5 grid gap-3.5">
                              {rewardOutputs.map((output, outputIndex) => {
                                const rewardLabel = getRewardLabel(output.value, latestReward.height);
                                const address = output.address ?? "unknown";
                                return (
                                  <Link
                                    key={`${latestReward.height}-${outputIndex}-${address}`}
                                    href={address === "unknown" ? "/blocks" : `/address/${address}`}
                                    className="group relative flex items-center justify-between rounded-xl px-2.5 py-3 transition-[transform,color] hover:translate-x-1"
                                  >
                                    {outputIndex > 0 ? (
                                      <span className="pointer-events-none absolute inset-x-1 top-0 h-px bg-white/8" />
                                    ) : null}
                                    <div className="min-w-0">
                                      <p className="truncate text-[10px] uppercase tracking-[0.14em] text-[var(--flux-text-muted)] sm:text-[11px]">
                                        {rewardLabel.type}
                                      </p>
                                      <p className="truncate font-mono text-[11px] text-white sm:text-xs">
                                        {address.slice(0, 12)}...{address.slice(-8)}
                                      </p>
                                    </div>
                                    <p className="font-mono text-xs text-[var(--flux-cyan)]">
                                      {output.value.toFixed(8)}
                                    </p>
                                  </Link>
                                );
                              })}
                            </div>
                          </div>
                          {rewardFeeProfile ? (
                            <div className="my-auto pt-4">
                              <div className="rounded-[18px] border border-white/[0.07] bg-[linear-gradient(140deg,rgba(8,16,36,0.42),rgba(8,16,36,0.16))] px-3 py-3.5">
                                <p className="text-[9px] uppercase tracking-[0.16em] text-[var(--flux-text-dim)]">
                                  Fee Signal
                                </p>
                                <div className="mt-2.5 grid grid-cols-3 gap-2 text-[10px]">
                                  <div className="rounded-lg border border-white/[0.08] bg-[rgba(7,15,33,0.58)] px-2 py-1.5">
                                    <p className="text-[8px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                                      Base
                                    </p>
                                    <p className="mt-1 font-mono text-[11px] text-white">
                                      {rewardFeeProfile.baseReward.toFixed(4)}
                                    </p>
                                  </div>
                                  <div className="rounded-lg border border-white/[0.08] bg-[rgba(7,15,33,0.58)] px-2 py-1.5">
                                    <p className="text-[8px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                                      Current Fees
                                    </p>
                                    <p className="mt-1 font-mono text-[11px] text-white">
                                      {rewardFeeProfile.currentFee.toFixed(4)}
                                    </p>
                                  </div>
                                  <div className="rounded-lg border border-white/[0.08] bg-[rgba(7,15,33,0.58)] px-2 py-1.5">
                                    <p className="text-[8px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                                      Avg Fees
                                    </p>
                                    <p className="mt-1 font-mono text-[11px] text-[var(--flux-cyan)]">
                                      {rewardFeeProfile.averageFee.toFixed(4)}
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-2.5 flex h-10 items-end gap-1.5 rounded-lg border border-white/[0.08] bg-[rgba(7,15,33,0.58)] px-2 py-1.5">
                                  {rewardFeeProfile.points.map((point, index) => (
                                    <span
                                      key={`${point.hash}-fee-signal`}
                                      className="w-[6px] rounded-full bg-[linear-gradient(180deg,rgba(56,232,255,0.95),rgba(168,85,247,0.78))]"
                                      style={{
                                        height: `${Math.max(20, Math.round(point.ratio * 100))}%`,
                                        opacity: index === 0 ? 1 : 0.72,
                                      }}
                                    />
                                  ))}
                                </div>
                                <p className="mt-1.5 flex items-center justify-between font-mono text-[9px] text-white/55">
                                  <span>Peak fee {rewardFeeProfile.maxFee.toFixed(4)}</span>
                                  <span className="text-[var(--flux-cyan)]">
                                    Fee share {rewardFeeProfile.feeShare.toFixed(2)}%
                                  </span>
                                </p>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        <div className="flex h-full min-h-[324px] flex-col gap-3.5 border-t border-white/[0.08] pt-3.5 xl:border-l xl:border-t-0 xl:border-white/[0.08] xl:pl-3.5 xl:pt-0">
                          {rewardDispatchStats ? (
                            <div className="grid grid-cols-2 gap-3 rounded-[18px] border border-white/[0.07] bg-[rgba(7,15,33,0.45)] px-3 py-3">
                              <div>
                                <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
                                  Outputs
                                </p>
                                <p className="mt-1.5 font-mono text-sm text-white">
                                  {formatInteger(rewardDispatchStats.outputCount)}
                                </p>
                              </div>
                              <div>
                                <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
                                  Reward Age
                                </p>
                                <p className="mt-1.5 font-mono text-sm text-white">
                                  {rewardDispatchStats.age}
                                </p>
                              </div>
                              <div>
                                <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
                                  Largest
                                </p>
                                <p className="mt-1.5 font-mono text-sm text-[var(--flux-cyan)]">
                                  {rewardDispatchStats.largest.toFixed(8)}
                                </p>
                              </div>
                              <div>
                                <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
                                  Smallest
                                </p>
                                <p className="mt-1.5 font-mono text-sm text-[var(--flux-cyan)]">
                                  {rewardDispatchStats.smallest.toFixed(8)}
                                </p>
                              </div>
                              {rewardFeeProfile ? (
                                <div className="col-span-2 rounded-lg border border-white/[0.08] bg-[rgba(7,15,33,0.5)] px-2.5 py-2">
                                  <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                                    <span>Fee Share</span>
                                    <span className="font-mono text-[var(--flux-cyan)]">
                                      {rewardFeeProfile.feeShare.toFixed(2)}%
                                    </span>
                                  </div>
                                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                                    <div
                                      className="h-full rounded-full bg-[linear-gradient(90deg,rgba(56,232,255,0.9),rgba(168,85,247,0.78))]"
                                      style={{
                                        width: `${Math.max(3, Math.min(100, rewardFeeProfile.feeShare))}%`,
                                      }}
                                    />
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {rewardSplit.length > 0 ? (
                            <div className="flex flex-1 flex-col overflow-hidden rounded-[20px] border border-white/[0.07] bg-[rgba(7,15,33,0.52)] px-3.5 py-4">
                              <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--flux-text-muted)]">
                                Reward Split
                              </p>
                              <p className="mt-1.5 font-mono text-[10px] text-white/60">
                                {formatInteger(rewardDispatchStats?.outputCount)} outputs tracked
                              </p>
                              <div className="mt-4 space-y-3.5">
                                {rewardSplit.map((splitRow) => (
                                  <div key={splitRow.type}>
                                    <div className="flex items-center justify-between text-[11px]">
                                      <span className="font-mono uppercase tracking-[0.08em] text-white/80">
                                        {splitRow.type}
                                      </span>
                                      <div className="text-right">
                                        <p className="font-mono text-sm text-[var(--flux-cyan)]">
                                          {splitRow.percent.toFixed(1)}%
                                        </p>
                                        <p className="font-mono text-[10px] text-white/65">
                                          {splitRow.value.toFixed(8)}
                                        </p>
                                      </div>
                                    </div>
                                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10">
                                      <div
                                        className="h-full rounded-full bg-[linear-gradient(90deg,rgba(56,232,255,0.9),rgba(168,85,247,0.8))]"
                                        style={{ width: `${Math.min(100, Math.max(6, splitRow.percent))}%` }}
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {rewardHistory.length > 0 ? (
                                <div className="mt-auto pt-4">
                                  <div className="rounded-[18px] border border-white/[0.07] bg-[rgba(7,15,33,0.62)] px-3 py-3">
                                    <div className="mb-1.5 flex items-end justify-between">
                                      <p className="text-[9px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                                        Reward Pulse
                                      </p>
                                      <p className="font-mono text-[9px] text-white/55">
                                        last {formatInteger(rewardHistory.length)}
                                      </p>
                                    </div>
                                    <div className="space-y-2">
                                      {rewardHistory.map((rewardItem) => (
                                        <div
                                          key={`${rewardItem.hash}-reward-pulse`}
                                          className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-[10px]"
                                        >
                                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--flux-cyan)] shadow-[0_0_8px_rgba(56,232,255,0.7)]" />
                                          <p className="truncate font-mono text-white/80">
                                            #{rewardItem.height.toLocaleString()}
                                          </p>
                                          <p className="font-mono text-[var(--flux-cyan)]">
                                            {formatTimeAgo(rewardItem.timestamp)} ago
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="flex-1 rounded-lg border border-white/[0.08] bg-[linear-gradient(145deg,rgba(8,16,36,0.24),rgba(8,16,36,0.08))] px-3 py-2 text-xs text-[var(--flux-text-muted)]">
                              Reward split data is syncing...
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="px-2 py-3 text-sm text-[var(--flux-text-muted)]">
                    Reward data is syncing...
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="relative overflow-hidden rounded-[30px] border border-white/[0.08] bg-[linear-gradient(105deg,rgba(6,17,38,0.32)_0%,rgba(7,13,30,0.14)_56%,rgba(8,14,32,0.32)_100%)] px-3 py-3 backdrop-blur-[1.5px] sm:px-5 sm:py-4">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute inset-0 bg-[radial-gradient(80%_140%_at_0%_0%,rgba(56,232,255,0.12),transparent_68%),radial-gradient(80%_140%_at_100%_100%,rgba(168,85,247,0.14),transparent_70%)]" />
            <div
              className="absolute inset-[-20%] bg-[linear-gradient(120deg,rgba(168,85,247,0.14),transparent_46%,rgba(56,232,255,0.14),transparent_82%)] mix-blend-screen opacity-40"
              style={{ animation: "flux-river-drift 20s ease-in-out infinite reverse" }}
            />

            <div className="relative mb-2.5 sm:mb-3">
              <p className="text-[9px] uppercase tracking-[0.2em] text-[var(--flux-text-dim)] sm:text-[10px] sm:tracking-[0.22em]">
                Telemetry Layer
              </p>
              <h3 className="mt-1 text-[15px] font-semibold text-white sm:text-lg">
                Chain Stats + Network Cadence
              </h3>
            </div>

            <div className="relative grid gap-4 sm:gap-5 xl:grid-cols-[1.3fr_0.7fr]">
              <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                {metrics.map((metric, index) => (
                  <MetricSignalTile key={metric.id} metric={metric} index={index} />
                ))}
              </div>

              <div className="relative overflow-hidden rounded-[22px] border border-white/[0.08] bg-[linear-gradient(145deg,rgba(8,16,35,0.34),rgba(8,16,35,0.1))] px-3 py-3 sm:px-3.5">
                <div className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
                <p className="text-[9px] uppercase tracking-[0.18em] text-[var(--flux-text-dim)] sm:text-[10px] sm:tracking-[0.2em]">
                  Network Cadence
                </p>
                <p className="mt-1 text-sm text-[var(--flux-text-secondary)]">
                  Ambient chain health and refresh tempo.
                </p>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-white/[0.08] bg-[linear-gradient(145deg,rgba(9,17,38,0.5),rgba(9,17,38,0.26))] px-2.5 py-2">
                    <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                      Tip Age
                    </p>
                    <p className="mt-1 font-mono text-sm text-white">{formatTimeAgo(tipTime)} ago</p>
                  </div>
                  <div className="rounded-lg border border-white/[0.08] bg-[linear-gradient(145deg,rgba(9,17,38,0.5),rgba(9,17,38,0.26))] px-2.5 py-2">
                    <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                      Freshness
                    </p>
                    <p className="mt-1 font-mono text-sm text-white">{homeSnapshot?.degraded ? "degraded" : "live"}</p>
                  </div>
                  <div className="rounded-lg border border-white/[0.08] bg-[linear-gradient(145deg,rgba(9,17,38,0.5),rgba(9,17,38,0.26))] px-2.5 py-2">
                    <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                      Retry
                    </p>
                    <p className="mt-1 font-mono text-sm text-white">{retryAfter}s</p>
                  </div>
                  <div className="rounded-lg border border-white/[0.08] bg-[linear-gradient(145deg,rgba(9,17,38,0.5),rgba(9,17,38,0.26))] px-2.5 py-2">
                    <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
                      Target
                    </p>
                    <p className="mt-1 font-mono text-sm text-white">30s</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
