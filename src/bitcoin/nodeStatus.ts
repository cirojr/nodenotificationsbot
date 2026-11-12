import type {BlockchainInfo, NetworkInfo} from './rpcClient';

export interface BitcoinRpc {
  getBlockchainInfo(): Promise<BlockchainInfo>;
  getNetworkInfo(): Promise<NetworkInfo>;
}

export interface NodePeerInfo {
  total: number;
  inbound: number | null;
  outbound: number | null;
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
}

export interface Sampler {
  sample(): Promise<NodeSample>;
}

function normalizeWarnings(
  ...values: Array<string | string[] | undefined>
): string[] {
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

function mapPeers(network: NetworkInfo | undefined): NodePeerInfo | null {
  if (!network) {
    return null;
  }
  return {
    total: network.connections,
    inbound: network.connections_in ?? null,
    outbound:
      network.connections_out ??
      (network.connections_in !== undefined
        ? network.connections - network.connections_in
        : null),
  };
}

async function optional<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

/**
 * Take one read-only snapshot of the node. `getblockchaininfo` is the source
 * of truth; `getnetworkinfo` is best-effort context (peers and warnings) and
 * never fails the sample on its own.
 */
export async function sampleNode(rpc: BitcoinRpc): Promise<NodeSample> {
  const [info, network] = await Promise.all([
    rpc.getBlockchainInfo(),
    optional(rpc.getNetworkInfo()),
  ]);
  const rawVerification = info.verificationprogress;
  const progressPercent = Number.isFinite(rawVerification)
    ? Math.min(100, Math.max(0, rawVerification * 100))
    : 0;
  const bestBlockTime =
    typeof info.time === 'number' && Number.isFinite(info.time)
      ? new Date(info.time * 1000)
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
    peers: mapPeers(network),
    warnings: normalizeWarnings(info.warnings, network?.warnings),
  };
}

/**
 * "Synced" per the plan's state machine: the node says it left IBD and the
 * block tip is at (or one behind) the known header tip.
 */
export function isNodeSynced(sample: NodeSample): boolean {
  return (
    sample.initialBlockDownload === false && sample.blocks >= sample.headers - 1
  );
}

export class RpcNodeSampler implements Sampler {
  private readonly rpc: BitcoinRpc;

  constructor(rpc: BitcoinRpc) {
    this.rpc = rpc;
  }

  sample(): Promise<NodeSample> {
    return sampleNode(this.rpc);
  }
}
