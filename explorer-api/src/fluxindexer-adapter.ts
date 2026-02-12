import type { Env } from './env.js';

function toNumber(value: unknown, fallback = 0): number {
  const asNumber = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(asNumber) ? asNumber : fallback;
}

function toOptionalNumber(value: unknown): number | null {
  const asNumber = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function confirmationsFromHeight(bestHeight: number, height: number | null): number {
  if (height == null) return 0;

  const h = Math.trunc(height);
  const tip = Math.trunc(bestHeight);

  if (h < 0) return -1;
  if (tip < h) return 0;
  return tip - h + 1;
}

function toString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function toIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return fallback;

    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) {
        const ms = trimmed.length >= 13 ? num : num * 1000;
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
      }
    }

    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return fallback;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value >= 1e12 ? value : value * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  return fallback;
}

function toSatoshiBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function toSatoshiString(value: unknown): string {
  return toSatoshiBigInt(value).toString();
}

function amountToSatoshiBigInt(value: unknown): bigint {

  if (typeof value === 'bigint') return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.round(value * 1e8));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return 0n;

    const negative = trimmed.startsWith('-');
    const abs = negative ? trimmed.slice(1) : trimmed;

    if (abs.includes('.')) {
      const [wholeRaw, fracRaw = ''] = abs.split('.', 2);
      const whole = wholeRaw.length > 0 ? BigInt(wholeRaw) : 0n;
      const fracPadded = (fracRaw + '00000000').slice(0, 8);
      const frac = BigInt(fracPadded);
      const sat = whole * 100000000n + frac;
      return negative ? -sat : sat;
    }

    return toSatoshiBigInt(trimmed);
  }

  return toSatoshiBigInt(value);
}

export interface FluxIndexerBlockResponse {
  hash: string;
  size?: number;
  height: number;
  version?: number;
  merkleRoot?: string;
  time?: number;
  nonce?: string;
  bits?: string;
  difficulty: string;
  chainWork?: string;
  confirmations?: number;
  previousBlockHash?: string;
  nextBlockHash?: string;
  reward?: string;
  txCount?: number;
  txs?: Array<{ txid: string }>;
  txDetails?: Array<{
    txid: string;
    order: number;
    kind: 'coinbase' | 'transfer' | 'fluxnode_start' | 'fluxnode_confirm' | 'fluxnode_other';
    isCoinbase: boolean;
    fluxnodeType?: number | null;
    fluxnodeTier?: string | null;
    fluxnodeIp?: string | null;
    valueSat?: number;
    value?: number;
    valueInSat?: number;
    valueIn?: number;
    feeSat?: number;
    fee?: number;
    fromAddr?: string | null;
    toAddr?: string | null;
  }>;
  txSummary?: {
    total: number;
    regular: number;
    coinbase: number;
    transfers: number;
    fluxnodeStart: number;
    fluxnodeConfirm: number;
    fluxnodeOther: number;
    fluxnodeTotal: number;
    tierCounts: {
      cumulus: number;
      nimbus: number;
      stratus: number;
      starting: number;
      unknown: number;
    };
  };
}

export interface FluxIndexerTransactionResponse {
  txid: string;
  version?: number;
  lockTime?: number;
  vin?: Array<any>;
  vout?: Array<any>;
  blockHash?: string;
  blockHeight?: number;
  confirmations?: number;
  blockTime?: number;
  time?: number;
  value?: string;
  size?: number;
  vsize?: number;
  valueIn?: string;
  fees?: string;
  nType?: number | null;
  benchmarkTier?: string | null;
  ip?: string | null;
  collateralOutputHash?: string | null;
  collateralOutputIndex?: number | null;
  hex?: string;
}

type CachedTipHeight = { atMs: number; height: number };

let cachedTipHeight: CachedTipHeight | null = null;
let tipHeightInFlight: Promise<number> | null = null;
const TIP_HEIGHT_CACHE_TTL_MS = 5_000;

async function getTipHeightCached(env: Env): Promise<number> {
  const nowMs = Date.now();
  const cached = cachedTipHeight;
  if (cached && nowMs - cached.atMs <= TIP_HEIGHT_CACHE_TTL_MS) {
    return cached.height;
  }

  if (tipHeightInFlight) {
    return tipHeightInFlight;
  }

  const request = (async (): Promise<number> => {
    try {
      const height = await fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) });
      const normalized = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
      cachedTipHeight = { atMs: Date.now(), height: normalized };
      return normalized;
    } finally {
      tipHeightInFlight = null;
    }
  })();

  tipHeightInFlight = request;
  return request;
}

export async function fluxdGet<T>(
  env: Env,
  method: string,
  params?: Record<string, string | number | boolean>,
  timeoutMs = 30_000
): Promise<T> {
  if (env.fixturesMode) {
    return fixturesGet(method, params) as T;
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
  };

  const authMode = env.rpcAuthMode;
  if (authMode !== 'none' && env.rpcUser && env.rpcPass) {
    headers.authorization = 'Basic ' + Buffer.from(`${env.rpcUser}:${env.rpcPass}`).toString('base64');
  }

  const search = params
    ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    : '';

  const url = `${env.fluxdRpcUrl}/daemon/${method}${search}`;

  let attempt = 0;
  const maxAttempts = method === 'getblockdeltas' ? 2 : 1;

  while (true) {
    attempt += 1;

    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        keepalive: false,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `fluxd_rust /daemon/${method} failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`
        );
      }

      const json = (await response.json()) as any;
      if (json && typeof json === 'object' && 'error' in json && json.error) {
        const message = typeof json.error?.message === 'string'
          ? json.error.message
          : typeof json.error === 'string'
            ? json.error
            : 'RPC error';
        throw new Error(message);
      }

      if (json && typeof json === 'object' && 'result' in json) {
        return json.result as T;
      }
      return json as T;
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw err instanceof Error ? err : new Error('fluxd_rust request failed');
      }

      const backoffMs = attempt * 150;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

async function fluxdGetWithOptions<T>(
  env: Env,
  method: string,
  params?: Record<string, string | number | boolean>,
  options?: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<T> {
  if (env.fixturesMode) {
    return fixturesGet(method, params) as T;
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
  };

  const authMode = env.rpcAuthMode;
  if (authMode !== 'none' && env.rpcUser && env.rpcPass) {
    headers.authorization = 'Basic ' + Buffer.from(`${env.rpcUser}:${env.rpcPass}`).toString('base64');
  }

  const query: Record<string, string> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      query[key] = String(value);
    }
  }
  if (options) {
    query.options = JSON.stringify(options);
  }

  const search = Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : '';

  const url = `${env.fluxdRpcUrl}/daemon/${method}${search}`;

  let attempt = 0;
  const maxAttempts = method === 'getblockdeltas' ? 2 : 1;

  while (true) {
    attempt += 1;

    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        keepalive: false,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `fluxd_rust /daemon/${method} failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`
        );
      }

      const json = (await response.json()) as any;
      if (json && typeof json === 'object' && 'error' in json && json.error) {
        const message = typeof json.error?.message === 'string'
          ? json.error.message
          : typeof json.error === 'string'
            ? json.error
            : 'RPC error';
        throw new Error(message);
      }

      if (json && typeof json === 'object' && 'result' in json) {
        return json.result as T;
      }
      return json as T;
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw err instanceof Error ? err : new Error('fluxd_rust request failed');
      }

      const backoffMs = attempt * 150;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

type BlockDeltaTx = {
  txid: string;
  index: number;
  inputs: Array<{ address?: string; satoshis?: number }>;
  outputs: Array<{ address?: string; satoshis?: number }>;

  nType?: number;
  ip?: string;
  benchmarkTier?: string;
  collateralOutputHash?: string;
  collateralOutputIndex?: number;
};

type FixtureResponse = unknown;

type FixtureBlock = {
  hash: string;
  height: number;
  time: number;
  bits: string;
  difficulty: number;
  chainwork: string;
  deltas: BlockDeltaTx[];
};

type FixtureTx = {
  txid: string;
  version?: number;
  locktime?: number;
  vin?: unknown[];
  vout?: unknown[];
  blockhash?: string;
  height?: number;
  time?: number;
};

