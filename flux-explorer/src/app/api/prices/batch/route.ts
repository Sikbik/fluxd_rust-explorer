/**
 * Batch Price Fetching API Route
 *
 * Server-side endpoint to fetch historical prices from SQLite cache
 * Uses pre-populated hourly price data for FMV compliance
 */

import { NextRequest, NextResponse } from "next/server";
import { getCachedPricesByTimestamps } from "@/lib/db/price-cache";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

/**
 * POST /api/prices/batch
 *
 * Request body: { timestamps: number[] }
 * Response: { prices: Record<number, number | null> }
 */
export async function POST(request: NextRequest) {
  try {
    const { timestamps } = await request.json() as { timestamps: number[] };

    if (!Array.isArray(timestamps)) {
      return NextResponse.json(
        { error: "Invalid request: timestamps must be an array" },
        { status: 400, headers: corsHeaders }
      );
    }

    const hasInvalidTimestamp = timestamps.some((ts) => !Number.isFinite(ts) || ts <= 0);
    if (hasInvalidTimestamp) {
      return NextResponse.json(
        { error: "All timestamps must be positive finite numbers" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Security: Enforce maximum array size to prevent DoS
    const normalizedTimestamps = Array.from(
      new Set(
        timestamps
          .filter((ts) => Number.isFinite(ts) && ts > 0)
          .map((ts) => Math.trunc(ts))
      )
    );

    const MAX_TIMESTAMPS = 2000;
    if (normalizedTimestamps.length > MAX_TIMESTAMPS) {
      return NextResponse.json(
        { error: `Maximum ${MAX_TIMESTAMPS} timestamps allowed per request` },
        { status: 400, headers: corsHeaders }
      );
    }

    if (normalizedTimestamps.length === 0) {
      return NextResponse.json({ prices: {} }, { headers: corsHeaders });
    }

    const results: Record<number, number | null> = {};
    const priceMap = getCachedPricesByTimestamps(normalizedTimestamps);
    for (const ts of normalizedTimestamps) {
      results[ts] = priceMap.get(ts) ?? null;
    }

    // Count how many prices were found
    const found = Object.values(results).filter(p => p !== null).length;
    const missing = normalizedTimestamps.length - found;

    if (missing > 0) {
      console.warn(`Price lookup: Found ${found}/${normalizedTimestamps.length} prices (${missing} missing)`);
      console.warn(`Missing prices may indicate price database needs updating. Run: npm run update-prices`);
    }

    return NextResponse.json({ prices: results }, { headers: corsHeaders });

  } catch (error) {
    console.error("Error in batch price fetch:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
