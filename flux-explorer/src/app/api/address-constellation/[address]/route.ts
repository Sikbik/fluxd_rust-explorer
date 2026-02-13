import { NextRequest, NextResponse } from "next/server";
import { FluxAPI } from "@/lib/api/client";
import type {
  AddressConstellationData,
  AddressConstellationEdge,
  AddressConstellationNode,
} from "@/types/address-constellation";
import type {
  AddressBalancesResponse,
  AddressNeighborEntry,
  AddressTransactionSummary,
  Transaction,
} from "@/types/flux-api";
import { isLikelyFluxAddress } from "@/lib/security/export-guard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ConstellationScanMode = "fast" | "deep";

const FAST_ROOT_NON_REWARD_LIMIT = 20;
const FAST_ROOT_SCAN_CAP = 1_000;
const FAST_ROOT_PAGE_SIZE = 90;
const FAST_ROOT_MAX_PAGES = 1;
const FAST_ROOT_SLACK_MAX = 6;

const DEEP_ROOT_NON_REWARD_LIMIT = 40;
const DEEP_ROOT_SCAN_CAP = 8_000;
const DEEP_ROOT_PAGE_SIZE = 160;
const DEEP_ROOT_MAX_PAGES = 4;
const DEEP_ROOT_SLACK_MAX = 10;

const FIRST_HOP_LIMIT = 8;
const SCAN_MAX_HOP_REQUESTS = 2;
const HOP_ROOT_MIN_TXS = 5;
const DEEP_HOP_NON_REWARD_LIMIT = 6;
const DEEP_HOP_SCAN_CAP = 1_200;
const DEEP_HOP_PAGE_SIZE = 120;
const DEEP_HOP_MAX_PAGES = 2;
const DEEP_HOP_SLACK_MAX = 4;
const SECOND_HOP_LIMIT = 16;
const SECOND_HOP_PER_PARENT = 3;
const FULL_TX_BATCH_SIZE = 30;
const FULL_TX_FALLBACK_TRIGGER_RATIO = 0.25;
const BUILD_BUDGET_MS = 20_000;
const FAST_ROOT_TX_TIMEOUT_MS = 4_500;
const DEEP_ROOT_TX_TIMEOUT_MS = 10_000;
const DEEP_HOP_TX_TIMEOUT_MS = 7_500;
const BATCH_TX_TIMEOUT_MS = 4_800;
const SINGLE_TX_FALLBACK_TIMEOUT_MS = 2_200;
const MIN_TIMEOUT_MS = 300;

const CACHE_TTL_MS = 120_000;
const COALESCE_WINDOW_MS = 25_000;
const STALE_WINDOW_MS = 900_000;

const RATE_LIMIT = {
  capacity: 20,
  refillPerSec: 0.4,
  cost: 1,
  blockMs: 10_000,
} as const;

type CacheEntry = {
  at: number;
  value: AddressConstellationData;
};

type InflightEntry = {
  promise: Promise<AddressConstellationData>;
  at: number;
};

type QuotaState = {
  tokens: number;
  lastRefillMs: number;
  blockedUntilMs: number;
};

type NodeAggregate = {
  txCount: number;
  volume: number;
  inboundTxCount: number;
  outboundTxCount: number;
};

type EdgeAggregate = {
  a: string;
  b: string;
  txCount: number;
  volume: number;
  toCenter: number;
  fromCenter: number;
};

class ConstellationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstellationTimeoutError";
  }
}

const responseCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, InflightEntry>();
const quotaByIp = new Map<string, QuotaState>();

const CLEANUP_INTERVAL_MS = 60_000;
let cleanupTimerStarted = false;

function timeLeftMs(startedAt: number): number {
  return Math.max(0, BUILD_BUDGET_MS - (Date.now() - startedAt));
}

function boundedTimeout(startedAt: number, maxMs: number): number {
  const left = timeLeftMs(startedAt);
  if (left <= MIN_TIMEOUT_MS) {
    throw new ConstellationTimeoutError("constellation_budget_exhausted");
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(maxMs, left - 50));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ConstellationTimeoutError(`${label}_timeout`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function maybeStartCleanupTimer() {
  if (cleanupTimerStarted) return;
  cleanupTimerStarted = true;

  setInterval(() => {
    const now = Date.now();

    responseCache.forEach((entry, key) => {
      if (now - entry.at > STALE_WINDOW_MS) {
        responseCache.delete(key);
      }
    });

    inflightRequests.forEach((entry, key) => {
      if (now - entry.at > COALESCE_WINDOW_MS) {
        inflightRequests.delete(key);
      }
    });

    quotaByIp.forEach((state, key) => {
      if (now - state.lastRefillMs > STALE_WINDOW_MS && state.blockedUntilMs <= now) {
        quotaByIp.delete(key);
      }
    });
  }, CLEANUP_INTERVAL_MS);
}

function normalizeIp(value: string): string {
  if (!value) return "unknown";
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return normalizeIp(realIp);

  return normalizeIp(request.ip ?? "unknown");
}

function consumeQuota(ip: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const state = quotaByIp.get(ip) ?? {
    tokens: RATE_LIMIT.capacity,
    lastRefillMs: now,
    blockedUntilMs: 0,
  };

  if (state.blockedUntilMs > now) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntilMs - now) / 1000)),
    };
  }

  const elapsedSeconds = Math.max(0, (now - state.lastRefillMs) / 1000);
  state.tokens = Math.min(
    RATE_LIMIT.capacity,
    state.tokens + elapsedSeconds * RATE_LIMIT.refillPerSec
  );
  state.lastRefillMs = now;

  if (state.tokens < RATE_LIMIT.cost) {
    state.blockedUntilMs = now + RATE_LIMIT.blockMs;
    quotaByIp.set(ip, state);
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil(RATE_LIMIT.blockMs / 1000)),
    };
  }

  state.tokens -= RATE_LIMIT.cost;
  quotaByIp.set(ip, state);
  return { ok: true };
}

