'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, Link2, MoreHorizontal, PauseCircle, PlayCircle, Plus, Trash2, Users } from 'lucide-react';
import { formatNumber, type ClientDTO, type Paginated } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { ALL, fromSelect, useListState } from '@/lib/hooks/use-list-state';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar } from '@/components/ui/filter-bar';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { SimpleSelect } from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/status-badge';
import { ClientDeleteDialog, ClientFormDialog, useToggleClientStatus } from '../clients/client-dialogs';
import { QuotaMini } from '../clients/client-quota';
import { ErrorState } from '../query-state';
import { RelativeTime } from '../relative-time';

export function ClientsPage() {
  const canManage = usePermission('clients.manage');
  const canDelete = usePermission('files.delete');
  const canPortals = usePermission('portals.manage');
  const router = useRouter();
  const sp = useSearchParams();
  const ls = useListState<{ status?: string }>({ pageSize: 25, sort: { key: 'createdAt', order: 'desc' } });
  const [createOpen, setCreateOpen] = React.useState(sp.get('new') === '1');
  const [deleting, setDeleting] = React.useState<ClientDTO | null>(null);
  const toggle = useToggleClientStatus();

  const params = { page: ls.page, pageSize: ls.pageSize, q: ls.q || undefined, status: ls.filters.status, sort: ls.sort?.key, order: ls.sort?.order };
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.clients.list(params),
    queryFn: ({ signal }) => api.get<Paginated<ClientDTO>>(`/clients${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const hasFilter = !!(ls.q || ls.filters.status);

  const columns: DataTableColumn<ClientDTO>[] = [
    {
      key: 'name',
      header: 'Client',
      sortable: true,
      className: 'min-w-52',
      cell: (c) => (
        <div className="min-w-0 max-w-64">
          <Link href={`/clients/${c.id}`} className="block truncate font-medium text-fg hover:underline">{c.name}</Link>
          {c.company && <p className="truncate text-xs text-fg-subtle">{c.company}</p>}
        </div>
      ),
    },
    { key: 'email', header: 'Email', className: 'hidden xl:table-cell', cell: (c) => <span className="block max-w-48 truncate text-fg-muted">{c.email ?? '—'}</span> },
    { key: 'storageUsedBytes', header: 'Storage', sortable: true, cell: (c) => <QuotaMini usedBytes={c.storageUsedBytes} quotaBytes={c.quotaBytes} /> },
    { key: 'files', header: 'Files', align: 'right', className: 'hidden md:table-cell', cell: (c) => <span className="tabular-nums">{formatNumber(c.fileCount)}</span> },
    { key: 'uploads', header: 'Uploads', align: 'right', className: 'hidden lg:table-cell', cell: (c) => <span className="tabular-nums">{formatNumber(c.uploadCount)}</span> },
    { key: 'portals', header: 'Portals', align: 'right', className: 'hidden lg:table-cell', cell: (c) => <span className="tabular-nums">{formatNumber(c.portalCount)}</span> },
    { key: 'lastUploadAt', header: 'Last upload', sortable: true, className: 'hidden md:table-cell', cell: (c) => <RelativeTime date={c.lastUploadAt} fallback="Never" className="whitespace-nowrap tabular-nums text-fg-muted" /> },
    { key: 'status', header: 'Status', cell: (c) => <StatusBadge kind="client" status={c.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: 'w-12',
      cell: (c) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${c.name}`}><MoreHorizontal aria-hidden /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild><Link href={`/clients/${c.id}`}><ExternalLink aria-hidden /> Open</Link></DropdownMenuItem>
            {canPortals && <DropdownMenuItem asChild><Link href={`/portals/new?clientId=${c.id}`}><Link2 aria-hidden /> Create upload portal</Link></DropdownMenuItem>}
            {canManage && (
              <DropdownMenuItem onSelect={() => toggle.mutate(c)}>
                {c.status === 'active' ? <PauseCircle aria-hidden /> : <PlayCircle aria-hidden />}
                {c.status === 'active' ? 'Disable' : 'Enable'}
              </DropdownMenuItem>
            )}
            {canManage && canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDeleting(c)}><Trash2 aria-hidden /> Delete</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const newButton = canManage && (
    <Button onClick={() => setCreateOpen(true)}><Plus aria-hidden /> New client</Button>
  );

  return (
    <>
      <PageHeader title="Clients" description="The people and companies you collect files from. Each client can have one or more upload portals." actions={newButton} />
      <FilterBar>
        <div data-grow className="sm:max-w-sm"><SearchInput placeholder="Search by name, company or email…" aria-label="Search clients" onChange={ls.setQ} /></div>
        <SimpleSelect
          aria-label="Filter by status"
          className="w-40"
          value={ls.filters.status ?? ALL}
          onValueChange={(v) => ls.setFilter('status', fromSelect(v))}
          options={[{ value: ALL, label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }]}
        />
      </FilterBar>
      {error && !data ? (
        <div className="rounded-lg border border-border bg-surface"><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load clients" /></div>
      ) : (
        <div className="space-y-4">
          <DataTable
            caption="Clients"
            columns={columns}
            rows={data?.items ?? []}
            getRowId={(c) => c.id}
            loading={isPending}
            sort={ls.sort}
            onSortChange={ls.setSort}
            empty={
              hasFilter ? (
                <EmptyState icon={<Users />} title="No clients match your search" description="Try a different name or clear the filters." />
              ) : (
                <EmptyState icon={<Users />} title="No clients yet" description="Create your first client to generate an upload portal." action={newButton || undefined} />
              )
            }
          />
          {data && data.total > 0 && <Pagination page={ls.page} pageSize={ls.pageSize} total={data.total} onPageChange={ls.setPage} onPageSizeChange={ls.setPageSize} />}
        </div>
      )}
      <ClientFormDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={(c) => router.push(`/clients/${c.id}`)} />
      <ClientDeleteDialog client={deleting} onOpenChange={(o) => !o && setDeleting(null)} />
    </>
  );
}
