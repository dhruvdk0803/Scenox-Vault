'use client';

import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { subDays, startOfDay } from 'date-fns';
import { FolderTree, Files as FilesIcon, FolderSearch } from 'lucide-react';
import type { FileDTO, Paginated } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { ALL, fromSelect, useListState } from '@/lib/hooks/use-list-state';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar } from '@/components/ui/filter-bar';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { SimpleSelect } from '@/components/ui/select';
import { ClientSelect, PortalSelect } from '../client-select';
import { ErrorState } from '../query-state';
import { ExportsTray } from './exports-tray';
import { FileBrowser } from './file-browser';
import { FileBulkBar } from './file-bulk-bar';
import { FileTable } from './file-table';
import { FILE_STATUS_OPTIONS, FILE_TYPE_OPTIONS } from './file-utils';

const DATE_PRESETS = [
  { value: ALL, label: 'Any time' },
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
const SIZE_PRESETS = [
  { value: ALL, label: 'Any size' },
  { value: String(1e6), label: '≥ 1 MB' },
  { value: String(1e8), label: '≥ 100 MB' },
  { value: String(1e9), label: '≥ 1 GB' },
  { value: String(1e10), label: '≥ 10 GB' },
];

type Filters = { clientId?: string; portalId?: string; type?: string; status?: string; date?: string; minSize?: string };

function AllFiles() {
  const ls = useListState<Filters>({ pageSize: 50, sort: { key: 'createdAt', order: 'desc' } });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const { filters } = ls;

  const params = {
    page: ls.page,
    pageSize: ls.pageSize,
    q: ls.q || undefined,
    sort: ls.sort?.key,
    order: ls.sort?.order,
    clientId: filters.clientId,
    portalId: filters.portalId,
    type: filters.type,
    status: filters.status,
    from: filters.date ? startOfDay(subDays(new Date(), Number(filters.date) - 1)).toISOString() : undefined,
    minSize: filters.minSize,
  };
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.files.list(params),
    queryFn: ({ signal }) => api.get<Paginated<FileDTO>>(`/files${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const hasFilter = !!(ls.q || filters.clientId || filters.portalId || filters.type || filters.status || filters.date || filters.minSize);

  return (
    <div className="space-y-4">
      <FilterBar>
        <div data-grow className="sm:max-w-sm">
          <SearchInput placeholder="Search file names and paths…" aria-label="Search files" onChange={(v) => { ls.setQ(v); setSelected(new Set()); }} />
        </div>
        <ClientSelect allowAll value={filters.clientId} onChange={(v) => { ls.setFilter('clientId', v); ls.setFilter('portalId', undefined); }} className="w-44" aria-label="Filter by client" />
        <PortalSelect allowAll clientId={filters.clientId} value={filters.portalId} onChange={(v) => ls.setFilter('portalId', v)} className="w-44" aria-label="Filter by portal" />
        <SimpleSelect aria-label="File type" className="w-36" value={filters.type ?? ALL} onValueChange={(v) => ls.setFilter('type', fromSelect(v))} options={[{ value: ALL, label: 'All types' }, ...FILE_TYPE_OPTIONS]} />
        <SimpleSelect aria-label="Status" className="w-36" value={filters.status ?? ALL} onValueChange={(v) => ls.setFilter('status', fromSelect(v))} options={[{ value: ALL, label: 'Any status' }, ...FILE_STATUS_OPTIONS]} />
        <SimpleSelect aria-label="Uploaded" className="w-36" value={filters.date ?? ALL} onValueChange={(v) => ls.setFilter('date', fromSelect(v))} options={DATE_PRESETS} />
        <SimpleSelect aria-label="Minimum size" className="w-32" value={filters.minSize ?? ALL} onValueChange={(v) => ls.setFilter('minSize', fromSelect(v))} options={SIZE_PRESETS} />
        <ExportsTray />
      </FilterBar>

      {error && !data ? (
        <div className="rounded-lg border border-border bg-surface"><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load files" /></div>
      ) : (
        <>
          <FileTable
            files={data?.items ?? []}
            loading={isPending}
            showClient
            selectedIds={selected}
            onSelectionChange={setSelected}
            sort={ls.sort}
            onSortChange={ls.setSort}
            empty={
              <EmptyState
                icon={<FolderSearch />}
                title={hasFilter ? 'No files match your filters' : 'No files yet'}
                description={hasFilter ? 'Try removing a filter or searching for something else.' : 'Files your clients upload through their portals will appear here.'}
              />
            }
          />
          {data && data.total > 0 && (
            <Pagination page={ls.page} pageSize={ls.pageSize} total={data.total} onPageChange={ls.setPage} onPageSizeChange={ls.setPageSize} />
          )}
        </>
      )}
      <FileBulkBar selectedIds={selected} onClear={() => setSelected(new Set())} />
    </div>
  );
}

function Folders() {
  const [clientId, setClientId] = React.useState<string>();
  const [portalId, setPortalId] = React.useState<string>();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ClientSelect value={clientId} onChange={(v) => { setClientId(v); setPortalId(undefined); }} className="w-64" aria-label="Client to browse" placeholder="Choose a client…" />
        {clientId && <PortalSelect allowAll clientId={clientId} value={portalId} onChange={setPortalId} className="w-56" aria-label="Portal" />}
      </div>
      {clientId ? (
        <FileBrowser clientId={clientId} portalId={portalId} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState icon={<FolderTree />} title="Choose a client to browse" description="Pick a client above to explore their folders and files. Use “All files” to search across every client." />
        </div>
      )}
    </div>
  );
}

/** Global file manager: folder view (per client) or flat "All files" table. */
export function FilesExplorer() {
  const [view, setView] = React.useState<'folders' | 'all'>('all');
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="File view" className="inline-flex rounded-lg border border-border bg-surface-muted p-0.5">
        {([['all', 'All files', FilesIcon], ['folders', 'Folders', FolderTree]] as const).map(([v, label, Icon]) => (
          <button
            key={v}
            role="tab"
            type="button"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors', view === v ? 'bg-surface text-fg shadow-xs' : 'text-fg-muted hover:text-fg')}
          >
            <Icon className="size-4" aria-hidden /> {label}
          </button>
        ))}
      </div>
      {view === 'all' ? <AllFiles /> : <Folders />}
    </div>
  );
}
