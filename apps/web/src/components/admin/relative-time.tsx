'use client';

import { format, formatDistanceToNowStrict } from 'date-fns';
import { Tooltip } from '@/components/ui/tooltip';
import { useNow } from '@/lib/hooks/use-now';

/** "12 minutes ago" with the absolute timestamp in a tooltip. */
export function RelativeTime({ date, className, fallback = '—' }: { date: string | Date | null | undefined; className?: string; fallback?: string }) {
  useNow();
  if (!date) return <span className={className}>{fallback}</span>;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return <span className={className}>{fallback}</span>;
  const diff = Date.now() - d.getTime();
  const label = Math.abs(diff) < 45_000 ? 'just now' : formatDistanceToNowStrict(d, { addSuffix: true });
  return (
    <Tooltip content={format(d, 'PPpp')}>
      <time dateTime={d.toISOString()} className={className ?? 'whitespace-nowrap tabular-nums'}>
        {label}
      </time>
    </Tooltip>
  );
}

export function formatDateTime(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'PPpp');
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'PP');
}
