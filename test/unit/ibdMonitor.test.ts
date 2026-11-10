import {describe, expect, it} from 'vitest';
import type {IbdMonitorConfig} from '../../src/config';
import {IbdMonitor} from '../../src/services/ibdMonitor';
import {
  FakeClock,
  FakeSampler,
  makeSample,
  memoryRepo,
  RecordingSender,
  silentLogger,
  syncedSample,
  testConfig,
} from '../helpers';

function setup(
  options: {config?: Partial<IbdMonitorConfig>; adminChatIds?: number[]} = {},
) {
  const clock = new FakeClock();
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
    adminChatIds: options.adminChatIds ?? [],
    rpcUrl: 'http://127.0.0.1:8332',
    now: clock.now,
  });

  async function subscribe(
    chatId: number,
    sample: Parameters<typeof makeSample>[0],
    step?: number,
  ) {
    sampler.push(makeSample(sample));
    return monitor.subscribe(chatId, step);
  }

  return {clock, repo, sampler, sender, config, monitor, subscribe};
}

describe('IbdMonitor subscriptions', () => {
  it('sends an immediate snapshot and records the baseline bucket', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();

    await subscribe(1, {progressPercent: 9.5, verificationProgress: 0.095}, 10);

    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]?.html).toContain('Node is in IBD');
    const subscription = repo.getByChatId(1);
    expect(subscription?.active).toBe(true);
    expect(subscription?.lastState).toBe('ibd');
    expect(subscription?.lastProgressBucket).toBe(0);

    // 9.5% -> 10.0% crosses the first bucket for step=10.
    sampler.push(makeSample({progressPercent: 10, verificationProgress: 0.1}));
    await monitor.tick();

    expect(sender.messages).toHaveLength(2);
    expect(sender.last()?.html).toContain(
      'Progress     10.0%  (step: every 10%)',
    );
    expect(repo.getByChatId(1)?.lastProgressBucket).toBe(1);

    // Same bucket -> no message.
    sampler.push(makeSample({progressPercent: 10, verificationProgress: 0.1}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);
  });

  it('sends one message when progress jumps several buckets', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {progressPercent: 34, verificationProgress: 0.34}, 10);

    sampler.push(makeSample({progressPercent: 56, verificationProgress: 0.56}));
    await monitor.tick();

    expect(sender.messages).toHaveLength(2);
    expect(sender.last()?.html).toContain('Progress     56.0%');
    expect(repo.getByChatId(1)?.lastProgressBucket).toBe(5);

    sampler.push(makeSample({progressPercent: 60, verificationProgress: 0.6}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(3);
  });

  it('updates the step when /ibd watch is re-issued', async () => {
    const {monitor, sampler, sender, repo, subscribe} = setup();
    await subscribe(1, {progressPercent: 20, verificationProgress: 0.2}, 10);
    expect(sender.messages).toHaveLength(1);

    await monitor.subscribe(1, 5);
    expect(repo.getByChatId(1)?.progressStepPercent).toBe(5);
    expect(sender.messages).toHaveLength(2);

    sampler.push(makeSample({progressPercent: 25, verificationProgress: 0.25}));
    await monitor.tick();
    expect(sender.messages).toHaveLength(3);
    expect(sender.last()?.html).toContain(
      'Progress     25.0%  (step: every 5%)',
    );
  });

  it('enforces the server-wide subscription cap', async () => {
    const {monitor, subscribe} = setup({config: {maxSubscriptions: 1}});
    await subscribe(1, {progressPercent: 10});

    await expect(monitor.subscribe(2, 10)).rejects.toMatchObject({
      code: 'cap_reached',
    });

    expect(await monitor.unsubscribe(1)).toBe(true);
    await expect(monitor.subscribe(2, 10)).resolves.toMatchObject({
      telegramChatId: 2,
    });
  });

  it('enforces allowedChatIds, falling back to admins when empty', async () => {
    const restricted = setup({config: {allowedChatIds: [1]}});
    await expect(restricted.monitor.subscribe(2, 10)).rejects.toMatchObject({
      code: 'not_allowed',
    });
    await expect(restricted.subscribe(1, {})).resolves.toMatchObject({
      telegramChatId: 1,
    });

    const adminOnly = setup({config: {allowedChatIds: []}, adminChatIds: [9]});
    expect(adminOnly.monitor.isChatAllowed(9)).toBe(true);
    expect(adminOnly.monitor.isChatAllowed(1)).toBe(false);
  });

  it('rejects new subscriptions but still allows unsubscribe when disabled', async () => {
    const {monitor, repo} = setup({config: {enabled: false}});

    await expect(monitor.subscribe(1, 10)).rejects.toMatchObject({
      code: 'disabled',
    });

    // An existing row (e.g. config was disabled after restart) can still be stopped.
    repo.create(1, 10);
    expect(await monitor.unsubscribe(1)).toBe(true);
    expect(repo.getByChatId(1)?.active).toBe(false);
    expect(repo.getByChatId(1)?.lastState).toBe('unknown');
  });

  it('auto-stops a synced subscription after stopAfterSyncMinutes', async () => {
    const {monitor, repo, sampler, sender, clock, subscribe} = setup({
      config: {stopAfterSyncMinutes: 60},
    });

    await subscribe(1, {...syncedSample()});
    expect(sender.messages).toHaveLength(1);
    expect(repo.getByChatId(1)?.lastState).toBe('synced');

    clock.advance(61 * 60_000);
    sampler.push(syncedSample());
    await monitor.tick();

    expect(repo.getByChatId(1)?.active).toBe(false);
    expect(sender.messages).toHaveLength(1);
  });
});

