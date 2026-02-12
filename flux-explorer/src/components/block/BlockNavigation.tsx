"use client";

import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Home } from "lucide-react";
import Link from "next/link";

interface BlockNavigationProps {
  currentHeight: number;
  previousHash?: string;
  nextHash?: string;
}

export function BlockNavigation({
  currentHeight,
  previousHash,
  nextHash,
}: BlockNavigationProps) {
  return (
    <div className="flex flex-col items-stretch justify-between gap-2 overflow-hidden sm:flex-row sm:items-center">
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <Button
          variant="outline"
          size="sm"
          asChild
          className="flex-shrink-0 border-white/[0.16] bg-[rgba(10,21,42,0.56)] hover:border-cyan-300/45"
        >
          <Link href="/">
            <Home className="h-4 w-4 mr-2" />
            <span className="hidden sm:inline">Home</span>
          </Link>
        </Button>
        {previousHash && (
          <Button
            variant="outline"
            size="sm"
            asChild
            className="min-w-0 flex-1 border-white/[0.16] bg-[rgba(10,21,42,0.56)] hover:border-cyan-300/45 sm:flex-initial"
          >
            <Link href={`/block/${previousHash}`} className="overflow-hidden">
              <ChevronLeft className="h-4 w-4 mr-2 flex-shrink-0" />
              <span className="hidden md:inline truncate">Previous Block</span>
              <span className="md:hidden truncate">Prev</span>
              <span className="ml-2 text-muted-foreground hidden lg:inline whitespace-nowrap">
                #{(currentHeight - 1).toLocaleString()}
              </span>
            </Link>
          </Button>
        )}
      </div>

      {nextHash && (
        <Button
          variant="outline"
          size="sm"
          asChild
          className="min-w-0 w-full border-white/[0.16] bg-[rgba(10,21,42,0.56)] hover:border-cyan-300/45 sm:w-auto"
        >
          <Link href={`/block/${nextHash}`} className="overflow-hidden">
            <span className="mr-2 text-muted-foreground hidden lg:inline whitespace-nowrap">
              #{(currentHeight + 1).toLocaleString()}
            </span>
            <span className="hidden md:inline truncate">Next Block</span>
            <span className="md:hidden truncate">Next</span>
            <ChevronRight className="h-4 w-4 ml-2 flex-shrink-0" />
          </Link>
        </Button>
      )}
    </div>
  );
}
