import { NextRequest, NextResponse } from "next/server";
import { FluxAPI } from "@/lib/api/client";
import type {
  AddressConstellationData,
  AddressConstellationEdge,
  AddressConstellationNode,
} from "@/types/address-constellation";
import type { AddressTransactionSummary, Transaction } from "@/types/flux-api";
import { isLikelyFluxAddress } from "@/lib/security/export-guard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ROOT_NON_REWARD_LIMIT = 90;
const ROOT_SCAN_CAP = 8_000;
const ROOT_PAGE_SIZE = 220;
const FIRST_HOP_LIMIT = 8;
const MAX_HOP_REQUESTS = 3;
const HOP_NON_REWARD_LIMIT = 24;
const HOP_SCAN_CAP = 1_200;
const HOP_PAGE_SIZE = 160;
const SECOND_HOP_LIMIT = 16;
const SECOND_HOP_PER_PARENT = 3;
const MAX_BALANCE_LOOKUPS = 10;
const BALANCE_LOOKUP_CONCURRENCY = 4;
const FULL_TX_BATCH_SIZE = 40;
const FULL_TX_FALLBACK_TRIGGER_RATIO = 0.35;
const BUILD_BUDGET_MS = 10_000;
const ROOT_TX_TIMEOUT_MS = 5_000;
const HOP_TX_TIMEOUT_MS = 2_800;
const ADDRESS_LOOKUP_TIMEOUT_MS = 2_200;
const BATCH_TX_TIMEOUT_MS = 2_200;
const MIN_TIMEOUT_MS = 300;

const CACHE_TTL_MS = 30_000;
const COALESCE_WINDOW_MS = 2_000;
const STALE_WINDOW_MS = 120_000;

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

  const lists: string[][] = [];
  if (preferred?.length) {
    lists.push(preferred);
  }

  if (tx.isCoinbase || !preferred?.length) {
    if (alternate?.length) {
      lists.push(alternate);
    }
  }

  for (const list of lists) {
    for (const raw of list) {
      const normalized = normalizeAddress(raw);
      if (!normalized) continue;
      if (normalized === currentAddress) continue;
      unique.add(normalized);
    }
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
  if (tx.isCoinbase) return true;
  if (tx.direction !== "received") return false;
  return (tx.fromAddresses?.length ?? 0) === 0;
}

type NonRewardWindow = {
  items: AddressTransactionSummary[];
  scanned: number;
  excludedRewards: number;
};