describe('IbdMonitor state machine', () => {
  it('sends the completion message once', async () => {
    const {monitor, sampler, sender, repo, clock, subscribe} = setup();
    await subscribe(1, {progressPercent: 88, verificationProgress: 0.88});

    clock.advance(60_000);
    sampler.push(syncedSample());
    await monitor.tick();

    expect(sender.messages).toHaveLength(2);
    expect(sender.last()?.html).toContain(
      'IBD finished — node is fully synced',
    );
    expect(repo.getByChatId(1)?.lastState).toBe('synced');

    clock.advance(60_000);
    sampler.push(syncedSample());
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);
  });

  it('alerts once on a stall, then resumes silently', async () => {
    const base = makeSample({
      blocks: 100,
      headers: 200,
      progressPercent: 50,
      verificationProgress: 0.5,
    });
    const {monitor, sampler, sender, repo, clock, subscribe} = setup();
    await subscribe(1, {...base});

    clock.advance(60_000);
    sampler.push({...base});
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);

    clock.advance(15 * 60_000);
    sampler.push({...base});
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);
    expect(sender.last()?.html).toContain('IBD appears stalled');
    expect(repo.getByChatId(1)?.lastState).toBe('stalled');

    clock.advance(60_000);
    sampler.push({...base});
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);

    // Blocks advance: resume without a separate message.
    clock.advance(60_000);
    sampler.push({
      ...base,
      blocks: 101,
      progressPercent: 50.5,
      verificationProgress: 0.505,
    });
    await monitor.tick();
    expect(repo.getByChatId(1)?.lastState).toBe('ibd');
    expect(sender.messages).toHaveLength(2);

    // A later bucket crossing is sent again.
    clock.advance(60_000);
    sampler.push({
      ...base,
      blocks: 200,
      progressPercent: 60,
      verificationProgress: 0.6,
    });
    await monitor.tick();
    expect(sender.messages).toHaveLength(3);
    expect(sender.last()?.html).toContain('Progress     60.0%');
  });

  it('alerts once on regression and resumes when blocks grow', async () => {
    const base = makeSample({
      blocks: 1000,
      headers: 2000,
      progressPercent: 40,
      verificationProgress: 0.4,
    });
    const {monitor, sampler, sender, repo, clock, subscribe} = setup();
    await subscribe(1, {...base});

    clock.advance(60_000);
    sampler.push({...base});
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);

    clock.advance(60_000);
    sampler.push({...base, blocks: 900});
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);
    expect(sender.last()?.html).toContain('Node regressed / is reindexing');
    expect(repo.getByChatId(1)?.lastState).toBe('regressed');

    clock.advance(60_000);
    sampler.push({...base, blocks: 900});
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);

    clock.advance(60_000);
    sampler.push({...base, blocks: 901});
    await monitor.tick();
    expect(repo.getByChatId(1)?.lastState).toBe('ibd');
    expect(sender.messages).toHaveLength(2);
  });

  it('alerts after the unreachable threshold and recovers', async () => {
    const {monitor, sampler, sender, repo, clock, subscribe} = setup();
    await subscribe(1, {});

    clock.advance(60_000);
    sampler.push(new Error('connect ECONNREFUSED 127.0.0.1:8332'));
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);

    clock.advance(5 * 60_000);
    sampler.push(new Error('connect ECONNREFUSED 127.0.0.1:8332'));
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);
    expect(sender.last()?.html).toContain('Node unreachable');
    expect(repo.getByChatId(1)?.lastState).toBe('unreachable');

    clock.advance(60_000);
    sampler.push(new Error('connect ECONNREFUSED 127.0.0.1:8332'));
    await monitor.tick();
    expect(sender.messages).toHaveLength(2);

    clock.advance(60_000);
    sampler.push(makeSample());
    await monitor.tick();
    expect(sender.messages).toHaveLength(3);
    expect(sender.last()?.html).toContain('Node reachable again');
    expect(repo.getByChatId(1)?.lastState).toBe('ibd');
  });

  it('alerts admins when sampling has been failing for 3x the interval', async () => {
    const {monitor, sampler, sender, clock, subscribe} = setup({
      adminChatIds: [9],
    });
    await subscribe(1, {});

    clock.advance(3 * 60_000);
    sampler.push(new Error('connect ECONNREFUSED'));
    await monitor.tick();

    expect(sender.messages).toHaveLength(2);
    expect(sender.last()?.chatId).toBe(9);
    expect(sender.last()?.html).toContain('RPC has been unreachable');
  });

  it('does not duplicate completion or a crossed bucket across restarts', async () => {
    const {monitor, repo, sampler, sender} = setup();
    const nowIso = new Date().toISOString();

    repo.create(1, 10);
    repo.update(1, {
      lastState: 'ibd',
      lastProgressBucket: 8,
      lastSentProgress: 88.73,
      lastSentAt: nowIso,
    });
    sampler.push(
      makeSample({progressPercent: 88.73, verificationProgress: 0.8873}),
    );
    await monitor.tick();
    expect(sender.messages).toHaveLength(0);

    sampler.push(
      makeSample({progressPercent: 90.1, verificationProgress: 0.901}),
    );
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);

    repo.setActive(1, false);
    repo.create(2, 10);
    repo.update(2, {lastState: 'synced', lastSentAt: nowIso});
    sampler.push(syncedSample());
    await monitor.tick();
    expect(sender.messages).toHaveLength(1);
  });

  it('sends a heartbeat when configured and nothing was sent', async () => {
    const {monitor, sampler, sender, clock, subscribe} = setup({
      config: {heartbeatMinutes: 1},
    });
    await subscribe(1, {progressPercent: 50, verificationProgress: 0.5});
    expect(sender.messages).toHaveLength(1);

    clock.advance(2 * 60_000);
    sampler.push(makeSample({progressPercent: 50, verificationProgress: 0.5}));
    await monitor.tick();

    expect(sender.messages).toHaveLength(2);
    expect(sender.last()?.html).toContain('Node is in IBD');
  });

  it('deactivates a subscription when Telegram blocks the bot', async () => {
    const {repo, sender, subscribe} = setup();
    sender.result = {
      ok: false,
      error: 'Forbidden: bot was blocked by the user',
      retryable: false,
      blocked: true,
    };

    await subscribe(1, {});

    expect(repo.getByChatId(1)?.active).toBe(false);
  });
});

