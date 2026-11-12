import {describe, expect, it} from 'vitest';
import {
  isNodeSynced,
  sampleNode,
  type BitcoinRpc,
  type NodeSample,
} from '../../src/bitcoin/nodeStatus';
import type {BlockchainInfo, NetworkInfo} from '../../src/bitcoin/rpcClient';
import {RpcError} from '../../src/bitcoin/rpcClient';

const HASH = '00000000000000000001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7';

const blockchainInfo: BlockchainInfo = {
  chain: 'main',
  blocks: 812_345,
  headers: 915_432,
  bestblockhash: HASH,
  verificationprogress: 0.8873,
  initialblockdownload: true,
  size_on_disk: 657_400_000_000,
  pruned: false,
  warnings: '',
  time: 1_762_610_520,
};

const networkInfo: NetworkInfo = {
  connections: 8,
  connections_in: 2,
  connections_out: 6,
  warnings: '',
};

class FakeRpc implements BitcoinRpc {
  info: BlockchainInfo | Error = blockchainInfo;
  network: NetworkInfo | Error = networkInfo;

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    if (this.info instanceof Error) {
      throw this.info;
    }
    return this.info;
  }

  async getNetworkInfo(): Promise<NetworkInfo> {
    if (this.network instanceof Error) {
      throw this.network;
    }
    return this.network;
  }
}

function midIbdSample(overrides: Partial<NodeSample> = {}): NodeSample {
  return {
    sampledAt: new Date(),
    chain: 'main',
    blocks: 812_345,
    headers: 915_432,
    progressPercent: 88.73,
    verificationProgress: 0.8873,
    initialBlockDownload: true,
    bestBlockHash: HASH,
    bestBlockTime: null,
    sizeOnDisk: 0,
    pruned: false,
    peers: null,
    warnings: [],
    ...overrides,
  };
}

describe('sampleNode', () => {
  it('maps getblockchaininfo and getnetworkinfo', async () => {
    const sample = await sampleNode(new FakeRpc());

    expect(sample.chain).toBe('main');
    expect(sample.blocks).toBe(812_345);
    expect(sample.headers).toBe(915_432);
    expect(sample.progressPercent).toBeCloseTo(88.73, 2);
    expect(sample.initialBlockDownload).toBe(true);
    expect(sample.bestBlockHash).toBe(HASH);
    expect(sample.bestBlockTime?.toISOString()).toBe(
      new Date(1_762_610_520 * 1000).toISOString(),
    );
    expect(sample.peers).toEqual({total: 8, inbound: 2, outbound: 6});
    expect(sample.warnings).toEqual([]);
  });

  it('merges warnings from both RPCs', async () => {
    const rpc = new FakeRpc();
    rpc.info = {...blockchainInfo, warnings: 'warning one'};
    rpc.network = {...networkInfo, warnings: 'warning two'};

    const sample = await sampleNode(rpc);
    expect(sample.warnings).toEqual(['warning one', 'warning two']);
  });

  it('degrades gracefully when getnetworkinfo fails', async () => {
    const rpc = new FakeRpc();
    rpc.network = new RpcError('network down', 'network');

    const sample = await sampleNode(rpc);
    expect(sample.peers).toBeNull();
    expect(sample.warnings).toEqual([]);
  });

  it('propagates getblockchaininfo failures', async () => {
    const rpc = new FakeRpc();
    rpc.info = new RpcError('node down', 'network');

    await expect(sampleNode(rpc)).rejects.toBeInstanceOf(RpcError);
  });

  it('clamps non-finite verificationprogress for progress tracking but keeps it for display decisions', async () => {
    const rpc = new FakeRpc();
    rpc.info = {...blockchainInfo, verificationprogress: Number.NaN};

    const sample = await sampleNode(rpc);
    expect(sample.progressPercent).toBe(0);
    expect(Number.isFinite(sample.verificationProgress)).toBe(false);
  });
});

describe('isNodeSynced', () => {
  it('requires the IBD flag to be false and the tip near the header tip', () => {
    expect(
      isNodeSynced(
        midIbdSample({
          initialBlockDownload: false,
          blocks: 915_432,
          headers: 915_432,
        }),
      ),
    ).toBe(true);
    expect(
      isNodeSynced(
        midIbdSample({
          initialBlockDownload: false,
          blocks: 915_431,
          headers: 915_432,
        }),
      ),
    ).toBe(true);
    expect(
      isNodeSynced(
        midIbdSample({
          initialBlockDownload: true,
          blocks: 915_432,
          headers: 915_432,
        }),
      ),
    ).toBe(false);
    expect(
      isNodeSynced(
        midIbdSample({
          initialBlockDownload: false,
          blocks: 800_000,
          headers: 915_432,
        }),
      ),
    ).toBe(false);
  });
});