const FIXTURE_BLOCK_1: FixtureBlock = {
  hash: '1'.repeat(64),
  height: 1,
  time: 1700000000,
  bits: '1d00ffff',
  difficulty: 1,
  chainwork: '0x00',
  deltas: [
    {
      txid: '2'.repeat(64),
      index: 0,
      inputs: [],
      outputs: [{ address: 't1' + 'b'.repeat(33), satoshis: 50_0000_0000 }],
    },
  ],
};

function fixturesGet(method: string, params?: Record<string, string | number | boolean>): FixtureResponse {
  if (method === 'getblockcount') {
    return FIXTURE_BLOCK_1.height;
  }

  if (method === 'getblockhash') {
    const rawParams = params?.params;
    const decoded = typeof rawParams === 'string' ? JSON.parse(rawParams) : [];
    const height = decoded?.[0];
    if (height === 1 || height === '1') return FIXTURE_BLOCK_1.hash;
    if (height === 0 || height === '0') return '0'.repeat(64);
    throw new Error('Block height out of range');
  }

  if (method === 'getblockheader') {
    const rawParams = params?.params;
    const decoded = typeof rawParams === 'string' ? JSON.parse(rawParams) : [];
    const hash = decoded?.[0];

    if (hash === FIXTURE_BLOCK_1.hash) {
      return {
        hash: FIXTURE_BLOCK_1.hash,
        confirmations: 1,
        height: FIXTURE_BLOCK_1.height,
        version: 4,
        merkleroot: '0'.repeat(64),
        finalsaplingroot: '0'.repeat(64),
        time: FIXTURE_BLOCK_1.time,
        bits: FIXTURE_BLOCK_1.bits,
        difficulty: FIXTURE_BLOCK_1.difficulty,
        chainwork: FIXTURE_BLOCK_1.chainwork,
        type: 'POW',
        nonce: '0',
        solution: '',
        previousblockhash: '0'.repeat(64),
      };
    }

    if (hash === '0'.repeat(64)) {
      return {
        hash: '0'.repeat(64),
        confirmations: 2,
        height: 0,
        version: 4,
        merkleroot: '0'.repeat(64),
        finalsaplingroot: '0'.repeat(64),
        time: FIXTURE_BLOCK_1.time - 60,
        bits: FIXTURE_BLOCK_1.bits,
        difficulty: FIXTURE_BLOCK_1.difficulty,
        chainwork: FIXTURE_BLOCK_1.chainwork,
        type: 'POW',
        nonce: '0',
        solution: '',
        previousblockhash: undefined,
        nextblockhash: FIXTURE_BLOCK_1.hash,
      };
    }

    throw new Error('Block not found');
  }

  if (method === 'getblockchaininfo') {
    return {
      chain: 'main',
      blocks: FIXTURE_BLOCK_1.height,
      headers: FIXTURE_BLOCK_1.height,
      bestblockhash: FIXTURE_BLOCK_1.hash,
      difficulty: FIXTURE_BLOCK_1.difficulty,
      chainwork: FIXTURE_BLOCK_1.chainwork,
      total_supply_zat: '0',
      valuePools: [
        { id: 'sprout', chainValueZat: '0' },
        { id: 'sapling', chainValueZat: '0' },
      ],
    };
  }

  if (method === 'getblockhashes') {
    return [FIXTURE_BLOCK_1.hash];
  }

  if (method === 'gettxstats') {
    const now = String(Math.floor(Date.now() / 1000));
    return {
      low: 0,
      high: 0,
      blocks: 1,
      txCount: 0,
      regularTxCount: 0,
      fluxnodeTxCount: 0,
      generatedAt: now,
    };
  }

  if (method === 'gettxoutsetinfo') {
    return {
      height: FIXTURE_BLOCK_1.height,
      bestblock: FIXTURE_BLOCK_1.hash,
      transactions: 1,
      txouts: 1,
      bytes_serialized: 0,
      hash_serialized: '0'.repeat(64),
      total_amount: 0,
    };
  }

  if (method === 'getindexstats') {
    return {
      spent_index_entries: 0,
      address_outpoint_entries: 1,
    };
  }

  if (method === 'getaddressdeltas') {
    return [];
  }

  if (method === 'getaddressmempool') {
    return [];
  }

  if (method === 'getrichlist') {
    const lastUpdate = String(Math.floor(Date.now() / 1000));
    return {
      lastUpdate,
      generatedAt: lastUpdate,
      lastBlockHeight: FIXTURE_BLOCK_1.height,
      totalSupply: '0',
      totalAddresses: 1,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      addresses: [
        {
          rank: 1,
          address: 't1' + 'c'.repeat(33),
          balance: '0',
          txCount: 0,
          cumulusCount: 0,
          nimbusCount: 0,
          stratusCount: 0,
        },
      ],
    };
  }

  if (method === 'estimatefee') {
    return 0.0001;
  }

  if (method === 'getblockdeltas') {
    const rawParams = params?.params;
    const decoded = typeof rawParams === 'string' ? JSON.parse(rawParams) : [];
    const id = decoded?.[0];

    if (id === 1 || id === '1' || id === FIXTURE_BLOCK_1.hash) {
      return {
        ...FIXTURE_BLOCK_1,
        confirmations: 1,
        size: 0,
        version: 4,
        merkleroot: '0'.repeat(64),
        nonce: '0',
        previousblockhash: '0'.repeat(64),
      };
    }

    throw new Error('Block not found');
  }

  if (method === 'getrawtransaction') {
    const rawParams = params?.params;
    const decoded = typeof rawParams === 'string' ? JSON.parse(rawParams) : [];
    const txid = decoded?.[0];
    if (typeof txid === 'string' && txid === FIXTURE_BLOCK_1.deltas[0].txid) {
      const tx: FixtureTx = {
        txid,
        version: 1,
        locktime: 0,
        vin: [],
        vout: [],
        blockhash: FIXTURE_BLOCK_1.hash,
        height: FIXTURE_BLOCK_1.height,
        time: FIXTURE_BLOCK_1.time,
      };
      return {
        ...tx,
        confirmations: 1,
        blocktime: FIXTURE_BLOCK_1.time,
        size: 0,
        vsize: 0,
        hex: '00',
      };
    }
    throw new Error('No such mempool or blockchain transaction');
  }

  if (method === 'getaddressbalance') {
    return { balance: '0', received: '0', cumulusCount: 0, nimbusCount: 0, stratusCount: 0 };
  }

  if (method === 'getaddressutxos') {
    return [];
  }

  if (method === 'getaddresstxids') {
    return [];
  }

  if (method === 'getinfo') {
    return {
      version: 1,
      protocolversion: 170013,
      blocks: FIXTURE_BLOCK_1.height,
      headers: FIXTURE_BLOCK_1.height,
    };
  }

  if (method === 'getnetworkinfo') {
    return { connections: 8 };
  }

  throw new Error(`No fixture for method ${method}`);
}

type BlockDeltasResponse = {
  hash: string;
  confirmations?: number;
  size: number;
  height: number;
  version: number;
  merkleroot: string;
  deltas: BlockDeltaTx[];
  time: number;
  nonce?: string;
  bits: string;
  difficulty: number | string;
  chainwork: string;
  previousblockhash?: string;
  nextblockhash?: string;
};

function amountToFluxNumber(satoshis: bigint): number {
  const sign = satoshis < 0n ? -1 : 1;
  const abs = satoshis < 0n ? -satoshis : satoshis;
  const whole = abs / 100000000n;
  const frac = abs % 100000000n;
  const value = Number(whole) + Number(frac) / 1e8;
  return sign < 0 ? -value : value;
}

