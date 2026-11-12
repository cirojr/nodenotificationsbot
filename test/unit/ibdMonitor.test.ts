import {describe, expect, it} from 'vitest';
import type {IbdMonitorConfig} from '../../src/config';
import {IbdMonitor} from '../../src/services/ibdMonitor';
import {
  FakeSampler,
  makeSample,
  memoryRepo,
  RecordingSender,
  silentLogger,
  syncedSample,
  testConfig,
} from '../helpers';

function setup(options: {config?: Partial<IbdMonitorConfig>} = {}) {
  const repo = memoryRepo();
  const sampler = new FakeSampler();
  const sender = new RecordingSender();
  const config = testConfig(options.config ?? {});
  const monitor = new IbdMonitor({
    repo,
    sampler,
    sender,
    config,
    logger: silentLogger,
    rpcUrl: 'http://127.0.0.1:8332',
  });

  async function subscribe(
    chatId: number,
    sample: Parameters<typeof makeSample>[0] = {},
  ) {
    sampler.push(makeSample(sample));
    return monitor.subscribe(chatId);
  }

  return {repo, sampler, sender, config, monitor, subscribe};
}

describe('IbdMonitor subscriptions', () => {
  it('saves the chat and records the current bucket on /ibd', async () => {
    const {repo, subscribe} = setup();

    const sample = await subscribe(1, {
      progressPercent: 9.5,
      verificationProgress: 0.095,
    });

    expect(sample.progressPercent).toBeCloseTo(9.5, 3);
    expect(repo.list().map(chat => chat.chatId)).toEqual([1]);
    expect(repo.get(1)?.lastState).toBe('ibd');
    expect(repo.get(1)?.lastSentBucket).toBe(0);
  });

  it('notifies when the progress bucket advances', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {
      progressPercent: 9.5,
      verificationProgress: 0.095,
    });

    sampler.push(makeSample({progressPercent: 10, verificationProgress: 0.1}));
    await monitor.tick();

    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]?.chatId).toBe(1);
    expect(sender.last()?.html).toContain(
      'Progress     10.0%  (step: every 10%)',
    );
    expect(repo.get(1)?.lastSentBucket).toBe(1);

    sampler.push(makeSample({progressPercent: 10, verificationProgress: 0.1}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);
  });

  it('sends one message when progress jumps several buckets', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {
      progressPercent: 34,
      verificationProgress: 0.34,
    });

    sampler.push(makeSample({progressPercent: 56, verificationProgress: 0.56}));
    await monitor.tick();

    expect(sender.messages).toHaveLength(1);
    expect(sender.last()?.html).toContain('Progress     56.0%');
    expect(repo.get(1)?.lastSentBucket).toBe(5);

    sampler.push(makeSample({progressPercent: 60, verificationProgress: 0.6}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);
  });

  it('broadcasts the same update to every monitored chat', async () => {
    const {monitor, sampler, sender, subscribe} = setup();
    await subscribe(1, {progressPercent: 9.5});
    await subscribe(2, {progressPercent: 9.5});

    sampler.push(makeSample({progressPercent: 10}));
    await monitor.tick();

    expect(sender.messages.map(message => message.chatId)).toEqual([1, 2]);
  });

  it('removes a chat on /ibd stop', async () => {
    const {monitor, repo, subscribe} = setup();
    await subscribe(1, {progressPercent: 50});

    expect(await monitor.unsubscribe(1)).toBe(true);
    expect(repo.get(1)).toBeNull();
    expect(await monitor.unsubscribe(1)).toBe(false);
  });

  it('does not save a chat when the node is already synced', async () => {
    const {monitor, repo, sampler} = setup();
    sampler.push(syncedSample());

    const sample = await monitor.subscribe(1);

    expect(sample.initialBlockDownload).toBe(false);
    expect(repo.get(1)).toBeNull();
  });

  it('saves the chat as unreachable when /ibd cannot sample', async () => {
    const {monitor, repo, sampler} = setup();
    sampler.push(new Error('connection refused'));

    await expect(monitor.subscribe(1)).rejects.toThrow('connection refused');
    expect(repo.get(1)?.lastState).toBe('unreachable');
  });
});

describe('IbdMonitor state machine', () => {
  it('sends the completion message once and clears the chats', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {progressPercent: 88});

    sampler.push(syncedSample());
    await monitor.tick();

    expect(sender.messages).toHaveLength(1);
    expect(sender.last()?.html).toContain(
      'IBD finished — node is fully synced',
    );
    expect(repo.get(1)).toBeNull();

    await monitor.tick();
    expect(sender.messages).toHaveLength(1);
  });

  it('retries a transient completion failure, then clears the chat', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {progressPercent: 88});

    sender.result = {
      ok: false,
      error: 'Too Many Requests',
      retryable: true,
      blocked: false,
    };
    sampler.push(syncedSample());
    await monitor.tick();
    expect(repo.get(1)?.lastState).toBe('synced');

    sender.result = {ok: true};
    sampler.push(syncedSample());
    await monitor.tick();
    expect(repo.get(1)).toBeNull();
  });

  it('sends the unreachable alert once, then recovers', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {progressPercent: 50});

    sampler.push(new Error('connect ECONNREFUSED 127.0.0.1:8332'));
    await monitor.tick();
    expect(sender.last()?.html).toContain('Node unreachable');
    expect(repo.get(1)?.lastState).toBe('unreachable');

    sampler.push(new Error('connect ECONNREFUSED 127.0.0.1:8332'));
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);

    sampler.push(makeSample({progressPercent: 51}));
    await monitor.tick();
    expect(sender.last()?.html).toContain('Node reachable again');
    expect(repo.get(1)?.lastState).toBe('ibd');
  });

  it('alerts again on a new unreachable episode', async () => {
    const {monitor, sampler, sender, subscribe} = setup();
    await subscribe(1, {progressPercent: 50});
    const failure = new Error('connect ECONNREFUSED 127.0.0.1:8332');

    sampler.push(failure);
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);

    sampler.push(makeSample({progressPercent: 51}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);

    sampler.push(failure);
    await monitor.tick();
    expect(sender.messages).toHaveLength(3);
    expect(sender.last()?.html).toContain('Node unreachable');
  });

  it('does not duplicate a progress update after a restart', async () => {
    const {monitor, repo, sampler, sender} = setup();
    repo.add(1);
    repo.update(1, {lastState: 'ibd', lastSentBucket: 8});

    sampler.push(makeSample({progressPercent: 88.73}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(0);

    sampler.push(makeSample({progressPercent: 90.1}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);
  });

  it('resets the baseline silently when progress moves backwards', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {progressPercent: 50});

    sampler.push(makeSample({progressPercent: 40}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(0);
    expect(repo.get(1)?.lastSentBucket).toBe(4);

    sampler.push(makeSample({progressPercent: 50}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);

    sampler.push(makeSample({progressPercent: 60}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);
  });

  it('removes a chat when Telegram blocks the bot', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {progressPercent: 9.5});

    sender.result = {
      ok: false,
      error: 'Forbidden: bot was blocked by the user',
      retryable: false,
      blocked: true,
    };
    sampler.push(makeSample({progressPercent: 10}));
    await monitor.tick();

    expect(repo.get(1)).toBeNull();
  });

  it('does not sample while no chats are monitored', async () => {
    const {monitor, sampler, sender} = setup();
    sampler.push(makeSample());

    await monitor.tick();

    expect(sampler.pending).toBe(1);
    expect(sender.messages).toHaveLength(0);
  });
});