function normalizeAddress(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  return isLikelyFluxAddress(trimmed) ? trimmed : null;
}

function parseScanMode(request: NextRequest): ConstellationScanMode {
  const raw = request.nextUrl.searchParams.get("mode");
  return raw && raw.toLowerCase() === "deep" ? "deep" : "fast";
}

function scoreAggregate(value: NodeAggregate): number {
  return value.volume + value.txCount * 6;
}

function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function addNodeActivity(
  map: Map<string, NodeAggregate>,
  nodeId: string,
  txDirection: "received" | "sent",
  volume: number
) {
  const current = map.get(nodeId) ?? {
    txCount: 0,
    volume: 0,
    inboundTxCount: 0,
    outboundTxCount: 0,
  };

  current.txCount += 1;
  current.volume += volume;
  if (txDirection === "received") {
    current.inboundTxCount += 1;
  } else {
    current.outboundTxCount += 1;
  }
  map.set(nodeId, current);
}

function addEdgeActivity(
  map: Map<string, EdgeAggregate>,
  center: string,
  source: string,
  target: string,
  volume: number
) {
  const [a, b] = sortPair(source, target);
  const key = `${a}|${b}`;
  const current = map.get(key) ?? {
    a,
    b,
    txCount: 0,
    volume: 0,
    toCenter: 0,
    fromCenter: 0,
  };

  current.txCount += 1;
  current.volume += volume;

  if (a === center || b === center) {
    if (source === center && target !== center) {
      current.fromCenter += 1;
    } else if (target === center && source !== center) {
      current.toCenter += 1;
    }
  }

  map.set(key, current);
}

function extractCounterparties(
  tx: AddressTransactionSummary,
  currentAddress: string
): string[] {
  const preferred = tx.direction === "received" ? tx.fromAddresses : tx.toAddresses;
  const alternate = tx.direction === "received" ? tx.toAddresses : tx.fromAddresses;
  const unique = new Set<string>();

  const addList = (list: string[] | undefined) => {
    if (!list?.length) return;
    for (const raw of list) {
      const normalized = normalizeAddress(raw);
      if (!normalized) continue;
      if (normalized === currentAddress) continue;
      unique.add(normalized);
    }
  };

  addList(preferred);

  if ((tx.isCoinbase || unique.size === 0) && alternate?.length) {
    addList(alternate);
  }

  return Array.from(unique);
}

function extractCounterpartiesFromFullTransaction(
  tx: Transaction,
  currentAddress: string
): string[] {
  const inputSet = new Set<string>();
  const outputSet = new Set<string>();

  for (const vin of tx.vin ?? []) {
    const addr = vin.addr ? normalizeAddress(vin.addr) : null;
    if (!addr) continue;
    inputSet.add(addr);
  }

  for (const vout of tx.vout ?? []) {
    for (const rawAddr of vout.scriptPubKey.addresses ?? []) {
      const addr = normalizeAddress(rawAddr);
      if (!addr) continue;
      outputSet.add(addr);
    }
  }

  const inputHasCurrent = inputSet.has(currentAddress);
  const outputHasCurrent = outputSet.has(currentAddress);
  const counterparties = new Set<string>();

  if (inputHasCurrent) {
    outputSet.forEach((addr) => {
      if (addr !== currentAddress) counterparties.add(addr);
    });
  }

  if (outputHasCurrent) {
    inputSet.forEach((addr) => {
      if (addr !== currentAddress) counterparties.add(addr);
    });
  }

  if (!inputHasCurrent && !outputHasCurrent) {
    inputSet.forEach((addr) => {
      if (addr !== currentAddress) counterparties.add(addr);
    });
    outputSet.forEach((addr) => {
      if (addr !== currentAddress) counterparties.add(addr);
    });
  }

  return Array.from(counterparties);
}

function isRewardLikeTransaction(tx: AddressTransactionSummary): boolean {
  return tx.isCoinbase;
}

type NonRewardWindow = {
  items: AddressTransactionSummary[];
  scanned: number;
  excludedRewards: number;
  pagesFetched: number;
};

