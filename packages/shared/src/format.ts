const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Human-readable byte size using base-1000 units (matches what OS file managers show). */
export function formatBytes(bytes: number | bigint | null | undefined, decimals = 1): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), UNITS.length - 1);
  const v = n / 1000 ** i;
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : decimals)} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** "11m 32s", "2h 4m", "31s". Returns "—" for unknown. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatNumber(n: number | null | undefined): string {
  return new Intl.NumberFormat('en-US').format(Number(n ?? 0));
}

export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(digits)}%`;
}
