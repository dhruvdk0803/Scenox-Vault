import { formatBytes } from '@scenox/shared';
import { ProgressBar } from '@/components/ui/progress-bar';

/** Storage used with a slim quota meter (when the client has a quota). */
export function QuotaMini({ usedBytes, quotaBytes }: { usedBytes: number; quotaBytes: number | null }) {
  if (!quotaBytes) return <span className="tabular-nums">{formatBytes(usedBytes)}</span>;
  const f = usedBytes / quotaBytes;
  return (
    <div className="flex w-36 flex-col gap-1">
      <span className="text-xs tabular-nums text-fg-muted">
        <span className="font-medium text-fg">{formatBytes(usedBytes)}</span> / {formatBytes(quotaBytes)}
      </span>
      <ProgressBar value={f * 100} size="sm" tone={f >= 0.95 ? 'danger' : f >= 0.8 ? 'warning' : 'primary'} label="Quota used" />
    </div>
  );
}