export async function getBlockByHash(env: Env, hash: string): Promise<FluxIndexerBlockResponse> {
  const deltasResp = await fluxdGet<BlockDeltasResponse>(env, 'getblockdeltas', { params: JSON.stringify([hash]) });

  const txs = Array.isArray(deltasResp.deltas) ? deltasResp.deltas : [];

  type BlockTxDetail = {
    txid: string;
    order: number;
    kind: 'coinbase' | 'transfer' | 'fluxnode_start' | 'fluxnode_confirm' | 'fluxnode_other';
    isCoinbase: boolean;
    fluxnodeType: number | null;
    fluxnodeTier: string | null;
    fluxnodeIp: string | null;
    valueSat: number;
    value: number;
    valueInSat: number;
    valueIn: number;
    feeSat: number;
    fee: number;
    fromAddr: string | null;
    toAddr: string | null;
  };

  const fluxnodeByTxid = new Map<string, { nType: number | null; ip: string | null; tier: string | null }>();
  {
    const ids = txs.map((tx) => toString(tx?.txid)).filter((id) => id.length === 64);
    const needsLookup = ids.filter((txid) => {
      const fluxnodeType = typeof txs.find((t) => t.txid === txid)?.nType === 'number'
        ? (txs.find((t) => t.txid === txid)?.nType as number)
        : null;
      const inputs = Array.isArray(txs.find((t) => t.txid === txid)?.inputs) ? (txs.find((t) => t.txid === txid)?.inputs as unknown[]) : [];
      return inputs.length === 0 && fluxnodeType == null;
    });

    const maxLookups = 30;
    const suspect = needsLookup.slice(0, maxLookups);

    const concurrency = 6;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, suspect.length) }, async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= suspect.length) return;
        const txid = suspect[idx];
        try {
          const tx = await fluxdGet<any>(env, 'getrawtransaction', { params: JSON.stringify([txid, 1]) });
          const nType = typeof tx?.nType === 'number' ? tx.nType : null;
          const ip = typeof tx?.ip === 'string' && tx.ip.length > 0 ? tx.ip : null;
          const tier = typeof tx?.benchmarkTier === 'string' && tx.benchmarkTier.length > 0 ? tx.benchmarkTier : null;
          if (nType != null) {
            fluxnodeByTxid.set(txid, { nType, ip, tier });
          }
        } catch {
        }
      }
    });
    await Promise.all(workers);
  }

  const txDetails: BlockTxDetail[] = txs.map((tx, order) => {
    const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
    const outputs = Array.isArray(tx.outputs) ? tx.outputs : [];

    const fallback = fluxnodeByTxid.get(toString(tx.txid));

    const fluxnodeType = typeof tx.nType === 'number' ? tx.nType : fallback?.nType ?? null;
    const fluxnodeIp = typeof tx.ip === 'string' && tx.ip.length > 0 ? tx.ip : fallback?.ip ?? null;
    const fluxnodeTier = typeof tx.benchmarkTier === 'string' && tx.benchmarkTier.length > 0 ? tx.benchmarkTier : fallback?.tier ?? null;

    const isCoinbase = inputs.length === 0 && fluxnodeType == null;

    const vinSat = inputs.reduce((acc: bigint, row) => {
      const sat = toNumber(row?.satoshis, 0);
      return acc + BigInt(Math.max(0, Math.trunc(-sat)));
    }, 0n);

    const voutSat = outputs.reduce((acc: bigint, row) => {
      const sat = toNumber(row?.satoshis, 0);
      return acc + BigInt(Math.max(0, Math.trunc(sat)));
    }, 0n);

    const feeSat = !isCoinbase && vinSat > voutSat ? (vinSat - voutSat) : 0n;

    const fromAddr = inputs.find((i) => typeof i?.address === 'string' && i.address.length > 0)?.address ?? null;
    const toAddr = outputs.find((o) => typeof o?.address === 'string' && o.address.length > 0)?.address ?? null;

    const kind = fluxnodeType === 2 ? 'fluxnode_start' : fluxnodeType === 4 ? 'fluxnode_confirm' : isCoinbase ? 'coinbase' : 'transfer';

    return {
      txid: toString(tx.txid),
      order,
      kind,
      isCoinbase,
      fluxnodeType,
      fluxnodeIp,
      fluxnodeTier,
      valueSat: Number(voutSat),
      value: amountToFluxNumber(voutSat),
      valueInSat: Number(vinSat),
      valueIn: amountToFluxNumber(vinSat),
      feeSat: Number(feeSat),
      fee: amountToFluxNumber(feeSat),
      fromAddr,
      toAddr,
    };
  });

  const coinbaseCount = txDetails.filter((d) => d.kind === 'coinbase').length;
  const transfers = txDetails.filter((d) => d.kind === 'transfer').length;
  const fluxnodeStart = txDetails.filter((d) => d.kind === 'fluxnode_start').length;
  const fluxnodeConfirm = txDetails.filter((d) => d.kind === 'fluxnode_confirm').length;
  const fluxnodeOther = txDetails.filter((d) => d.kind === 'fluxnode_other').length;

  const tierCounts = { cumulus: 0, nimbus: 0, stratus: 0, starting: 0, unknown: 0 };
  for (const tx of txDetails) {
    if (tx.kind === 'fluxnode_start') {
      tierCounts.starting += 1;
      continue;
    }
    if (tx.kind === 'fluxnode_confirm') {
      const tier = (tx.fluxnodeTier ?? '').toString().toUpperCase();
      if (tier === 'CUMULUS') tierCounts.cumulus += 1;
      else if (tier === 'NIMBUS') tierCounts.nimbus += 1;
      else if (tier === 'STRATUS') tierCounts.stratus += 1;
      else tierCounts.unknown += 1;
    }
  }

  const txSummary = {
    total: txDetails.length,
    regular: transfers + coinbaseCount,
    coinbase: coinbaseCount,
    transfers,
    fluxnodeStart,
    fluxnodeConfirm,
    fluxnodeOther,
    fluxnodeTotal: fluxnodeStart + fluxnodeConfirm + fluxnodeOther,
    tierCounts,
  };

  const rewardSat = txDetails.find((d) => d.kind === 'coinbase')?.valueSat ?? 0;

  return {
    hash: toString(deltasResp.hash, hash),
    height: toNumber(deltasResp.height, 0),
    size: toNumber(deltasResp.size, 0),
    version: toNumber(deltasResp.version, 0),
    merkleRoot: toString(deltasResp.merkleroot),
    time: toNumber(deltasResp.time, 0),
    nonce: toString(deltasResp.nonce),
    bits: toString(deltasResp.bits),
    difficulty: toString(deltasResp.difficulty),
    chainWork: toString(deltasResp.chainwork),
    confirmations: toNumber(deltasResp.confirmations, 0),
    previousBlockHash: toString(deltasResp.previousblockhash),
    nextBlockHash: toString(deltasResp.nextblockhash),
    reward: toSatoshiString(rewardSat),
    txCount: txDetails.length,
    txs: txDetails.map((d) => ({ txid: d.txid })),
    txDetails,
    txSummary,
  };
}

export async function getBlockByHeight(env: Env, height: number): Promise<FluxIndexerBlockResponse> {
  const hash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([height]) });
  return getBlockByHash(env, hash);
}

export async function getLatestBlocks(
  env: Env,
  limit: number,
  tipHeightHint?: number
): Promise<{
  blocks: Array<{
    height: number;
    hash: string;
    time?: number;
    size?: number;
    txCount?: number;
    regularTxCount?: number;
    nodeConfirmationCount?: number;
    tierCounts?: { cumulus: number; nimbus: number; stratus: number; starting: number; unknown: number };
  }>;
}> {
  const tipHeight = tipHeightHint ?? await fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) });

  const capped = Math.max(1, Math.min(Math.floor(limit), 50));
  const heights = [] as number[];
  for (let h = tipHeight; h >= 0 && heights.length < capped; h--) {
    heights.push(h);
  }

  const blocks = await Promise.all(
    heights.map(async (h) => {
      const verbose = 1;
      const block = await fluxdGet<any>(env, 'getblock', { params: JSON.stringify([h, verbose]) });
      const txs = Array.isArray(block?.tx) ? block.tx : [];
      const txCount = txs.length;
      const nodeConfirmationCount = toNumber(block?.nodeConfirmationCount ?? block?.node_confirmation_count, 0);
      const regularTxCount = toNumber(
        block?.regularTxCount ?? block?.regular_tx_count,
        Math.max(0, txCount - nodeConfirmationCount)
      );
      const tierCountsSource = block?.tierCounts ?? block?.tier_counts;
      const tierCounts =
        tierCountsSource && typeof tierCountsSource === 'object'
          ? {
              cumulus: toNumber((tierCountsSource as any).cumulus, 0),
              nimbus: toNumber((tierCountsSource as any).nimbus, 0),
              stratus: toNumber((tierCountsSource as any).stratus, 0),
              starting: toNumber((tierCountsSource as any).starting, 0),
              unknown: toNumber((tierCountsSource as any).unknown, 0),
            }
          : undefined;
      return {
        height: toNumber(block?.height, h),
        hash: toString(block?.hash),
        time: toNumber(block?.time),
        size: toNumber(block?.size, 0),
        txCount,
        regularTxCount,
        nodeConfirmationCount,
        tierCounts,
      };
    })
  );

  return { blocks };
}