async function fetchNonRewardTransactions(
  address: string,
  options: {
    targetCount: number;
    scanCap: number;
    pageSize: number;
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

  while (collected.length < options.targetCount && scanned < options.scanCap) {
    let pageSize = Math.min(options.pageSize, options.scanCap - scanned);
    if (pageSize <= 0) break;
    pageSize = Math.max(1, pageSize);

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
          excludeCoinbase: true,
        },
        {
          timeoutMs: boundedTimeout(options.startedAt, options.requestTimeoutMs),
          retryLimit: 0,
        }
      );
    } catch {
      break;
    }

    const pageItems = page?.items ?? [];
    if (pageItems.length === 0) {
      break;
    }

    scanned += pageItems.length;

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

    if (pageItems.length < pageSize) break;
    const nextCursor = page?.nextCursor;
    if (!nextCursor) break;
    const nextCursorKey = `${nextCursor.height}:${nextCursor.txIndex}:${nextCursor.txid}`;
    if (nextCursorKey === lastCursor) break;
    lastCursor = nextCursorKey;
    cursor = nextCursor;
    if (timeLeftMs(options.startedAt) <= MIN_TIMEOUT_MS) break;
  }

  return {
    items: collected,
    scanned,
    excludedRewards,
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

  for (let i = 0; i < txids.length; i += FULL_TX_BATCH_SIZE) {
    const chunk = txids.slice(i, i + FULL_TX_BATCH_SIZE);
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
      // Best effort. Summary data remains the fallback.
      break;
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

async function fetchBalances(addresses: string[], startedAt: number): Promise<Map<string, number | null>> {
  const targets = Array.from(new Set(addresses)).slice(0, MAX_BALANCE_LOOKUPS);
  const pairs = await mapWithConcurrency(
    targets,
    BALANCE_LOOKUP_CONCURRENCY,
    async (address) => {
      try {
        const info = await withTimeout(
          FluxAPI.getAddress(address),
          boundedTimeout(startedAt, ADDRESS_LOOKUP_TIMEOUT_MS),
          "address_lookup"
        );
        return [address, Number.isFinite(info.balance) ? info.balance : null] as const;
      } catch {
        return [address, null] as const;
      }
    }
  );

  return new Map(pairs);
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

async function buildConstellation(address: string): Promise<AddressConstellationData> {
  const startedAt = Date.now();
  let centerInfo: Awaited<ReturnType<typeof FluxAPI.getAddress>> | null = null;
  let rootTransactions: AddressTransactionSummary[] = [];

  try {
    const [centerResult, rootWindow] = await Promise.all([
      withTimeout(
        FluxAPI.getAddress(address),
        boundedTimeout(startedAt, ADDRESS_LOOKUP_TIMEOUT_MS),
        "center_lookup"
      ).catch(() => null),
      fetchNonRewardTransactions(address, {
        targetCount: ROOT_NON_REWARD_LIMIT,
        scanCap: ROOT_SCAN_CAP,
        pageSize: ROOT_PAGE_SIZE,
        startedAt,
        requestTimeoutMs: ROOT_TX_TIMEOUT_MS,
      }).catch(() => ({ items: [] as AddressTransactionSummary[], scanned: 0, excludedRewards: 0 })),
    ]);

    centerInfo = centerResult;
    rootTransactions = rootWindow.items;
  } catch {
    centerInfo = null;
    rootTransactions = [];
  }

  let rootFallbackCounterparties = new Map<string, string[]>();
  try {
    rootFallbackCounterparties = await buildFullTransactionCounterpartyMap(
      address,
      rootTransactions,
      startedAt,
      true
    );
  } catch {
    rootFallbackCounterparties = new Map<string, string[]>();
  }

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

  const firstHopCandidates = Array.from(firstHopAgg.entries())
    .sort((a, b) => scoreAggregate(b[1]) - scoreAggregate(a[1]));
  const firstHopSelected = firstHopCandidates.slice(0, FIRST_HOP_LIMIT);
  const firstHopSet = new Set(firstHopSelected.map(([id]) => id));

  const hopTargets = firstHopSelected.slice(0, MAX_HOP_REQUESTS).map(([id]) => id);
  let hopRequests = 0;

  await mapWithConcurrency(hopTargets, 3, async (hopAddress) => {
    try {
      const window = await fetchNonRewardTransactions(hopAddress, {
        targetCount: HOP_NON_REWARD_LIMIT,
        scanCap: HOP_SCAN_CAP,
        pageSize: HOP_PAGE_SIZE,
        startedAt,
        requestTimeoutMs: HOP_TX_TIMEOUT_MS,
      });
      hopRequests += 1;
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

  const nodesForBalance = [
    address,
    ...firstHopSelected.map(([id]) => id),
    ...Array.from(selectedSecond),
  ];
  const balances = await fetchBalances(nodesForBalance, startedAt);
  if (centerInfo && Number.isFinite(centerInfo.balance)) {
    balances.set(address, centerInfo.balance);
  }

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
    },
    truncated: {
      firstHop: firstHopCandidates.length > FIRST_HOP_LIMIT,
      secondHop: secondHopAgg.size > SECOND_HOP_LIMIT,
      requests: firstHopSelected.length > MAX_HOP_REQUESTS,
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

  const cacheKey = `address-constellation:${address}`;
  const now = Date.now();
  const cached = responseCache.get(cacheKey);
  if (cached && now - cached.at <= CACHE_TTL_MS) {
    return NextResponse.json(cached.value, {
      headers: {
        "Cache-Control": "public, s-maxage=15, stale-while-revalidate=45",
        "X-Constellation-Cache": "hit",
      },
    });
  }

  const inflight = inflightRequests.get(cacheKey);
  if (inflight && now - inflight.at <= COALESCE_WINDOW_MS) {
    try {
      const sharedValue = await inflight.promise;
      return NextResponse.json(sharedValue, {
        headers: {
          "Cache-Control": "public, s-maxage=15, stale-while-revalidate=45",
          "X-Constellation-Coalesced": "true",
        },
      });
    } catch (error) {
      console.error("Failed shared constellation request:", error);
    }
  }

  const promise = buildConstellation(address);
  inflightRequests.set(cacheKey, { promise, at: now });

  try {
    const value = await promise;
    responseCache.set(cacheKey, { at: Date.now(), value });

    return NextResponse.json(value, {
      headers: {
        "Cache-Control": "public, s-maxage=15, stale-while-revalidate=45",
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
