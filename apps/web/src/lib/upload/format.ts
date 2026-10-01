import { formatDuration } from '@scenox/shared';

/** "ETA 31s" style label; "—" while unknown. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 1) return '< 1s';
  return formatDuration(seconds);
}

export function percentOf(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}