async function fetchNonRewardTransactions(
  address: string,
  options: {
    targetCount: number;
    scanCap: number;
    pageSize: number;
    maxPages?: number;
    slackMax?: number;
    apiExcludeCoinbase?: boolean;
    apiIncludeIo?: boolean;
    apiSkipTotals?: boolean;
    startedAt: number;
    requestTimeoutMs: number;
  }
): Promise<NonRewardWindow> {
  const collected: AddressTransactionSummary[] = [];
  let scanned = 0;
  let excludedRewards = 0;
  let cursor:
    | { height: number; txIndex: number; txid: string }
    | undefined = undefined;
  let lastCursor = "";
  const maxPages = Math.max(1, options.maxPages ?? Number.POSITIVE_INFINITY);
  let pagesFetched = 0;

  while (
    collected.length < options.targetCount &&
    scanned < options.scanCap &&
    pagesFetched < maxPages
  ) {
    const remainingNeeded = Math.max(0, options.targetCount - collected.length);
    let pageSize = Math.min(options.pageSize, options.scanCap - scanned);
    if (pageSize <= 0) break;
    pageSize = Math.max(1, pageSize);
    if (remainingNeeded > 0) {
      const slackMax = Math.max(0, Math.trunc(options.slackMax ?? 60));
      const slack = Math.min(slackMax, remainingNeeded);
      pageSize = Math.min(pageSize, Math.max(1, remainingNeeded + slack));
    }

    let page:
      | Awaited<ReturnType<typeof FluxAPI.getAddressTransactions>>
      | null = null;

    try {
      page = await FluxAPI.getAddressTransactions(
        [address],
        {
          from: 0,
          to: pageSize,
          cursorHeight: cursor?.height,
          cursorTxIndex: cursor?.txIndex,
          cursorTxid: cursor?.txid,
          excludeCoinbase: options.apiExcludeCoinbase ?? true,
          includeIo: options.apiIncludeIo ?? true,
          skipTotals: options.apiSkipTotals ?? true,
        },
        {
          timeoutMs: boundedTimeout(options.startedAt, options.requestTimeoutMs),
          retryLimit: 0,
        }
      );
    } catch {
      break;
    }
    pagesFetched += 1;

    const pageItems = page?.items ?? [];
    const pageScanned = Math.max(
      0,
      Math.trunc(page?.scanned ?? pageItems.length)
    );
    scanned += pageScanned > 0 ? pageScanned : pageSize;
    excludedRewards += Math.max(
      0,
      Math.trunc(page?.skippedCoinbase ?? 0)
    );

    for (const tx of pageItems) {
      if (isRewardLikeTransaction(tx)) {
        excludedRewards += 1;
        continue;
      }

      collected.push(tx);
      if (collected.length >= options.targetCount) {
        break;
      }
    }

    const nextCursor = page?.nextCursor;
    if (!nextCursor) break;
    const nextCursorKey = `${nextCursor.height}:${nextCursor.txIndex}:${nextCursor.txid}`;
    if (nextCursorKey === lastCursor) break;
    lastCursor = nextCursorKey;
    cursor = nextCursor;

    if (pageItems.length === 0) {
      if (timeLeftMs(options.startedAt) <= MIN_TIMEOUT_MS) break;
      continue;
    }

    if (pageItems.length < pageSize) break;
    if (timeLeftMs(options.startedAt) <= MIN_TIMEOUT_MS) break;
  }

  return {
    items: collected,
    scanned,
    excludedRewards,
    pagesFetched,
  };
}

async function buildFullTransactionCounterpartyMap(
  currentAddress: string,
  txs: AddressTransactionSummary[],
  startedAt: number,
  allowBatchFallback: boolean
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (txs.length === 0) return map;

  const txids = txs.map((tx) => tx.txid).filter(Boolean);
  if (txids.length === 0) return map;

  const summaryCoverage = txs.reduce((count, tx) => {
    const counterparties = extractCounterparties(tx, currentAddress);
    return count + (counterparties.length > 0 ? 1 : 0);
  }, 0);

  const summaryCoverageRatio = summaryCoverage / txs.length;
  if (summaryCoverageRatio >= FULL_TX_FALLBACK_TRIGGER_RATIO) {
    return map;
  }
  if (!allowBatchFallback) {
    return map;
  }
  if (timeLeftMs(startedAt) < 4_000) {
    return map;
  }

  const cappedTxids = txids.slice(0, 60);

  for (let i = 0; i < cappedTxids.length; i += FULL_TX_BATCH_SIZE) {
    if (timeLeftMs(startedAt) < 2_500) break;

    const chunk = cappedTxids.slice(i, i + FULL_TX_BATCH_SIZE);
    try {
      const batch = await withTimeout(
        FluxAPI.getTransactionsBatch(chunk),
        boundedTimeout(startedAt, BATCH_TX_TIMEOUT_MS),
        "full_tx_batch"
      );
      for (const fullTx of batch) {
        if (!fullTx?.txid) continue;
        map.set(
          fullTx.txid,
          extractCounterpartiesFromFullTransaction(fullTx, currentAddress)
        );
      }
    } catch {
      for (const txid of chunk) {
        try {
          const fullTx = await withTimeout(
            FluxAPI.getTransaction(txid),
            boundedTimeout(startedAt, SINGLE_TX_FALLBACK_TIMEOUT_MS),
            "full_tx_single"
          );
          if (!fullTx?.txid) continue;
          map.set(
            fullTx.txid,
            extractCounterpartiesFromFullTransaction(fullTx, currentAddress)
          );
        } catch {
          // Best effort per transaction fallback.
        }
      }
    }
  }

  return map;
}

async function mapWithConcurrency<T>(
  items: string[],
  limit: number,
  mapper: (item: string) => Promise<T>
): Promise<T[]> {
  if (items.length === 0) return [];

  const results: T[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      const result = await mapper(item);
      results[currentIndex] = result;
    }
  });

  await Promise.all(workers);
  return results;
}

function toNode(
  id: string,
  hop: 0 | 1 | 2,
  aggregate: NodeAggregate,
  balances: Map<string, number | null>
): AddressConstellationNode {
  return {
    id,
    label: `${id.slice(0, 6)}...${id.slice(-5)}`,
    hop,
    txCount: aggregate.txCount,
    volume: Number(aggregate.volume.toFixed(8)),
    inboundTxCount: aggregate.inboundTxCount,
    outboundTxCount: aggregate.outboundTxCount,
    score: Number(scoreAggregate(aggregate).toFixed(8)),
    balance: balances.get(id) ?? null,
  };
}

function toEdge(
  edge: EdgeAggregate,
  center: string
): AddressConstellationEdge {
  let direction: AddressConstellationEdge["direction"] = "mixed";
  if (edge.a === center || edge.b === center) {
    if (edge.toCenter > 0 && edge.fromCenter === 0) {
      direction = "inbound";
    } else if (edge.fromCenter > 0 && edge.toCenter === 0) {
      direction = "outbound";
    } else {
      direction = "mixed";
    }
  }

  const strength = Math.max(
    0.12,
    Math.min(1, edge.txCount / 9 + Math.log10(edge.volume + 1) / 4)
  );

  return {
    source: edge.a,
    target: edge.b,
    txCount: edge.txCount,
    volume: Number(edge.volume.toFixed(8)),
    direction,
    strength: Number(strength.toFixed(4)),
  };
}

function satoshiStringToFlux(valueSat: string): number {
  try {
    if (!valueSat) return 0;
    return Number(BigInt(valueSat)) / 1e8;
  } catch {
    return 0;
  }
}

