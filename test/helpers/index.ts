import pino from 'pino';
import type {IbdMonitorConfig} from '../../src/config';
import type {Logger} from '../../src/logger';
import type {NodeSample, Sampler} from '../../src/bitcoin/nodeStatus';
import type {MessageSender, SendResult} from '../../src/services/ibdMonitor';
import {SqliteNodeMonitorRepo} from '../../src/storage/nodeMonitorRepo';
import {openSqlite} from '../../src/storage/sqlite';

export const silentLogger: Logger = pino({level: 'silent'});

export function testConfig(
  overrides: Partial<IbdMonitorConfig> = {},
): IbdMonitorConfig {
  return {
    enabled: true,
    sampleIntervalSeconds: 60,
    defaultProgressStepPercent: 10,
    minProgressStepPercent: 1,
    maxProgressStepPercent: 50,
    heartbeatMinutes: 0,
    stallMinutes: 15,
    reorgTolerance: 12,
    unreachableAlertAfterMinutes: 5,
    minAlertIntervalSeconds: 300,
    stopAfterSyncMinutes: 60,
    maxSubscriptions: 5,
    allowedChatIds: ['*'],
    speedWindowMinutes: 15,
    commandThrottleSeconds: 3,
    ...overrides,
  };
}

export class FakeClock {
  current: number;

  constructor(start = Date.UTC(2026, 10, 8, 14, 0, 0)) {
    this.current = start;
  }

  now = (): number => this.current;

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}

const HASH = '00000000000000000001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7';

export function makeSample(overrides: Partial<NodeSample> = {}): NodeSample {
  const base: NodeSample = {
    sampledAt: new Date(Date.UTC(2026, 10, 8, 14, 7, 31)),
    chain: 'main',
    blocks: 812_345,
    headers: 915_432,
    progressPercent: 88.73,
    verificationProgress: 0.8873,
    initialBlockDownload: true,
    bestBlockHash: HASH,
    bestBlockTime: new Date(Date.UTC(2026, 10, 8, 14, 2, 0)),
    sizeOnDisk: 612.4 * 1024 ** 3,
    pruned: false,
    peers: {total: 8, inbound: 2, outbound: 6},
    warnings: [],
    nodeVersion: 280_000,
    subversion: '/Satoshi:28.0.0/',
  };
  return {...base, ...overrides};
}

export function syncedSample(overrides: Partial<NodeSample> = {}): NodeSample {
  return makeSample({
    blocks: 915_432,
    headers: 915_432,
    progressPercent: 100,
    verificationProgress: 0.99999,
    initialBlockDownload: false,
    ...overrides,
  });
}

export class FakeSampler implements Sampler {
  private readonly queue: Array<NodeSample | Error> = [];

  push(...items: Array<NodeSample | Error>): void {
    this.queue.push(...items);
  }

  get pending(): number {
    return this.queue.length;
  }

  async sample(): Promise<NodeSample> {
    const next = this.queue.shift();
    if (!next) {
      throw new Error('FakeSampler: no sample queued');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

export class RecordingSender implements MessageSender {
  readonly messages: Array<{chatId: number; html: string}> = [];
  result: SendResult = {ok: true};

  async send(chatId: number, html: string): Promise<SendResult> {
    this.messages.push({chatId, html});
    return this.result;
  }

  last(): {chatId: number; html: string} | undefined {
    return this.messages[this.messages.length - 1];
  }

  clear(): void {
    this.messages.length = 0;
  }
}

export function memoryRepo(): SqliteNodeMonitorRepo {
  return new SqliteNodeMonitorRepo(openSqlite(':memory:', silentLogger));
}
