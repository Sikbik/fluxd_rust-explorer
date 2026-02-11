
import { NextRequest, NextResponse } from "next/server";
import ky from "ky";
import type { RichListData, RichListAddress } from "@/types/rich-list";
import { satoshisToFlux } from "@/lib/api/fluxindexer-utils";

const INDEXER_API_URL =
  process.env.SERVER_API_URL ||
  process.env.INDEXER_API_URL ||
  "http://127.0.0.1:42067";

const CACHE_DURATION = 60;
const PAGE_SIZE = 1000;
const MAX_ADDRESSES = 1000;

export const dynamic = 'force-dynamic';
export const revalidate = CACHE_DURATION;
interface InflightRequest {
  promise: Promise<RichListData>;
  timestamp: number;
}

const inflightRequests = new Map<string, InflightRequest>();
const COALESCE_WINDOW_MS = 5000;

setInterval(() => {
  const now = Date.now();
  const keysToDelete: string[] = [];

  inflightRequests.forEach((request, key) => {
    if (now - request.timestamp > COALESCE_WINDOW_MS) {
      keysToDelete.push(key);
    }
  });

  keysToDelete.forEach(key => inflightRequests.delete(key));
}, COALESCE_WINDOW_MS);

type RichListCacheEntry = {
  at: number;
  value: RichListData;
};

const richListCache = new Map<string, RichListCacheEntry>();
const richListRefresh = new Map<string, Promise<void>>();

async function refreshRichList(cacheKey: string, now: number, minBalance: number): Promise<void> {
  const data = await fetchRichListData(minBalance);
  richListCache.set(cacheKey, { at: now, value: data });
}

interface IndexerRichListResponse {
  lastUpdate: string;
  lastBlockHeight: number;
  totalSupply: string;
  totalAddresses: number;
  page: number;
  pageSize: number;
  totalPages: number;
  addresses: Array<{
    rank: number;
    address: string;
    balance: string;
    txCount: number;
    cumulusCount?: number;
    nimbusCount?: number;
    stratusCount?: number;
  }>;
  warmingUp?: boolean;
  degraded?: boolean;
  retryAfterSeconds?: number;
  message?: string;
}

interface IndexerSupplyStatsResponse {
  blockHeight: number;
  transparentSupply: string;
  shieldedPool: string;
  totalSupply: string;
  lastUpdate: string;
  timestamp: string;
}

/**
 * GET /api/rich-list
 * Fetch paginated rich list data
 *
 * Query params:
 * - page: Page number (1-based, default: 1)
 * - pageSize: Results per page (default: 100, max: 1000)
 * - minBalance: Minimum balance filter (default: 1)
 */
export async function GET(request: NextRequest) {
  try {
    // Allow overriding min balance but default to 1 FLUX
    const minBalanceStr = request.nextUrl.searchParams.get("minBalance");
    let minBalance = 1;

    if (minBalanceStr) {
      const parsed = parseInt(minBalanceStr, 10);

      // Security: Validate input is a valid finite number
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        return NextResponse.json(
          { error: "minBalance must be a valid finite positive integer" },
          { status: 400 }
        );
      }

      // Security: Reject negative numbers
      if (parsed < 0) {
        return NextResponse.json(
          { error: "minBalance must be non-negative" },
          { status: 400 }
        );
      }

      // Security: Reject unreasonably large values (max supply is 560M FLUX)
      const MAX_BALANCE = 560000000 * 1e8; // in zatoshis
      if (parsed > MAX_BALANCE) {
        return NextResponse.json(
          { error: `minBalance cannot exceed maximum supply` },
          { status: 400 }
        );
      }

      minBalance = parsed;
    }

    const cacheKey = `richlist:${minBalance}`;
    const now = Date.now();

    const cached = richListCache.get(cacheKey);
    if (cached) {
      if (now - cached.at >= 60_000 && !richListRefresh.get(cacheKey)) {
        const refresh = refreshRichList(cacheKey, now, minBalance).finally(() => {
          richListRefresh.delete(cacheKey);
        });
        richListRefresh.set(cacheKey, refresh);
      }

      return NextResponse.json(
        {
          ...cached.value,
          page: 1,
          pageSize: cached.value.addresses.length,
          totalPages: Math.max(1, Math.ceil(cached.value.totalAddresses / PAGE_SIZE)),
        },
        {
          headers: {
            "Cache-Control": `public, s-maxage=${CACHE_DURATION}, stale-while-revalidate=${
              CACHE_DURATION * 2
            }`,
          },
        }
      );
    }

    const existingRequest = inflightRequests.get(cacheKey);
    if (existingRequest) {
      const data = await existingRequest.promise;
      return NextResponse.json(
        {
          ...data,
          page: 1,
          pageSize: data.addresses.length,
          totalPages: Math.max(1, Math.ceil(data.totalAddresses / PAGE_SIZE)),
        },
        {
          headers: {
            "Cache-Control": `public, s-maxage=${CACHE_DURATION}, stale-while-revalidate=${
              CACHE_DURATION * 2
            }`,
          },
        }
      );
    }

    const fetchPromise = fetchRichListData(minBalance);

    inflightRequests.set(cacheKey, {
      promise: fetchPromise,
      timestamp: now,
    });

    const data = await fetchPromise;
    richListCache.set(cacheKey, { at: now, value: data });

    return NextResponse.json(
      {
        ...data,
        page: 1,
        pageSize: data.addresses.length,
        totalPages: Math.max(1, Math.ceil(data.totalAddresses / PAGE_SIZE)),
      },
      {
        headers: {
          "Cache-Control": `public, s-maxage=${CACHE_DURATION}, stale-while-revalidate=${
            CACHE_DURATION * 2
          }`,
        },
      }
    );
  } catch (error) {
    console.error("Failed to fetch rich list:", error);

    void error;

    return NextResponse.json(
      {
        lastUpdate: new Date().toISOString(),
        lastBlockHeight: 0,
        totalSupply: 0,
        transparentSupply: 0,
        shieldedPool: 0,
        totalAddresses: 0,
        addresses: [],
        warmingUp: true,
        degraded: true,
        retryAfterSeconds: 3,
        message: "rich list is temporarily unavailable",
      },
      {
        status: 200,
        headers: {
          "Cache-Control": `public, s-maxage=${CACHE_DURATION}, stale-while-revalidate=${CACHE_DURATION * 2}`,
        },
      }
    );
  }
}

