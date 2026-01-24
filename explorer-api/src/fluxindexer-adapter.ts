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

  if (h < 0 || tip < h) return 0;
  return tip - h + 1;
}

function toString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
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
  hex?: string;
}

export async function fluxdGet<T>(
  env: Env,
  method: string,
  params?: Record<string, string | number | boolean>,
  timeoutMs = 30_000
): Promise<T> {
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
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`fluxd_rust /daemon/${method} failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
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
}

async function fluxdGetWithOptions<T>(
  env: Env,
  method: string,
  params?: Record<string, string | number | boolean>,
  options?: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<T> {
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
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`fluxd_rust /daemon/${method} failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
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
}

type BlockDeltaTx = {
  txid: string;
  index: number;
  inputs: Array<{ address?: string; satoshis?: number }>;
  outputs: Array<{ address?: string; satoshis?: number }>;
};

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

  const txDetails: NonNullable<FluxIndexerBlockResponse['txDetails']> = txs.map((tx, order) => {
    const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
    const outputs = Array.isArray(tx.outputs) ? tx.outputs : [];

    const isCoinbase = inputs.length === 0;

    const vinSat = inputs.reduce((acc: bigint, row) => acc + toSatoshiBigInt(row?.satoshis ?? 0), 0n);
    const voutSat = outputs.reduce((acc: bigint, row) => acc + toSatoshiBigInt(row?.satoshis ?? 0), 0n);

    const feeSat = !isCoinbase && vinSat > voutSat ? (vinSat - voutSat) : 0n;

    const fromAddr = inputs.find((i) => typeof i?.address === 'string' && i.address.length > 0)?.address ?? null;
    const toAddr = outputs.find((o) => typeof o?.address === 'string' && o.address.length > 0)?.address ?? null;

    return {
      txid: toString(tx.txid),
      order,
      kind: (isCoinbase ? 'coinbase' : 'transfer') as 'coinbase' | 'transfer',
      isCoinbase,
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

  const coinbaseCount = txDetails.filter((d) => d.isCoinbase).length;
  const transfers = Math.max(0, txDetails.length - coinbaseCount);

  const txSummary = {
    total: txDetails.length,
    regular: transfers,
    coinbase: coinbaseCount,
    transfers,
    fluxnodeStart: 0,
    fluxnodeConfirm: 0,
    fluxnodeOther: 0,
    fluxnodeTotal: 0,
    tierCounts: { cumulus: 0, nimbus: 0, stratus: 0, starting: 0, unknown: 0 },
  };

  const rewardSat = txDetails.find((d) => d.isCoinbase)?.valueSat ?? 0;

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

export async function getLatestBlocks(env: Env, limit: number): Promise<{ blocks: Array<{ height: number; hash: string; time?: number; size?: number; txCount?: number }> }> {
  const tipHeight = await fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) });

  const capped = Math.max(1, Math.min(Math.floor(limit), 50));
  const heights = [] as number[];
  for (let h = tipHeight; h >= 0 && heights.length < capped; h--) {
    heights.push(h);
  }

  const blocks = await Promise.all(
    heights.map(async (h) => {
      const hash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([h]) });
      const header = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([hash]) });
      return {
        height: toNumber(header.height, h),
        hash: toString(header.hash, hash),
        time: toNumber(header.time),
        size: undefined,
        txCount: undefined,
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

  return {
    txid: toString(tx.txid, txid),
    version: toNumber(tx.version),
    lockTime: toNumber(tx.locktime),
    vin: tx.vin,
    vout: tx.vout,
    blockHash: toString(tx.blockhash),
    blockHeight: toNumber(tx.height),
    confirmations: toNumber(tx.confirmations),
    blockTime: toNumber(tx.blocktime),
    time: toNumber(tx.time),
    size: toNumber(tx.size),
    vsize: toNumber(tx.vsize ?? tx.size),
    hex: includeHex ? toString(tx.hex) : undefined,
  };
}

