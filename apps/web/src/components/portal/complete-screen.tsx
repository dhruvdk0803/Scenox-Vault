'use client';

import { AlertTriangle, CheckCircle2, Plus, RotateCw } from 'lucide-react';
import { formatBytes, formatNumber } from '@scenox/shared';
import { Button, Card } from '@/components/ui';
import type { UploadSnapshot } from '@/lib/upload';
import { QueueList, type QueueActions } from './queue-list';

export function CompleteScreen({
  snapshot, actions, canUploadMore, onUploadMore, onRetryFailed,
}: {
  snapshot: UploadSnapshot;
  actions: QueueActions;
  canUploadMore: boolean;
  onUploadMore: () => void;
  onRetryFailed: () => void;
}) {
  const { stats } = snapshot;
  const failed = stats.failedFiles;
  const allFailed = stats.completedFiles === 0 && failed > 0;
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex animate-fade-in flex-col items-center gap-5 px-6 py-10 text-center shadow-sm sm:py-12">
        <div className={`flex size-16 items-center justify-center rounded-full ${allFailed ? 'bg-warning-bg text-warning' : 'bg-success-bg text-success'}`} aria-hidden>
          {allFailed ? <AlertTriangle className="size-8" /> : <CheckCircle2 className="size-8" />}
        </div>
        <div className="flex flex-col gap-1.5" role="status">
          <h2 className="text-2xl font-semibold tracking-tight text-fg">{allFailed ? 'Upload incomplete' : 'Upload complete'}</h2>
          {stats.completedFiles > 0 && (
            <p className="text-base tabular-nums text-fg-muted">
              {formatBytes(stats.completedBytes)} uploaded successfully · {formatNumber(stats.completedFiles)} {stats.completedFiles === 1 ? 'file' : 'files'}
            </p>
          )}
          {failed > 0 && (
            <p className="text-sm font-medium text-danger">
              {formatNumber(failed)} {failed === 1 ? 'file' : 'files'} couldn’t be uploaded
            </p>
          )}
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {failed > 0 && (
            <Button size="lg" onClick={onRetryFailed}>
              <RotateCw aria-hidden /> Retry failed
            </Button>
          )}
          {canUploadMore && (
            <Button size="lg" variant={failed > 0 ? 'outline' : 'primary'} onClick={onUploadMore}>
              <Plus aria-hidden /> Upload more files
            </Button>
          )}
        </div>
        {failed === 0 && <p className="text-sm text-fg-subtle">You can close this window.</p>}
      </Card>
      {failed > 0 && <QueueList items={snapshot.items} actions={actions} filter="failed" showTabs={false} maxHeight="320px" />}
    </div>
  );
}
