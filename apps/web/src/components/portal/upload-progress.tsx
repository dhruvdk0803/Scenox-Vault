'use client';

import * as React from 'react';
import { Pause, Play, Plus, X } from 'lucide-react';
import { formatBytes, formatNumber, formatSpeed } from '@scenox/shared';
import { Button, Card, ConfirmDialog, ProgressBar } from '@/components/ui';
import { formatEta, type UploadSnapshot } from '@/lib/upload';

function headline(s: UploadSnapshot): string {
  if (s.offline) return 'Waiting for connection…';
  if (s.paused) return 'Paused';
  if (s.stats.activeFiles === 0 && s.stats.queuedFiles === 0 && s.stats.pausedFiles > 0) return 'Paused';
  return 'Uploading…';
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums text-fg">{value}</dd>
    </div>
  );
}

export function OverallProgress({
  snapshot, onPauseAll, onResumeAll, onCancelAll, onAddMore,
}: {
  snapshot: UploadSnapshot;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onCancelAll: () => void;
  onAddMore?: () => void;
}) {
  const { stats } = snapshot;
  const [confirm, setConfirm] = React.useState(false);
  const pct = Math.floor(stats.percent);
  const stopped = snapshot.paused || snapshot.offline;
  const hasSpeed = !stopped && stats.speed > 0;

  return (
    <Card className="flex animate-fade-in flex-col gap-5 p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight text-fg" aria-live="polite">
            {headline(snapshot)}
          </h2>
          <p className="text-sm tabular-nums text-fg-muted">
            {formatBytes(stats.bytesUploaded)} / {formatBytes(stats.totalBytes)} · {pct}%
            {hasSpeed && <> · {formatSpeed(stats.speed)}</>}
            {hasSpeed && <> · ETA {formatEta(stats.etaSeconds)}</>}
          </p>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          {onAddMore && (
            <Button variant="outline" size="sm" onClick={onAddMore}>
              <Plus aria-hidden /> Add files
            </Button>
          )}
          {snapshot.paused ? (
            <Button variant="outline" size="sm" onClick={onResumeAll}>
              <Play aria-hidden /> Resume all
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onPauseAll}>
              <Pause aria-hidden /> Pause all
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setConfirm(true)} className="text-danger hover:bg-danger-bg hover:text-danger">
            <X aria-hidden /> Cancel
          </Button>
        </div>
      </div>

      <ProgressBar value={stats.percent} size="lg" label="Overall upload progress" />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label="Current speed" value={hasSpeed ? formatSpeed(stats.speed) : '—'} />
        <Stat label="Average speed" value={stats.avgSpeed > 0 ? formatSpeed(stats.avgSpeed) : '—'} />
        <Stat label="Time left" value={hasSpeed ? formatEta(stats.etaSeconds) : '—'} />
        <Stat label="Files" value={`${formatNumber(stats.completedFiles)} of ${formatNumber(stats.totalFiles)}${stats.failedFiles ? ` · ${stats.failedFiles} failed` : ''}`} />
      </dl>

      <div className="flex gap-2 sm:hidden">
        {snapshot.paused ? (
          <Button variant="outline" className="flex-1" onClick={onResumeAll}>
            <Play aria-hidden /> Resume all
          </Button>
        ) : (
          <Button variant="outline" className="flex-1" onClick={onPauseAll}>
            <Pause aria-hidden /> Pause all
          </Button>
        )}
        <Button variant="outline" className="flex-1 text-danger" onClick={() => setConfirm(true)}>
          <X aria-hidden /> Cancel
        </Button>
      </div>

      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} destructive title="Cancel the upload?"
        description="Files that haven’t finished will be discarded. Files that already uploaded are kept."
        confirmLabel="Cancel upload" cancelLabel="Keep uploading" onConfirm={onCancelAll}
      />
    </Card>
  );
}

/** Sticky phone bar: overall progress + pause/resume. */
export function MobileProgressBar({ snapshot, onPauseAll, onResumeAll }: { snapshot: UploadSnapshot; onPauseAll: () => void; onResumeAll: () => void }) {
  const { stats } = snapshot;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-border bg-surface/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-lg backdrop-blur sm:hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-xs tabular-nums text-fg-muted">
          <span className="font-medium text-fg">{Math.floor(stats.percent)}%</span>
          <span className="truncate">{snapshot.offline ? 'Waiting for connection' : snapshot.paused ? 'Paused' : stats.speed > 0 ? `${formatSpeed(stats.speed)} · ${formatEta(stats.etaSeconds)}` : 'Uploading…'}</span>
        </div>
        <ProgressBar value={stats.percent} label="Overall upload progress" />
      </div>
      <Button variant="outline" size="icon" className="size-11" aria-label={snapshot.paused ? 'Resume all' : 'Pause all'} onClick={snapshot.paused ? onResumeAll : onPauseAll}>
        {snapshot.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
      </Button>
    </div>
  );
}