describe('IbdMonitor /ibd status', () => {
  it('returns a snapshot and the subscription view', async () => {
    const {monitor, subscribe} = setup();
    await subscribe(1, {progressPercent: 88.7, verificationProgress: 0.887}, 5);

    const status = await monitor.status(1);
    expect(status.error).toBeNull();
    expect(status.sample?.blocks).toBe(812_345);
    expect(status.subscription?.progressStepPercent).toBe(5);

    const message = monitor.formatStatusMessage(status);
    expect(message).toContain('IBD monitor subscription');
    expect(message).toContain('Step         every 5%');
  });

  it('reports an unreachable node without throwing', async () => {
    const {monitor, sampler, clock, subscribe} = setup();
    await subscribe(1, {});
    clock.advance(31_000);
    sampler.push(new Error('connection refused'));

    const status = await monitor.status(1);
    expect(status.sample).toBeNull();
    expect(status.error).toContain('connection refused');
    expect(monitor.formatStatusMessage(status)).toContain('unreachable');
  });

  it('reports when there is no subscription', async () => {
    const {monitor, sampler} = setup();
    sampler.push(makeSample());
    const status = await monitor.status(1);
    expect(status.subscription).toBeNull();
    expect(monitor.formatStatusMessage(status)).toContain('not subscribed');
  });
});
