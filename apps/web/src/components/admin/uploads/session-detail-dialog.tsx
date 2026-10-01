'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { differenceInSeconds } from 'date-fns';
import { FileX2 } from 'lucide-react';
import { formatBytes, formatDuration, formatNumber, formatSpeed, type FileDTO, type Paginated, type UploadSessionDTO } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { FileTable } from '../files/file-table';
import { ErrorState } from '../query-state';
import { formatDateTime } from '../relative-time';
import { SessionProgress } from '../session-progress';

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-fg">{children}</dd>
    </div>
  );
}

const dash = <span className="text-fg-subtle">—</span>;

export function SessionDetailDialog({ sessionId, onOpenChange }: { sessionId: string | null; onOpenChange: (open: boolean) => void }) {
  const [page, setPage] = React.useState(1);
  React.useEffect(() => setPage(1), [sessionId]);

  const { data: s, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.uploads.detail(sessionId ?? ''),
    queryFn: ({ signal }) => api.get<UploadSessionDTO>(`/uploads/${sessionId}`, { signal }),
    enabled: !!sessionId,
    refetchInterval: (q) => (q.state.data?.status === 'active' ? 5000 : false),
  });
  const active = s?.status === 'active';

  const fileParams = { uploadSessionId: sessionId ?? undefined, page, pageSize: 25, sort: 'createdAt', order: 'desc' };
  const files = useQuery({
    queryKey: queryKeys.files.list(fileParams),
    queryFn: ({ signal }) => api.get<Paginated<FileDTO>>(`/files${qs(fileParams)}`, { signal }),
    enabled: !!sessionId,
    placeholderData: keepPreviousData,
    refetchInterval: active ? 5000 : false,
  });

  const duration = s ? differenceInSeconds(new Date(s.completedAt ?? s.lastActivityAt), new Date(s.startedAt)) : null;

  return (
    <Dialog open={!!sessionId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Upload session
            {s && <StatusBadge kind="session" status={s.status} />}
          </DialogTitle>
          <DialogDescription>{s ? `${s.clientName} · ${s.portalName}` : 'Loading session…'}</DialogDescription>
        </DialogHeader>

        {error && !s ? (
          <ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load this session" />
        ) : isPending || !s ? (
          <div className="space-y-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>
        ) : (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-surface-muted/50 p-4">
              <div className="mb-2 flex items-baseline justify-between gap-2 text-sm tabular-nums">
                <span className="font-medium">{formatNumber(s.uploadedFiles)} of {formatNumber(s.totalFiles)} files</span>
                {s.failedFiles > 0 && <span className="text-danger">{formatNumber(s.failedFiles)} failed</span>}
              </div>
              <SessionProgress session={s} className="[&>div:first-child]:h-2" />
              {!active && s.totalBytes > 0 && (
                <p className="mt-1 text-xs tabular-nums text-fg-subtle">{formatBytes(s.uploadedBytes)} of {formatBytes(s.totalBytes)} uploaded</p>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <Item label="Client"><Link href={`/clients/${s.clientId}`} className="font-medium underline-offset-2 hover:underline">{s.clientName}</Link></Item>
              <Item label="Portal"><Link href={`/portals/${s.portalId}`} className="font-medium underline-offset-2 hover:underline">{s.portalName}</Link></Item>
              <Item label="Uploader">{s.uploaderName ?? dash}</Item>
              <Item label="Email">{s.uploaderEmail ?? dash}</Item>
              <Item label="Company">{s.uploaderCompany ?? dash}</Item>
              <Item label="IP address"><span className="font-mono text-xs">{s.ip ?? '—'}</span></Item>
              <Item label="Started"><span className="tabular-nums">{formatDateTime(s.startedAt)}</span></Item>
              <Item label="Last activity"><span className="tabular-nums">{formatDateTime(s.lastActivityAt)}</span></Item>
              <Item label="Completed"><span className="tabular-nums">{formatDateTime(s.completedAt)}</span></Item>
              <Item label="Duration"><span className="tabular-nums">{formatDuration(duration)}</span></Item>
              <Item label="Average speed"><span className="tabular-nums">{s.avgSpeedBps ? formatSpeed(s.avgSpeedBps) : '—'}</span></Item>
              <Item label="Session ID"><span className="font-mono text-xs">{s.id}</span></Item>
            </dl>

            {s.message && (
              <div>
                <h3 className="mb-1.5 text-sm font-semibold text-fg">Message from uploader</h3>
                <p className="whitespace-pre-wrap rounded-lg border border-border bg-surface-muted/50 p-3 text-sm text-fg">{s.message}</p>
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-semibold text-fg">Files in this session</h3>
              {files.error && !files.data ? (
                <ErrorState error={files.error} onRetry={() => files.refetch()} retrying={files.isFetching} title="Couldn't load files" />
              ) : (
                <div className="space-y-3">
                  <FileTable
                    files={files.data?.items ?? []}
                    loading={files.isPending}
                    selectable={false}
                    selectedIds={new Set()}
                    onSelectionChange={() => undefined}
                    empty={<EmptyState icon={<FileX2 />} title="No files yet" description="Files appear here as soon as they start uploading." />}
                  />
                  {files.data && files.data.total > 25 && <Pagination page={page} pageSize={25} total={files.data.total} onPageChange={setPage} />}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
