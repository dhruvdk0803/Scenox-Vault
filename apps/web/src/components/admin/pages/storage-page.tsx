'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Cloud, HardDrive, Info, Trash2 } from 'lucide-react';
import { formatBytes, formatNumber, formatPercent, type StorageDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { StorageMeter } from '@/components/ui/storage-meter';
import { ErrorState } from '../query-state';
import { StorageBanner } from '../storage-banner';

type ClientRow = StorageDTO['byClient'][number];

export function StoragePage() {
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.storage,
    queryFn: ({ signal }) => api.get<StorageDTO>('/storage', { signal }),
    refetchInterval: 30_000,
  });

  const columns: DataTableColumn<ClientRow>[] = [
    { key: 'client', header: 'Client', className: 'min-w-44', cell: (c) => <Link href={`/clients/${c.clientId}`} className="block max-w-64 truncate font-medium hover:underline">{c.clientName}</Link> },
    { key: 'files', header: 'Files', align: 'right', cell: (c) => <span className="tabular-nums">{formatNumber(c.files)}</span> },
    { key: 'bytes', header: 'Used', align: 'right', cell: (c) => <span className="tabular-nums">{formatBytes(c.bytes)}</span> },
    {
      key: 'quota',
      header: 'Quota',
      className: 'min-w-52',
      cell: (c) =>
        c.quotaBytes ? (
          <div className="w-48"><StorageMeter usedBytes={c.bytes} limitBytes={c.quotaBytes} /></div>
        ) : (
          <div className="w-48 space-y-1">
            <p className="text-xs tabular-nums text-fg-subtle">No quota · {data && data.vaultUsedBytes > 0 ? formatPercent(c.bytes / data.vaultUsedBytes, 0) : '0%'} of vault</p>
            <ProgressBar size="sm" tone="neutral" value={data && data.vaultUsedBytes > 0 ? (c.bytes / data.vaultUsedBytes) * 100 : 0} label={`${c.clientName} share of vault`} />
          </div>
        ),
    },
  ];

  if (error && !data) return <><PageHeader title="Storage" /><Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load storage" /></Card></>;

  const s3 = data?.driver === 's3';
  return (
    <>
      <PageHeader title="Storage" description="Disk usage, what's taking space, and temporary data." />
      <div className="space-y-6">
        {data && !s3 && <StorageBanner level={data.warningLevel} usedBytes={data.disk.usedBytes} capacityBytes={data.disk.totalBytes} showLink={false} />}

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>{s3 ? 'Object storage' : 'Disk usage'}</CardTitle><CardDescription>{s3 ? 'Files are stored in an S3-compatible bucket.' : (data?.disk.path ?? 'Server disk')}</CardDescription></CardHeader>
            <CardContent>
              {isPending ? <Skeleton className="h-20" /> : s3 ? (
                <p className="text-2xl font-semibold tabular-nums">{formatBytes(data!.vaultUsedBytes)} <span className="text-base font-normal text-fg-subtle">in the vault</span></p>
              ) : (
                <div className="space-y-4">
                  <StorageMeter usedBytes={data!.disk.usedBytes} limitBytes={data!.disk.totalBytes} warnAt={0.85} criticalAt={0.95} />
                  <dl className="grid grid-cols-3 gap-4 text-sm">
                    <div><dt className="text-xs text-fg-subtle">Total</dt><dd className="font-semibold tabular-nums">{formatBytes(data!.disk.totalBytes)}</dd></div>
                    <div><dt className="text-xs text-fg-subtle">Used</dt><dd className="font-semibold tabular-nums">{formatBytes(data!.disk.usedBytes)}</dd></div>
                    <div><dt className="text-xs text-fg-subtle">Free</dt><dd className="font-semibold tabular-nums">{formatBytes(data!.disk.freeBytes)}</dd></div>
                  </dl>
                </div>
              )}
            </CardContent>
          </Card>
          <StatCard label="Vault data" icon={<HardDrive />} loading={isPending} value={formatBytes(data?.vaultUsedBytes)} subText={data && !s3 && data.disk.totalBytes ? `${formatPercent(data.vaultUsedBytes / data.disk.totalBytes, 1)} of disk` : 'Files uploaded by clients'} className="justify-center" />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Incomplete uploads" loading={isPending} value={formatNumber(data?.temp.incompleteUploads)} subText="Cleaned up automatically (see Settings → Retention)" />
          <StatCard label="Incomplete upload data" loading={isPending} value={formatBytes(data?.temp.incompleteBytes)} />
          <StatCard label="ZIP export temp data" icon={<Trash2 />} loading={isPending} value={formatBytes(data?.temp.exportsBytes)} />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            <h2 className="text-base font-semibold">By client</h2>
            <DataTable
              caption="Storage by client"
              columns={columns}
              rows={data?.byClient ?? []}
              getRowId={(c) => c.clientId}
              loading={isPending}
              empty={<EmptyState icon={<HardDrive />} title="No stored files yet" description="Storage per client appears here once files are uploaded." />}
            />
          </div>
          <div className="space-y-3">
            <h2 className="text-base font-semibold">By file status</h2>
            <Card>
              <CardContent className="p-0">
                {isPending ? <div className="p-5"><Skeleton className="h-32" /></div> : data!.byStatus.length === 0 ? (
                  <p className="p-5 text-sm text-fg-subtle">No files yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {data!.byStatus.map((r) => (
                      <li key={r.status} className="flex items-center justify-between gap-3 px-5 py-3">
                        <StatusBadge kind="file" status={r.status} />
                        <span className="text-right text-sm tabular-nums"><span className="font-medium">{formatBytes(r.bytes)}</span><span className="block text-xs text-fg-subtle">{formatNumber(r.files)} files</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <Card className="border-primary-soft-border bg-primary-soft/40">
          <CardContent className="flex gap-4">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"><Cloud className="size-5" aria-hidden /></span>
            <div className="space-y-2 text-sm">
              <h2 className="flex items-center gap-1.5 text-base font-semibold">Running out of space? <Info className="size-4 text-fg-subtle" aria-hidden /></h2>
              <p className="text-fg-muted">You have a few options, from quickest to most scalable:</p>
              <ul className="list-disc space-y-1 pl-5 text-fg-muted">
                <li><strong className="font-medium text-fg">Delete what you don&apos;t need.</strong> Remove old client files and expired exports from the Files page.</li>
                <li><strong className="font-medium text-fg">Attach a larger volume.</strong> Grow the disk or mount a new volume and point the vault data directory at it.</li>
                <li><strong className="font-medium text-fg">Move to object storage.</strong> Switch the storage driver to any S3-compatible service — Amazon S3, Cloudflare R2, Backblaze B2 or a self-hosted MinIO — for effectively unlimited capacity.</li>
              </ul>
              <p className="text-fg-muted">Step-by-step instructions are in <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">docs/DEPLOYMENT.md</code> in your Scenox Vault repository.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
