"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as d3 from "d3";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Orbit, Sparkles, Activity, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
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

function optimizeGraphForMobile(data: AddressConstellationData): AddressConstellationData {
  const nodeCap = 72;
  const edgeCap = 120;
  if (data.nodes.length <= nodeCap && data.edges.length <= edgeCap) {
    return data;
  }

  const nodeById = new Map(data.nodes.map((entry) => [entry.id, entry]));
  const centerNode = data.nodes.find((entry) => entry.hop === 0);
  if (!centerNode) {
    return data;
  }

  const nodePriority = (entry: AddressConstellationNode): number => {
    const txSignal = Math.log10(entry.txCount + 1) * 4;
    const volumeSignal = Math.log10(entry.volume + 1) * 1.4;
    const balanceSignal =
      entry.balance !== null && entry.balance > 0 ? Math.log10(entry.balance + 1) * 0.8 : 0;
    return entry.score * 1.7 + txSignal + volumeSignal + balanceSignal;
  };

  const sortedFirstHop = data.nodes
    .filter((entry) => entry.hop === 1)
    .sort((left, right) => nodePriority(right) - nodePriority(left));
  const keptFirstHop = sortedFirstHop.slice(0, 24);
  const keptFirstHopIds = new Set(keptFirstHop.map((entry) => entry.id));

  const secondHopConnectedIds = new Set<string>();
  for (const edge of data.edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    if (keptFirstHopIds.has(source)) secondHopConnectedIds.add(target);
    if (keptFirstHopIds.has(target)) secondHopConnectedIds.add(source);
  }

  const sortedSecondHop = data.nodes
    .filter((entry) => entry.hop === 2)
    .sort((left, right) => {
      const rightConnected = secondHopConnectedIds.has(right.id) ? 1 : 0;
      const leftConnected = secondHopConnectedIds.has(left.id) ? 1 : 0;
      if (rightConnected !== leftConnected) return rightConnected - leftConnected;
      return nodePriority(right) - nodePriority(left);
    });
  const keptSecondHop = sortedSecondHop.slice(0, 40);

  const keptNodeIds = new Set<string>([
    centerNode.id,
    ...keptFirstHop.map((entry) => entry.id),
    ...keptSecondHop.map((entry) => entry.id),
  ]);

  const keptEdges = data.edges
    .filter((edge) => {
      const source = String(edge.source);
      const target = String(edge.target);
      return keptNodeIds.has(source) && keptNodeIds.has(target);
    })
    .sort((left, right) => {
      const leftTouchesCenter =
        String(left.source) === centerNode.id || String(left.target) === centerNode.id ? 1 : 0;
      const rightTouchesCenter =
        String(right.source) === centerNode.id || String(right.target) === centerNode.id ? 1 : 0;
      if (leftTouchesCenter !== rightTouchesCenter) return rightTouchesCenter - leftTouchesCenter;
      const rightWeight = right.strength * 100 + Math.log10(right.txCount + 1) * 5;
      const leftWeight = left.strength * 100 + Math.log10(left.txCount + 1) * 5;
      return rightWeight - leftWeight;
    })
    .slice(0, edgeCap);

  const edgeNodeIds = new Set<string>([centerNode.id]);
  for (const edge of keptEdges) {
    edgeNodeIds.add(String(edge.source));
    edgeNodeIds.add(String(edge.target));
  }

  const keptNodes = data.nodes.filter((entry) => {
    if (entry.id === centerNode.id) return true;
    if (edgeNodeIds.has(entry.id)) return true;
    const fallbackNode = nodeById.get(entry.id);
    return Boolean(fallbackNode && entry.hop === 1 && keptFirstHopIds.has(entry.id));
  });

  return {
    ...data,
    nodes: keptNodes,
    edges: keptEdges,
  };
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

function getAnchorFromPointerEvent(event: unknown): { x: number; y: number } {
  if (!event || typeof event !== "object") return { x: 0, y: 0 };

  const candidate = event as {
    clientX?: unknown;
    clientY?: unknown;
    sourceEvent?: unknown;
    touches?: Array<{ clientX?: unknown; clientY?: unknown }> | null;
  };

  if (typeof candidate.clientX === "number" && typeof candidate.clientY === "number") {
    return { x: candidate.clientX, y: candidate.clientY };
  }

  const touch = Array.isArray(candidate.touches) ? candidate.touches[0] : null;
  if (touch && typeof touch.clientX === "number" && typeof touch.clientY === "number") {
    return { x: touch.clientX, y: touch.clientY };
  }

  const source = candidate.sourceEvent as
    | { clientX?: unknown; clientY?: unknown; touches?: Array<{ clientX?: unknown; clientY?: unknown }> | null }
    | undefined;
  if (source && typeof source.clientX === "number" && typeof source.clientY === "number") {
    return { x: source.clientX, y: source.clientY };
  }

  const sourceTouch = source && Array.isArray(source.touches) ? source.touches[0] : null;
  if (
    sourceTouch &&
    typeof sourceTouch.clientX === "number" &&
    typeof sourceTouch.clientY === "number"
  ) {
    return { x: sourceTouch.clientX, y: sourceTouch.clientY };
  }

  return { x: 0, y: 0 };
}

export function AddressConstellation({ address }: AddressConstellationProps) {
  const router = useRouter();
  const pageAddress = address.trim();
  const [centerAddress, setCenterAddress] = useState(pageAddress);
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainerNode(node);
  }, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomApiRef = useRef<{ zoomIn: () => void; zoomOut: () => void; reset: () => void } | null>(
    null
  );
  const stablePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const { width, height } = useContainerSize(containerNode);
  const [hoveredNode, setHoveredNode] = useState<HoverInfo | null>(null);
  const [mobileSelectedNode, setMobileSelectedNode] = useState<AddressConstellationNode | null>(null);
  const [isHopAnimating, setIsHopAnimating] = useState(false);
  const [scanMode, setScanMode] = useState<"fast" | "deep">("fast");
  const isMobile = width > 0 && width < 640;

  useEffect(() => {
    if (!pageAddress) return;
    setCenterAddress(pageAddress);
  }, [pageAddress]);

  useEffect(() => {
    setMobileSelectedNode(null);
  }, [centerAddress]);

  const { data, isLoading, error, isFetching } = useAddressConstellation(centerAddress, scanMode, {
    refetchOnWindowFocus: false,
  });

  const graphSourceData = useMemo(() => {
    if (!data) return null;
    return isMobile ? optimizeGraphForMobile(data) : data;
  }, [data, isMobile]);

  const graphData = useMemo(
    () =>
      graphSourceData
        ? buildGraphData(graphSourceData)
        : { nodes: [] as GraphNode[], links: [] as GraphLink[] },
    [graphSourceData]
  );

  const hopToAddress = useCallback(
    (nextAddress: string) => {
      if (!nextAddress || nextAddress === centerAddress) return;
      setIsHopAnimating(true);
      setCenterAddress(nextAddress);
    },
    [centerAddress]
  );

  useEffect(() => {
    if (!isHopAnimating || isFetching) return;
    const timer = window.setTimeout(() => setIsHopAnimating(false), isMobile ? 180 : 220);
    return () => window.clearTimeout(timer);
  }, [isFetching, isHopAnimating, isMobile]);

  useEffect(() => {
    if (!svgRef.current || width === 0 || height === 0 || graphData.nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const enableGlow = !isMobile;
    if (enableGlow) {
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
    }

    const viewport = svg.append("g").attr("class", "constellation-viewport");

    if (!isMobile) {
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
    }

    const linkLayer = viewport.append("g").attr("stroke-linecap", "round");
    const nodeLayer = viewport.append("g");
    const labelLayer = viewport.append("g");

    const nodes = graphData.nodes.map((entry) => ({ ...entry }));
    const links = graphData.links.map((entry) => ({ ...entry }));
    const knownPositions = stablePositionsRef.current;
    const adjacency = new Map<string, string[]>();
    links.forEach((entry) => {
      const sourceId = typeof entry.source === "string" ? entry.source : entry.source.id;
      const targetId = typeof entry.target === "string" ? entry.target : entry.target.id;
      if (!adjacency.has(sourceId)) adjacency.set(sourceId, []);
      if (!adjacency.has(targetId)) adjacency.set(targetId, []);
      adjacency.get(sourceId)?.push(targetId);
      adjacency.get(targetId)?.push(sourceId);
    });
    nodes.forEach((entry) => {
      const known = knownPositions.get(entry.id);
      if (known) {
        entry.x = known.x;
        entry.y = known.y;
        return;
      }
      const neighbors = adjacency.get(entry.id) ?? [];
      for (const neighborId of neighbors) {
        const neighborPos = knownPositions.get(neighborId);
        if (!neighborPos) continue;
        const branchJitter = isMobile ? 18 : 26;
        entry.x = neighborPos.x + (Math.random() - 0.5) * branchJitter;
        entry.y = neighborPos.y + (Math.random() - 0.5) * branchJitter;
        return;
      }
      const drift = isMobile ? 20 : 42;
      entry.x = width / 2 + (Math.random() - 0.5) * drift;
      entry.y = height / 2 + (Math.random() - 0.5) * drift;
    });

    const centerNode = nodes.find((entry) => entry.hop === 0);
    if (centerNode) {
      centerNode.fx = width / 2;
      centerNode.fy = height / 2;
      centerNode.x = width / 2;
      centerNode.y = height / 2;
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
            if (sourceHop === 0 || targetHop === 0) return isMobile ? 88 : 100;
            if (sourceHop === 1 && targetHop === 1) return isMobile ? 110 : 128;
            return isMobile ? 122 : 140;
          })
          .strength((link) => {
            const baseStrength = Math.min(0.95, 0.2 + link.strength * 0.6);
            return isMobile ? Math.min(0.72, baseStrength * 0.76) : baseStrength;
          })
      )
      .force(
        "charge",
        d3
          .forceManyBody<GraphNode>()
          .strength((entry) => {
            if (!isMobile) return entry.hop === 0 ? -1200 : entry.hop === 1 ? -560 : -320;
            return entry.hop === 0 ? -760 : entry.hop === 1 ? -320 : -170;
          })
      )
      .force(
        "collide",
        d3
          .forceCollide<GraphNode>()
          .radius((entry) => entry.radius + (isMobile ? 7 : 11))
          .iterations(isMobile ? 1 : 3)
      )
      .force(
        "x",
        d3
          .forceX<GraphNode>(width / 2)
          .strength((entry) => (entry.hop === 0 ? (isMobile ? 0.22 : 0.2) : isMobile ? 0.08 : 0.05))
      )
      .force(
        "y",
        d3
          .forceY<GraphNode>(height / 2)
          .strength((entry) => (entry.hop === 0 ? (isMobile ? 0.22 : 0.2) : isMobile ? 0.08 : 0.05))
      )
      .alpha(1)
      .alphaDecay(isMobile ? 0.14 : 0.06)
      .alphaMin(isMobile ? 0.06 : 0.001)
      .velocityDecay(isMobile ? 0.5 : 0.4);

    const line = linkLayer
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke", (entry) => getEdgeColor(entry))
      .attr("stroke-width", (entry) => (isMobile ? 0.65 + entry.strength * 1.6 : 1 + entry.strength * 2.6))
      .attr("opacity", 0);

    const nodeGroup = nodeLayer
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", "constellation-node")
      .style("opacity", (entry) => (knownPositions.has(entry.id) ? 1 : 0))
      .style("cursor", "pointer");

    if (!isMobile) {
      nodeGroup
        .append("circle")
        .attr("r", (entry) => entry.radius * 1.62)
        .attr("fill", (entry) => entry.glow)
        .attr("opacity", (entry) => (entry.hop === 0 ? 0.24 : 0.16))
        .style("filter", "blur(8px)");
    }

    if (!isMobile) {
      nodeGroup
        .append("circle")
        .attr("r", (entry) => entry.radius + 5)
        .attr("fill", "none")
        .attr("stroke", (entry) => entry.color)
        .attr("stroke-width", (entry) => (entry.hop === 0 ? 1.6 : 1))
        .attr("opacity", 0.42)
        .attr("stroke-dasharray", (entry) => (entry.hop === 0 ? "5 3" : "3 4"));
    }

    nodeGroup
      .append("circle")
      .attr("r", (entry) => entry.radius)
      .attr("fill", (entry) => entry.color)
      .attr("opacity", 0.22)
      .attr("stroke", (entry) => entry.color)
      .attr("stroke-width", (entry) => (entry.hop === 0 ? (isMobile ? 1.8 : 2.2) : isMobile ? 1 : 1.2))
      .style("filter", enableGlow ? "url(#constellation-node-glow)" : "none");

    nodeGroup
      .append("circle")
      .attr("r", (entry) => Math.max(2.5, entry.radius * 0.3))
      .attr("fill", (entry) => entry.color)
      .attr("opacity", 0.94);

    const showLabels = !isMobile;
    const labels = showLabels
      ? labelLayer
          .selectAll("g")
          .data(nodes)
          .enter()
          .append("g")
          .attr("class", "constellation-label")
          .attr("pointer-events", "none")
      : null;

    if (labels) {
      labels
        .append("text")
        .text((entry) => (entry.hop === 0 ? "CURRENT" : entry.label))
        .attr("text-anchor", "middle")
        .attr("dy", (entry) => entry.radius + 14)
        .attr(
          "fill",
          (entry) => (entry.hop === 0 ? "rgba(56,232,255,0.96)" : "rgba(174,203,230,0.86)")
        )
        .attr("font-size", (entry) => (entry.hop === 0 ? "9px" : "8px"))
        .attr("font-weight", (entry) => (entry.hop === 0 ? 700 : 500))
        .attr("letter-spacing", "0.09em");
    }
    const enterDuration = isMobile ? 120 : 220;
    line.transition().duration(enterDuration).attr("opacity", isMobile ? 0.72 : 0.9);
    nodeGroup
      .filter((entry) => !knownPositions.has(entry.id))
      .transition()
      .duration(enterDuration)
      .style("opacity", 1);
    if (labels) {
      labels.style("opacity", 0).transition().duration(enterDuration).style("opacity", 1);
    }

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

    if (!isMobile) {
      nodeGroup.call(drag);
    }

    if (!isMobile) {
      nodeGroup
        .on("mouseenter", (event, entry) => {
          const anchor = getAnchorFromPointerEvent(event);
          setHoveredNode({
            node: entry,
            anchorX: anchor.x,
            anchorY: anchor.y,
          });
        })
        .on("mousemove", (event, entry) => {
          const anchor = getAnchorFromPointerEvent(event);
          setHoveredNode({
            node: entry,
            anchorX: anchor.x,
            anchorY: anchor.y,
          });
        })
        .on("mouseleave", () => setHoveredNode(null));
    }

    nodeGroup.on("click", (event, entry) => {
        if (isMobile) {
          setMobileSelectedNode(entry);
          return;
        }

        if (entry.id === centerAddress) return;

        const shouldNavigate =
          event &&
          typeof event === "object" &&
          Boolean(
            (event as { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }).metaKey ||
              (event as { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }).ctrlKey ||
              (event as { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }).shiftKey ||
              (event as { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }).altKey
          );

        if (shouldNavigate) {
          router.push(`/address/${entry.id}`);
          return;
        }

        hopToAddress(entry.id);
      });

    const latestPositions = new Map<string, { x: number; y: number }>();
    let animationFrameId: number | null = null;
    const renderTick = () => {
      line
        .attr("x1", (entry) => (entry.source as GraphNode).x ?? 0)
        .attr("y1", (entry) => (entry.source as GraphNode).y ?? 0)
        .attr("x2", (entry) => (entry.target as GraphNode).x ?? 0)
        .attr("y2", (entry) => (entry.target as GraphNode).y ?? 0);

      nodeGroup.attr("transform", (entry) => `translate(${entry.x ?? 0},${entry.y ?? 0})`);

      if (labels) {
        labels.attr("transform", (entry) => `translate(${entry.x ?? 0},${entry.y ?? 0})`);
      }
    };
    const scheduleRender = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        renderTick();
      });
    };

    simulation.on("tick", () => {
      nodes.forEach((entry) => {
        entry.x = Math.max(entry.radius + 8, Math.min(width - entry.radius - 8, entry.x ?? width / 2));
        entry.y = Math.max(entry.radius + 8, Math.min(height - entry.radius - 8, entry.y ?? height / 2));
        latestPositions.set(entry.id, {
          x: entry.x,
          y: entry.y,
        });
      });

      if (isMobile) {
        scheduleRender();
        return;
      }

      renderTick();
    });
    simulation.on("end", () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      renderTick();
    });
    const settleTimer = isMobile
      ? window.setTimeout(() => {
          simulation.stop();
          renderTick();
        }, 900)
      : null;

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.65, 2.2])
      .on("zoom", (event) => {
        viewport.attr("transform", event.transform.toString());
      });
    svg.call(zoomBehavior);

    zoomApiRef.current = {
      zoomIn: () => {
        svg.transition().duration(180).call(zoomBehavior.scaleBy, 1.18);
      },
      zoomOut: () => {
        svg.transition().duration(180).call(zoomBehavior.scaleBy, 1 / 1.18);
      },
      reset: () => {
        svg.transition().duration(180).call(zoomBehavior.transform, d3.zoomIdentity);
      },
    };

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
      setHoveredNode(null);
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
      stablePositionsRef.current = latestPositions;
      zoomApiRef.current = null;
    };
  }, [centerAddress, graphData.links, graphData.nodes, height, hopToAddress, isMobile, router, width]);

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
  const renderedFirstHopCount = graphData.nodes.filter((entry) => entry.hop === 1).length;
  const renderedSecondHopCount = graphData.nodes.filter((entry) => entry.hop === 2).length;
  const isMobileSimplified =
    isMobile &&
    graphSourceData !== null &&
    (graphSourceData.nodes.length < data.nodes.length || graphSourceData.edges.length < data.edges.length);
  const isExploring = centerAddress !== pageAddress;
  const centerNode = data.nodes.find((entry) => entry.hop === 0);
  const tooltipStyle = (() => {
    if (!hoveredNode || typeof window === "undefined") return undefined;

    const tooltipWidth = 240;
    const tooltipHeight = 198;
    const pad = 14;
    const offset = 14;

    const anchorX = hoveredNode.anchorX;
    const anchorY = hoveredNode.anchorY;

    let x = anchorX + offset;
    let y = anchorY + offset;

    if (x + tooltipWidth + pad > window.innerWidth) {
      x = anchorX - tooltipWidth - offset;
    }
    if (y + tooltipHeight + pad > window.innerHeight) {
      y = anchorY - tooltipHeight - offset;
    }

    x = clamp(x, pad, Math.max(pad, window.innerWidth - tooltipWidth - pad));
    y = clamp(y, pad, Math.max(pad, window.innerHeight - tooltipHeight - pad));

    return {
      left: x,
      top: y,
    };
  })();

  return (
    <Card className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.52),rgba(7,15,33,0.24))]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_100%_at_12%_0%,rgba(56,232,255,0.13),transparent_65%),radial-gradient(90%_120%_at_100%_100%,rgba(168,85,247,0.12),transparent_72%)]" />
      <div className="pointer-events-none absolute inset-0 hidden flux-home-grid-motion opacity-15 sm:block" />

      <CardHeader className="relative gap-3">
        <div className="sm:hidden">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Orbit className="h-5 w-5 text-cyan-300" />
              Address Constellation
            </CardTitle>
            {isFetching ? (
              <Badge variant="outline" className="border-white/[0.2] bg-white/[0.04] text-muted-foreground">
                Refreshing...
              </Badge>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-white/[0.18] bg-white/[0.04] text-[11px] uppercase tracking-[0.12em]"
              onClick={() => setScanMode((prev) => (prev === "fast" ? "deep" : "fast"))}
            >
              Scan: {scanMode === "deep" ? "Deep" : "Fast"}
            </Button>
            {isExploring ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 border-white/[0.18] bg-white/[0.04] text-[11px] uppercase tracking-[0.12em]"
                onClick={() => hopToAddress(pageAddress)}
              >
                Reset
              </Button>
            ) : null}
            {isExploring ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 border-white/[0.18] bg-white/[0.04] text-[11px] uppercase tracking-[0.12em]"
                onClick={() => router.push(`/address/${centerAddress}`)}
              >
                Open Page
              </Button>
            ) : null}
            <Badge variant="outline" className="border-cyan-400/30 bg-cyan-500/10 text-cyan-200">
              1st: {isMobileSimplified ? `${renderedFirstHopCount}/${firstHopCount}` : firstHopCount}
            </Badge>
            <Badge variant="outline" className="border-emerald-400/30 bg-emerald-500/10 text-emerald-200">
              2nd: {isMobileSimplified ? `${renderedSecondHopCount}/${secondHopCount}` : secondHopCount}
            </Badge>
            {isMobileSimplified ? (
              <Badge variant="outline" className="border-white/[0.18] bg-white/[0.04] text-muted-foreground">
                Optimized View
              </Badge>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
              <Sparkles className="h-3 w-3 text-cyan-300" />
              <span className="font-mono normal-case tracking-normal text-cyan-200">
                {centerAddress.slice(0, 6)}...{centerAddress.slice(-5)}
              </span>
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
              <Activity className="h-3 w-3 text-purple-300" />
              Tap to explore
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
              Balance:{" "}
              <span className="font-semibold text-cyan-200">
                {centerNode?.balance === null || centerNode?.balance === undefined
                  ? "unavailable"
                  : `${formatFlux(centerNode.balance)} FLUX`}
              </span>
            </span>
          </div>
        </div>

        <div className="hidden sm:block">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Orbit className="h-5 w-5 text-cyan-300" />
              Address Constellation
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-white/[0.18] bg-white/[0.04] text-muted-foreground">
                {scanMode === "deep" ? "Deep" : "Fast"} Scan
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="h-8 border-white/[0.18] bg-white/[0.04] text-[11px] uppercase tracking-[0.12em]"
                onClick={() => setScanMode((prev) => (prev === "fast" ? "deep" : "fast"))}
              >
                {scanMode === "fast" ? "Deep Scan" : "Fast Scan"}
              </Button>
              {isExploring ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 border-white/[0.18] bg-white/[0.04] text-[11px] uppercase tracking-[0.12em]"
                    onClick={() => hopToAddress(pageAddress)}
                  >
                    Reset
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 border-white/[0.18] bg-white/[0.04] text-[11px] uppercase tracking-[0.12em]"
                    onClick={() => router.push(`/address/${centerAddress}`)}
                  >
                    Open Page
                  </Button>
                </>
              ) : null}
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
              Centered on{" "}
              <span className="font-mono normal-case tracking-normal text-cyan-200">
                {centerAddress.slice(0, 6)}...{centerAddress.slice(-5)}
              </span>
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
              <Activity className="h-3 w-3 text-purple-300" />
              Two-hop transfer neighborhoods
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
              Click to re-center (Ctrl/Cmd to open)
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[rgba(8,18,37,0.54)] px-2 py-1">
              Drag nodes, scroll to zoom
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="relative">
        <div
          ref={containerRef}
          className={`relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(7,15,33,0.85),rgba(5,10,24,0.82))] transition-[opacity,transform] duration-200 ${
            isHopAnimating ? "opacity-80 scale-[0.996]" : "opacity-100 scale-100"
          }`}
        >
          <svg ref={svgRef} className="h-full w-full" />
          <div className="absolute right-3 top-3 z-10 flex flex-col gap-2 sm:hidden">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9 border-white/[0.18] bg-[rgba(8,18,37,0.54)]"
              onClick={() => zoomApiRef.current?.zoomIn()}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4 text-cyan-200" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9 border-white/[0.18] bg-[rgba(8,18,37,0.54)]"
              onClick={() => zoomApiRef.current?.zoomOut()}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4 text-cyan-200" />
            </Button>
            {isExploring ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 border-white/[0.18] bg-[rgba(8,18,37,0.54)]"
                onClick={() => hopToAddress(pageAddress)}
                aria-label="Reset to page address"
              >
                <RotateCcw className="h-4 w-4 text-cyan-200" />
              </Button>
            ) : null}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-[linear-gradient(180deg,transparent,rgba(3,8,18,0.8))]" />
          {isMobile ? (
            <div
              className={`absolute inset-0 z-20 transition-opacity duration-200 ${
                mobileSelectedNode ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
              }`}
            >
              <button
                type="button"
                className="absolute inset-0 bg-[rgba(2,8,18,0.56)]"
                onClick={() => setMobileSelectedNode(null)}
                aria-label="Close selected address panel"
              />
              <div
                className={`absolute inset-x-2 bottom-2 rounded-2xl border border-white/[0.14] bg-[linear-gradient(150deg,rgba(8,19,40,0.98),rgba(7,15,33,0.96))] p-3 shadow-[0_20px_45px_rgba(0,0,0,0.55)] transition-[opacity,transform] duration-220 ${
                  mobileSelectedNode ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
                }`}
              >
                <div className="mx-auto mb-2 h-1 w-12 rounded-full bg-white/20" />
                {mobileSelectedNode ? (
                  <>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--flux-text-dim)]">
                      {mobileSelectedNode.hop === 0
                        ? "Center Address"
                        : mobileSelectedNode.hop === 1
                          ? "First Ring"
                          : "Second Ring"}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-cyan-200">{mobileSelectedNode.id}</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[var(--flux-text-secondary)]">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">Tx Count</div>
                        <div className="font-semibold">{mobileSelectedNode.txCount.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">Volume</div>
                        <div className="font-semibold">{formatFlux(mobileSelectedNode.volume)} FLUX</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">Inbound</div>
                        <div className="font-semibold">{mobileSelectedNode.inboundTxCount.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">Outbound</div>
                        <div className="font-semibold">{mobileSelectedNode.outboundTxCount.toLocaleString()}</div>
                      </div>
                    </div>
                    <div className="mt-2 border-t border-white/[0.1] pt-2 text-[11px] text-[var(--flux-text-muted)]">
                      Balance:{" "}
                      <span className="font-semibold text-cyan-200">
                        {mobileSelectedNode.balance === null
                          ? "unavailable"
                          : `${formatFlux(mobileSelectedNode.balance)} FLUX`}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 bg-cyan-500/20 text-cyan-100 hover:bg-cyan-500/30"
                        disabled={mobileSelectedNode.id === centerAddress}
                        onClick={() => {
                          if (mobileSelectedNode.id !== centerAddress) {
                            hopToAddress(mobileSelectedNode.id);
                          }
                        }}
                      >
                        {mobileSelectedNode.id === centerAddress ? "Current Center" : "Hop To Address"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 border-white/[0.18] bg-white/[0.04]"
                        onClick={() => router.push(`/address/${mobileSelectedNode.id}`)}
                      >
                        Open Page
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 text-[var(--flux-text-dim)]"
                        onClick={() => setMobileSelectedNode(null)}
                      >
                        Close
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {isMobile ? (
          <div className="mt-3 rounded-xl border border-white/[0.1] bg-[rgba(8,18,37,0.52)] px-3 py-2 text-[11px] uppercase tracking-[0.12em] text-[var(--flux-text-dim)]">
            Tap an address node to open the bottom sheet and hop.
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-muted-foreground sm:grid-cols-4">
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

      {!isMobile && hoveredNode && typeof document !== "undefined"
        ? createPortal(
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
            </div>,
            document.body
          )
        : null}
    </Card>
  );
}