export async function getBlocksRange(env: Env, from: number, to: number): Promise<{ blocks: Array<Record<string, unknown>> }> {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const range = end - start;
  if (range > 10000) {
    throw new Error('range too large');
  }

  const blocks = await Promise.all(
    Array.from({ length: range + 1 }, (_, idx) => start + idx).map(async (height) => {
      const hash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([height]) });
      const header = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([hash]) });
      return {
        height: toNumber(header.height, height),
        hash: toString(header.hash, hash),
        time: toNumber(header.time),
        difficulty: toString(header.difficulty),
        bits: toString(header.bits),
        chainwork: toString(header.chainwork),
        prev_hash: toString(header.previousblockhash),
        version: toNumber(header.version),
      };
    })
  );

  return { blocks };
}

export async function getTransaction(env: Env, txid: string, includeHex: boolean): Promise<FluxIndexerTransactionResponse> {
  const verbose = 1;
  const tx = await fluxdGet<any>(env, 'getrawtransaction', { params: JSON.stringify([txid, verbose]) });

  const rawVin = Array.isArray(tx.vin) ? tx.vin : [];
  const rawVout = Array.isArray(tx.vout) ? tx.vout : [];

  let vin = rawVin.map((input: any) => {
    if (input?.coinbase != null) return input;

    const sat = amountToSatoshiBigInt(input?.valueSat ?? input?.value ?? 0);
    return {
      ...input,
      value: sat.toString(),
      valueSat: Number(sat),
    };
  });

  const vout = rawVout.map((output: any) => {
    const sat = amountToSatoshiBigInt(output?.valueSat ?? output?.value ?? 0);
    return {
      ...output,
      value: sat.toString(),
      valueSat: Number(sat),
    };
  });

  if (typeof tx.blockhash === 'string' && tx.blockhash.length === 64) {
    try {
      const deltasResp = await fluxdGet<BlockDeltasResponse>(env, 'getblockdeltas', { params: JSON.stringify([tx.blockhash]) }, 10_000);
      const txDeltas = Array.isArray(deltasResp?.deltas) ? deltasResp.deltas : [];
      const deltaTx = txDeltas.find((d) => d?.txid === txid);
      const deltaInputs = Array.isArray(deltaTx?.inputs) ? deltaTx?.inputs : [];

      if (deltaInputs.length > 0) {
        vin = vin.map((input: any, idx: number) => {
          if (input?.coinbase != null) return input;
          const deltaSat = toNumber(deltaInputs[idx]?.satoshis, 0);
          const sat = BigInt(Math.max(0, Math.trunc(-deltaSat)));
          return {
            ...input,
            value: sat.toString(),
            valueSat: Number(sat),
          };
        });
      }
    } catch {
    }
  }

  const vinSat = vin.reduce((acc: bigint, input: any) => acc + toSatoshiBigInt(input?.value ?? 0), 0n);
  const voutSat = vout.reduce((acc: bigint, output: any) => acc + toSatoshiBigInt(output?.value ?? 0), 0n);

  const isCoinbase = vin.length === 0;
  const feeSat = isCoinbase ? 0n : (vinSat > voutSat ? (vinSat - voutSat) : 0n);

  return {
    txid: toString(tx.txid, txid),
    version: toNumber(tx.version),
    lockTime: toNumber(tx.locktime),
    vin,
    vout,
    blockHash: toString(tx.blockhash),
    blockHeight: toNumber(tx.height),
    confirmations: toNumber(tx.confirmations),
    blockTime: toNumber(tx.blocktime),
    time: toNumber(tx.time),
    size: toNumber(tx.size),
    vsize: toNumber(tx.vsize ?? tx.size),
    value: toSatoshiString(voutSat),
    valueIn: toSatoshiString(vinSat),
    fees: toSatoshiString(feeSat),
    nType: toOptionalNumber(tx.nType),
    benchmarkTier: typeof tx.benchmarkTier === 'string' ? tx.benchmarkTier : null,
    ip: typeof tx.ip === 'string' ? tx.ip : null,
    collateralOutputHash: typeof tx.collateralOutputHash === 'string' ? tx.collateralOutputHash : null,
    collateralOutputIndex: toOptionalNumber(tx.collateralOutputIndex),
    hex: includeHex ? toString(tx.hex) : undefined,
  };
}

export async function getAddressSummary(env: Env, address: string): Promise<{
  address: string;
  balance: string;
  totalReceived: string;
  totalSent: string;
  unconfirmedBalance: string;
  unconfirmedTxs: number;
  txs: number;
  transactions: Array<{ txid: string }>;
  cumulusCount?: number;
  nimbusCount?: number;
  stratusCount?: number;
}> {
  const bestHeight = await getTipHeightCached(env);
  const previewWindowBlocks = 2_000;
  const previewRange = { start: Math.max(1, bestHeight - previewWindowBlocks), end: bestHeight };

  const [addressBalance, txCount, txids, mempoolDeltas] = await Promise.all([
    fluxdGet<any>(env, 'getaddressbalance', { params: JSON.stringify([{ addresses: [address] }]) }),
    fluxdGet<number>(env, 'getaddresstxidscount', { params: JSON.stringify([{ addresses: [address] }]) }),
    fluxdGet<string[]>(env, 'getaddresstxids', { params: JSON.stringify([{ addresses: [address], ...previewRange }]) }),
    fluxdGet<any[]>(env, 'getaddressmempool', { params: JSON.stringify([{ addresses: [address] }]) }),
  ]);

  const satBalance = toSatoshiBigInt(addressBalance.balance);
  const satReceived = toSatoshiBigInt(addressBalance.received);
  const satSent = satReceived > satBalance ? (satReceived - satBalance) : 0n;

  const deltas = Array.isArray(mempoolDeltas) ? mempoolDeltas : [];
  const unconfirmedBalance = deltas.reduce((acc: bigint, row: any) => acc + toSatoshiBigInt(row?.satoshis), 0n);
  const unconfirmedTxs = new Set(deltas.map((row: any) => toString(row?.txid)).filter((id) => id.length > 0)).size;

  return {
    address,
    balance: satBalance.toString(),
    totalReceived: satReceived.toString(),
    totalSent: satSent.toString(),
    unconfirmedBalance: unconfirmedBalance.toString(),
    unconfirmedTxs,
    txs: typeof txCount === 'number' && Number.isFinite(txCount) ? Math.max(0, Math.trunc(txCount)) : (Array.isArray(txids) ? txids.length : 0),
    transactions: Array.isArray(txids) ? txids.slice(-25).reverse().map((id) => ({ txid: toString(id) })) : [],
    cumulusCount: addressBalance?.cumulusCount != null ? toNumber(addressBalance.cumulusCount, 0) : undefined,
    nimbusCount: addressBalance?.nimbusCount != null ? toNumber(addressBalance.nimbusCount, 0) : undefined,
    stratusCount: addressBalance?.stratusCount != null ? toNumber(addressBalance.stratusCount, 0) : undefined,
  };
}

export interface FluxAddressTransactionsCursor {
  height: number;
  txIndex: number;
  txid: string;
}

export interface FluxIndexerAddressTransactionsResponse {
  address: string;
  transactions: Array<{
    txid: string;
    blockHeight: number;
    timestamp: number;
    blockHash?: string;
    direction?: string;
    value?: string;
    receivedValue?: string;
    sentValue?: string;
    fromAddresses?: string[];
    fromAddressCount?: number;
    toAddresses?: string[];
    toAddressCount?: number;
    selfTransfer?: boolean;
    feeValue?: string;
    changeValue?: string;
    toOthersValue?: string;
    confirmations?: number;
    isCoinbase?: boolean;
  }>;
  total: number;
  filteredTotal?: number;
  limit: number;
  offset?: number;
  nextCursor?: FluxAddressTransactionsCursor;
}

type AddressDeltaRow = {
  address: string;
  height: number;
  txIndex: number;
  txid: string;
  satoshis: number;
};

type GroupedAddressTx = {
  txid: string;
  height: number;
  txIndex: number;
  net: bigint;
  received: bigint;
  sent: bigint;
};