export async function getAddressSummary(env: Env, address: string): Promise<{ address: string; balance: string; totalReceived: string; totalSent: string; unconfirmedBalance: string; unconfirmedTxs: number; txs: number; transactions: Array<{ txid: string }> }> {
  const [balance, txids, mempoolDeltas] = await Promise.all([
    fluxdGet<any>(env, 'getaddressbalance', { params: JSON.stringify([{ address }]) }),
    fluxdGet<string[]>(env, 'getaddresstxids', { params: JSON.stringify([{ addresses: [address] }]) }),
    fluxdGet<any[]>(env, 'getaddressmempool', { params: JSON.stringify([{ addresses: [address] }]) }),
  ]);

  const satBalance = toSatoshiBigInt(balance.balance);
  const satReceived = toSatoshiBigInt(balance.received);
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
    txs: Array.isArray(txids) ? txids.length : 0,
    transactions: Array.isArray(txids) ? txids.slice(-25).reverse().map((id) => ({ txid: toString(id) })) : [],
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
  }
): Promise<FluxIndexerAddressTransactionsResponse> {
  const rangeStart = params.fromBlock ?? 0;
  const rangeEnd = params.toBlock ?? 0;

  const rangeObj = (rangeStart > 0 && rangeEnd > 0) ? { start: rangeStart, end: rangeEnd } : undefined;

  const deltasResp = await fluxdGetWithOptions<any>(
    env,
    'getaddressdeltas',
    { params: JSON.stringify([{ addresses: [address], ...(rangeObj ?? {}) }]) },
    { chainInfo: false }
  );

  const deltas = Array.isArray(deltasResp) ? deltasResp : deltasResp?.deltas;
  const rowsRaw = Array.isArray(deltas) ? deltas : [];

  const rows: AddressDeltaRow[] = rowsRaw.map((row: any) => ({
    address: toString(row?.address, address),
    height: toNumber(row?.height, 0),
    txIndex: toNumber(row?.blockindex ?? row?.tx_index ?? row?.txIndex, 0),
    txid: toString(row?.txid),
    satoshis: toNumber(row?.satoshis, 0),
  }));

  const bestHeight = await fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) });

  const grouped = new Map<string, GroupedAddressTx>();
  for (const d of rows) {
    const key = `${d.height}:${d.txIndex}:${d.txid}`;
    const sat = BigInt(Math.trunc(d.satoshis));
    const existing = grouped.get(key);
    if (existing) {
      existing.net += sat;
      if (sat > 0n) existing.received += sat;
      if (sat < 0n) existing.sent += -sat;
      continue;
    }
    grouped.set(key, {
      txid: d.txid,
      height: d.height,
      txIndex: d.txIndex,
      net: sat,
      received: sat > 0n ? sat : 0n,
      sent: sat < 0n ? -sat : 0n,
    });
  }

  const groupedTxs = Array.from(grouped.values()).sort((a, b) => {
    const heightCmp = b.height - a.height;
    if (heightCmp !== 0) return heightCmp;

    const indexCmp = b.txIndex - a.txIndex;
    if (indexCmp !== 0) return indexCmp;

    return b.txid.localeCompare(a.txid);
  });

  const txIoByTxid = new Map<string, AddressTxIoSummary>();

  const heightsNeeded = Array.from(new Set(groupedTxs.map((tx) => tx.height)));

  const maxConcurrency = 8;
  let heightCursor = 0;

  const heightWorkers = Array.from({ length: Math.min(maxConcurrency, heightsNeeded.length) }, async () => {
    while (true) {
      const idx = heightCursor;
      heightCursor += 1;
      if (idx >= heightsNeeded.length) return;

      const height = heightsNeeded[idx];
      const hash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([height]) });
      const deltas = await fluxdGet<any>(env, 'getblockdeltas', { params: JSON.stringify([hash]) });

      const txDeltas = Array.isArray(deltas?.deltas) ? deltas.deltas : [];

      for (const entry of txDeltas) {
        const txid = typeof entry?.txid === 'string' ? entry.txid : null;
        if (!txid) continue;

        const inputRows = Array.isArray(entry?.inputs) ? entry.inputs : [];
        const outputRows = Array.isArray(entry?.outputs) ? entry.outputs : [];

        const fromSet = new Set<string>();
        let vinValue = 0n;

        for (const input of inputRows) {
          if (typeof input?.address === 'string' && input.address.length > 0) {
            fromSet.add(input.address);
          }
          const sat = input?.satoshis;
          if (typeof sat === 'number' && Number.isFinite(sat)) {
            vinValue += BigInt(Math.max(0, Math.trunc(-sat)));
          }
        }

        const toSet = new Set<string>();
        let voutValue = 0n;
        let receivedToAddress = 0n;

        for (const output of outputRows) {
          if (typeof output?.address === 'string' && output.address.length > 0) {
            toSet.add(output.address);
          }
          const sat = output?.satoshis;
          if (typeof sat === 'number' && Number.isFinite(sat)) {
            const v = BigInt(Math.max(0, Math.trunc(sat)));
            voutValue += v;
            if (output.address === address) {
              receivedToAddress += v;
            }
          }
        }

        const isCoinbase = inputRows.length === 0;
        const feeSat = isCoinbase ? 0n : (vinValue > voutValue ? (vinValue - voutValue) : 0n);
        const changeSat = !isCoinbase ? receivedToAddress : 0n;

        let sentFromAddress = 0n;
        const groupedEntry = groupedTxs.find((t) => t.txid === txid);
        if (groupedEntry) {
          sentFromAddress = groupedEntry.sent;
        }

        const receivedMinusChange = receivedToAddress >= changeSat
          ? (receivedToAddress - changeSat)
          : 0n;

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

  await Promise.all(heightWorkers);

  const headerByHeight = new Map<number, { hash: string; timestamp: number }>();
  const txsWithTime = await Promise.all(
    groupedTxs.map(async (tx) => {
      const cached = headerByHeight.get(tx.height);
      if (cached) {
        return { tx, blockHash: cached.hash, timestamp: cached.timestamp };
      }

      const hash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([tx.height]) });
      const header = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([hash]) });
      const timestamp = toNumber(header.time, 0);
      headerByHeight.set(tx.height, { hash, timestamp });
      return { tx, blockHash: hash, timestamp };
    })
  );

  const fromTs = params.fromTimestamp;
  const toTs = params.toTimestamp;

  const filtered = txsWithTime.filter((row) => {
    if (fromTs != null && row.timestamp < fromTs) return false;
    if (toTs != null && row.timestamp > toTs) return false;
    return true;
  });

  let startIndex = 0;
  if (params.cursorHeight != null && params.cursorTxIndex != null && params.cursorTxid) {
    const idx = filtered.findIndex(
      (row) => row.tx.height === params.cursorHeight && row.tx.txIndex === params.cursorTxIndex && row.tx.txid === params.cursorTxid
    );
    startIndex = idx >= 0 ? idx + 1 : 0;
  } else if (params.offset != null) {
    startIndex = Math.max(0, params.offset);
  }

  const limit = Math.max(1, Math.min(params.limit, 250));
  const page = filtered.slice(startIndex, startIndex + limit);
  const next = filtered[startIndex + limit];

  const nextCursor = next
    ? {
        height: next.tx.height,
        txIndex: next.tx.txIndex,
        txid: next.tx.txid,
      }
    : undefined;

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
        selfTransfer: fromAddresses.includes(address) && toAddresses.includes(address),
        confirmations: confirmationsFromHeight(bestHeight, row.tx.height > 0 ? row.tx.height : null),
        isCoinbase,
      };
    }),
    total: groupedTxs.length,
    filteredTotal: filtered.length,
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

  return {
    blockHeight: toNumber(chainInfo.blocks, 0),
    transparentSupply: transparentSupplyZat.toString(),
    shieldedPool: shieldedPoolZat.toString(),
    totalSupply: totalSupplyZat.toString(),
    lastUpdate: now,
    timestamp: now,
  };
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
    lastUpdate: toString(response.lastUpdate, new Date().toISOString()),
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

