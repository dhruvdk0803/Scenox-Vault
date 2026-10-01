import { describe, expect, it } from 'vitest';
import { AdaptiveConcurrency } from './adaptive-concurrency';

describe('AdaptiveConcurrency', () => {
  it('starts at min(max, 4)', () => {
    expect(new AdaptiveConcurrency({ max: 8 }).current).toBe(4);
    expect(new AdaptiveConcurrency({ max: 2 }).current).toBe(2);
  });

  it('steps down on repeated failures, never below 1', () => {
    const c = new AdaptiveConcurrency({ max: 6 });
    c.recordFailure(1000);
    expect(c.current).toBe(4); // a single failure is tolerated
    c.recordFailure(2000);
    expect(c.current).toBe(3);
    for (let i = 0; i < 20; i++) c.recordFailure(3000 + i);
    expect(c.current).toBe(1);
  });

  it('does not count failures that are far apart', () => {
    const c = new AdaptiveConcurrency({ max: 6 });
    c.recordFailure(0);
    c.recordFailure(40_000);
    expect(c.current).toBe(4);
  });

  it('steps back up one at a time after a quiet period, up to max', () => {
    const c = new AdaptiveConcurrency({ max: 5 });
    c.recordFailure(0);
    c.recordFailure(1);
    expect(c.current).toBe(3);
    expect(c.tick(30_000)).toBe(false);
    expect(c.tick(61_000)).toBe(true);
    expect(c.current).toBe(4);
    expect(c.tick(100_000)).toBe(false);
    expect(c.tick(122_000)).toBe(true);
    expect(c.current).toBe(5);
    expect(c.tick(500_000)).toBe(false);
  });

  it('an error restarts the quiet period', () => {
    const c = new AdaptiveConcurrency({ max: 5, initial: 3 });
    c.recordFailure(50_000);
    expect(c.tick(70_000)).toBe(false);
    expect(c.tick(111_000)).toBe(true);
  });
});
