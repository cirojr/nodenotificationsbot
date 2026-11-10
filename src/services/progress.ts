export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

/** floor(progress / step); step is always >= 1 after validation. */
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
  const next = (progressBucket(progressPercent, step) + 1) * step;
  return next <= 100 ? next : null;
}

/** True when progress crossed into a later bucket (a multi-bucket jump sends once). */
export function shouldSendProgress(
  lastBucket: number | null,
  currentBucket: number,
): boolean {
  return lastBucket === null || currentBucket > lastBucket;
}

export interface SpeedTrackerOptions {
  /** Averaging window in minutes (default 15). */
  windowMinutes: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface SpeedSample {
  at: number;
  blocks: number;
}

/**
 * In-memory ring buffer of recent block heights used for speed and ETA.
 * Samples older than 2x the window are dropped, and the buffer resets when the
 * tip moves backwards (reindex / reorg).
 */
export class SpeedTracker {
  private readonly windowMs: number;
  private readonly now: () => number;
  private samples: SpeedSample[] = [];
  private readonly maxSamples = 2_000;

  constructor(options: SpeedTrackerOptions) {
    this.windowMs = Math.max(1, options.windowMinutes) * 60_000;
    this.now = options.now ?? Date.now;
  }

  add(blocks: number, at = this.now()): void {
    const last = this.samples[this.samples.length - 1];
    if (last && blocks < last.blocks) {
      this.samples = [];
    }
    this.samples.push({at, blocks});

    const cutoff = at - this.windowMs * 2;
    this.samples = this.samples.filter(sample => sample.at >= cutoff);
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(this.samples.length - this.maxSamples);
    }
  }

  clear(): void {
    this.samples = [];
  }

  get size(): number {
    return this.samples.length;
  }

  private windowSamples(now = this.now()): SpeedSample[] {
    const cutoff = now - this.windowMs;
    return this.samples.filter(sample => sample.at >= cutoff);
  }

  /** Blocks per minute over the window, or null until there are >= 2 samples. */
  speedBlocksPerMinute(now = this.now()): number | null {
    const samples = this.windowSamples(now);
    const oldest = samples[0];
    const latest = samples[samples.length - 1];
    if (!oldest || !latest || samples.length < 2) {
      return null;
    }
    const minutes = (latest.at - oldest.at) / 60_000;
    if (minutes <= 0) {
      return null;
    }
    const delta = latest.blocks - oldest.blocks;
    if (delta < 0) {
      return null;
    }
    return delta / minutes;
  }

  /** Actual span covered by the samples used for speed, in minutes. */
  spanMinutes(now = this.now()): number {
    const samples = this.windowSamples(now);
    const oldest = samples[0];
    const latest = samples[samples.length - 1];
    if (!oldest || !latest) {
      return 0;
    }
    return Math.max(0, (latest.at - oldest.at) / 60_000);
  }
}

/** ETA in minutes from remaining blocks and speed, or null when unknown. */
export function estimateEtaMinutes(
  behind: number,
  speedBlocksPerMinute: number | null,
): number | null {
  if (behind <= 0 || speedBlocksPerMinute === null) {
    return null;
  }
  if (!Number.isFinite(speedBlocksPerMinute) || speedBlocksPerMinute <= 0) {
    return null;
  }
  return behind / speedBlocksPerMinute;
}

export function formatEta(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) {
    return 'collecting samples…';
  }
  if (minutes < 1) {
    return '< 1 min';
  }
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours === 0) {
    return `~${mins} min`;
  }
  return `~${hours} h ${String(mins).padStart(2, '0')} min`;
}
