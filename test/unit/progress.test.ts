import {describe, expect, it} from 'vitest';
import {
  estimateEtaMinutes,
  formatEta,
  nextProgressPercent,
  shouldSendProgress,
  SpeedTracker,
} from '../../src/services/progress';

describe('progress steps', () => {
  it('computes the next notification percentage', () => {
    expect(nextProgressPercent(9.5, 10)).toBe(10);
    expect(nextProgressPercent(88.7, 10)).toBe(90);
    expect(nextProgressPercent(34, 10)).toBe(40);
    expect(nextProgressPercent(99.5, 10)).toBe(100);
    expect(nextProgressPercent(100, 10)).toBeNull();
    expect(nextProgressPercent(-5, 10)).toBe(10);
    expect(nextProgressPercent(120, 10)).toBeNull();
  });

  it('sends on the first sample and when the next step is reached', () => {
    expect(shouldSendProgress(null, 0, 10)).toBe(true);
    expect(shouldSendProgress(9.5, 10, 10)).toBe(true);
    expect(shouldSendProgress(10, 10.5, 10)).toBe(false);
    expect(shouldSendProgress(10, 20, 10)).toBe(true);
    expect(shouldSendProgress(34, 56, 10)).toBe(true);
    expect(shouldSendProgress(100, 100, 10)).toBe(false);
  });
});

describe('SpeedTracker', () => {
  it('needs two samples before reporting speed', () => {
    let now = 0;
    const tracker = new SpeedTracker({windowMinutes: 15, now: () => now});
    tracker.add(1000, now);
    expect(tracker.speedBlocksPerMinute(now)).toBeNull();
    now = 5 * 60_000;
    tracker.add(1100, now);
    expect(tracker.speedBlocksPerMinute(now)).toBe(20);
    expect(tracker.spanMinutes(now)).toBe(5);
  });

  it('uses only the configured window', () => {
    let now = 0;
    const tracker = new SpeedTracker({windowMinutes: 10, now: () => now});
    tracker.add(1000, now);
    now = 5 * 60_000;
    tracker.add(1100, now);
    now = 10 * 60_000;
    tracker.add(1400, now);
    now = 15 * 60_000;
    tracker.add(1500, now);
    // Window covers the last 10 min: 1100 @5m … 1500 @15m => 40 blocks/min.
    expect(tracker.speedBlocksPerMinute(now)).toBe(40);
  });

  it('resets on a backwards tip (reindex)', () => {
    let now = 0;
    const tracker = new SpeedTracker({windowMinutes: 15, now: () => now});
    tracker.add(1000, now);
    now = 60_000;
    tracker.add(1100, now);
    tracker.add(0, now);
    expect(tracker.size).toBe(1);
    expect(tracker.speedBlocksPerMinute(now)).toBeNull();
  });
});

describe('ETA', () => {
  it('computes and formats an ETA', () => {
    expect(estimateEtaMinutes(103_087, 1240)).toBeCloseTo(83.13, 1);
    expect(formatEta(83.13)).toBe('~1 h 23 min');
    expect(formatEta(5)).toBe('~5 min');
    expect(formatEta(0.4)).toBe('< 1 min');
    expect(formatEta(null)).toBe('collecting samples…');
  });

  it('returns null without positive speed or remaining work', () => {
    expect(estimateEtaMinutes(0, 100)).toBeNull();
    expect(estimateEtaMinutes(100, 0)).toBeNull();
    expect(estimateEtaMinutes(100, null)).toBeNull();
  });
});
