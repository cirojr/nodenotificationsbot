import {describe, expect, it} from 'vitest';
import {
  formatIbdFinished,
  formatRecovered,
  formatSnapshot,
  formatUnreachable,
} from '../../src/telegram/ibdMessages';
import {makeSample, syncedSample} from '../helpers';

const snapshotContext = {stepPercent: 10};

describe('formatSnapshot — IBD', () => {
  it('renders the aligned snapshot', () => {
    const message = formatSnapshot(makeSample(), snapshotContext);

    expect(message).toContain('🟡 Node is in IBD — 88.7%');
    expect(message).toContain('Chain        main');
    expect(message).toContain('Blocks       812,345 / 915,432  (88.7%)');
    expect(message).toContain('Headers      915,432');
    expect(message).toContain('Verified     88.73%');
    expect(message).toContain('Remaining    103,087 blocks');
    expect(message).toContain('Progress     88.7%  (step: every 10%)');
    expect(message).toContain('Next update  at 90.0%');
    expect(message).toContain(
      'Tip          00000000000000000001…  (2026-11-08 14:02 UTC)',
    );
    expect(message).toContain('Disk         612.4 GiB  (pruned: no)');
    expect(message).toContain('Peers        8  (in 2 / out 6)');
    expect(message).toContain('Warnings     none');
    expect(message).toContain('Sampled      2026-11-08 14:07:31 UTC');
    expect(message).not.toContain('Speed');
    expect(message).not.toContain('ETA');
    expect(message.startsWith('<pre>')).toBe(false);
    expect(message).toContain('<pre>\n');
    expect(message.trimEnd().endsWith('</pre>')).toBe(true);
  });

  it('handles a fresh node waiting for headers', () => {
    const message = formatSnapshot(
      makeSample({
        blocks: 0,
        headers: 0,
        progressPercent: 0,
        verificationProgress: 0,
        bestBlockHash: '',
        bestBlockTime: null,
        peers: {total: 0, inbound: 0, outbound: 0},
      }),
      snapshotContext,
    );

    expect(message).toContain('Blocks       0 / 0  (waiting for headers)');
    expect(message).toContain('Status       waiting for headers from peers');
    expect(message).not.toContain('Remaining');
    expect(message).not.toContain('Progress');
    expect(message).toContain('Peers        0  (in 0 / out 0)');
  });

  it('escapes node warnings', () => {
    const message = formatSnapshot(
      makeSample({warnings: ['<script>alert(1)</script>']}),
      snapshotContext,
    );
    expect(message).not.toContain('<script>');
    expect(message).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows unknown peers when getnetworkinfo is unavailable', () => {
    const message = formatSnapshot(makeSample({peers: null}), snapshotContext);
    expect(message).toContain('Peers        unknown');
  });
});

describe('formatSnapshot — synced', () => {
  it('renders the synced table', () => {
    const message = formatSnapshot(syncedSample(), snapshotContext);
    expect(message).toContain('✅ Node is not in IBD — chain is synced');
    expect(message).toContain('Blocks       915,432 / 915,432  (0 behind)');
    expect(message).toContain('Verified     99.999%');
    expect(message).not.toContain('Progress');
    expect(message).not.toContain('Next update');
  });
});

describe('event messages', () => {
  it('formats completion', () => {
    const message = formatIbdFinished(syncedSample());
    expect(message).toContain('✅ IBD finished — node is fully synced');
    expect(message).toContain('Blocks 915,432 / 915,432');
    expect(message).toContain('verification 99.999%');
  });

  it('formats and sanitizes unreachable errors', () => {
    const message = formatUnreachable(
      '127.0.0.1:8332',
      'connect ECONNREFUSED <x>',
      60,
    );
    expect(message).toContain('🔌 Node unreachable');
    expect(message).toContain(
      'RPC at 127.0.0.1:8332 did not answer: connect ECONNREFUSED &lt;x&gt;.',
    );
    expect(message).toContain(
      'I will keep checking every 60 s and message you once when the node is reachable again.',
    );
  });

  it('formats a recovery snapshot', () => {
    const message = formatRecovered(makeSample());
    expect(message).toContain('✅ Node reachable again — monitoring resumed');
    expect(message).toContain('Blocks       812,345 / 915,432  (88.7%)');
    expect(message).toContain('Peers        8  (in 2 / out 6)');
  });
});
