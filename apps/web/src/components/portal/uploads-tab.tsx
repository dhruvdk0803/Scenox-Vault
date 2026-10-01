'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { UploadCloud } from 'lucide-react';
import { formatBytes, formatNumber, type ClientUploadDTO } from '@scenox/shared';
import { Button, Card, EmptyState, Skeleton, StatusBadge } from '@/components/ui';
import { friendlyError, plural, whenFull, whenShort } from '@/lib/portal/format';
import { useUploadHistory } from '@/lib/portal/hooks';
import { usePortal } from './portal-context';
import { InlineError } from './ui-bits';

/** Upload history as a timeline: one entry per batch, newest first. */
export function UploadsTab() {
  const { navigate } = usePortal();
  const q = useUploadHistory();
  const items = q.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Upload history</h1>
        <p className="text-sm text-fg-muted">Every batch of files you’ve sent, newest first.</p>
      </div>

      {q.isError && !q.data && <InlineError message={friendlyError(q.error, 'We couldn’t load your upload history.')} onRetry={() => void q.refetch()} />}

      {q.isLoading ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading uploads">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      ) : q.data && items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<UploadCloud />} title="No uploads yet" description="When you send files, each batch will be listed here."
            action={<Button onClick={() => navigate({ tab: 'upload' })}><UploadCloud aria-hidden /> Upload files</Button>}
          />
        </Card>
      ) : (
        <ol aria-label="Uploads" className="relative flex flex-col gap-4">
          {items.map((u, i) => <UploadEntry key={u.id} u={u} last={i === items.length - 1} />)}
        </ol>
      )}
    </div>
  );
}

function UploadEntry({ u, last }: { u: ClientUploadDTO; last: boolean }) {
  const at = u.completedAt ?? u.startedAt;
  return (
    <li className="relative flex gap-4">
      <div aria-hidden className="relative flex w-3 shrink-0 justify-center">
        <span className="z-10 mt-5 size-2.5 rounded-full border-2 border-primary bg-surface" />
        {!last && <span className="absolute bottom-[-1rem] top-7 w-px bg-border" />}
      </div>
      <Card className="min-w-0 flex-1 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-sm font-semibold text-fg">{u.uploaderName ? `Upload by ${u.uploaderName}` : 'File upload'}</span>
            <StatusBadge kind="session" status={u.status} />
          </div>
          <time dateTime={at} title={whenFull(at)} className="text-xs text-fg-muted">
            <span className="sm:hidden">{whenShort(at)}</span>
            <span className="hidden sm:inline">{format(new Date(at), 'EEE, MMM d, yyyy · h:mm a')}</span>
          </time>
        </div>
        <p className="mt-1.5 text-sm tabular-nums text-fg-muted">
          {formatNumber(u.files)} {plural(u.files, 'file')} · {formatBytes(u.bytes)}
        </p>
        {u.message && (
          <blockquote className="mt-3 whitespace-pre-line break-words rounded-md border-l-2 border-primary-soft-border bg-surface-muted/60 px-3 py-2 text-sm text-fg-muted">
            {u.message}
          </blockquote>
        )}
      </Card>
    </li>
  );
}