/**
 * Fetch rich list data from the indexer
 * This is the actual data fetching logic, separated for coalescing
 */
async function fetchRichListData(minBalance: number): Promise<RichListData> {
  const aggregatedAddresses: RichListAddress[] = [];
  let metadata: IndexerRichListResponse | null = null;
  let page = 1;
  let supplyStatsPromise: Promise<IndexerSupplyStatsResponse | null> | null = null;

  while (
    aggregatedAddresses.length < MAX_ADDRESSES &&
    (metadata === null || page <= metadata.totalPages)
  ) {
    const response = await fetchRichListPage({
      page,
      pageSize: PAGE_SIZE,
      minBalance,
    });

    if (!metadata) {
      metadata = response;

      if (metadata.warmingUp || metadata.degraded) {
        const warmingUp = Boolean(metadata.warmingUp);
        const degraded = metadata.degraded ?? warmingUp;

        return {
          lastUpdate: metadata.lastUpdate,
          lastBlockHeight: metadata.lastBlockHeight,
          totalSupply: satoshisToFlux(metadata.totalSupply || "0"),
          transparentSupply: satoshisToFlux(metadata.totalSupply || "0"),
          shieldedPool: 0,
          totalAddresses: metadata.totalAddresses,
          addresses: [],
          warmingUp,
          degraded,
          retryAfterSeconds: metadata.retryAfterSeconds ?? 3,
          message: metadata.message ?? "rich list is warming up",
        };
      }

      // Start fetching supply stats in parallel with rich list
      supplyStatsPromise = fetchSupplyStats().catch((error) => {
        console.warn("Failed to fetch supply stats, using rich list total:", error);
        return null;
      });
    }

    const totalSupplyFlux = satoshisToFlux(response.totalSupply || "0");

    response.addresses.forEach((address) => {
      if (aggregatedAddresses.length >= MAX_ADDRESSES) {
        return;
      }
      const balanceFlux = satoshisToFlux(address.balance || "0");
      const percentage =
        totalSupplyFlux > 0 ? (balanceFlux / totalSupplyFlux) * 100 : 0;

      aggregatedAddresses.push({
        rank: address.rank,
        address: address.address,
        balance: balanceFlux,
        percentage,
        txCount: address.txCount,
        cumulusCount: address.cumulusCount,
        nimbusCount: address.nimbusCount,
        stratusCount: address.stratusCount,
      });
    });

    if (response.totalPages === 0 || page >= response.totalPages) {
      break;
    }

    page += 1;
  }

  if (!metadata) {
    throw new Error("Indexer has not populated the rich list yet");
  }

  // Wait for supply stats to complete (started earlier in parallel)
  const supplyStats = supplyStatsPromise ? await supplyStatsPromise : null;

  // Use supply stats if available, otherwise fall back to rich list total
  const totalSupplyFlux = supplyStats
    ? satoshisToFlux(supplyStats.totalSupply || "0")
    : satoshisToFlux(metadata.totalSupply || "0");

  const transparentSupplyFlux = supplyStats
    ? satoshisToFlux(supplyStats.transparentSupply || "0")
    : totalSupplyFlux;

  const shieldedPoolFlux = supplyStats
    ? satoshisToFlux(supplyStats.shieldedPool || "0")
    : 0;

  return {
    lastUpdate: metadata.lastUpdate,
    lastBlockHeight: supplyStats?.blockHeight || metadata.lastBlockHeight,
    totalSupply: totalSupplyFlux,
    transparentSupply: transparentSupplyFlux,
    shieldedPool: shieldedPoolFlux,
    totalAddresses: metadata.totalAddresses,
    addresses: aggregatedAddresses,
  };
}

async function fetchSupplyStats(): Promise<IndexerSupplyStatsResponse> {
  const response = await ky.get(`${INDEXER_API_URL}/api/v1/supply`, {
    timeout: 10000,
    retry: {
      limit: 2,
      methods: ["get"],
      statusCodes: [408, 413, 429, 500, 502, 503, 504],
    },
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Indexer supply endpoint responded with ${response.status}: ${bodyText}`
    );
  }

  return (await response.json()) as IndexerSupplyStatsResponse;
}

async function fetchRichListPage(params: {
  page: number;
  pageSize: number;
  minBalance: number;
}): Promise<IndexerRichListResponse> {
  const response = await ky.get(`${INDEXER_API_URL}/api/v1/richlist`, {
    searchParams: {
      page: params.page.toString(),
      pageSize: params.pageSize.toString(),
      minBalance: params.minBalance.toString(),
    },
    timeout: 120000,
    retry: {
      limit: 2,
      methods: ["get"],
      statusCodes: [408, 413, 429, 500, 502, 503, 504],
    },
  });

  if (!response.ok) {
    const bodyText = await response.text();
    let details = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed?.error) {
        details = parsed.error;
      }
    } catch {
      // ignore JSON parse errors, keep raw text
    }
    throw new Error(
      `Indexer responded with ${response.status}: ${details || "Unknown error"}`
    );
  }

  return (await response.json()) as IndexerRichListResponse;
}