async function fillBalances(
  balances: Map<string, number | null>,
  addresses: string[],
  startedAt: number
): Promise<{
  requested: number;
  returned: number;
  populated: number;
  truncated: number;
}> {
  const stats = {
    requested: addresses.length,
    returned: 0,
    populated: 0,
    truncated: 0,
  };

  if (addresses.length === 0) return stats;
  if (timeLeftMs(startedAt) <= MIN_TIMEOUT_MS) return stats;

  try {
    const baseUrl = process.env.SERVER_API_URL || "http://127.0.0.1:42067";
    const url = new URL("/api/v1/addresses/balances", baseUrl);
    const response = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ addresses, maxUtxos: 100_000 }),
        cache: "no-store",
      }).then(async (res) => {
        if (!res.ok) {
          throw new Error(`balances_fetch_failed:${res.status}`);
        }
        return (await res.json()) as AddressBalancesResponse;
      }),
      boundedTimeout(startedAt, 2_400),
      "balances"
    );

    const rows = (response as AddressBalancesResponse | null)?.balances;
    if (!Array.isArray(rows)) return stats;
    stats.returned = rows.length;

    for (const row of rows) {
      const normalized = normalizeAddress(String((row as { address?: unknown }).address ?? ""));
      if (!normalized) continue;

      const balanceSat = (row as { balanceSat?: unknown }).balanceSat;
      const truncated = Boolean((row as { truncated?: unknown }).truncated);

      if (truncated || balanceSat == null) {
        stats.truncated += 1;
        balances.set(normalized, null);
        continue;
      }

      const balance = satoshiStringToFlux(String(balanceSat));
      if (!Number.isFinite(balance)) {
        stats.truncated += 1;
        balances.set(normalized, null);
        continue;
      }

      stats.populated += 1;
      balances.set(normalized, balance);
    }
  } catch {
    // Best effort only.
  }

  return stats;
}

function neighborEntryToAggregate(entry: AddressNeighborEntry): NodeAggregate {
  const volume = satoshiStringToFlux(entry.totalValueSat);
  return {
    txCount: Math.max(0, Math.trunc(entry.txCount)),
    volume,
    inboundTxCount: Math.max(0, Math.trunc(entry.inboundTxCount)),
    outboundTxCount: Math.max(0, Math.trunc(entry.outboundTxCount)),
  };
}

