'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download } from 'lucide-react';
import { formatBytes, formatNumber, type ExportJobDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge } from '@/components/ui/status-badge';
import { RelativeTime } from '../relative-time';

const OPEN_EVENT = 'sv:exports-open';
/** Ask any mounted ExportsTray to open (called after an export job is created). */
export function openExportsTray() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_EVENT));
}

const isActive = (j: ExportJobDTO) => j.status === 'queued' || j.status === 'processing';

function ExportRow({ initial }: { initial: ExportJobDTO }) {
  const qc = useQueryClient();
  // Poll each in-flight job every 2s until it settles.
  const { data: job = initial } = useQuery({
    queryKey: queryKeys.exports.detail(initial.id),
    queryFn: ({ signal }) => api.get<ExportJobDTO>(`/exports/${initial.id}`, { signal }),
    initialData: initial,
    refetchInterval: (q) => (q.state.data && isActive(q.state.data) ? 2000 : false),
    staleTime: 0,
  });
  const settled = !isActive(job);
  React.useEffect(() => {
    if (settled && !isActive(initial)) return;
    if (settled) void qc.invalidateQueries({ queryKey: queryKeys.exports.list });
  }, [settled, initial, qc]);

  const pct = Math.round(Math.max(0, Math.min(1, job.progress)) * 100);
  return (
    <li className="space-y-2 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg tabular-nums">
            {formatNumber(job.fileCount)} {job.fileCount === 1 ? 'file' : 'files'} · {formatBytes(job.totalBytes)}
          </p>
          <p className="text-xs text-fg-subtle"><RelativeTime date={job.createdAt} /></p>
        </div>
        <StatusBadge kind="export" status={job.status} />
      </div>
      {isActive(job) && (
        <div className="space-y-1">
          <ProgressBar value={job.status === 'queued' ? null : pct} size="sm" label="ZIP export progress" />
          <p className="text-xs tabular-nums text-fg-muted" aria-live="polite">{job.status === 'queued' ? 'Waiting to start…' : `Preparing ZIP… ${pct}%`}</p>
        </div>
      )}
      {job.status === 'ready' && (
        <Button size="sm" asChild className="w-full">
          <a href={job.downloadUrl ?? `/api/exports/${job.id}/download`}>
            <Download aria-hidden /> Download ZIP{job.outputSize ? ` (${formatBytes(job.outputSize)})` : ''}
          </a>
        </Button>
      )}
      {job.status === 'failed' && <p className="text-xs text-danger">{job.error ?? 'The export failed. Try again with fewer files.'}</p>}
      {job.status === 'expired' && <p className="text-xs text-fg-subtle">This export has expired. Start a new one.</p>}
    </li>
  );
}

/** Popover listing the user's recent ZIP exports; polls in-flight jobs every 2 seconds. */
export function ExportsTray() {
  const canExport = usePermission('files.download');
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, h);
    return () => window.removeEventListener(OPEN_EVENT, h);
  }, []);

  const { data } = useQuery({
    queryKey: queryKeys.exports.list,
    queryFn: ({ signal }) => api.get<ExportJobDTO[]>('/exports', { signal }),
    enabled: canExport,
    refetchInterval: (q) => (q.state.data?.some(isActive) ? 2000 : 30_000),
  });
  if (!canExport) return null;
  const jobs = (data ?? []).slice(0, 8);
  const activeCount = jobs.filter(isActive).length;
  const readyCount = jobs.filter((j) => j.status === 'ready').length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Exports${activeCount ? `, ${activeCount} in progress` : ''}`}>
          <Archive aria-hidden /> Exports
          {(activeCount > 0 || readyCount > 0) && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">{activeCount || readyCount}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <h3 className="text-sm font-semibold text-fg">ZIP exports</h3>
        {jobs.length === 0 ? (
          <p className="mt-2 text-sm text-fg-muted">No exports yet. Select several files and choose Download to build a ZIP.</p>
        ) : (
          <ul className="mt-1 max-h-96 divide-y divide-border overflow-y-auto">
            {jobs.map((j) => (
              <ExportRow key={j.id} initial={j} />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
