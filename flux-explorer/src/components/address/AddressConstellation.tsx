"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Orbit, Sparkles, Activity } from "lucide-react";
import { useAddressConstellation } from "@/lib/api/hooks/useAddressConstellation";
import type {
  AddressConstellationData,
  AddressConstellationEdge,
  AddressConstellationNode,
} from "@/types/address-constellation";

interface AddressConstellationProps {
  address: string;
  pollingToken?: number;
}

interface GraphNode extends AddressConstellationNode, d3.SimulationNodeDatum {
  radius: number;
  color: string;
  glow: string;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  txCount: number;
  volume: number;
  direction: AddressConstellationEdge["direction"];
  strength: number;
}

interface HoverInfo {
  node: AddressConstellationNode;
  anchorX: number;
  anchorY: number;
}

function getNodeColor(node: AddressConstellationNode): { color: string; glow: string } {
  if (node.hop === 0) {
    return {
      color: "rgba(56,232,255,0.98)",
      glow: "rgba(56,232,255,0.82)",
    };
  }
  if (node.hop === 1) {
    return {
      color: "rgba(168,85,247,0.92)",
      glow: "rgba(168,85,247,0.75)",
    };
  }
  return {
    color: "rgba(76,222,170,0.88)",
    glow: "rgba(76,222,170,0.68)",
  };
}

function getEdgeColor(link: Pick<AddressConstellationEdge, "direction">): string {
  if (link.direction === "inbound") return "rgba(56,232,255,0.46)";
  if (link.direction === "outbound") return "rgba(217,70,239,0.42)";
  return "rgba(148,163,184,0.28)";
}

function useContainerSize(container: HTMLDivElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!container) return;

    const updateSize = () => {
      const width = Math.max(320, container.clientWidth);
      const mobile = width < 640;
      const height = mobile ? 340 : Math.max(420, Math.min(620, Math.round(width * 0.55)));
      setSize({ width, height });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        updateSize();
      }
    };
    window.addEventListener("resize", updateSize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    const raf = requestAnimationFrame(updateSize);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [container]);

  return size;
}

function buildGraphData(data: AddressConstellationData): { nodes: GraphNode[]; links: GraphLink[] } {
  const maxBalance = data.nodes.reduce((max, node) => {
    if (node.balance === null) return max;
    return Math.max(max, node.balance);
  }, 0);
  const maxScore = data.nodes.reduce((max, node) => Math.max(max, node.score), 1);

  const nodes: GraphNode[] = data.nodes.map((node) => {
    const balanceRatio =
      node.balance !== null && maxBalance > 0
        ? Math.sqrt(Math.max(0, node.balance) / maxBalance)
        : 0;
    const scoreRatio = Math.sqrt(Math.max(0, node.score) / maxScore);
    const ratio = node.balance !== null ? balanceRatio * 0.72 + scoreRatio * 0.28 : scoreRatio;
    const radius =
      node.hop === 0
        ? 26
        : node.hop === 1
          ? 11 + ratio * 13
          : 8 + ratio * 8;
    const palette = getNodeColor(node);

    return {
      ...node,
      radius,
      color: palette.color,
      glow: palette.glow,
    };
  });

  const links: GraphLink[] = data.edges.map((edge) => ({
    ...edge,
    source: edge.source,
    target: edge.target,
  }));

  return { nodes, links };
}

