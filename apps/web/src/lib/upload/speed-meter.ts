/**
 * Time-based exponential moving average of throughput.
 * Feed it CUMULATIVE byte counts with timestamps; it derives instantaneous speed per sample and smooths
 * with alpha = 1 - exp(-dt / window), so the result is independent of how often samples arrive.
 */
export class SpeedMeter {
  private ema = 0;
  private hasEma = false;
  private started = false;
  private lastBytes = 0;
  private lastTs = 0;
  private bytes = 0;
  private activeMs = 0;
  private stableSince = 0;

  constructor(
    private readonly windowMs = 3000,
    /** Samples closer together than this are merged into the next one (reduces noise). */
    private readonly minSampleMs = 100,
    /** Gaps longer than this are not counted as active time (pauses, stalls). */
    private readonly maxGapMs = 5000,
  ) {}

  reset(): void {
    this.ema = 0;
    this.hasEma = false;
    this.started = false;
    this.bytes = 0;
    this.activeMs = 0;
    this.stableSince = 0;
  }

  record(cumulativeBytes: number, now: number): void {
    if (!this.started) {
      this.started = true;
      this.lastBytes = cumulativeBytes;
      this.lastTs = now;
      return;
    }
    const dt = now - this.lastTs;
    const db = cumulativeBytes - this.lastBytes;
    if (db < 0) {
      // Progress rewound (e.g. resumed from a lower server offset): re-baseline.
      this.lastBytes = cumulativeBytes;
      this.lastTs = now;
      return;
    }
    if (dt < this.minSampleMs) return;
    const instant = db / (dt / 1000);
    if (!this.hasEma) {
      this.ema = instant;
      this.hasEma = true;
    } else {
      const alpha = 1 - Math.exp(-dt / this.windowMs);
      this.ema += alpha * (instant - this.ema);
    }
    this.bytes += db;
    if (dt <= this.maxGapMs) this.activeMs += dt;
    else this.stableSince = 0;
    if (this.stableSince === 0 && this.ema > 0) this.stableSince = now;
    this.lastBytes = cumulativeBytes;
    this.lastTs = now;
  }

  /** Smoothed bytes/second. Decays toward 0 when no samples arrive (stalled connection). */
  speed(now?: number): number {
    if (!this.hasEma) return 0;
    if (now === undefined) return this.ema;
    const idle = now - this.lastTs - 1000;
    if (idle <= 0) return this.ema;
    if (idle > this.windowMs * 5) return 0;
    return this.ema * Math.exp(-idle / this.windowMs);
  }

  /** Bytes / active time since the last reset. */
  average(): number {
    return this.activeMs > 0 ? this.bytes / (this.activeMs / 1000) : 0;
  }

  /** How long the speed has been continuously measurable (ms). */
  stableMs(now: number): number {
    return this.stableSince > 0 ? Math.max(0, now - this.stableSince) : 0;
  }
}

/** Seconds remaining, or null until the speed estimate has been stable long enough. */
export function computeEta(remainingBytes: number, speed: number, stableMs: number, minStableMs = 2000): number | null {
  if (!(remainingBytes > 0)) return 0;
  if (!(speed > 0) || stableMs < minStableMs) return null;
  return remainingBytes / speed;
}
