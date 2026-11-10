import {describe, expect, it} from 'vitest';
import {
  isNodeInIbd,
  isNodeSynced,
  sampleNode,
  type BitcoinRpc,
  type NodeSample,
} from '../../src/bitcoin/nodeStatus';
import type {
  BlockHeader,
  BlockchainInfo,
  ChainStatesInfo,
  NetworkInfo,
} from '../../src/bitcoin/rpcClient';
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
};

const networkInfo: NetworkInfo = {
  connections: 8,
  connections_in: 2,
  connections_out: 6,
  version: 280_000,
  subversion: '/Satoshi:28.0.0/',
  warnings: '',
};

const header: BlockHeader = {hash: HASH, height: 812_345, time: 1_762_610_520};

class FakeRpc implements BitcoinRpc {
  info: BlockchainInfo = blockchainInfo;
  network: NetworkInfo | Error = networkInfo;
  header: BlockHeader | Error = header;
  chainStates: ChainStatesInfo | null | Error = null;

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.info;
  }

  async getNetworkInfo(): Promise<NetworkInfo> {
    if (this.network instanceof Error) {
      throw this.network;
    }
    return this.network;
  }

  async getBlockHeader(): Promise<BlockHeader> {
    if (this.header instanceof Error) {
      throw this.header;
    }
    return this.header;
  }

  async getChainStates(): Promise<ChainStatesInfo | null> {
    if (this.chainStates instanceof Error) {
      throw this.chainStates;
    }
    return this.chainStates;
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
    nodeVersion: null,
    subversion: null,
    ...overrides,
  };
}

describe('sampleNode', () => {
  it('maps getblockchaininfo/getnetworkinfo/getblockheader', async () => {
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
    expect(sample.subversion).toBe('/Satoshi:28.0.0/');
    expect(sample.warnings).toEqual([]);
  });

  it('degrades gracefully when optional RPCs fail', async () => {
    const rpc = new FakeRpc();
    rpc.network = new RpcError('network down', 'network');
    rpc.header = new RpcError('header missing', 'rpc');
    rpc.chainStates = new RpcError('method not found', 'rpc', {
      rpcCode: -32601,
    });

    const sample = await sampleNode(rpc);
    expect(sample.peers).toBeNull();
    expect(sample.bestBlockTime).toBeNull();
    expect(sample.assumeUtxo).toBeUndefined();
    expect(sample.warnings).toEqual([]);
  });

  it('uses the background chainstate for assumeutxo progress', async () => {
    const rpc = new FakeRpc();
    rpc.info = {
      ...blockchainInfo,
      initialblockdownload: false,
      blocks: 915_432,
      verificationprogress: 0.99999,
    };
    rpc.chainStates = {
      headers: 915_432,
      chainstates: [
        {
          blocks: 915_432,
          bestblockhash: HASH,
          verificationprogress: 0.99999,
          validated: true,
          snapshot_blockhash: 'a'.repeat(64),
        },
        {
          blocks: 612_004,
          bestblockhash: 'b'.repeat(64),
          verificationprogress: 0.668,
          validated: false,
        },
      ],
    };

    const sample = await sampleNode(rpc);
    expect(sample.progressPercent).toBeCloseTo(66.8, 1);
    expect(sample.assumeUtxo?.background?.blocks).toBe(612_004);
    expect(sample.assumeUtxo?.background?.validated).toBe(false);
    expect(sample.assumeUtxo?.active?.blocks).toBe(915_432);
    expect(sample.assumeUtxo?.snapshotBlockHash).toBe('a'.repeat(64));
  });

  it('clamps non-finite verificationprogress for bucketing but keeps it for display decisions', async () => {
    const rpc = new FakeRpc();
    rpc.info = {...blockchainInfo, verificationprogress: Number.NaN};

    const sample = await sampleNode(rpc);
    expect(sample.progressPercent).toBe(0);
    expect(Number.isFinite(sample.verificationProgress)).toBe(false);
  });

  it('honours the sample timeout', async () => {
    const rpc: BitcoinRpc = {
      getBlockchainInfo: () => new Promise<BlockchainInfo>(() => {}),
      getNetworkInfo: async () => networkInfo,
      getBlockHeader: async () => header,
      getChainStates: async () => null,
    };

    await expect(sampleNode(rpc, 10)).rejects.toMatchObject({kind: 'timeout'});
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

  it('exposes the inverse for IBD handling', () => {
    expect(isNodeInIbd(midIbdSample())).toBe(true);
    expect(
      isNodeInIbd(
        midIbdSample({
          initialBlockDownload: false,
          blocks: 915_432,
          headers: 915_432,
        }),
      ),
    ).toBe(false);
  });
});
