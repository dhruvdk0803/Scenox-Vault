'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Link2, MoreHorizontal, PauseCircle, PlayCircle, Plus } from 'lucide-react';
import { formatBytes, formatNumber, type Paginated, type PortalDTO } from '@scenox/shared';
import { api, errorMessage, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { ALL, fromSelect, useListState } from '@/lib/hooks/use-list-state';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar } from '@/components/ui/filter-bar';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { SimpleSelect } from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toaster';
import { ClientSelect } from '../client-select';
import { ErrorState } from '../query-state';
import { formatDate, RelativeTime } from '../relative-time';

export function PortalsPage() {
  const canManage = usePermission('portals.manage');
  const qc = useQueryClient();
  const ls = useListState<{ status?: string; clientId?: string }>({ pageSize: 25 });
  const params = { page: ls.page, pageSize: ls.pageSize, q: ls.q || undefined, status: ls.filters.status, clientId: ls.filters.clientId };
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.portals.list(params),
    queryFn: ({ signal }) => api.get<Paginated<PortalDTO>>(`/portals${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const hasFilter = !!(ls.q || ls.filters.status || ls.filters.clientId);

  const toggle = useMutation({
    mutationFn: (p: PortalDTO) => api.patch<PortalDTO>(`/portals/${p.id}`, { status: p.storedStatus === 'active' ? 'disabled' : 'active' }),
    onSuccess: (p) => { toast.success(p.storedStatus === 'active' ? 'Portal enabled' : 'Portal disabled'); void qc.invalidateQueries({ queryKey: queryKeys.portals.all }); },
    onError: (e) => toast.error("Couldn't update the portal", { description: errorMessage(e) }),
  });

  const newHref = `/portals/new${ls.filters.clientId ? `?clientId=${ls.filters.clientId}` : ''}`;
  const newButton = canManage && <Button asChild><Link href={newHref}><Plus aria-hidden /> New portal</Link></Button>;

  const columns: DataTableColumn<PortalDTO>[] = [
    {
      key: 'name',
      header: 'Portal',
      className: 'min-w-52',
      cell: (p) => (
        <div className="min-w-0 max-w-64">
          <Link href={`/portals/${p.id}`} className="block truncate font-medium hover:underline">{p.name}</Link>
          <Link href={`/clients/${p.clientId}`} className="block truncate text-xs text-fg-subtle hover:text-fg-muted">{p.clientName}</Link>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (p) => <StatusBadge kind="portal" status={p.status} /> },
    {
      key: 'link',
      header: 'Link',
      className: 'hidden lg:table-cell',
      cell: (p) => p.url ? (
        <div className="flex items-center gap-0.5">
          <code className="max-w-40 truncate font-mono text-xs text-fg-muted" title={p.url}>…/{p.tokenPreview}…</code>
          <CopyButton value={p.url} label={`Copy link for ${p.name}`} className="size-7" />
        </div>
      ) : <span className="text-fg-subtle">—</span>,
    },
    { key: 'files', header: 'Files', align: 'right', className: 'hidden md:table-cell', cell: (p) => <span className="tabular-nums">{formatNumber(p.fileCount)}</span> },
    { key: 'storage', header: 'Storage', align: 'right', className: 'hidden md:table-cell', cell: (p) => <span className="tabular-nums">{formatBytes(p.storageUsedBytes)}</span> },
    { key: 'lastUploadAt', header: 'Last upload', className: 'hidden xl:table-cell', cell: (p) => <RelativeTime date={p.lastUploadAt} fallback="Never" className="whitespace-nowrap tabular-nums text-fg-muted" /> },
    { key: 'expiresAt', header: 'Expires', className: 'hidden lg:table-cell', cell: (p) => <span className="whitespace-nowrap tabular-nums text-fg-muted">{p.expiresAt ? formatDate(p.expiresAt) : 'Never'}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: 'w-12',
      cell: (p) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${p.name}`}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild><Link href={`/portals/${p.id}`}><Link2 aria-hidden /> Open</Link></DropdownMenuItem>
            {p.url && <DropdownMenuItem asChild><a href={p.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden /> Open portal</a></DropdownMenuItem>}
            {canManage && (
              <DropdownMenuItem onSelect={() => toggle.mutate(p)}>
                {p.storedStatus === 'active' ? <PauseCircle aria-hidden /> : <PlayCircle aria-hidden />}
                {p.storedStatus === 'active' ? 'Disable' : 'Enable'}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Upload Portals" description="Secure links your clients use to upload files." actions={newButton} />
      <FilterBar>
        <div data-grow className="sm:max-w-sm"><SearchInput placeholder="Search portals…" aria-label="Search portals" onChange={ls.setQ} /></div>
        <ClientSelect allowAll value={ls.filters.clientId} onChange={(v) => ls.setFilter('clientId', v)} className="w-52" aria-label="Filter by client" />
        <SimpleSelect
          aria-label="Filter by status"
          className="w-40"
          value={ls.filters.status ?? ALL}
          onValueChange={(v) => ls.setFilter('status', fromSelect(v))}
          options={[{ value: ALL, label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'expired', label: 'Expired' }, { value: 'disabled', label: 'Disabled' }]}
        />
      </FilterBar>
      {error && !data ? (
        <div className="rounded-lg border border-border bg-surface"><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load portals" /></div>
      ) : (
        <div className="space-y-4">
          <DataTable
            caption="Upload portals"
            columns={columns}
            rows={data?.items ?? []}
            getRowId={(p) => p.id}
            loading={isPending}
            empty={
              hasFilter ? (
                <EmptyState icon={<Link2 />} title="No portals match your filters" description="Try a different search or clear the filters." />
              ) : (
                <EmptyState icon={<Link2 />} title="No portals yet" description="Create a portal to give a client a secure link for uploading files." action={newButton || undefined} />
              )
            }
          />
          {data && data.total > 0 && <Pagination page={ls.page} pageSize={ls.pageSize} total={data.total} onPageChange={ls.setPage} onPageSizeChange={ls.setPageSize} />}
        </div>
      )}
    </>
  );
}
