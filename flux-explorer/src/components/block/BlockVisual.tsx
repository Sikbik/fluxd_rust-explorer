"use client";

import { Block } from "@/types/flux-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Info, Server } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface BlockVisualProps {
  block: Block;
}

function isFluxNodeKind(kind: string) {
  return kind === "fluxnode_start" || kind === "fluxnode_confirm" || kind === "fluxnode_other";
}

export function BlockVisual({ block }: BlockVisualProps) {
  const summary = block.txSummary;
  const txDetails = block.txDetails || [];
  const loading = !summary || txDetails.length === 0;

  const maxBlockSize = 2 * 1024 * 1024; // 2 MB
  const blockFullness = (block.size / maxBlockSize) * 100;

  const txCountForAverage = txDetails.length || block.tx.length || 1;
  const avgTxSize = block.size / txCountForAverage;

  return (
    <Card className="overflow-visible rounded-2xl border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.46),rgba(7,15,33,0.22))]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info className="h-5 w-5" />
          Block Visualization
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 overflow-visible">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Block Fullness</span>
            <span className="text-muted-foreground">
              {blockFullness.toFixed(2)}% of 2MB
            </span>
          </div>
          <Progress value={blockFullness} className="h-2 border border-white/[0.08] bg-[rgba(8,18,37,0.45)]" />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Transaction Count</span>
            {loading ? (
              <Skeleton className="h-4 w-32" />
            ) : (
              <div className="flex items-center gap-2">
                {summary && (summary.regular + (summary.coinbase || 0)) > 0 && (
                  <span className="text-muted-foreground">
                    {summary.regular + (summary.coinbase || 0)} transaction{(summary.regular + (summary.coinbase || 0)) !== 1 ? "s" : ""}
                  </span>
                )}
                {summary && (summary.fluxnodeConfirm + summary.fluxnodeStart + summary.fluxnodeOther) > 0 && (
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Server className="h-3 w-3" />
                    {(summary.fluxnodeConfirm + summary.fluxnodeStart + summary.fluxnodeOther)} node messages
                  </span>
                )}
              </div>
            )}
          </div>
          {loading ? (
            <div className="flex flex-wrap gap-0.5 min-h-[60px]">
              {Array.from({ length: txDetails.length || block.tx.length || 0 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-3 rounded-sm flex-shrink-0" />
              ))}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-0.5 overflow-visible">
                {txDetails.map((detail, index) => {
                  let bgColor = "bg-orange-500";
                  let tooltip = `Transaction ${index + 1}`;
                  let fluxNode = false;

                  if (detail.kind === "coinbase") {
                    bgColor = "bg-green-500";
                    tooltip = "Coinbase (Block Reward)";
                  } else if (detail.kind === "transfer") {
                    bgColor = "bg-orange-500";
                    tooltip = `Transfer ${index + 1}`;
                  } else {
                    fluxNode = true;
                    if (detail.kind === "fluxnode_start") {
                      bgColor = "bg-yellow-500";
                      tooltip = "FluxNode Starting";
                    } else if (detail.kind === "fluxnode_confirm") {
                      // Get tier directly from detail (API now returns correct tier name)
                      let tier = detail.fluxnodeTier?.toString().toUpperCase();
                      // Convert numeric tier to name if needed (1=CUMULUS, 2=NIMBUS, 3=STRATUS)
                      if (tier === "1") tier = "CUMULUS";
                      else if (tier === "2") tier = "NIMBUS";
                      else if (tier === "3") tier = "STRATUS";

                      if (tier === "CUMULUS") bgColor = "bg-pink-500";
                      else if (tier === "NIMBUS") bgColor = "bg-purple-600";
                      else if (tier === "STRATUS") bgColor = "bg-blue-600";
                      else bgColor = "bg-gray-500";
                      tooltip = tier && tier !== "UNKNOWN" ? `${tier} FluxNode Confirmation` : "FluxNode Confirmation";
                    } else {
                      bgColor = "bg-yellow-500";
                      tooltip = "FluxNode Starting";
                    }
                  }

                  const prev = txDetails[index - 1];
                  const shouldAddGap = fluxNode && prev && !isFluxNodeKind(prev.kind);
                  // Position tooltip to the right for first few items to prevent left cutoff
                  const isLeftEdge = index < 3;

                  return (
                    <div
                      key={detail.txid}
                      className={`relative group h-3 w-3 rounded-sm ${bgColor} cursor-help transition-transform hover:scale-125 flex-shrink-0 ${shouldAddGap ? "ml-4" : ""}`}
                    >
                      <div className={`absolute bottom-full mb-2 whitespace-nowrap rounded-lg border border-white/[0.14] bg-[linear-gradient(140deg,rgba(7,18,39,0.96),rgba(8,16,35,0.96))] px-2 py-1 text-xs text-[var(--flux-text-secondary)] shadow-lg opacity-0 invisible transition-all duration-200 group-hover:opacity-100 group-hover:visible z-50 pointer-events-none ${isLeftEdge ? "left-0" : "left-1/2 -translate-x-1/2"}`}>
                        {tooltip}
                        <div className={`absolute top-full -mt-1 border-4 border-transparent border-t-[rgba(7,18,39,0.96)] ${isLeftEdge ? "left-1" : "left-1/2 -translate-x-1/2"}`}></div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground pt-2">
                {summary?.coinbase ? (
                  <div className="flex items-center gap-1">
                    <div className="h-3 w-3 rounded-sm bg-green-500"></div>
                    <span>Coinbase</span>
                  </div>
                ) : null}
                {summary?.transfers ? (
                  <div className="flex items-center gap-1">
                    <div className="h-3 w-3 rounded-sm bg-orange-500"></div>
                    <span>Transfers</span>
                  </div>
                ) : null}
                {summary && summary.fluxnodeConfirm + summary.fluxnodeStart + summary.fluxnodeOther > 0 && (
                  <div className="flex items-center gap-3">
                    {summary.fluxnodeStart > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="h-3 w-3 rounded-sm bg-yellow-500" />
                        Starting
                      </span>
                    )}
                    {summary.tierCounts.cumulus > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="h-3 w-3 rounded-sm bg-pink-500" />
                        Cumulus
                      </span>
                    )}
                    {summary.tierCounts.nimbus > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="h-3 w-3 rounded-sm bg-purple-600" />
                        Nimbus
                      </span>
                    )}
                    {summary.tierCounts.stratus > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="h-3 w-3 rounded-sm bg-blue-600" />
                        Stratus
                      </span>
                    )}
                    {summary.tierCounts.unknown > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="h-3 w-3 rounded-sm bg-gray-500" />
                        Unknown
                      </span>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Average Transaction Size</span>
            <span className="text-muted-foreground">
              {(avgTxSize / 1024).toFixed(2)} KB
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-8 flex-1 items-center justify-center rounded-md border border-cyan-400/20 bg-[linear-gradient(90deg,rgba(56,232,255,0.16),rgba(168,85,247,0.18))]">
              <span className="text-xs font-medium">
                {avgTxSize.toFixed(0)} bytes
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