function formatFlux(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getAnchorFromTarget(target: EventTarget | null): { x: number; y: number } {
  if (!(target instanceof SVGGElement)) {
    return { x: 0, y: 0 };
  }

  const rect = target.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

export function AddressConstellation({ address, pollingToken }: AddressConstellationProps) {
  const router = useRouter();
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainerNode(node);
  }, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useContainerSize(containerNode);
  const [hoveredNode, setHoveredNode] = useState<HoverInfo | null>(null);

  const {
    data,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useAddressConstellation(address, {
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (pollingToken === undefined || pollingToken === 0) return;
    refetch({ cancelRefetch: true });
  }, [pollingToken, refetch]);

  const graphData = useMemo(
    () => (data ? buildGraphData(data) : { nodes: [] as GraphNode[], links: [] as GraphLink[] }),
    [data]
  );

  useEffect(() => {
    if (!svgRef.current || width === 0 || height === 0 || graphData.nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const defs = svg.append("defs");
    const glow = defs.append("filter").attr("id", "constellation-node-glow");
    glow.append("feGaussianBlur").attr("stdDeviation", 3.4).attr("result", "glow");
    glow
      .append("feMerge")
      .selectAll("feMergeNode")
      .data(["glow", "SourceGraphic"])
      .enter()
      .append("feMergeNode")
      .attr("in", (entry) => entry);

    const viewport = svg.append("g").attr("class", "constellation-viewport");

    const backgroundLayer = viewport.append("g");
    backgroundLayer
      .append("ellipse")
      .attr("cx", width * 0.5)
      .attr("cy", height * 0.52)
      .attr("rx", width * 0.44)
      .attr("ry", height * 0.35)
      .attr("fill", "url(#none)");
    backgroundLayer
      .append("rect")
      .attr("x", width * 0.12)
      .attr("y", height * 0.18)
      .attr("width", width * 0.76)
      .attr("height", height * 0.64)
      .attr("rx", 30)
      .attr("fill", "rgba(8,19,39,0.2)")
      .attr("stroke", "rgba(255,255,255,0.04)");

    const linkLayer = viewport.append("g").attr("stroke-linecap", "round");
    const nodeLayer = viewport.append("g");
    const labelLayer = viewport.append("g");

    const nodes = graphData.nodes.map((entry) => ({ ...entry }));
    const links = graphData.links.map((entry) => ({ ...entry }));

    const centerNode = nodes.find((entry) => entry.hop === 0);
    if (centerNode) {
      centerNode.fx = width / 2;
      centerNode.fy = height / 2;
    }

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<GraphNode, GraphLink>(links)
          .id((entry) => entry.id)
          .distance((link) => {
            const sourceHop = typeof link.source === "string" ? 2 : link.source.hop;
            const targetHop = typeof link.target === "string" ? 2 : link.target.hop;
            if (sourceHop === 0 || targetHop === 0) return 100;
            if (sourceHop === 1 && targetHop === 1) return 128;
            return 140;
          })
          .strength((link) => Math.min(0.95, 0.2 + link.strength * 0.6))
      )
      .force(
        "charge",
        d3
          .forceManyBody<GraphNode>()
          .strength((entry) => (entry.hop === 0 ? -1200 : entry.hop === 1 ? -560 : -320))
      )
      .force("collide", d3.forceCollide<GraphNode>().radius((entry) => entry.radius + 11).iterations(3))
      .force("x", d3.forceX<GraphNode>(width / 2).strength((entry) => (entry.hop === 0 ? 0.2 : 0.05)))
      .force("y", d3.forceY<GraphNode>(height / 2).strength((entry) => (entry.hop === 0 ? 0.2 : 0.05)))
      .alpha(1)
      .alphaDecay(0.06);

    const line = linkLayer
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke", (entry) => getEdgeColor(entry))
      .attr("stroke-width", (entry) => 1 + entry.strength * 2.6)
      .attr("opacity", 0.9);

    const nodeGroup = nodeLayer
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", "constellation-node")
      .style("cursor", "pointer");

    nodeGroup
      .append("circle")
      .attr("r", (entry) => entry.radius * 1.62)
      .attr("fill", (entry) => entry.glow)
      .attr("opacity", (entry) => (entry.hop === 0 ? 0.24 : 0.16))
      .style("filter", "blur(8px)");

    nodeGroup
      .append("circle")
      .attr("r", (entry) => entry.radius + 5)
      .attr("fill", "none")
      .attr("stroke", (entry) => entry.color)
      .attr("stroke-width", (entry) => (entry.hop === 0 ? 1.6 : 1))
      .attr("opacity", 0.42)
      .attr("stroke-dasharray", (entry) => (entry.hop === 0 ? "5 3" : "3 4"));

    nodeGroup
      .append("circle")
      .attr("r", (entry) => entry.radius)
      .attr("fill", (entry) => entry.color)
      .attr("opacity", 0.22)
      .attr("stroke", (entry) => entry.color)
      .attr("stroke-width", (entry) => (entry.hop === 0 ? 2.2 : 1.2))
      .style("filter", "url(#constellation-node-glow)");

    nodeGroup
      .append("circle")
      .attr("r", (entry) => Math.max(2.5, entry.radius * 0.3))
      .attr("fill", (entry) => entry.color)
      .attr("opacity", 0.94);

    const labels = labelLayer
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", "constellation-label")
      .attr("pointer-events", "none");

    labels
      .append("text")
      .text((entry) => (entry.hop === 0 ? "CURRENT" : entry.label))
      .attr("text-anchor", "middle")
      .attr("dy", (entry) => entry.radius + 14)
      .attr("fill", (entry) => (entry.hop === 0 ? "rgba(56,232,255,0.96)" : "rgba(174,203,230,0.86)"))
      .attr("font-size", (entry) => (entry.hop === 0 ? "9px" : "8px"))
      .attr("font-weight", (entry) => (entry.hop === 0 ? 700 : 500))
      .attr("letter-spacing", "0.09em");

    const drag = d3
      .drag<SVGGElement, GraphNode>()
      .on("start", (event, entry) => {
        if (!event.active) simulation.alphaTarget(0.25).restart();
        if (entry.hop === 0) return;
        entry.fx = entry.x;
        entry.fy = entry.y;
      })
      .on("drag", (event, entry) => {
        if (entry.hop === 0) return;
        entry.fx = event.x;
        entry.fy = event.y;
      })
      .on("end", (event, entry) => {
        if (!event.active) simulation.alphaTarget(0);
        if (entry.hop === 0) return;
        entry.fx = null;
        entry.fy = null;
      });

    nodeGroup.call(drag);

    nodeGroup
      .on("mouseenter", (event, entry) => {
        const anchor = getAnchorFromTarget(event.currentTarget);
        setHoveredNode({
          node: entry,
          anchorX: anchor.x,
          anchorY: anchor.y,
        });
      })
      .on("mousemove", (event, entry) => {
        const anchor = getAnchorFromTarget(event.currentTarget);
        setHoveredNode({
          node: entry,
          anchorX: anchor.x,
          anchorY: anchor.y,
        });
      })
      .on("mouseleave", () => setHoveredNode(null))
      .on("click", (_, entry) => {
        if (entry.id === address) return;
        router.push(`/address/${entry.id}`);
      });

    simulation.on("tick", () => {
      nodes.forEach((entry) => {
        entry.x = Math.max(entry.radius + 8, Math.min(width - entry.radius - 8, entry.x ?? width / 2));
        entry.y = Math.max(entry.radius + 8, Math.min(height - entry.radius - 8, entry.y ?? height / 2));
      });

      line
        .attr("x1", (entry) => (entry.source as GraphNode).x ?? 0)
        .attr("y1", (entry) => (entry.source as GraphNode).y ?? 0)
        .attr("x2", (entry) => (entry.target as GraphNode).x ?? 0)
        .attr("y2", (entry) => (entry.target as GraphNode).y ?? 0);

      nodeGroup.attr("transform", (entry) => `translate(${entry.x ?? 0},${entry.y ?? 0})`);

      labels.attr("transform", (entry) => `translate(${entry.x ?? 0},${entry.y ?? 0})`);
    });

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.65, 2.2])
      .on("zoom", (event) => {
        viewport.attr("transform", event.transform.toString());
      });
    svg.call(zoomBehavior);

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
      setHoveredNode(null);
    };
  }, [address, graphData.links, graphData.nodes, height, router, width]);

  if (isLoading) {
    return (
      <Card className="rounded-2xl border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.46),rgba(7,15,33,0.22))]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Orbit className="h-5 w-5 text-cyan-300" />
            Address Constellation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-[420px] w-full rounded-2xl" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data || data.nodes.length === 0) {
    return (
      <Card className="rounded-2xl border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.46),rgba(7,15,33,0.22))]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Orbit className="h-5 w-5 text-cyan-300" />
            Address Constellation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {error?.message ?? "No interaction data available for this address."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const firstHopCount = data.nodes.filter((entry) => entry.hop === 1).length;
  const secondHopCount = data.nodes.filter((entry) => entry.hop === 2).length;
  const tooltipStyle = (() => {
    if (!hoveredNode || typeof window === "undefined") return undefined;

    const tooltipWidth = 240;
    const tooltipHeight = 198;
    const pad = 14;

    const x = clamp(
      hoveredNode.anchorX + 16,
      pad,
      Math.max(pad, window.innerWidth - tooltipWidth - pad)
    );
    const y = clamp(
      hoveredNode.anchorY - tooltipHeight * 0.45,
      pad,
      Math.max(pad, window.innerHeight - tooltipHeight - pad)
    );

    return {
      left: x,
      top: y,
    };
  })();

  return (
    <Card className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.52),rgba(7,15,33,0.24))]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_100%_at_12%_0%,rgba(56,232,255,0.13),transparent_65%),radial-gradient(90%_120%_at_100%_100%,rgba(168,85,247,0.12),transparent_72%)]" />
      <div className="pointer-events-none absolute inset-0 flux-home-grid-motion opacity-15" />

      <CardHeader className="relative gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Orbit className="h-5 w-5 text-cyan-300" />
            Address Constellation
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-cyan-400/30 bg-cyan-500/10 text-cyan-200">
              First Ring: {firstHopCount}
            </Badge>
            <Badge variant="outline" className="border-emerald-400/30 bg-emerald-500/10 text-emerald-200">
              Second Ring: {secondHopCount}
            </Badge>
            {isFetching ? (
              <Badge variant="outline" className="border-white/[0.2] bg-white/[0.04] text-muted-foreground">
                Refreshing...
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
            <Sparkles className="h-3 w-3 text-cyan-300" />
            Centered on current address
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
            <Activity className="h-3 w-3 text-purple-300" />
            Two-hop transfer neighborhoods
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
            Drag nodes, scroll to zoom
          </span>
        </div>
      </CardHeader>

      <CardContent className="relative">
        <div
          ref={containerRef}
          className="relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(7,15,33,0.85),rgba(5,10,24,0.82))]"
        >
          <svg ref={svgRef} className="h-full w-full" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-[linear-gradient(180deg,transparent,rgba(3,8,18,0.8))]" />
        </div>

        <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-4">
          <div className="rounded-xl border border-white/[0.08] bg-[rgba(8,18,37,0.45)] p-2.5">
            <div className="uppercase tracking-[0.14em] text-[10px] text-[var(--flux-text-dim)]">Analyzed TX</div>
            <div className="mt-1 text-sm font-semibold text-[var(--flux-text-secondary)]">
              {data.stats.analyzedTransactions.toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[rgba(8,18,37,0.45)] p-2.5">
            <div className="uppercase tracking-[0.14em] text-[10px] text-[var(--flux-text-dim)]">Edges</div>
            <div className="mt-1 text-sm font-semibold text-[var(--flux-text-secondary)]">
              {data.stats.edgeCount.toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[rgba(8,18,37,0.45)] p-2.5">
            <div className="uppercase tracking-[0.14em] text-[10px] text-[var(--flux-text-dim)]">Hop Queries</div>
            <div className="mt-1 text-sm font-semibold text-[var(--flux-text-secondary)]">
              {data.stats.hopRequests.toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[rgba(8,18,37,0.45)] p-2.5">
            <div className="uppercase tracking-[0.14em] text-[10px] text-[var(--flux-text-dim)]">Dataset</div>
            <div className="mt-1 text-sm font-semibold text-[var(--flux-text-secondary)]">
              {data.truncated.firstHop || data.truncated.secondHop ? "Bounded" : "Full Window"}
            </div>
          </div>
        </div>
      </CardContent>

      {hoveredNode ? (
        <div
          className="pointer-events-none fixed z-[120] min-w-[220px] rounded-xl border border-white/[0.14] bg-[linear-gradient(140deg,rgba(7,18,39,0.95),rgba(8,16,35,0.95))] px-3 py-2.5 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
          style={tooltipStyle}
        >
          <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
            {hoveredNode.node.hop === 0 ? "Center Address" : hoveredNode.node.hop === 1 ? "First Ring" : "Second Ring"}
          </div>
          <div className="mt-1 font-mono text-xs text-cyan-200">{hoveredNode.node.id}</div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[var(--flux-text-secondary)]">
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">Tx Count</div>
              <div className="font-semibold">{hoveredNode.node.txCount.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">Volume</div>
              <div className="font-semibold">{formatFlux(hoveredNode.node.volume)} FLUX</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">Inbound</div>
              <div className="font-semibold">{hoveredNode.node.inboundTxCount.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">Outbound</div>
              <div className="font-semibold">{hoveredNode.node.outboundTxCount.toLocaleString()}</div>
            </div>
          </div>
          <div className="mt-2 border-t border-white/[0.1] pt-2 text-[11px] text-[var(--flux-text-muted)]">
            Balance:{" "}
            <span className="font-semibold text-cyan-200">
              {hoveredNode.node.balance === null ? "unavailable" : `${formatFlux(hoveredNode.node.balance)} FLUX`}
            </span>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
