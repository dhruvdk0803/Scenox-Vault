import { formatBytes, formatPercent } from '@scenox/shared';
import { cn } from '@/lib/utils';
import { ProgressBar } from './progress-bar';

export interface StorageMeterProps {
  usedBytes: number;
  /** null/0 = unlimited (no bar, just used label) */
  limitBytes?: number | null;
  warnAt?: number; // fraction, default 0.8
  criticalAt?: number; // fraction, default 0.95
  className?: string;
  showPercent?: boolean;
}

export function StorageMeter({ usedBytes, limitBytes, warnAt = 0.8, criticalAt = 0.95, className, showPercent = true }: StorageMeterProps) {
  if (!limitBytes) {
    return (
      <div className={cn('text-sm tabular-nums text-fg', className)}>
        {formatBytes(usedBytes)} <span className="text-fg-subtle">used · no limit</span>
      </div>
    );
  }
  const fraction = usedBytes / limitBytes;
  const tone = fraction >= criticalAt ? 'danger' : fraction >= warnAt ? 'warning' : 'primary';
  const state = tone === 'danger' ? 'Storage almost full' : tone === 'warning' ? 'Storage running low' : null;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-2 text-sm tabular-nums">
        <span className="font-medium text-fg">
          {formatBytes(usedBytes)} / {formatBytes(limitBytes)}
        </span>
        {showPercent && <span className="text-fg-subtle">{formatPercent(fraction, 0)}</span>}
      </div>
      <ProgressBar value={fraction * 100} tone={tone} label="Storage used" />
      {state && (
        <p className={cn('text-xs font-medium', tone === 'danger' ? 'text-danger' : 'text-warning')}>{state}</p>
      )}
    </div>
  );
}
