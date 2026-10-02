'use client';

import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Eye, MoreHorizontal, Trash2, UploadCloud } from 'lucide-react';
import { formatNumber, formatSpeed, type Paginated, type UploadSessionDTO } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { ALL, fromSelect, useListState } from '@/lib/hooks/use-list-state';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar } from '@/components/ui/filter-bar';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { SimpleSelect } from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/status-badge';
import { ClientSelect, PortalSelect } from '../client-select';
import { ErrorState } from '../query-state';
import { RelativeTime } from '../relative-time';
import { SessionProgress } from '../session-progress';
import { DeleteUploadDialog } from './delete-upload-dialog';
import { SessionDetailDialog } from './session-detail-dialog';

const STATUS_OPTIONS = [
  { value: ALL, label: 'Any status' },
  { value: 'active', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'abandoned', label: 'Abandoned' },
  { value: 'failed', label: 'Failed' },
];

export interface UploadsTableProps {
  fixedClientId?: string;
  fixedPortalId?: string;
  pageSize?: number;
  /** Show search + filters (default true). */
  filters?: boolean;
  /** Controlled open session (e.g. synced to ?session=). */
  sessionId?: string | null;
  onSessionChange?: (id: string | null) => void;
  emptyAction?: React.ReactNode;
}

type F = { clientId?: string; portalId?: string; status?: string };

/** Upload sessions table (server paginated, live-refreshing while any session is active). */
export function UploadsTable({ fixedClientId, fixedPortalId, pageSize = 25, filters = true, sessionId, onSessionChange, emptyAction }: UploadsTableProps) {
  const ls = useListState<F>({ pageSize });
  const [internalId, setInternalId] = React.useState<string | null>(null);
  const openId = onSessionChange ? (sessionId ?? null) : internalId;
  const setOpenId = onSessionChange ?? setInternalId;
  const canDelete = usePermission('files.delete');
  const [deleteSession, setDeleteSession] = React.useState<UploadSessionDTO | null>(null);

  const params = {
    page: ls.page,
    pageSize: ls.pageSize,
    q: ls.q || undefined,
    clientId: fixedClientId ?? ls.filters.clientId,
    portalId: fixedPortalId ?? ls.filters.portalId,
    status: ls.filters.status,
  };
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.uploads.list(params),
    queryFn: ({ signal }) => api.get<Paginated<UploadSessionDTO>>(`/uploads${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((s) => s.status === 'active') ? 5000 : false),
  });
  const hasFilter = !!(params.q || (!fixedClientId && params.clientId) || (!fixedPortalId && params.portalId) || params.status);

  const columns: DataTableColumn<UploadSessionDTO>[] = [
    ...(fixedClientId ? [] : [{ key: 'client', header: 'Client', className: 'min-w-36', cell: (s: UploadSessionDTO) => <span className="block max-w-48 truncate font-medium">{s.clientName}</span> }]),
    ...(fixedPortalId ? [] : [{ key: 'portal', header: 'Portal', className: 'hidden md:table-cell', cell: (s: UploadSessionDTO) => <span className="block max-w-44 truncate text-fg-muted">{s.portalName}</span> }]),
    {
      key: 'uploader',
      header: 'Uploader',
      className: 'hidden lg:table-cell',
      cell: (s) =>
        s.uploaderName || s.uploaderEmail ? (
          <div className="max-w-48">
            <p className="truncate">{s.uploaderName ?? s.uploaderEmail}</p>
            {s.uploaderName && s.uploaderEmail && <p className="truncate text-xs text-fg-subtle">{s.uploaderEmail}</p>}
          </div>
        ) : (
          <span className="text-fg-subtle">Anonymous</span>
        ),
    },
    { key: 'files', header: 'Files', align: 'right', cell: (s) => <span className="tabular-nums">{formatNumber(s.uploadedFiles)}<span className="text-fg-subtle"> / {formatNumber(s.totalFiles)}</span></span> },
    { key: 'data', header: 'Data', className: 'min-w-44', cell: (s) => <SessionProgress session={s} /> },
    { key: 'speed', header: 'Avg speed', align: 'right', className: 'hidden xl:table-cell', cell: (s) => <span className="tabular-nums text-fg-muted">{s.avgSpeedBps ? formatSpeed(s.avgSpeedBps) : '—'}</span> },
    { key: 'status', header: 'Status', cell: (s) => <StatusBadge kind="session" status={s.status} /> },
    { key: 'startedAt', header: 'Started', cell: (s) => <RelativeTime date={s.startedAt} className="whitespace-nowrap tabular-nums text-fg-muted" /> },
    {
      key: 'view',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: canDelete ? 'w-28' : 'w-16',
      cell: (s) => (
        // React events bubble through portals: keep menu clicks from also opening the row.
        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => setOpenId(s.id)} aria-label={`View upload session from ${s.clientName}`}>
            View
          </Button>
          {canDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`More actions for upload from ${s.clientName}`}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setOpenId(s.id)}><Eye aria-hidden /> View details</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDeleteSession(s)}><Trash2 aria-hidden /> Delete upload</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {filters && (
        <FilterBar className="mb-0">
          <div data-grow className="sm:max-w-sm">
            <SearchInput placeholder="Search uploader, email or client…" aria-label="Search upload sessions" onChange={ls.setQ} />
          </div>
          {!fixedClientId && <ClientSelect allowAll value={ls.filters.clientId} onChange={(v) => { ls.setFilter('clientId', v); ls.setFilter('portalId', undefined); }} className="w-48" aria-label="Filter by client" />}
          {!fixedPortalId && <PortalSelect allowAll clientId={fixedClientId ?? ls.filters.clientId} value={ls.filters.portalId} onChange={(v) => ls.setFilter('portalId', v)} className="w-48" aria-label="Filter by portal" />}
          <SimpleSelect aria-label="Filter by status" className="w-40" value={ls.filters.status ?? ALL} onValueChange={(v) => ls.setFilter('status', fromSelect(v))} options={STATUS_OPTIONS} />
        </FilterBar>
      )}
      {error && !data ? (
        <div className="rounded-lg border border-border bg-surface"><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load uploads" /></div>
      ) : (
        <>
          <DataTable
            caption="Upload sessions"
            columns={columns}
            rows={data?.items ?? []}
            getRowId={(s) => s.id}
            loading={isPending}
            onRowClick={(s) => setOpenId(s.id)}
            empty={
              <EmptyState
                icon={<UploadCloud />}
                title={hasFilter ? 'No uploads match your filters' : 'No uploads yet'}
                description={hasFilter ? 'Try adjusting or clearing the filters.' : 'When a client uploads through a portal, each batch shows up here with live progress.'}
                action={hasFilter ? undefined : emptyAction}
              />
            }
          />
          {data && data.total > 0 && (
            <Pagination page={ls.page} pageSize={ls.pageSize} total={data.total} onPageChange={ls.setPage} onPageSizeChange={filters ? ls.setPageSize : undefined} />
          )}
        </>
      )}
      <SessionDetailDialog sessionId={openId} onOpenChange={(o) => !o && setOpenId(null)} />
      <DeleteUploadDialog session={deleteSession} onOpenChange={(o) => !o && setDeleteSession(null)} />
    </div>
  );
}
