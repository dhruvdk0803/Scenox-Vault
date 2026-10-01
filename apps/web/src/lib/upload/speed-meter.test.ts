import { describe, expect, it } from 'vitest';
import { computeEta, SpeedMeter } from './speed-meter';
import { formatEta } from './format';

describe('SpeedMeter', () => {
  it('reports 0 until it has two samples', () => {
    const m = new SpeedMeter();
    expect(m.speed(0)).toBe(0);
    m.record(0, 0);
    expect(m.speed(0)).toBe(0);
  });

  it('converges to a constant rate', () => {
    const m = new SpeedMeter();
    for (let t = 0; t <= 10_000; t += 200) m.record((t / 1000) * 5_000_000, t);
    expect(m.speed()).toBeCloseTo(5_000_000, -3);
    expect(m.average()).toBeCloseTo(5_000_000, -3);
  });

  it('smooths over roughly the window when the rate changes', () => {
    const m = new SpeedMeter(3000);
    let bytes = 0;
    for (let t = 0; t <= 10_000; t += 100) m.record((bytes += 100_000), t); // 1 MB/s
    const before = m.speed();
    for (let t = 10_100; t <= 11_000; t += 100) m.record((bytes += 1_000_000), t); // jump to 10 MB/s for 1s
    const after = m.speed();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(10_000_000 * 0.6); // not yet converged after 1s of a 3s window
  });

  it('is independent of sample frequency', () => {
    const fast = new SpeedMeter();
    const slow = new SpeedMeter();
    for (let t = 0; t <= 9000; t += 100) fast.record(t * 1000, t);
    for (let t = 0; t <= 9000; t += 500) slow.record(t * 1000, t);
    expect(fast.speed()).toBeCloseTo(slow.speed(), -4);
  });

  it('decays when samples stop (stalled connection)', () => {
    const m = new SpeedMeter();
    for (let t = 0; t <= 5000; t += 100) m.record(t * 1000, t);
    const live = m.speed(5000);
    expect(m.speed(9000)).toBeLessThan(live * 0.6);
    expect(m.speed(60_000)).toBe(0);
  });

  it('ignores rewinds and excludes long gaps from the average', () => {
    const m = new SpeedMeter();
    m.record(0, 0);
    m.record(1_000_000, 1000); // 1 MB/s for 1 s
    m.record(500_000, 1500); // rewound to a lower server offset: re-baselined, not counted
    m.record(1_500_000, 2500); // +1 MB over 1 s
    m.record(2_500_000, 62_500); // +1 MB over 60 s (paused): bytes counted, time not
    expect(m.average()).toBeCloseTo(3_000_000 / 2, -3);
  });

  it('tracks how long the estimate has been stable', () => {
    const m = new SpeedMeter();
    expect(m.stableMs(1000)).toBe(0);
    m.record(0, 0);
    m.record(1000, 200);
    expect(m.stableMs(2200)).toBe(2000);
    m.reset();
    expect(m.stableMs(2200)).toBe(0);
  });
});

describe('computeEta / formatEta', () => {
  it('is unknown until the speed has been stable for 2s', () => {
    expect(computeEta(1000, 100, 500)).toBeNull();
    expect(computeEta(1000, 0, 5000)).toBeNull();
    expect(computeEta(1000, 100, 2000)).toBe(10);
  });
  it('is 0 when nothing remains', () => {
    expect(computeEta(0, 0, 0)).toBe(0);
  });
  it('formats', () => {
    expect(formatEta(null)).toBe('—');
    expect(formatEta(0.2)).toBe('< 1s');
    expect(formatEta(31)).toBe('31s');
    expect(formatEta(692)).toBe('11m 32s');
  });
});
