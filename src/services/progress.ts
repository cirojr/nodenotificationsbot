export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

/** The percentage bucket the current progress falls into. */
export function progressBucket(
  progressPercent: number,
  stepPercent: number,
): number {
  const step = stepPercent > 0 ? stepPercent : 1;
  return Math.floor(clampPercent(progressPercent) / step);
}

/** The next percentage that will trigger an update, or null at 100%. */
export function nextProgressPercent(
  progressPercent: number,
  stepPercent: number,
): number | null {
  const step = stepPercent > 0 ? stepPercent : 1;
  const next = (Math.floor(clampPercent(progressPercent) / step) + 1) * step;
  return next <= 100 ? next : null;
}

/**
 * True when the current progress has moved into a new step bucket. A
 * multi-step jump still sends only one message.
 */
export function shouldSendProgress(
  lastBucket: number | null,
  currentProgressPercent: number,
  stepPercent: number,
): boolean {
  if (lastBucket === null) {
    return true;
  }
  return progressBucket(currentProgressPercent, stepPercent) > lastBucket;
}
