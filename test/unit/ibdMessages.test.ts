import {describe, expect, it} from 'vitest';
import {
  formatEvent,
  formatIbdFinished,
  formatMonitorStatus,
  formatRecovered,
  formatRegression,
  formatSnapshot,
  formatStall,
  formatUnreachable,
} from '../../src/telegram/ibdMessages';
import {makeSample, syncedSample} from '../helpers';

const snapshotContext = {
  stepPercent: 10,
  speedBlocksPerMinute: 1240,
  speedWindowMinutes: 10,
  etaMinutes: 83.13,
};

describe('formatSnapshot — IBD', () => {
  it('renders the aligned snapshot from the plan', () => {
    const message = formatSnapshot(makeSample(), snapshotContext);

    expect(message).toContain('🟡 Node is in IBD (initial block download)');
    expect(message).toContain('Chain        main');
    expect(message).toContain('Blocks       812,345 / 915,432  (88.7%)');
    expect(message).toContain('Headers      915,432');
    expect(message).toContain('Verified     88.73%');
    expect(message).toContain('Remaining    103,087 blocks');
    expect(message).toContain(
      'Speed        1,240 blocks/min  (10 min average)',
    );
    expect(message).toContain('ETA          ~1 h 23 min');
    expect(message).toContain('Progress     88.7%  (step: every 10%)');
    expect(message).toContain('Next update  at 90.0%');
    expect(message).toContain(
      'Tip          00000000000000000001…  (2026-11-08 14:02 UTC)',
    );
    expect(message).toContain('Disk         612.4 GiB  (pruned: no)');
    expect(message).toContain('Peers        8  (in 2 / out 6)');
    expect(message).toContain('Warnings     none');
    expect(message).toContain('Sampled      2026-11-08 14:07:31 UTC');
    expect(message.startsWith('<pre>')).toBe(false);
    expect(message).toContain('<pre>\n');
    expect(message.trimEnd().endsWith('</pre>')).toBe(true);
  });

  it('shows a collecting-samples placeholder until speed is known', () => {
    const message = formatSnapshot(makeSample(), {
      stepPercent: 10,
      speedBlocksPerMinute: null,
      etaMinutes: null,
    });
    expect(message).toContain('Speed        collecting samples…');
    expect(message).toContain('ETA          collecting samples…');
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
      {stepPercent: 10, speedBlocksPerMinute: null, etaMinutes: null},
    );

    expect(message).toContain('Blocks       0 / 0  (waiting for headers)');
    expect(message).toContain('Status       waiting for headers from peers');
    expect(message).not.toContain('Remaining');
    expect(message).not.toContain('ETA');
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

  it('renders an assumeutxo background chainstate', () => {
    const sample = makeSample({
      blocks: 800_000,
      progressPercent: 66.8,
      verificationProgress: 0.668,
      assumeUtxo: {
        active: {
          blocks: 915_432,
          headers: 915_432,
          bestBlockHash: 'a'.repeat(64),
          verificationProgress: 0.99999,
          validated: true,
          snapshotBlockHash: 'a'.repeat(64),
        },
        background: {
          blocks: 612_004,
          headers: 915_432,
          bestBlockHash: 'b'.repeat(64),
          verificationProgress: 0.668,
          validated: false,
        },
        snapshotBlockHash: 'a'.repeat(64),
      },
    });

    const message = formatSnapshot(sample, snapshotContext);
    expect(message).toContain('🟡 Node is catching up (assumeutxo)');
    expect(message).toContain(
      'Active       915,432 / 915,432  · validated: yes',
    );
    expect(message).toContain(
      'Background   612,004 / 915,432  (66.9%)  · validated: no',
    );
    expect(message).toContain('Progress     66.8%  (step: every 10%)');
    expect(message).toContain('Next update  at 70.0%');
    expect(message).toContain('ETA (bg)     ~1 h 23 min');
    expect(message).toContain('Snapshot     base aaaaaaaaaaaaaaaaaaaaaaaa…');
  });
});

describe('formatSnapshot — synced', () => {
  it('renders the synced table', () => {
    const message = formatSnapshot(syncedSample(), {
      stepPercent: 10,
      speedBlocksPerMinute: 0,
      etaMinutes: null,
    });
    expect(message).toContain('✅ Node is not in IBD — chain is synced');
    expect(message).toContain('Blocks       915,432 / 915,432  (0 behind)');
    expect(message).toContain('Verified     99.999%');
    expect(message).not.toContain('Progress');
    expect(message).not.toContain('Next update');
  });

  it('includes assumeutxo state even after the active chain is at the tip', () => {
    const message = formatSnapshot(
      syncedSample({
        assumeUtxo: {
          active: {
            blocks: 915_432,
            headers: 915_432,
            bestBlockHash: 'a'.repeat(64),
            verificationProgress: 0.99999,
            validated: true,
          },
          background: {
            blocks: 700_000,
            headers: 915_432,
            bestBlockHash: 'b'.repeat(64),
            verificationProgress: 0.76,
            validated: false,
          },
        },
      }),
      snapshotContext,
    );

    expect(message).toContain('✅ Node is not in IBD — chain is synced');
    expect(message).toContain(
      'Background   700,000 / 915,432  (76.5%)  · validated: no',
    );
  });
});

describe('event messages', () => {
  it('formats completion', () => {
    const message = formatIbdFinished(syncedSample());
    expect(message).toContain('✅ IBD finished — node is fully synced');
    expect(message).toContain('Blocks 915,432 / 915,432');
    expect(message).toContain('verification 99.999%');
  });

  it('formats a stall with context and checks', () => {
    const message = formatStall(
      makeSample({peers: {total: 0, inbound: 0, outbound: 0}}),
      18,
    );
    expect(message).toContain('⚠️ IBD appears stalled');
    expect(message).toContain(
      'No new blocks for 18 min (last #812,345). Peers: 0. Verification: 88.73%.',
    );
    expect(message).toContain('bitcoin-cli getnetworkinfo');
  });

  it('formats a regression', () => {
    const message = formatRegression(
      makeSample({blocks: 812_345}),
      makeSample({blocks: 0}),
    );
    expect(message).toContain('🔻 Node regressed / is reindexing');
    expect(message).toContain(
      'Blocks dropped from 812,345 to 0 while headers stayed at 915,432',
    );
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
    expect(message).toContain('I will keep retrying every 60 s.');
  });

  it('formats a recovery snapshot', () => {
    const message = formatRecovered(makeSample());
    expect(message).toContain('✅ Node reachable again — monitoring resumed');
    expect(message).toContain('Blocks       812,345 / 915,432  (88.7%)');
  });

  it('detects completion and regression generically', () => {
    const prev = makeSample({
      blocks: 1000,
      headers: 2000,
      initialBlockDownload: true,
    });
    const synced = syncedSample();
    expect(formatEvent(prev, synced)).toContain('IBD finished');
    expect(
      formatEvent(prev, makeSample({blocks: 900, headers: 2000})),
    ).toContain('regressed');
    expect(
      formatEvent(prev, makeSample({blocks: 1005, headers: 2000})),
    ).toBeNull();
  });

  it('formats subscription status', () => {
    const message = formatMonitorStatus(
      {
        progressStepPercent: 10,
        active: true,
        lastState: 'ibd',
        lastSentProgress: 88.73,
        lastSentAt: '2026-11-08T14:07:31.000Z',
      },
      makeSample(),
    );
    expect(message).toContain('📊 IBD monitor subscription');
    expect(message).toContain('Monitoring   yes');
    expect(message).toContain('Step         every 10%');
    expect(message).toContain('Last state   ibd');
    expect(message).toContain('Next update  at 90.0%');
    expect(message).toContain('2026-11-08 14:07:31 UTC');
  });
});