async function tryBuildConstellationFromNeighbors(
  address: string,
  scanMode: ConstellationScanMode,
  startedAt: number
): Promise<AddressConstellationData | null> {
  const rootLimit = scanMode === "deep" ? 60 : 35;
  const hopLimit = 20;

  let root: Awaited<ReturnType<typeof FluxAPI.getAddressNeighbors>> | null = null;
  const rootFetchStart = Date.now();
  try {
    root = await withTimeout(
      FluxAPI.getAddressNeighbors(address, rootLimit),
      boundedTimeout(startedAt, 2_800),
      "neighbors_root"
    );
  } catch {
    return null;
  }
  const rootFetchMs = Date.now() - rootFetchStart;

  if (typeof root.generation !== "number" || !Number.isFinite(root.generation) || root.generation <= 0) {
    return null;
  }

  if (!root || !Array.isArray(root.neighbors)) {
    return null;
  }

  if (root.neighbors.length === 0) {
    const balances = new Map<string, number | null>();
    const balanceStats = await fillBalances(balances, [address], startedAt);
    const centerAggregate: NodeAggregate = {
      txCount: 0,
      volume: 0,
      inboundTxCount: 0,
      outboundTxCount: 0,
    };
    const buildMs = Date.now() - startedAt;

    return {
      center: address,
      generatedAt: new Date().toISOString(),
      nodes: [toNode(address, 0, centerAggregate, balances)],
      edges: [],
      stats: {
        analyzedTransactions: 0,
        hopRequests: 0,
        firstHopCount: 0,
        secondHopCount: 0,
        edgeCount: 0,
        scanMode,
        rootFetchMs,
        buildMs,
        rootScanned: 0,
        rootExcludedRewards: 0,
        rootPagesFetched: 0,
        rootFallbackTxs: 0,
        hopScanned: 0,
        hopExcludedRewards: 0,
        hopPagesFetched: 0,
        balanceRequested: balanceStats.requested,
        balanceReturned: balanceStats.returned,
        balancePopulated: balanceStats.populated,
        balanceTruncated: balanceStats.truncated,
      },
      truncated: {
        firstHop: false,
        secondHop: false,
        requests: false,
      },
    };
  }

  const nodeAgg = new Map<string, NodeAggregate>();
  const edgeAgg = new Map<string, EdgeAggregate>();
  const firstHopAgg = new Map<string, NodeAggregate>();
  const secondHopAgg = new Map<string, NodeAggregate>();
  const secondHopByParent = new Map<string, Map<string, number>>();

  const rootNeighbors = root.neighbors
    .map((entry) => {
      const normalized = normalizeAddress(entry.address);
      if (!normalized) return null;
      if (normalized === address) return null;
      return {
        id: normalized,
        aggregate: neighborEntryToAggregate(entry),
      };
    })
    .filter((entry): entry is { id: string; aggregate: NodeAggregate } => entry !== null);

  if (rootNeighbors.length === 0) {
    const balances = new Map<string, number | null>();
    const balanceStats = await fillBalances(balances, [address], startedAt);
    const centerAggregate: NodeAggregate = {
      txCount: 0,
      volume: 0,
      inboundTxCount: 0,
      outboundTxCount: 0,
    };
    const buildMs = Date.now() - startedAt;

    return {
      center: address,
      generatedAt: new Date().toISOString(),
      nodes: [toNode(address, 0, centerAggregate, balances)],
      edges: [],
      stats: {
        analyzedTransactions: 0,
        hopRequests: 0,
        firstHopCount: 0,
        secondHopCount: 0,
        edgeCount: 0,
        scanMode,
        rootFetchMs,
        buildMs,
        rootScanned: 0,
        rootExcludedRewards: 0,
        rootPagesFetched: 0,
        rootFallbackTxs: 0,
        hopScanned: 0,
        hopExcludedRewards: 0,
        hopPagesFetched: 0,
        balanceRequested: balanceStats.requested,
        balanceReturned: balanceStats.returned,
        balancePopulated: balanceStats.populated,
        balanceTruncated: balanceStats.truncated,
      },
      truncated: {
        firstHop: false,
        secondHop: false,
        requests: false,
      },
    };
  }

  const rootTxCountTotal = rootNeighbors.reduce(
    (sum, entry) => sum + entry.aggregate.txCount,
    0
  );
  const rootValueTotal = rootNeighbors.reduce(
    (sum, entry) => sum + entry.aggregate.volume,
    0
  );

  nodeAgg.set(address, {
    txCount: rootTxCountTotal,
    volume: rootValueTotal,
    inboundTxCount: rootNeighbors.reduce((sum, entry) => sum + entry.aggregate.inboundTxCount, 0),
    outboundTxCount: rootNeighbors.reduce((sum, entry) => sum + entry.aggregate.outboundTxCount, 0),
  });

  for (const neighbor of rootNeighbors) {
    firstHopAgg.set(neighbor.id, neighbor.aggregate);
    nodeAgg.set(neighbor.id, neighbor.aggregate);

    const [a, b] = sortPair(address, neighbor.id);
    const key = `${a}|${b}`;
    edgeAgg.set(key, {
      a,
      b,
      txCount: neighbor.aggregate.txCount,
      volume: neighbor.aggregate.volume,
      toCenter: neighbor.aggregate.inboundTxCount,
      fromCenter: neighbor.aggregate.outboundTxCount,
    });
  }

  const firstHopCandidates = Array.from(firstHopAgg.entries())
    .sort((a, b) => scoreAggregate(b[1]) - scoreAggregate(a[1]));
  const firstHopSelected = firstHopCandidates.slice(0, FIRST_HOP_LIMIT);
  const firstHopSet = new Set(firstHopSelected.map(([id]) => id));

  const indexedHopRequestCap = scanMode === "deep" ? FIRST_HOP_LIMIT : Math.min(4, FIRST_HOP_LIMIT);
  const hopTargets = firstHopSelected.slice(0, indexedHopRequestCap).map(([id]) => id);
  let hopRequests = 0;

  await mapWithConcurrency(hopTargets, 4, async (hopAddress) => {
    let resp: Awaited<ReturnType<typeof FluxAPI.getAddressNeighbors>> | null = null;
    try {
      resp = await withTimeout(
        FluxAPI.getAddressNeighbors(hopAddress, hopLimit),
        boundedTimeout(startedAt, 2_300),
        "neighbors_hop"
      );
    } catch {
      return null;
    }
    hopRequests += 1;

    const neighborEntries = Array.isArray(resp?.neighbors) ? resp!.neighbors : [];
    const parentMap = secondHopByParent.get(hopAddress) ?? new Map<string, number>();
    secondHopByParent.set(hopAddress, parentMap);

    for (const entry of neighborEntries) {
      const normalized = normalizeAddress(entry.address);
      if (!normalized) continue;
      if (normalized === address) continue;

      const agg = neighborEntryToAggregate(entry);
      nodeAgg.set(normalized, agg);

      const [a, b] = sortPair(hopAddress, normalized);
      const key = `${a}|${b}`;
      if (!edgeAgg.has(key)) {
        edgeAgg.set(key, {
          a,
          b,
          txCount: agg.txCount,
          volume: agg.volume,
          toCenter: 0,
          fromCenter: 0,
        });
      }

      if (!firstHopSet.has(normalized)) {
        const existing = secondHopAgg.get(normalized);
        if (existing) {
          existing.txCount += agg.txCount;
          existing.volume += agg.volume;
          existing.inboundTxCount += agg.inboundTxCount;
          existing.outboundTxCount += agg.outboundTxCount;
        } else {
          secondHopAgg.set(normalized, { ...agg });
        }

        parentMap.set(normalized, (parentMap.get(normalized) ?? 0) + agg.volume);
      }
    }

    return null;
  });

  const parentSelectionCount = new Map<string, number>();
  const parentPointer = new Map<string, number>();
  const selectedSecond = new Set<string>();

  for (const parent of hopTargets) {
    parentSelectionCount.set(parent, 0);
    parentPointer.set(parent, 0);
  }

  const sortedByParent = new Map<string, string[]>();
  for (const parent of hopTargets) {
    const candidateVolumes = secondHopByParent.get(parent) ?? new Map<string, number>();
    const sorted = Array.from(candidateVolumes.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    sortedByParent.set(parent, sorted);
  }

  let progress = true;
  while (selectedSecond.size < SECOND_HOP_LIMIT && progress) {
    progress = false;

    for (const parent of hopTargets) {
      const used = parentSelectionCount.get(parent) ?? 0;
      if (used >= SECOND_HOP_PER_PARENT) continue;

      const list = sortedByParent.get(parent) ?? [];
      let pointer = parentPointer.get(parent) ?? 0;
      while (pointer < list.length && selectedSecond.has(list[pointer])) {
        pointer += 1;
      }

      parentPointer.set(parent, pointer);
      if (pointer >= list.length) continue;

      const candidate = list[pointer];
      selectedSecond.add(candidate);
      parentSelectionCount.set(parent, used + 1);
      parentPointer.set(parent, pointer + 1);
      progress = true;

      if (selectedSecond.size >= SECOND_HOP_LIMIT) {
        break;
      }
    }
  }

  if (selectedSecond.size < SECOND_HOP_LIMIT) {
    const globalSecond = Array.from(secondHopAgg.entries())
      .sort((a, b) => scoreAggregate(b[1]) - scoreAggregate(a[1]))
      .map(([id]) => id);
    for (const candidate of globalSecond) {
      if (selectedSecond.has(candidate)) continue;
      selectedSecond.add(candidate);
      if (selectedSecond.size >= SECOND_HOP_LIMIT) break;
    }
  }

  const includedNodes = new Set<string>(
    [address, ...firstHopSelected.map(([id]) => id), ...Array.from(selectedSecond)]
  );

  const balances = new Map<string, number | null>();
  const balanceStats = await fillBalances(balances, Array.from(includedNodes), startedAt);

  const centerAggregate = nodeAgg.get(address) ?? {
    txCount: rootTxCountTotal,
    volume: rootValueTotal,
    inboundTxCount: 0,
    outboundTxCount: 0,
  };

  const nodes: AddressConstellationNode[] = [
    toNode(address, 0, centerAggregate, balances),
    ...firstHopSelected.map(([id, aggregate]) => toNode(id, 1, aggregate, balances)),
    ...Array.from(selectedSecond)
      .map((id) => {
        const aggregate = secondHopAgg.get(id) ?? nodeAgg.get(id);
        if (!aggregate) return null;
        return toNode(id, 2, aggregate, balances);
      })
      .filter((entry): entry is AddressConstellationNode => entry !== null),
  ];

  const edges = Array.from(edgeAgg.values())
    .filter((edge) => includedNodes.has(edge.a) && includedNodes.has(edge.b))
    .map((edge) => toEdge(edge, address));

  const buildMs = Date.now() - startedAt;

  return {
    center: address,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    stats: {
      analyzedTransactions: rootTxCountTotal,
      hopRequests,
      firstHopCount: firstHopSelected.length,
      secondHopCount: selectedSecond.size,
      edgeCount: edges.length,
      scanMode,
      rootFetchMs,
      buildMs,
      rootScanned: 0,
      rootExcludedRewards: 0,
      rootPagesFetched: 0,
      rootFallbackTxs: 0,
      hopScanned: 0,
      hopExcludedRewards: 0,
      hopPagesFetched: 0,
      balanceRequested: balanceStats.requested,
      balanceReturned: balanceStats.returned,
      balancePopulated: balanceStats.populated,
      balanceTruncated: balanceStats.truncated,
    },
    truncated: {
      firstHop: rootNeighbors.length > FIRST_HOP_LIMIT,
      secondHop: secondHopAgg.size > SECOND_HOP_LIMIT,
      requests: hopTargets.length > 0 && firstHopSelected.length > hopTargets.length,
    },
  };
}

async function buildConstellation(
  address: string,
  scanMode: ConstellationScanMode
): Promise<AddressConstellationData> {
  const startedAt = Date.now();

  const indexed = await tryBuildConstellationFromNeighbors(address, scanMode, startedAt).catch(
    () => null
  );
  if (indexed) {
    return indexed;
  }

  const isDeep = scanMode === "deep";
  let rootTransactions: AddressTransactionSummary[] = [];
  let rootFetchMs = 0;
  let rootScanned = 0;
  let rootExcludedRewards = 0;
  let rootPagesFetched = 0;

  const emptyWindow: NonRewardWindow = {
    items: [],
    scanned: 0,
    excludedRewards: 0,
    pagesFetched: 0,
  };

  try {
    const fetchStartedAt = Date.now();
    const rootTargetCount = isDeep ? DEEP_ROOT_NON_REWARD_LIMIT : FAST_ROOT_NON_REWARD_LIMIT;
    const rootScanCap = isDeep ? DEEP_ROOT_SCAN_CAP : FAST_ROOT_SCAN_CAP;
    const rootPageSize = isDeep ? DEEP_ROOT_PAGE_SIZE : FAST_ROOT_PAGE_SIZE;
    const rootMaxPages = isDeep ? DEEP_ROOT_MAX_PAGES : FAST_ROOT_MAX_PAGES;
    const rootSlackMax = isDeep ? DEEP_ROOT_SLACK_MAX : FAST_ROOT_SLACK_MAX;
    const rootTimeoutMs = isDeep ? DEEP_ROOT_TX_TIMEOUT_MS : FAST_ROOT_TX_TIMEOUT_MS;

    const rootWindow = await fetchNonRewardTransactions(address, {
      targetCount: rootTargetCount,
      scanCap: rootScanCap,
      pageSize: rootPageSize,
      maxPages: rootMaxPages,
      slackMax: rootSlackMax,
      apiSkipTotals: !isDeep,
      startedAt,
      requestTimeoutMs: rootTimeoutMs,
    }).catch(() => emptyWindow);
    rootFetchMs = Date.now() - fetchStartedAt;
    rootTransactions = rootWindow.items;
    rootScanned = rootWindow.scanned;
    rootExcludedRewards = rootWindow.excludedRewards;
    rootPagesFetched = rootWindow.pagesFetched;
  } catch {
    rootTransactions = [];
  }

  let rootFallbackCounterparties = new Map<string, string[]>();
  try {
    rootFallbackCounterparties = await buildFullTransactionCounterpartyMap(
      address,
      rootTransactions,
      startedAt,
      isDeep
    );
  } catch {
    rootFallbackCounterparties = new Map<string, string[]>();
  }
  const rootFallbackTxs = rootFallbackCounterparties.size;

  const nodeAgg = new Map<string, NodeAggregate>();
  const edgeAgg = new Map<string, EdgeAggregate>();
  const firstHopAgg = new Map<string, NodeAggregate>();
  const secondHopAgg = new Map<string, NodeAggregate>();
  const secondHopByParent = new Map<string, Map<string, number>>();

  nodeAgg.set(address, {
    txCount: 0,
    volume: 0,
    inboundTxCount: 0,
    outboundTxCount: 0,
  });

  for (const tx of rootTransactions) {
    const summaryCounterparties = extractCounterparties(tx, address);
    const counterparties =
      summaryCounterparties.length > 0
        ? summaryCounterparties
        : rootFallbackCounterparties.get(tx.txid) ?? [];
    if (counterparties.length === 0) continue;

    addNodeActivity(nodeAgg, address, tx.direction, Math.abs(tx.value));

    const volumePerCounterparty = Math.abs(tx.value) / counterparties.length;
    for (const counterparty of counterparties) {
      addNodeActivity(
        firstHopAgg,
        counterparty,
        tx.direction === "received" ? "sent" : "received",
        volumePerCounterparty
      );
      addNodeActivity(
        nodeAgg,
        counterparty,
        tx.direction === "received" ? "sent" : "received",
        volumePerCounterparty
      );

      const source = tx.direction === "received" ? counterparty : address;
      const target = tx.direction === "received" ? address : counterparty;
      addEdgeActivity(edgeAgg, address, source, target, volumePerCounterparty);
    }
  }

  const firstHopLimit = FIRST_HOP_LIMIT;
  const hopTargetCount = DEEP_HOP_NON_REWARD_LIMIT;
  const hopScanCap = DEEP_HOP_SCAN_CAP;
  const hopPageSize = DEEP_HOP_PAGE_SIZE;
  const hopMaxPages = DEEP_HOP_MAX_PAGES;
  const secondHopLimit = SECOND_HOP_LIMIT;
  const secondHopPerParent = SECOND_HOP_PER_PARENT;

  const firstHopCandidates = Array.from(firstHopAgg.entries())
    .sort((a, b) => scoreAggregate(b[1]) - scoreAggregate(a[1]));
  const firstHopSelected = firstHopCandidates.slice(0, firstHopLimit);
  const firstHopSet = new Set(firstHopSelected.map(([id]) => id));

  const shouldExpandHops =
    isDeep && rootTransactions.length >= HOP_ROOT_MIN_TXS && timeLeftMs(startedAt) >= 3_000;
  const maxHopRequests = shouldExpandHops ? SCAN_MAX_HOP_REQUESTS : 0;

  const hopTargets = firstHopSelected.slice(0, maxHopRequests).map(([id]) => id);
  let hopRequests = 0;
  let hopScanned = 0;
  let hopExcludedRewards = 0;
  let hopPagesFetched = 0;

  await mapWithConcurrency(hopTargets, 3, async (hopAddress) => {
    try {
      const window = await fetchNonRewardTransactions(hopAddress, {
        targetCount: hopTargetCount,
        scanCap: hopScanCap,
        pageSize: hopPageSize,
        maxPages: hopMaxPages,
        slackMax: DEEP_HOP_SLACK_MAX,
        apiSkipTotals: false,
        startedAt,
        requestTimeoutMs: DEEP_HOP_TX_TIMEOUT_MS,
      });
      hopRequests += 1;
      hopScanned += window.scanned;
      hopExcludedRewards += window.excludedRewards;
      hopPagesFetched += window.pagesFetched;
      const hopTransactions = window.items;
      const hopFallbackCounterparties = await buildFullTransactionCounterpartyMap(
        hopAddress,
        hopTransactions,
        startedAt,
        false
      );

      const parentMap = secondHopByParent.get(hopAddress) ?? new Map<string, number>();
      secondHopByParent.set(hopAddress, parentMap);

      for (const tx of hopTransactions) {
        const summaryCounterparties = extractCounterparties(tx, hopAddress);
        const counterparties =
          summaryCounterparties.length > 0
            ? summaryCounterparties
            : hopFallbackCounterparties.get(tx.txid) ?? [];
        if (counterparties.length === 0) continue;

        addNodeActivity(nodeAgg, hopAddress, tx.direction, Math.abs(tx.value));

        const volumePerCounterparty = Math.abs(tx.value) / counterparties.length;
        for (const counterparty of counterparties) {
          if (counterparty === address) {
            continue;
          }

          addNodeActivity(
            nodeAgg,
            counterparty,
            tx.direction === "received" ? "sent" : "received",
            volumePerCounterparty
          );

          const source = tx.direction === "received" ? counterparty : hopAddress;
          const target = tx.direction === "received" ? hopAddress : counterparty;
          addEdgeActivity(edgeAgg, address, source, target, volumePerCounterparty);

          if (!firstHopSet.has(counterparty)) {
            addNodeActivity(
              secondHopAgg,
              counterparty,
              tx.direction === "received" ? "sent" : "received",
              volumePerCounterparty
            );
            parentMap.set(counterparty, (parentMap.get(counterparty) ?? 0) + volumePerCounterparty);
          }
        }
      }
    } catch {
      // Best effort for second-hop expansion.
    }

    return null;
  });

  const parentSelectionCount = new Map<string, number>();
  const parentPointer = new Map<string, number>();
  const selectedSecond = new Set<string>();

  for (const parent of hopTargets) {
    parentSelectionCount.set(parent, 0);
    parentPointer.set(parent, 0);
  }

  const sortedByParent = new Map<string, string[]>();
  for (const parent of hopTargets) {
    const candidateVolumes = secondHopByParent.get(parent) ?? new Map<string, number>();
    const sorted = Array.from(candidateVolumes.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    sortedByParent.set(parent, sorted);
  }

  let progress = true;
  while (selectedSecond.size < secondHopLimit && progress) {
    progress = false;

    for (const parent of hopTargets) {
      const used = parentSelectionCount.get(parent) ?? 0;
      if (used >= secondHopPerParent) continue;

      const list = sortedByParent.get(parent) ?? [];
      let pointer = parentPointer.get(parent) ?? 0;
      while (pointer < list.length && selectedSecond.has(list[pointer])) {
        pointer += 1;
      }

      parentPointer.set(parent, pointer);
      if (pointer >= list.length) continue;

      const candidate = list[pointer];
      selectedSecond.add(candidate);
      parentSelectionCount.set(parent, used + 1);
      parentPointer.set(parent, pointer + 1);
      progress = true;

      if (selectedSecond.size >= secondHopLimit) {
        break;
      }
    }
  }

  if (selectedSecond.size < secondHopLimit) {
    const globalSecond = Array.from(secondHopAgg.entries())
      .sort((a, b) => scoreAggregate(b[1]) - scoreAggregate(a[1]))
      .map(([id]) => id);
    for (const candidate of globalSecond) {
      if (selectedSecond.has(candidate)) continue;
      selectedSecond.add(candidate);
      if (selectedSecond.size >= secondHopLimit) break;
    }
  }

  const includedNodes = new Set<string>(
    [address, ...firstHopSelected.map(([id]) => id), ...Array.from(selectedSecond)]
  );

  const balances = new Map<string, number | null>();
  const balanceStats = await fillBalances(balances, Array.from(includedNodes), startedAt);

  const centerAggregate = nodeAgg.get(address) ?? {
    txCount: rootTransactions.length,
    volume: rootTransactions.reduce((sum, tx) => sum + Math.abs(tx.value), 0),
    inboundTxCount: rootTransactions.filter((tx) => tx.direction === "received").length,
    outboundTxCount: rootTransactions.filter((tx) => tx.direction === "sent").length,
  };

  const nodes: AddressConstellationNode[] = [
    toNode(address, 0, centerAggregate, balances),
    ...firstHopSelected.map(([id, aggregate]) => toNode(id, 1, aggregate, balances)),
    ...Array.from(selectedSecond)
      .map((id) => {
        const aggregate = secondHopAgg.get(id) ?? nodeAgg.get(id);
        if (!aggregate) return null;
        return toNode(id, 2, aggregate, balances);
      })
      .filter((entry): entry is AddressConstellationNode => entry !== null),
  ];

  const edges = Array.from(edgeAgg.values())
    .filter((edge) => includedNodes.has(edge.a) && includedNodes.has(edge.b))
    .map((edge) => toEdge(edge, address));

  const buildMs = Date.now() - startedAt;

  return {
    center: address,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    stats: {
      analyzedTransactions: rootTransactions.length,
      hopRequests,
      firstHopCount: firstHopSelected.length,
      secondHopCount: selectedSecond.size,
      edgeCount: edges.length,
      scanMode,
      rootFetchMs,
      buildMs,
      rootScanned,
      rootExcludedRewards,
      rootPagesFetched,
      rootFallbackTxs,
      hopScanned,
      hopExcludedRewards,
      hopPagesFetched,
      balanceRequested: balanceStats.requested,
      balanceReturned: balanceStats.returned,
      balancePopulated: balanceStats.populated,
      balanceTruncated: balanceStats.truncated,
    },
    truncated: {
      firstHop: firstHopCandidates.length > firstHopLimit,
      secondHop: secondHopAgg.size > secondHopLimit,
      requests: maxHopRequests > 0 && firstHopSelected.length > maxHopRequests,
    },
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { address: string } }
) {
  maybeStartCleanupTimer();

  const address = String(params.address ?? "").trim();
  if (!isLikelyFluxAddress(address)) {
    return NextResponse.json(
      { error: "invalid_address" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const scanMode = parseScanMode(request);

  const ip = getClientIp(request);
  const quota = consumeQuota(ip);
  if (!quota.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSeconds: quota.retryAfterSeconds },
      {
        status: 429,
        headers: {
          "Retry-After": String(quota.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const cacheKey = `address-constellation:${address}:${scanMode}`;
  const now = Date.now();
  const cached = responseCache.get(cacheKey);
  if (cached && now - cached.at <= CACHE_TTL_MS) {
    return NextResponse.json(cached.value, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
        "X-Constellation-Cache": "hit",
        "X-Constellation-Mode": scanMode,
      },
    });
  }

  if (cached && now - cached.at <= STALE_WINDOW_MS) {
    if (!inflightRequests.has(cacheKey)) {
      const background = buildConstellation(address, scanMode);
      inflightRequests.set(cacheKey, { promise: background, at: now });
      void background
        .then((value) => {
          responseCache.set(cacheKey, { at: Date.now(), value });
        })
        .catch((error) => {
          console.error("Failed to refresh address constellation:", error);
        })
        .finally(() => {
          inflightRequests.delete(cacheKey);
        });
    }

    return NextResponse.json(cached.value, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
        "X-Constellation-Cache": "stale",
        "X-Constellation-Mode": scanMode,
      },
    });
  }

  const inflight = inflightRequests.get(cacheKey);
  if (inflight && now - inflight.at <= COALESCE_WINDOW_MS) {
    try {
      const sharedValue = await inflight.promise;
      return NextResponse.json(sharedValue, {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
          "X-Constellation-Coalesced": "true",
          "X-Constellation-Mode": scanMode,
        },
      });
    } catch (error) {
      console.error("Failed shared constellation request:", error);
    }
  }

  const promise = buildConstellation(address, scanMode);
  inflightRequests.set(cacheKey, { promise, at: now });

  try {
    const value = await promise;
    responseCache.set(cacheKey, { at: Date.now(), value });

    return NextResponse.json(value, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
        "X-Constellation-Mode": scanMode,
      },
    });
  } catch (error) {
    console.error("Failed to build address constellation:", error);
    const status = typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode?: number }).statusCode) || 500
      : 500;
    const message = error instanceof Error ? error.message : "Failed to build address constellation";

    return NextResponse.json(
      { error: message },
      {
        status,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } finally {
    inflightRequests.delete(cacheKey);
  }
}