export async function getDashboardStats(env: Env): Promise<{
  latestBlock: { height: number; hash: string | null; timestamp: number | null };
  averages: { blockTimeSeconds: number };
  transactions24h: number;
  latestRewards: Array<{
    height: number;
    hash: string;
    timestamp: number;
    txid: string;
    totalRewardSat: number;
    totalReward: number;
    outputs: Array<{ address: string | null; valueSat: number; value: number }>;
  }>;
  generatedAt: string;
}> {
  const tipHeight = await fluxdGet<number>(env, 'getblockcount', { params: JSON.stringify([]) });
  const tipHash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([tipHeight]) });
  const tipHeader = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([tipHash]) });

  const nowIso = new Date().toISOString();
  const latestTimestamp = toNumber(tipHeader.time, 0);

  const tipUnix = latestTimestamp || Math.floor(Date.now() / 1000);
  const windowSeconds = 24 * 60 * 60;
  const low = Math.max(0, tipUnix - windowSeconds);

  let txCount24h = 0;
  try {
    const hashes = await fluxdGet<string[]>(env, 'getblockhashes', { params: JSON.stringify([tipUnix, low, { noOrphans: true }]) });
    const lastN = hashes.length > 250 ? hashes.slice(-250) : hashes;

    const heights: number[] = [];
    for (const hash of lastN) {
      try {
        const header = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([hash]) });
        const h = toNumber(header.height, -1);
        if (h >= 0) heights.push(h);
      } catch {
      }
    }

    if (heights.length > 0) {
      const minHeight = Math.max(0, Math.min(...heights) - 50);
      const maxHeight = Math.max(...heights);

      const countRange = await fluxdGet<any>(env, 'getaddressdeltas', {
        params: JSON.stringify([{ addresses: [], start: minHeight, end: maxHeight }]),
      });

      const countRows = Array.isArray(countRange) ? countRange : countRange?.deltas;
      const unique = new Set<string>();
      if (Array.isArray(countRows)) {
        for (const row of countRows) {
          const txid = typeof row?.txid === 'string' ? row.txid : null;
          if (txid) unique.add(txid);
        }
      }
      txCount24h = unique.size;
    }
  } catch {
    txCount24h = 0;
  }

  let avgBlockTimeSeconds = 30;
  try {
    const sampleCount = 120;
    const heights = Array.from({ length: Math.min(sampleCount, tipHeight) }, (_, idx) => tipHeight - idx).filter((h) => h >= 0);

    const times: number[] = [];
    for (const h of heights) {
      try {
        const hash = await fluxdGet<string>(env, 'getblockhash', { params: JSON.stringify([h]) });
        const header = await fluxdGet<any>(env, 'getblockheader', { params: JSON.stringify([hash]) });
        const t = toNumber(header.time, 0);
        if (t > 0) times.push(t);
      } catch {
      }
    }

    if (times.length >= 2) {
      times.sort((a, b) => a - b);
      const span = times[times.length - 1] - times[0];
      const denom = times.length - 1;
      if (span > 0 && denom > 0) {
        avgBlockTimeSeconds = span / denom;
      }
    }
  } catch {
    avgBlockTimeSeconds = 30;
  }

  let latestRewards: Array<{
    height: number;
    hash: string;
    timestamp: number;
    txid: string;
    totalRewardSat: number;
    totalReward: number;
    outputs: Array<{ address: string | null; valueSat: number; value: number }>;
  }> = [];

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
    latestRewards,
    generatedAt: nowIso,
  };
}
