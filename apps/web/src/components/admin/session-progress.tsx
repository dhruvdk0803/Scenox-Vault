import { formatBytes } from '@scenox/shared';
import type { UploadSessionDTO } from '@scenox/shared';
import { ProgressBar } from '@/components/ui/progress-bar';
import { cn } from '@/lib/utils';

export function sessionPercent(s: Pick<UploadSessionDTO, 'uploadedBytes' | 'totalBytes'>): number {
  if (!s.totalBytes) return 0;
  return Math.max(0, Math.min(100, (s.uploadedBytes / s.totalBytes) * 100));
}

/** Data transferred for a session; shows a progress bar + % while the session is active. */
export function SessionProgress({ session, className }: { session: UploadSessionDTO; className?: string }) {
  if (session.status !== 'active') {
    return (
      <span className={cn('tabular-nums', className)}>
        {formatBytes(session.uploadedBytes)}
        {session.totalBytes > 0 && session.uploadedBytes < session.totalBytes && <span className="text-fg-subtle"> / {formatBytes(session.totalBytes)}</span>}
      </span>
    );
  }
  const pct = sessionPercent(session);
  return (
    <div className={cn('flex min-w-36 flex-col gap-1', className)}>
      <ProgressBar value={session.totalBytes ? pct : null} size="sm" label={`${session.clientName} upload progress`} />
      <div className="flex justify-between gap-2 text-xs tabular-nums text-fg-subtle">
        <span>
          {formatBytes(session.uploadedBytes)} / {formatBytes(session.totalBytes)}
        </span>
        {session.totalBytes > 0 && <span className="font-medium text-fg-muted">{Math.round(pct)}%</span>}
      </div>
    </div>
  );
}
