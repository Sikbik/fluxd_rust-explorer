import { NextRequest, NextResponse } from "next/server";
import {
  consumeExportSessionQuota,
  isLikelyFluxAddress,
  issueExportToken,
} from "@/lib/security/export-guard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return request.ip ?? "unknown";
}

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    const quota = consumeExportSessionQuota(ip);
    if (!quota.ok) {
      const retryAfterSeconds = quota.retryAfterSeconds ?? 1;
      return NextResponse.json(
        { error: "rate_limited", retryAfterSeconds },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSeconds),
            "Cache-Control": "no-store",
          },
        }
      );
    }

    const body = (await request.json()) as {
      address?: string;
      fromTimestamp?: number;
      toTimestamp?: number;
      limit?: number;
    };

    const address = String(body.address ?? "").trim();
    const fromTimestamp = Math.trunc(Number(body.fromTimestamp ?? 0));
    const toTimestamp = Math.trunc(Number(body.toTimestamp ?? 0));
    const requestedLimit = Math.trunc(Number(body.limit ?? 250));
    const maxLimit = Math.max(1, Math.min(250, requestedLimit || 250));

    if (!isLikelyFluxAddress(address)) {
      return NextResponse.json(
        { error: "invalid_address" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const hasValidRange =
      Number.isFinite(fromTimestamp) &&
      Number.isFinite(toTimestamp) &&
      fromTimestamp > 0 &&
      toTimestamp > 0 &&
      fromTimestamp <= toTimestamp;
    if (!hasValidRange) {
      return NextResponse.json(
        { error: "invalid_timestamp_range" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const maxRangeSeconds = 20 * 365 * 24 * 60 * 60;
    if (toTimestamp - fromTimestamp > maxRangeSeconds) {
      return NextResponse.json(
        { error: "range_too_large" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { token, expiresAt } = issueExportToken({
      ip,
      address,
      fromTimestamp,
      toTimestamp,
      maxLimit,
    });

    return NextResponse.json(
      {
        token,
        expiresAt,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    console.error("Failed to issue export session token:", error);
    return NextResponse.json(
      { error: "internal_server_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
