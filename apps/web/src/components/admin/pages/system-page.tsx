'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Cpu, HardDrive, MemoryStick, MinusCircle, Network, XCircle } from 'lucide-react';
import { formatBytes, formatDuration, formatNumber, formatSpeed, type SystemHealthDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { StorageMeter } from '@/components/ui/storage-meter';
import { ErrorState } from '../query-state';
import { RelativeTime } from '../relative-time';

type Check = SystemHealthDTO['checks'][number];
type Queue = SystemHealthDTO['queues'][number];

const OVERALL = {
  ok: { label: 'All systems operational', Icon: CheckCircle2, cls: 'border-success-border bg-success-bg text-success' },
  degraded: { label: 'Degraded performance', Icon: AlertTriangle, cls: 'border-warning-border bg-warning-bg text-warning' },
  down: { label: 'System outage', Icon: XCircle, cls: 'border-danger-border bg-danger-bg text-danger' },
} as const;

const CHECK_LABEL: Record<Check['name'], string> = { database: 'Database', redis: 'Redis', storage: 'Storage', worker: 'Background worker', clamav: 'Virus scanner (ClamAV)', smtp: 'Email (SMTP)' };

function Metric({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between"><CardTitle className="text-sm font-medium text-fg-muted">{title}</CardTitle><span className="text-fg-subtle [&_svg]:size-4" aria-hidden>{icon}</span></CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

export function SystemPage() {
  const { data, isPending, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: queryKeys.system,
    queryFn: ({ signal }) => api.get<SystemHealthDTO>('/system', { signal }),
    refetchInterval: 10_000,
  });

  const checkCols: DataTableColumn<Check>[] = [
    { key: 'name', header: 'Service', cell: (c) => <span className="font-medium">{CHECK_LABEL[c.name] ?? c.name}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (c) =>
        c.status === 'ok' ? <Badge tone="success"><CheckCircle2 aria-hidden /> Healthy</Badge>
        : c.status === 'down' ? <Badge tone="danger"><XCircle aria-hidden /> Down</Badge>
        : <Badge tone="neutral"><MinusCircle aria-hidden /> Disabled</Badge>,
    },
    { key: 'latency', header: 'Latency', align: 'right', cell: (c) => <span className="tabular-nums text-fg-muted">{c.latencyMs != null ? `${formatNumber(Math.round(c.latencyMs))} ms` : '—'}</span> },
    { key: 'message', header: 'Details', className: 'hidden md:table-cell', cell: (c) => <span className="text-fg-muted">{c.message ?? '—'}</span> },
  ];
  const queueCols: DataTableColumn<Queue>[] = [
    { key: 'name', header: 'Queue', cell: (q) => <span className="font-medium">{q.name}</span> },
    { key: 'waiting', header: 'Waiting', align: 'right', cell: (q) => <span className="tabular-nums">{formatNumber(q.waiting)}</span> },
    { key: 'active', header: 'Active', align: 'right', cell: (q) => <span className="tabular-nums">{formatNumber(q.active)}</span> },
    { key: 'failed', header: 'Failed', align: 'right', cell: (q) => <span className={cn('tabular-nums', q.failed > 0 && 'font-medium text-danger')}>{formatNumber(q.failed)}</span> },
    { key: 'completed', header: 'Completed', align: 'right', cell: (q) => <span className="tabular-nums text-fg-muted">{formatNumber(q.completed)}</span> },
  ];

  if (error && !data) return <><PageHeader title="System health" /><Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load system health" /></Card></>;

  const o = data ? OVERALL[data.status] : null;
  return (
    <>
      <PageHeader
        title="System health"
        description={data ? <>Version {data.version} · up {formatDuration(data.uptimeSeconds)} · refreshes every 10 seconds{dataUpdatedAt ? <> · updated <RelativeTime date={new Date(dataUpdatedAt)} /></> : null}</> : 'Server resources and service status.'}
      />
      <div className="space-y-6">
        {o ? (
          <div role={data!.status === 'ok' ? 'status' : 'alert'} className={cn('flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm font-medium', o.cls)}>
            <o.Icon className="size-4" aria-hidden /> {o.label}
          </div>
        ) : <Skeleton className="h-12" />}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Metric title="CPU" icon={<Cpu />}>
            {isPending ? <Skeleton className="h-20" /> : (
              <>
                <p className="text-2xl font-semibold tabular-nums">{data!.cpu.usagePercent.toFixed(0)}%</p>
                <ProgressBar value={data!.cpu.usagePercent} tone={data!.cpu.usagePercent >= 90 ? 'danger' : data!.cpu.usagePercent >= 75 ? 'warning' : 'primary'} label="CPU usage" />
                <p className="text-xs tabular-nums text-fg-subtle">Load {data!.cpu.loadAvg.map((l) => l.toFixed(2)).join(' · ')} · {data!.cpu.cores} cores</p>
              </>
            )}
          </Metric>
          <Metric title="Memory" icon={<MemoryStick />}>
            {isPending ? <Skeleton className="h-20" /> : (
              <>
                <StorageMeter usedBytes={data!.memory.usedBytes} limitBytes={data!.memory.totalBytes} warnAt={0.85} criticalAt={0.95} />
                <p className="text-xs tabular-nums text-fg-subtle">App process: {formatBytes(data!.memory.processRssBytes)}</p>
              </>
            )}
          </Metric>
          <Metric title="Disk" icon={<HardDrive />}>
            {isPending ? <Skeleton className="h-20" /> : (
              <>
                <StorageMeter usedBytes={data!.disk.usedBytes} limitBytes={data!.disk.totalBytes} warnAt={0.85} criticalAt={0.95} />
                <p className="text-xs tabular-nums text-fg-subtle">{formatBytes(data!.disk.freeBytes)} free</p>
              </>
            )}
          </Metric>
          <Metric title="Network" icon={<Network />}>
            {isPending ? <Skeleton className="h-20" /> : (
              <dl className="space-y-3">
                <div className="flex items-center justify-between"><dt className="flex items-center gap-1.5 text-sm text-fg-muted"><ArrowDown className="size-4" aria-hidden /> Receiving</dt><dd className="text-lg font-semibold tabular-nums">{data!.network.rxBytesPerSec != null ? formatSpeed(data!.network.rxBytesPerSec) : '—'}</dd></div>
                <div className="flex items-center justify-between"><dt className="flex items-center gap-1.5 text-sm text-fg-muted"><ArrowUp className="size-4" aria-hidden /> Sending</dt><dd className="text-lg font-semibold tabular-nums">{data!.network.txBytesPerSec != null ? formatSpeed(data!.network.txBytesPerSec) : '—'}</dd></div>
              </dl>
            )}
          </Metric>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Services</h2>
            <DataTable caption="Service checks" columns={checkCols} rows={data?.checks ?? []} getRowId={(c) => c.name} loading={isPending} skeletonRows={6} />
          </section>
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Queues</h2>
            <DataTable caption="Job queues" columns={queueCols} rows={data?.queues ?? []} getRowId={(q) => q.name} loading={isPending} skeletonRows={3} empty={<p className="p-6 text-center text-sm text-fg-subtle">No queues reported.</p>} />
          </section>
        </div>
      </div>
    </>
  );
}
