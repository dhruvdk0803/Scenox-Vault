import Link from 'next/link';
import { AlertTriangle, OctagonAlert } from 'lucide-react';
import { formatBytes, formatPercent } from '@scenox/shared';
import { cn } from '@/lib/utils';

/** Warning / critical disk banner. Renders nothing when level is "ok". */
export function StorageBanner({
  level, usedBytes, capacityBytes, showLink = true, className,
}: { level: 'ok' | 'warning' | 'critical'; usedBytes: number; capacityBytes: number; showLink?: boolean; className?: string }) {
  if (level === 'ok') return null;
  const critical = level === 'critical';
  const Icon = critical ? OctagonAlert : AlertTriangle;
  const pct = capacityBytes > 0 ? formatPercent(usedBytes / capacityBytes, 0) : '';
  return (
    <div
      role={critical ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border p-4 text-sm', critical ? 'border-danger-border bg-danger-bg text-danger' : 'border-warning-border bg-warning-bg text-warning', className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-semibold">{critical ? 'Disk space is critically low' : 'Disk space is running low'}</p>
        <p className="text-fg-muted">
          {formatBytes(usedBytes)} of {formatBytes(capacityBytes)} used{pct && ` (${pct})`}.{' '}
          {critical ? 'New uploads may start failing. ' : ''}
          Free space by deleting files you no longer need, or move the vault to S3-compatible object storage (S3, R2, Backblaze B2, MinIO) or a larger attached volume — see <code className="rounded bg-surface/70 px-1 text-xs">docs/DEPLOYMENT.md</code>.
          {showLink && (
            <>
              {' '}
              <Link href="/storage" className="font-medium text-fg underline underline-offset-2">View storage details</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