type AddressTxIoSummary = {
  fromAddresses: string[];
  fromAddressCount: number;
  toAddresses: string[];
  toAddressCount: number;
  feeSat: bigint;
  changeSat: bigint;
  toOthersSat: bigint;
  isCoinbase: boolean;
};

type CachedBlockHeader = { atMs: number; hash: string; timestamp: number };

const BLOCK_HEADER_CACHE_TTL_MS = 15 * 60_000;
const blockHeaderCacheByHeight = new Map<number, CachedBlockHeader>();
const blockHeaderInFlight = new Map<number, Promise<{ hash: string; timestamp: number }>>();
let lastBlockHeaderCacheSweepMs = 0;

function sweepBlockHeaderCache(nowMs: number): void {
  if (nowMs - lastBlockHeaderCacheSweepMs < 60_000) return;
  lastBlockHeaderCacheSweepMs = nowMs;

  for (const [height, entry] of blockHeaderCacheByHeight) {
    if (nowMs - entry.atMs > BLOCK_HEADER_CACHE_TTL_MS) {
      blockHeaderCacheByHeight.delete(height);
    }
  }
}

async function getBlockHeaderByHeightCached(env: Env, height: number): Promise<{ hash: string; timestamp: number }> {
  const nowMs = Date.now();
  sweepBlockHeaderCache(nowMs);

  const cached = blockHeaderCacheByHeight.get(height);
  if (cached && nowMs - cached.atMs <= BLOCK_HEADER_CACHE_TTL_MS) {
    return { hash: cached.hash, timestamp: cached.timestamp };
  }

  const inFlight = blockHeaderInFlight.get(height);
  if (inFlight) {
    return inFlight;
  }

  const request = (async (): Promise<{ hash: string; timestamp: number }> => {
    try {
      const hash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([height]) });
      const header = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([hash]) });

      const entry: CachedBlockHeader = { atMs: Date.now(), hash, timestamp: toNumber(header.time, 0) };
      blockHeaderCacheByHeight.set(height, entry);

      return { hash: entry.hash, timestamp: entry.timestamp };
    } finally {
      blockHeaderInFlight.delete(height);
    }
  })();

  blockHeaderInFlight.set(height, request);
  return request;
}

type CachedGroupedAddressTxs = { atMs: number; groupedTxs: GroupedAddressTx[] };

type CachedAddressTxCount = { atMs: number; count: number };

const ADDRESS_TX_COUNT_CACHE_TTL_MS = 60_000;
const addressTxCountCache = new Map<string, CachedAddressTxCount>();
const addressTxCountInFlight = new Map<string, Promise<number>>();
let lastAddressTxCountSweepMs = 0;

function sweepAddressTxCountCache(nowMs: number): void {
  if (nowMs - lastAddressTxCountSweepMs < 60_000) return;
  lastAddressTxCountSweepMs = nowMs;

  for (const [key, entry] of addressTxCountCache) {
    if (nowMs - entry.atMs > ADDRESS_TX_COUNT_CACHE_TTL_MS) {
      addressTxCountCache.delete(key);
    }
  }
}

async function getAddressTxCountCached(env: Env, address: string, range?: { start: number; end: number }): Promise<number> {
  const nowMs = Date.now();
  sweepAddressTxCountCache(nowMs);

  const key = `${address}:${range?.start ?? 0}:${range?.end ?? 0}`;
  const cached = addressTxCountCache.get(key);
  if (cached && nowMs - cached.atMs <= ADDRESS_TX_COUNT_CACHE_TTL_MS) {
    return cached.count;
  }

  const inFlight = addressTxCountInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const request = (async (): Promise<number> => {
    try {
      const count = await fluxdGet<number>(env, 'getaddresstxidscount', {
        params: JSON.stringify([{ addresses: [address], ...(range ?? {}) }]),
      });

      const normalized = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
      addressTxCountCache.set(key, { atMs: Date.now(), count: normalized });
      return normalized;
    } finally {
      addressTxCountInFlight.delete(key);
    }
  })();

  addressTxCountInFlight.set(key, request);
  return request;
}

const GROUPED_ADDRESS_TXS_CACHE_TTL_MS = 30_000;
const groupedAddressTxsCache = new Map<string, CachedGroupedAddressTxs>();
const groupedAddressTxsInFlight = new Map<string, Promise<GroupedAddressTx[]>>();
let lastGroupedAddressTxsSweepMs = 0;

function sweepGroupedAddressTxsCache(nowMs: number): void {
  if (nowMs - lastGroupedAddressTxsSweepMs < 60_000) return;
  lastGroupedAddressTxsSweepMs = nowMs;

  for (const [key, entry] of groupedAddressTxsCache) {
    if (nowMs - entry.atMs > GROUPED_ADDRESS_TXS_CACHE_TTL_MS) {
      groupedAddressTxsCache.delete(key);
    }
  }
}

function groupedAddressTxsCacheKey(address: string, range?: { start: number; end: number }): string {
  const start = range?.start ?? 0;
  const end = range?.end ?? 0;
  return `${address}:${start}:${end}`;
}

