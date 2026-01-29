/**
 * API Route for Flux Supply Statistics
 *
 * This server-side API route proxies requests to the FluxIndexer API
 * to get accurate supply statistics from the blockchain
 */

import { NextResponse } from "next/server";
import { satoshisToFlux } from "@/lib/api/fluxindexer-utils";

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Production (Flux/VPS): SERVER_API_URL set via docker-compose
    // Local dev: Falls back to 127.0.0.1:42067 (IPv4 explicit to avoid IPv6 issues)
    const indexerUrl = process.env.SERVER_API_URL || process.env.NEXT_PUBLIC_SERVER_API_URL || "http://127.0.0.1:42067";
    const response = await fetch(`${indexerUrl}/api/v1/supply`, {
      headers: {
        "Accept": "application/json",
      },
      // Cache for 15 seconds to catch blocks faster than the 30s average
      next: { revalidate: 15 },
    });

    if (!response.ok) {
      throw new Error(`FluxIndexer API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      blockHeight?: number;
      transparentSupply?: string;
      shieldedPool?: string;
      circulatingSupply?: string;
      totalSupply?: string;
      lastUpdate?: string;
      timestamp?: string;
    };

    const totalSupplySat = typeof data.totalSupply === 'string' ? data.totalSupply : '0';
    const circulatingSupplySat = typeof data.circulatingSupply === 'string'
      ? data.circulatingSupply
      : typeof data.transparentSupply === 'string'
        ? data.transparentSupply
        : totalSupplySat;

    const totalSupply = Number(satoshisToFlux(totalSupplySat).toFixed(8));
    const circulatingSupply = Number(satoshisToFlux(circulatingSupplySat).toFixed(8));

    return NextResponse.json({
      ...data,
      circulatingSupply: circulatingSupply.toString(),
      totalSupply: totalSupply.toString(),
      maxSupply: "560000000",
    });
  } catch (error) {
    console.error("Failed to fetch supply from FluxIndexer:", error);
    return NextResponse.json(
      { error: "Failed to fetch supply data" },
      { status: 500 }
    );
  }
}
