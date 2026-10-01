export interface AdaptiveOptions {
  max: number;
  /** Starting concurrency, default min(max, 4). */
  initial?: number;
  /** Failures within `failureWindowMs` needed to step down. */
  failureThreshold?: number;
  failureWindowMs?: number;
  /** Error-free period before stepping back up by one. */
  stableMs?: number;
}

/** Pure AIMD-ish controller: -1 on repeated failures (min 1), +1 after a quiet period (up to max). */
export class AdaptiveConcurrency {
  private cur: number;
  private readonly maxC: number;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly stableMs: number;
  private failures: number[] = [];
  private lastChange = 0;

  constructor(opts: AdaptiveOptions, now = 0) {
    this.maxC = Math.max(1, Math.floor(opts.max));
    this.cur = Math.max(1, Math.min(this.maxC, Math.floor(opts.initial ?? Math.min(this.maxC, 4))));
    this.threshold = opts.failureThreshold ?? 2;
    this.windowMs = opts.failureWindowMs ?? 30_000;
    this.stableMs = opts.stableMs ?? 60_000;
    this.lastChange = now;
  }

  get current(): number {
    return this.cur;
  }
  get max(): number {
    return this.maxC;
  }

  recordFailure(now: number): void {
    this.failures = this.failures.filter((t) => now - t <= this.windowMs);
    this.failures.push(now);
    this.lastChange = now; // any error restarts the quiet period
    if (this.failures.length >= this.threshold && this.cur > 1) {
      this.cur -= 1;
      this.failures = [];
    }
  }

  /** Call periodically; returns true when concurrency increased. */
  tick(now: number): boolean {
    if (this.cur < this.maxC && now - this.lastChange >= this.stableMs) {
      this.cur += 1;
      this.lastChange = now;
      return true;
    }
    return false;
  }
}