export async function getAddressTransactions(
  env: Env,
  address: string,
  params: {
    limit: number;
    offset?: number;
    cursorHeight?: number;
    cursorTxIndex?: number;
    cursorTxid?: string;
    fromBlock?: number;
    toBlock?: number;
    fromTimestamp?: number;
    toTimestamp?: number;
    excludeCoinbase?: boolean;
  }
): Promise<FluxIndexerAddressTransactionsResponse> {
  const rangeStart = params.fromBlock ?? 0;
  const rangeEnd = params.toBlock ?? 0;

  const explicitRange = rangeStart > 0 && rangeEnd > 0 ? { start: rangeStart, end: rangeEnd } : undefined;
  const tipHeight = explicitRange?.end ?? (await getTipHeightCached(env));
  const rangeObj = explicitRange ?? { start: 1, end: tipHeight };

  const fromTs = params.fromTimestamp;
  const toTs = params.toTimestamp;
  const excludeCoinbase = params.excludeCoinbase === true;

  const limit = Math.max(1, Math.min(params.limit, 250));
  const scanLimit = limit * 50;

  const nowMs = Date.now();
  sweepGroupedAddressTxsCache(nowMs);

  async function getGroupedTxWindow(start: number, end: number): Promise<GroupedAddressTx[]> {
    const groupedCacheKey = groupedAddressTxsCacheKey(address, { start, end });

    const cachedGrouped = groupedAddressTxsCache.get(groupedCacheKey);
    if (cachedGrouped && nowMs - cachedGrouped.atMs <= GROUPED_ADDRESS_TXS_CACHE_TTL_MS) {
      return cachedGrouped.groupedTxs;
    }

    const inFlight = groupedAddressTxsInFlight.get(groupedCacheKey);
    if (inFlight) {
      return inFlight;
    }

    const request = (async (): Promise<GroupedAddressTx[]> => {
      try {
        const deltasResp = await fluxdGetWithOptions<any>(
          env,
          'getaddressdeltas',
          { params: JSON.stringify([{ addresses: [address], start, end }]) },
          { chainInfo: false }
        );

        const deltas = Array.isArray(deltasResp) ? deltasResp : deltasResp?.deltas;
        const rowsRaw = Array.isArray(deltas) ? deltas : [];

        const grouped = new Map<string, GroupedAddressTx>();
        for (const row of rowsRaw) {
          const height = toNumber(row?.height, 0);
          const txIndex = toNumber(row?.blockindex ?? row?.tx_index ?? row?.txIndex, 0);
          const txid = toString(row?.txid);
          const satoshis = toNumber(row?.satoshis, 0);

          const key = `${height}:${txIndex}:${txid}`;
          const sat = BigInt(Math.trunc(satoshis));
          const existing = grouped.get(key);
          if (existing) {
            existing.net += sat;
            if (sat > 0n) existing.received += sat;
            if (sat < 0n) existing.sent += -sat;
            continue;
          }
          grouped.set(key, {
            txid,
            height,
            txIndex,
            net: sat,
            received: sat > 0n ? sat : 0n,
            sent: sat < 0n ? -sat : 0n,
          });
        }

        const result = Array.from(grouped.values()).sort((a, b) => {
          const heightCmp = b.height - a.height;
          if (heightCmp !== 0) return heightCmp;

          const indexCmp = b.txIndex - a.txIndex;
          if (indexCmp !== 0) return indexCmp;

          return b.txid.localeCompare(a.txid);
        });

        groupedAddressTxsCache.set(groupedCacheKey, { atMs: Date.now(), groupedTxs: result });
        return result;
      } finally {
        groupedAddressTxsInFlight.delete(groupedCacheKey);
      }
    })();

    groupedAddressTxsInFlight.set(groupedCacheKey, request);
    return request;
  }

  const page: Array<{ tx: GroupedAddressTx; blockHash: string; timestamp: number }> = [];

  let nextCursor: { height: number; txIndex: number; txid: string } | undefined;

  const cursor =
    params.cursorHeight != null && params.cursorTxIndex != null && params.cursorTxid
      ? { height: params.cursorHeight, txIndex: params.cursorTxIndex, txid: params.cursorTxid }
      : null;

  if (!cursor && params.offset != null && params.offset > 50_000) {
    try {
      const cursorResp = await fluxdGet<any>(env, 'getaddresspagecursor', {
        params: JSON.stringify([
          {
            addresses: [address],
            offset: params.offset,
            limit,
          },
        ]),
      });

      if (
        cursorResp &&
        typeof cursorResp.cursorHeight === 'number' &&
        typeof cursorResp.cursorTxIndex === 'number' &&
        typeof cursorResp.cursorTxid === 'string'
      ) {
        return getAddressTransactions(env, address, {
          ...params,
          offset: undefined,
          cursorHeight: cursorResp.cursorHeight,
          cursorTxIndex: cursorResp.cursorTxIndex,
          cursorTxid: cursorResp.cursorTxid,
        });
      }
    } catch {
    }
  }

  if (cursor) {
    const windowBlocks = 5_000;
    let windowEnd = Math.min(rangeObj.end, cursor.height);
    let didSeek = false;

    while (page.length < limit && windowEnd >= rangeObj.start) {
      const windowStart = Math.max(rangeObj.start, windowEnd - windowBlocks + 1);
      const groupedTxs = await getGroupedTxWindow(windowStart, windowEnd);

      let startIndex = 0;
      if (!didSeek) {
        const idx = groupedTxs.findIndex((tx) => tx.height === cursor.height && tx.txIndex === cursor.txIndex && tx.txid === cursor.txid);
        if (idx < 0) {
          windowEnd = windowStart - 1;
          continue;
        }
        startIndex = idx + 1;
        didSeek = true;
      }

      let scanIndex = startIndex;
      let scanned = 0;
      while (page.length < limit && scanIndex < groupedTxs.length && scanned < scanLimit) {
        const tx = groupedTxs[scanIndex];
        scanIndex += 1;
        if (excludeCoinbase && tx.txIndex === 0) {
          continue;
        }
        scanned += 1;

        const header = await getBlockHeaderByHeightCached(env, tx.height);
        if (fromTs != null && header.timestamp < fromTs) continue;
        if (toTs != null && header.timestamp > toTs) continue;

        page.push({ tx, blockHash: header.hash, timestamp: header.timestamp });
      }

      windowEnd = windowStart - 1;
    }
  } else {
    const windowBlocks = 20_000;
    let windowEnd = rangeObj.end;
    let remainingSkip = Math.max(0, params.offset ?? 0);

    while (page.length < limit && windowEnd >= rangeObj.start) {
      const windowStart = Math.max(rangeObj.start, windowEnd - windowBlocks + 1);
      const groupedTxs = await getGroupedTxWindow(windowStart, windowEnd);

      let scanIndex = 0;
      let scanned = 0;
      while (page.length < limit && scanIndex < groupedTxs.length && scanned < scanLimit) {
        const tx = groupedTxs[scanIndex];
        scanIndex += 1;
        if (excludeCoinbase && tx.txIndex === 0) {
          continue;
        }

        if (remainingSkip > 0 && fromTs == null && toTs == null) {
          remainingSkip -= 1;
          continue;
        }

        scanned += 1;
        const header = await getBlockHeaderByHeightCached(env, tx.height);
        if (fromTs != null && header.timestamp < fromTs) continue;
        if (toTs != null && header.timestamp > toTs) continue;

        if (remainingSkip > 0) {
          remainingSkip -= 1;
          continue;
        }

        page.push({ tx, blockHash: header.hash, timestamp: header.timestamp });
      }

      windowEnd = windowStart - 1;
    }
  }

  const last = page.length > 0 ? page[page.length - 1].tx : null;
  if (last) {
    nextCursor = { height: last.height, txIndex: last.txIndex, txid: last.txid };
  }

  let total = 0;
  try {
    total = await getAddressTxCountCached(env, address, rangeObj);
  } catch {
    total = 0;
  }

  const filteredTotal = total;

  const minTotal = (params.offset ?? 0) + page.length;
  if (total < minTotal) {
    total = minTotal;
  }

  const pageTxById = new Map<string, GroupedAddressTx>();
  for (const row of page) {
    pageTxById.set(row.tx.txid, row.tx);
  }

  const txIoByTxid = new Map<string, AddressTxIoSummary>();
  const pageTxids = new Set(page.map((row) => row.tx.txid));

  const hashesNeeded = Array.from(new Set(page.map((row) => row.blockHash).filter((h) => typeof h === 'string' && h.length === 64)));
  const txidsByBlockHash = new Map<string, string[]>();
  for (const row of page) {
    const hash = row.blockHash;
    if (typeof hash !== 'string' || hash.length !== 64) continue;
    const list = txidsByBlockHash.get(hash);
    if (list) {
      list.push(row.tx.txid);
    } else {
      txidsByBlockHash.set(hash, [row.tx.txid]);
    }
  }

  const maxConcurrency = 4;
  let hashCursor = 0;

  const workers = Array.from({ length: Math.min(maxConcurrency, hashesNeeded.length) }, async () => {
    while (true) {
      const idx = hashCursor;
      hashCursor += 1;
      if (idx >= hashesNeeded.length) return;

      const hash = hashesNeeded[idx];
      const txidsForBlock = txidsByBlockHash.get(hash) ?? [];
      let deltasResp: BlockDeltasResponse;
      try {
        deltasResp = await fluxdGet<BlockDeltasResponse>(env, 'getblockdeltas', {
          params: JSON.stringify([{ hash, txids: txidsForBlock }]),
        });
      } catch {
        continue;
      }

      const txDeltas = Array.isArray(deltasResp?.deltas) ? deltasResp.deltas : [];

      for (const entry of txDeltas) {
        const txid = typeof entry?.txid === 'string' ? entry.txid : null;
        if (!txid || !pageTxids.has(txid)) continue;

        const inputRows = Array.isArray(entry?.inputs) ? entry.inputs : [];
        const outputRows = Array.isArray(entry?.outputs) ? entry.outputs : [];

        const fromSet = new Set<string>();
        let vinValue = 0n;

        for (const input of inputRows) {
          if (typeof input?.address === 'string' && input.address.length > 0) {
            fromSet.add(input.address);
          }
          const sat = toNumber(input?.satoshis, 0);
          vinValue += BigInt(Math.max(0, Math.trunc(-sat)));
        }

        const toSet = new Set<string>();
        let voutValue = 0n;
        let receivedToAddress = 0n;

        for (const output of outputRows) {
          if (typeof output?.address === 'string' && output.address.length > 0) {
            toSet.add(output.address);
          }
          const sat = toNumber(output?.satoshis, 0);
          const v = BigInt(Math.max(0, Math.trunc(sat)));
          voutValue += v;
          if (output.address === address) {
            receivedToAddress += v;
          }
        }

        const fluxnodeType = typeof entry?.nType === 'number' ? entry.nType : null;
        const isCoinbase = inputRows.length === 0 && fluxnodeType == null;

        const feeSat = isCoinbase ? 0n : (vinValue > voutValue ? (vinValue - voutValue) : 0n);

        const pageTx = pageTxById.get(txid);
        const sentFromAddress = pageTx?.sent ?? 0n;

        const changeSat = !isCoinbase && sentFromAddress > 0n ? receivedToAddress : 0n;
        const receivedMinusChange = receivedToAddress >= changeSat ? (receivedToAddress - changeSat) : 0n;
        const toOthersSat = !isCoinbase && sentFromAddress > receivedMinusChange
          ? (sentFromAddress - receivedMinusChange)
          : 0n;

        txIoByTxid.set(txid, {
          fromAddresses: Array.from(fromSet),
          fromAddressCount: fromSet.size,
          toAddresses: Array.from(toSet),
          toAddressCount: toSet.size,
          feeSat,
          changeSat,
          toOthersSat,
          isCoinbase,
        });
      }
    }
  });

  await Promise.all(workers);

  return {
    address,
    transactions: page.map((row) => {
      const io = txIoByTxid.get(row.tx.txid);

      const isCoinbase = io?.isCoinbase ?? false;
      const fromAddresses = io?.fromAddresses ?? [];
      const toAddresses = io?.toAddresses ?? [];

      return {
        txid: row.tx.txid,
        blockHeight: row.tx.height,
        timestamp: row.timestamp,
        blockHash: row.blockHash,
        direction: row.tx.net < 0n ? 'sent' : 'received',
        value: (row.tx.net < 0n ? (-row.tx.net) : row.tx.net).toString(),
        receivedValue: row.tx.received.toString(),
        sentValue: row.tx.sent.toString(),
        feeValue: (io?.feeSat ?? 0n).toString(),
        changeValue: (io?.changeSat ?? 0n).toString(),
        toOthersValue: (io?.toOthersSat ?? 0n).toString(),
        fromAddresses,
        fromAddressCount: io?.fromAddressCount ?? fromAddresses.length,
        toAddresses,
        toAddressCount: io?.toAddressCount ?? toAddresses.length,
        selfTransfer: row.tx.received > 0n && row.tx.sent > 0n,
        confirmations: confirmationsFromHeight(tipHeight, row.tx.height > 0 ? row.tx.height : null),
        isCoinbase,
      };
    }),
    total,
    filteredTotal,
    limit,
    offset: params.offset,
    nextCursor,
  };
}

