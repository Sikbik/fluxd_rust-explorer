"use client";

import { useState } from "react";
import { Block } from "@/types/flux-api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { formatDistanceToNow } from "date-fns";
import { Box, Clock, Hash, CheckCircle, ChevronDown, ChevronUp } from "lucide-react";

interface BlockHeaderProps {
  block: Block;
}

export function BlockHeader({ block }: BlockHeaderProps) {
  const [showHashes, setShowHashes] = useState(false);
  const blockTime = new Date(block.time * 1000);

  return (
    <Card className="rounded-2xl border border-white/[0.08] bg-[linear-gradient(140deg,rgba(8,20,42,0.46),rgba(7,15,33,0.22))]">
      <CardContent className="pt-6">
        {/* Compact Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <div className="flex items-center gap-2">
              <Box className="h-5 w-5" />
              <span className="text-xl sm:text-2xl font-bold">Block #{block.height.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span className="truncate">{blockTime.toLocaleString()} ({formatDistanceToNow(blockTime, { addSuffix: true })})</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 border-blue-400/30 text-cyan-200">
              PoUW
            </Badge>
            <Badge variant="outline" className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 border-green-400/30 text-emerald-200">
              <CheckCircle className="h-3 w-3 mr-1" />
              {block.confirmations.toLocaleString()} confirmations
            </Badge>
          </div>
        </div>

        {/* Compact Block Hash with Toggle */}
        <div className="space-y-2 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Hash className="h-4 w-4" />
              Block Hash
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowHashes(!showHashes)}
              className="flex-shrink-0"
            >
              {showHashes ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
          <div className="flex items-center gap-2 overflow-hidden rounded-xl border border-white/[0.1] bg-[rgba(8,18,37,0.5)] px-3 py-2 font-mono text-xs sm:text-sm">
            <span className="truncate flex-1 min-w-0" title={block.hash}>{block.hash}</span>
            <CopyButton text={block.hash} className="flex-shrink-0" />
          </div>
        </div>

        {/* Collapsible Hashes Section */}
        {showHashes && (
          <div className="space-y-3 border-t border-white/[0.12] pt-3">
            {/* Previous Block Hash */}
            {block.previousblockhash && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Previous Block Hash</div>
                <div className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[rgba(8,18,37,0.44)] px-3 py-2 font-mono text-xs">
                  <a
                    href={`/block/${block.previousblockhash}`}
                    className="flex-1 hover:text-primary transition-colors truncate"
                    title={block.previousblockhash}
                  >
                    {block.previousblockhash}
                  </a>
                  <CopyButton text={block.previousblockhash} />
                </div>
              </div>
            )}

            {/* Next Block Hash */}
            {block.nextblockhash && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Next Block Hash</div>
                <div className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[rgba(8,18,37,0.44)] px-3 py-2 font-mono text-xs">
                  <a
                    href={`/block/${block.nextblockhash}`}
                    className="flex-1 hover:text-primary transition-colors truncate"
                    title={block.nextblockhash}
                  >
                    {block.nextblockhash}
                  </a>
                  <CopyButton text={block.nextblockhash} />
                </div>
              </div>
            )}

            {/* Merkle Root */}
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Merkle Root</div>
              <div className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[rgba(8,18,37,0.44)] px-3 py-2 font-mono text-xs">
                <span className="flex-1 truncate" title={block.merkleroot}>{block.merkleroot}</span>
                <CopyButton text={block.merkleroot} />
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
