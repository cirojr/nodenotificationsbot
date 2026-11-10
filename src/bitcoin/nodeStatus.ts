import {
  RpcError,
  type BlockHeader,
  type BlockchainInfo,
  type ChainStateInfo,
  type ChainStatesInfo,
  type NetworkInfo,
} from './rpcClient';

export interface BitcoinRpc {
  getBlockchainInfo(): Promise<BlockchainInfo>;
  getNetworkInfo(): Promise<NetworkInfo>;
  getBlockHeader(hash: string, verbose?: boolean): Promise<BlockHeader>;
  getChainStates(): Promise<ChainStatesInfo | null>;
}

export interface NodePeerInfo {
  total: number;
  inbound: number | null;
  outbound: number | null;
}

export interface NodeChainState {
  blocks: number;
  headers: number;
  bestBlockHash: string;
  verificationProgress: number;
  validated: boolean;
  snapshotBlockHash?: string;
}

export interface NodeAssumeUtxo {
  active: NodeChainState;
  background?: NodeChainState;
  snapshotBlockHash?: string;
}

export interface NodeSample {
  sampledAt: Date;
  chain: string;
  blocks: number;
  headers: number;
  /** Clamped 0..100; drives progress-step notifications. */
  progressPercent: number;
  /** Raw verificationprogress (kept for display; may be outside 0..1). */
  verificationProgress: number;
  initialBlockDownload: boolean;
  bestBlockHash: string;
  bestBlockTime: Date | null;
  sizeOnDisk: number;
  pruned: boolean;
  peers: NodePeerInfo | null;
  warnings: string[];
  nodeVersion: number | null;
  subversion: string | null;
  assumeUtxo?: NodeAssumeUtxo;
}

export interface Sampler {
  sample(): Promise<NodeSample>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toWarnings(...values: Array<string | string[] | undefined>): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const trimmed = item.trim();
      if (trimmed.length > 0 && !result.includes(trimmed)) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

function mapChainState(state: ChainStateInfo, headers: number): NodeChainState {
  return {
    blocks: state.blocks,
    headers,
    bestBlockHash: state.bestblockhash,
    verificationProgress: Number.isFinite(state.verificationprogress)
      ? state.verificationprogress
      : 0,
    validated: state.validated === true,
    ...(state.snapshot_blockhash
      ? {snapshotBlockHash: state.snapshot_blockhash}
      : {}),
  };
}

function parseAssumeUtxo(
  info: ChainStatesInfo | null,
  headers: number,
): NodeAssumeUtxo | undefined {
  if (
    !info ||
    !Array.isArray(info.chainstates) ||
    info.chainstates.length === 0
  ) {
    return undefined;
  }
  const [first, ...rest] = info.chainstates;
  if (!first) {
    return undefined;
  }

  const snapshotBlockHash =
    info.chainstates.find(state => state.snapshot_blockhash)
      ?.snapshot_blockhash ?? undefined;
  const hasAssumeUtxoMarker =
    info.chainstates.length > 1 || snapshotBlockHash !== undefined;
  if (!hasAssumeUtxoMarker) {
    return undefined;
  }

  const active = mapChainState(first, headers);
  const backgroundRaw = rest.find(state => !state.validated) ?? rest[0];
  const background = backgroundRaw
    ? mapChainState(backgroundRaw, headers)
    : undefined;

  return {
    active,
    ...(background ? {background} : {}),
    ...(snapshotBlockHash ? {snapshotBlockHash} : {}),
  };
}

async function optional<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new RpcError(`node sample timed out after ${timeoutMs} ms`, 'timeout'),
      );
    }, timeoutMs);
    timer.unref();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Take one read-only snapshot of the node using the fixed RPC set from the
 * plan (§6.2). getblockchaininfo is the source of truth; the other calls are
 * best-effort context and never fail the sample on their own.
 */
export async function sampleNode(
  rpc: BitcoinRpc,
  timeoutMs = 5_000,
): Promise<NodeSample> {
  return withTimeout(collectSample(rpc), timeoutMs * 2);
}

async function collectSample(rpc: BitcoinRpc): Promise<NodeSample> {
  const info = await rpc.getBlockchainInfo();

  const [network, header, chainStates] = await Promise.all([
    optional(rpc.getNetworkInfo()),
    optional(rpc.getBlockHeader(info.bestblockhash)),
    optional(rpc.getChainStates()),
  ]);

  const assumeUtxo = parseAssumeUtxo(chainStates ?? null, info.headers);

  const rawVerification = info.verificationprogress;
  const progressSource =
    assumeUtxo?.background?.verificationProgress ?? rawVerification;
  const progressPercent = Number.isFinite(progressSource)
    ? clamp(progressSource * 100, 0, 100)
    : 0;

  const peers: NodePeerInfo | null = network
    ? {
        total: network.connections,
        inbound: network.connections_in ?? null,
        outbound:
          network.connections_out ??
          (network.connections_in !== undefined
            ? network.connections - network.connections_in
            : null),
      }
    : null;

  const bestBlockTime =
    header && Number.isFinite(header.time)
      ? new Date(header.time * 1000)
      : null;

  return {
    sampledAt: new Date(),
    chain: info.chain,
    blocks: info.blocks,
    headers: info.headers,
    progressPercent,
    verificationProgress: rawVerification,
    initialBlockDownload: info.initialblockdownload === true,
    bestBlockHash: info.bestblockhash,
    bestBlockTime,
    sizeOnDisk: Number.isFinite(info.size_on_disk) ? info.size_on_disk : 0,
    pruned: info.pruned === true,
    peers,
    warnings: toWarnings(info.warnings, network?.warnings),
    nodeVersion:
      network && typeof network.version === 'number' ? network.version : null,
    subversion: network?.subversion ?? null,
    ...(assumeUtxo ? {assumeUtxo} : {}),
  };
}

/**
 * "Synced" per the plan's state machine: the node says it left IBD and the
 * block tip is at (or one behind) the known header tip.
 *
 * Note: per decision Q7 the production node does not use assumeutxo, and
 * completion does not wait for background validation.
 */
export function isNodeSynced(sample: NodeSample): boolean {
  return (
    sample.initialBlockDownload === false && sample.blocks >= sample.headers - 1
  );
}

/** True while the node still has block work to do (or is far behind headers). */
export function isNodeInIbd(sample: NodeSample): boolean {
  return !isNodeSynced(sample);
}

export class RpcNodeSampler implements Sampler {
  private readonly rpc: BitcoinRpc;
  private readonly timeoutMs: number;

  constructor(rpc: BitcoinRpc, timeoutMs = 5_000) {
    this.rpc = rpc;
    this.timeoutMs = timeoutMs;
  }

  sample(): Promise<NodeSample> {
    return sampleNode(this.rpc, this.timeoutMs);
  }
}