export async function getAddressUtxos(env: Env, address: string): Promise<Array<{ txid: string; vout: number; value: string; height?: number; confirmations?: number }>> {
  const utxos = await fluxdGet<any[]>(env, 'getaddressutxos', { params: JSON.stringify([{ addresses: [address], chainInfo: false }]) });

  if (!Array.isArray(utxos)) return [];

  const tipHeight = await fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) });

  return utxos.map((u) => {
    const height = toOptionalNumber(u.height);
    const satoshis = toNumber(u.satoshis, 0);
    const confirmations = confirmationsFromHeight(tipHeight, height);
    return {
      txid: toString(u.txid),
      vout: toNumber(u.outputIndex),
      value: toSatoshiString(satoshis),
      height: height ?? 0,
      confirmations,
    };
  });
}

export async function getSupplyStats(env: Env): Promise<{
  blockHeight: number;
  transparentSupply: string;
  shieldedPool: string;
  circulatingSupply: string;
  totalSupply: string;
  lastUpdate: string;
  timestamp: string;
}> {
  const chainInfo = await fluxdGet<any>(env, 'getblockchaininfo', { params: JSON.stringify([]) });
  const now = new Date().toISOString();

  const totalSupplyZat = toSatoshiBigInt(chainInfo.total_supply_zat ?? 0);

  const pools = Array.isArray(chainInfo.valuePools) ? chainInfo.valuePools : [];
  const shieldedPoolZat = pools.reduce(
    (acc: bigint, pool: any) => acc + toSatoshiBigInt(pool?.chainValueZat ?? pool?.chainValue_zat ?? 0),
    0n
  );

  const transparentSupplyZat = totalSupplyZat > shieldedPoolZat ? (totalSupplyZat - shieldedPoolZat) : 0n;

  const blockHeight = toNumber(chainInfo.blocks, 0);
  const circulatingSupplyZat = calculateCirculatingSupplyZat(blockHeight, totalSupplyZat);

  return {
    blockHeight,
    transparentSupply: transparentSupplyZat.toString(),
    shieldedPool: shieldedPoolZat.toString(),
    circulatingSupply: circulatingSupplyZat.toString(),
    totalSupply: totalSupplyZat.toString(),
    lastUpdate: now,
    timestamp: now,
  };
}

function calculateMainchainSupplyZat(height: number): bigint {
  const PON_HEIGHT = 2_020_000;
  const FIRST_HALVING = 657_850;
  const HALVING_INTERVAL = 655_350;

  const FUND_RELEASES = [
    { height: 836_274, amount: 7_500_000 },
    { height: 836_994, amount: 2_500_000 },
    { height: 837_714, amount: 22_000_000 },
    { height: 859_314, amount: 22_000_000 },
    { height: 880_914, amount: 22_000_000 },
    { height: 902_514, amount: 22_000_000 },
    { height: 924_114, amount: 22_000_000 },
    { height: 945_714, amount: 22_000_000 },
    { height: 967_314, amount: 22_000_000 },
    { height: 988_914, amount: 22_000_000 },
    { height: 1_010_514, amount: 22_000_000 },
    { height: 1_032_114, amount: 22_000_000 },
  ];

  let subsidy = 150;
  const miningHeight = Math.min(height, PON_HEIGHT - 1);
  const halvings = Math.min(2, Math.floor((miningHeight - 2500) / HALVING_INTERVAL));

  let coins = (FIRST_HALVING - 5000) * 150 + 375_000 + 13_020_000;

  for (let i = 1; i <= halvings; i++) {
    subsidy = subsidy / 2;

    if (i === halvings) {
      const nBlocksMain = miningHeight - FIRST_HALVING - ((i - 1) * HALVING_INTERVAL);
      coins += nBlocksMain * subsidy;
    } else {
      coins += HALVING_INTERVAL * subsidy;
    }
  }

  for (const release of FUND_RELEASES) {
    if (height >= release.height) coins += release.amount;
  }

  if (height >= PON_HEIGHT) {
    coins += (height - PON_HEIGHT + 1) * 14;
  }

  return BigInt(Math.floor(coins * 100_000_000));
}

function calculateCirculatingSupplyAllChainsZat(height: number): bigint {
  const PON_HEIGHT = 2_020_000;
  const ASSET_MINING_START = 825_000;
  const FIRST_HALVING = 657_850;
  const HALVING_INTERVAL = 655_350;
  const EXCHANGE_FUND_HEIGHT = 835_554;
  const EXCHANGE_FUND_AMOUNT = 10_000_000;
  const CHAIN_FUND_AMOUNT = 1_000_000;
  const SNAPSHOT_AMOUNT = 12_313_785.94991485;

  const CHAINS = [
    { name: 'KDA', launchHeight: 825_000 },
    { name: 'BSC', launchHeight: 883_000 },
    { name: 'ETH', launchHeight: 883_000 },
    { name: 'SOL', launchHeight: 969_500 },
    { name: 'TRX', launchHeight: 969_500 },
    { name: 'AVAX', launchHeight: 1_170_000 },
    { name: 'ERGO', launchHeight: 1_210_000 },
    { name: 'ALGO', launchHeight: 1_330_000 },
    { name: 'MATIC', launchHeight: 1_414_000 },
    { name: 'BASE', launchHeight: 1_738_000 },
  ];

  let subsidy = 150;
  const miningHeight = Math.min(height, PON_HEIGHT - 1);
  const halvings = Math.min(2, Math.floor((miningHeight - 2500) / HALVING_INTERVAL));

  let coins = (FIRST_HALVING - 5000) * 150 + 375_000 + 13_020_000;

  if (height >= EXCHANGE_FUND_HEIGHT) {
    coins += EXCHANGE_FUND_AMOUNT;
  }

  for (const chain of CHAINS) {
    if (height > chain.launchHeight) {
      coins += CHAIN_FUND_AMOUNT + SNAPSHOT_AMOUNT;
    }
  }

  for (let i = 1; i <= halvings; i++) {
    subsidy = subsidy / 2;

    if (i === halvings) {
      const nBlocksMain = miningHeight - FIRST_HALVING - ((i - 1) * HALVING_INTERVAL);
      coins += nBlocksMain * subsidy;

      if (miningHeight > ASSET_MINING_START) {
        const activeChains = CHAINS.filter((chain) => miningHeight > chain.launchHeight).length;
        coins += nBlocksMain * subsidy * activeChains / 10;
      }
    } else {
      coins += HALVING_INTERVAL * subsidy;

      if (miningHeight > ASSET_MINING_START) {
        const nBlocksAsset = HALVING_INTERVAL - (ASSET_MINING_START - FIRST_HALVING);
        const activeChains = CHAINS.filter((chain) => miningHeight > chain.launchHeight).length;
        coins += nBlocksAsset * subsidy * activeChains / 10;
      }
    }
  }

  if (height >= PON_HEIGHT) {
    coins += (height - PON_HEIGHT + 1) * 14 * 2;
  }

  return BigInt(Math.floor(coins * 100_000_000));
}

