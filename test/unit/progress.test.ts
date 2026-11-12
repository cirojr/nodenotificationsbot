import {describe, expect, it} from 'vitest';
import {
  nextProgressPercent,
  progressBucket,
  shouldSendProgress,
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

  it('maps progress to step buckets', () => {
    expect(progressBucket(0, 10)).toBe(0);
    expect(progressBucket(9.99, 10)).toBe(0);
    expect(progressBucket(10, 10)).toBe(1);
    expect(progressBucket(88.73, 10)).toBe(8);
    expect(progressBucket(100, 10)).toBe(10);
  });

  it('sends when the bucket advances', () => {
    expect(shouldSendProgress(null, 0, 10)).toBe(true);
    expect(shouldSendProgress(0, 9.9, 10)).toBe(false);
    expect(shouldSendProgress(0, 10, 10)).toBe(true);
    expect(shouldSendProgress(8, 88.73, 10)).toBe(false);
    expect(shouldSendProgress(8, 90, 10)).toBe(true);
    expect(shouldSendProgress(3, 56, 10)).toBe(true);
    expect(shouldSendProgress(10, 100, 10)).toBe(false);
  });
});