function calculateCirculatingSupplyZat(blockHeight: number, totalSupplyZat: bigint): bigint {
  const theoreticalMainchain = calculateMainchainSupplyZat(blockHeight);
  const theoreticalAllChains = calculateCirculatingSupplyAllChainsZat(blockHeight);
  const lockedParallelAssets = theoreticalMainchain - theoreticalAllChains;

  const circulating = totalSupplyZat - lockedParallelAssets;
  return circulating < 0n ? 0n : circulating;
}

export interface FluxIndexerRichListResponse {
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
}

export async function getRichList(
  env: Env,
  page: number,
  pageSize: number,
  minBalance: number
): Promise<FluxIndexerRichListResponse> {
  const response = await fluxdGet<any>(env, 'getrichlist', { params: JSON.stringify([page, pageSize, minBalance]) });

  const addresses = Array.isArray(response.addresses) ? response.addresses : [];

  return {
    lastUpdate: toIsoTimestamp(response.lastUpdate, new Date().toISOString()),
    lastBlockHeight: toNumber(response.lastBlockHeight, 0),
    totalSupply: toSatoshiString(response.totalSupply ?? 0),
    totalAddresses: toNumber(response.totalAddresses, 0),
    page: toNumber(response.page, page),
    pageSize: toNumber(response.pageSize, pageSize),
    totalPages: toNumber(response.totalPages, 1),
    addresses: addresses.map((row: any) => ({
      rank: toNumber(row?.rank, 0),
      address: toString(row?.address),
      balance: toSatoshiString(row?.balance ?? 0),
      txCount: toNumber(row?.txCount, 0),
      cumulusCount: row?.cumulusCount != null ? toNumber(row.cumulusCount, 0) : undefined,
      nimbusCount: row?.nimbusCount != null ? toNumber(row.nimbusCount, 0) : undefined,
      stratusCount: row?.stratusCount != null ? toNumber(row.stratusCount, 0) : undefined,
    })),
  };
}

export interface FluxIndexerIndexStatsResponse {
  tipHeight: number;
  utxoCount: number;
  spentIndexCount: number;
  addressOutpointCount: number;
  generatedAt: string;
}

export async function getIndexStats(env: Env): Promise<FluxIndexerIndexStatsResponse> {
  const [tipHeight, utxoSet, indexStats] = await Promise.all([
    fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) }),
    fluxdGet<any>(env, 'gettxoutsetinfo', { params: JSON.stringify([]) }),
    fluxdGet<any>(env, 'getindexstats', { params: JSON.stringify([]) }),
  ]);

  return {
    tipHeight: toNumber(tipHeight, 0),
    utxoCount: toNumber(utxoSet?.txouts, 0),
    spentIndexCount: toNumber(indexStats?.spent_index_entries, 0),
    addressOutpointCount: toNumber(indexStats?.address_outpoint_entries, 0),
    generatedAt: new Date().toISOString(),
  };
}

type DashboardRewardOutput = { address: string | null; valueSat: number; value: number };

type DashboardLatestReward = {
  height: number;
  hash: string;
  timestamp: number;
  txid: string;
  totalRewardSat: number;
  totalReward: number;
  outputs: Array<DashboardRewardOutput>;
};

let cachedTxCount24h: { atMs: number; total: number; regular: number; fluxnode: number } | null = null;

export async function getDashboardStats(env: Env): Promise<{
  latestBlock: { height: number; hash: string | null; timestamp: number | null };
  averages: { blockTimeSeconds: number };
  transactions24h: number;
  transactions24hNormal: number;
  transactions24hFluxnode: number;
  latestRewards: Array<DashboardLatestReward>;
  generatedAt: string;
}> {
  const tipHeight = await fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) });
  const tipHash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([tipHeight]) });
  const tipHeader = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([tipHash]) });

  const nowIso = new Date().toISOString();
  const latestTimestamp = toNumber(tipHeader.time, 0);

  const tipUnix = latestTimestamp || Math.floor(Date.now() / 1000);
  const windowSeconds = 24 * 60 * 60;
  const high = tipUnix >= 0 && tipUnix < 0xffff_fffe ? tipUnix + 1 : tipUnix;
  const low = Math.max(0, high - windowSeconds);

  let txCount24h = cachedTxCount24h?.total ?? 0;
  let txCount24hNormal = cachedTxCount24h?.regular ?? 0;
  let txCount24hFluxnode = cachedTxCount24h?.fluxnode ?? 0;
  const txCountCacheAt = cachedTxCount24h?.atMs ?? 0;
  const txCountCacheTtlMs = 5 * 60_000;

  if (Date.now() - txCountCacheAt > txCountCacheTtlMs) {
    try {
      const stats = await fluxdGet<any>(
        env,
        'gettxstats',
        { params: JSON.stringify([high, low, { noOrphans: true }]) },
        60_000
      );

      txCount24h = toNumber(stats?.txCount, 0);
      txCount24hFluxnode = toNumber(stats?.fluxnodeTxCount, 0);
      txCount24hNormal = toNumber(stats?.regularTxCount, Math.max(0, txCount24h - txCount24hFluxnode));

      cachedTxCount24h = { atMs: Date.now(), total: txCount24h, regular: txCount24hNormal, fluxnode: txCount24hFluxnode };
    } catch {
      txCount24h = cachedTxCount24h?.total ?? 0;
      txCount24hNormal = cachedTxCount24h?.regular ?? 0;
      txCount24hFluxnode = cachedTxCount24h?.fluxnode ?? 0;
    }
  }

  let avgBlockTimeSeconds = 30;
  try {
    const sampleCount = 120;
    const startHeight = Math.max(0, tipHeight - (sampleCount - 1));

    if (latestTimestamp > 0 && tipHeight > startHeight) {
      const startHash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([startHeight]) });
      const startHeader = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([startHash]) });
      const startTime = toNumber(startHeader?.time, 0);

      if (startTime > 0) {
        const span = latestTimestamp - startTime;
        const denom = tipHeight - startHeight;
        if (span > 0 && denom > 0) {
          avgBlockTimeSeconds = span / denom;
        }
      }
    }
  } catch {
    avgBlockTimeSeconds = 30;
  }

  let latestRewards: Array<DashboardLatestReward> = [];

  try {
    const deltasResp = await fluxdGet<BlockDeltasResponse>(env, 'getblockdeltas', { params: JSON.stringify([tipHash]) });
    const coinbase = Array.isArray(deltasResp.deltas) ? deltasResp.deltas[0] : null;
    if (coinbase && Array.isArray(coinbase.outputs)) {
      const outputs = coinbase.outputs
        .filter((o) => typeof o?.satoshis === 'number' && Number.isFinite(o.satoshis) && o.satoshis > 0)
        .map((o) => {
          const sat = Math.trunc(o.satoshis ?? 0);
          return {
            address: typeof o?.address === 'string' && o.address.length > 0 ? o.address : null,
            valueSat: sat,
            value: amountToFluxNumber(BigInt(sat)),
          };
        });

      const totalRewardSat = outputs.reduce((acc, o) => acc + o.valueSat, 0);

      latestRewards = [
        {
          height: toNumber(deltasResp.height, tipHeight),
          hash: toString(deltasResp.hash, tipHash),
          timestamp: toNumber(deltasResp.time, latestTimestamp),
          txid: toString(coinbase.txid),
          totalRewardSat,
          totalReward: amountToFluxNumber(BigInt(totalRewardSat)),
          outputs,
        },
      ];
    }
  } catch {
    latestRewards = [];
  }

  return {
    latestBlock: {
      height: toNumber(tipHeader.height, tipHeight),
      hash: toString(tipHeader.hash, tipHash) || null,
      timestamp: latestTimestamp || null,
    },
    averages: {
      blockTimeSeconds: avgBlockTimeSeconds,
    },
    transactions24h: txCount24h,
    transactions24hNormal: txCount24hNormal,
    transactions24hFluxnode: txCount24hFluxnode,
    latestRewards,
    generatedAt: nowIso,
  };
}
