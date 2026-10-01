'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { subDays, startOfDay } from 'date-fns';
import { CheckCircle2, ScrollText, XCircle } from 'lucide-react';
import type { ActivityDTO, Paginated } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { ALL, fromSelect, useListState } from '@/lib/hooks/use-list-state';
import { Badge } from '@/components/ui/badge';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar } from '@/components/ui/filter-bar';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { SimpleSelect } from '@/components/ui/select';
import { ACTION_FAMILIES } from '../activity-feed';
import { ErrorState } from '../query-state';
import { RelativeTime } from '../relative-time';

const DATE_PRESETS = [
  { value: ALL, label: 'Any time' },
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export function AuditPage() {
  const ls = useListState<{ action?: string; date?: string }>({ pageSize: 50 });
  const params = {
    page: ls.page,
    pageSize: ls.pageSize,
    q: ls.q || undefined,
    action: ls.filters.action,
    from: ls.filters.date ? startOfDay(subDays(new Date(), Number(ls.filters.date) - 1)).toISOString() : undefined,
  };
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.audit(params),
    queryFn: ({ signal }) => api.get<Paginated<ActivityDTO>>(`/audit${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const hasFilter = !!(params.q || params.action || params.from);

  const columns: DataTableColumn<ActivityDTO>[] = [
    { key: 'time', header: 'Time', cell: (a) => <RelativeTime date={a.createdAt} className="whitespace-nowrap tabular-nums text-fg-muted" /> },
    { key: 'actor', header: 'Actor', cell: (a) => <span className="block max-w-48 truncate font-medium">{a.actorLabel ?? (a.actorType === 'system' ? 'System' : 'Unknown')}</span> },
    {
      key: 'action',
      header: 'Action',
      className: 'min-w-64',
      cell: (a) => (
        <div className="max-w-md">
          <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">{a.action}</code>
          <p className="mt-1 truncate text-xs text-fg-subtle" title={a.summary}>{a.summary}</p>
        </div>
      ),
    },
    { key: 'resource', header: 'Resource', className: 'hidden lg:table-cell', cell: (a) => <span className="whitespace-nowrap text-fg-muted">{a.resourceType ?? '—'}{a.clientName ? ` · ${a.clientName}` : ''}</span> },
    { key: 'ip', header: 'IP address', className: 'hidden md:table-cell', cell: (a) => <span className="font-mono text-xs text-fg-muted">{a.ip ?? '—'}</span> },
    {
      key: 'result',
      header: 'Result',
      cell: (a) =>
        a.result === 'success' ? <Badge tone="success"><CheckCircle2 aria-hidden /> Success</Badge> : <Badge tone="danger"><XCircle aria-hidden /> Failed</Badge>,
    },
  ];

  return (
    <>
      <PageHeader title="Audit log" description="Administrative actions with who did what, from where, and whether it succeeded." />
      <FilterBar>
        <div data-grow className="sm:max-w-sm"><SearchInput placeholder="Search actions, actors or IPs…" aria-label="Search audit log" onChange={ls.setQ} /></div>
        <SimpleSelect aria-label="Filter by type" className="w-44" value={ls.filters.action ?? ALL} onValueChange={(v) => ls.setFilter('action', fromSelect(v))} options={[{ value: ALL, label: 'All actions' }, ...ACTION_FAMILIES.map((f) => ({ value: f.value, label: f.label }))]} />
        <SimpleSelect aria-label="Filter by date" className="w-40" value={ls.filters.date ?? ALL} onValueChange={(v) => ls.setFilter('date', fromSelect(v))} options={DATE_PRESETS} />
      </FilterBar>
      {error && !data ? (
        <div className="rounded-lg border border-border bg-surface"><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load the audit log" /></div>
      ) : (
        <div className="space-y-4">
          <DataTable
            caption="Audit log"
            columns={columns}
            rows={data?.items ?? []}
            getRowId={(a) => a.id}
            loading={isPending}
            empty={<EmptyState icon={<ScrollText />} title={hasFilter ? 'No entries match your filters' : 'No audit entries yet'} description={hasFilter ? 'Try clearing a filter.' : 'Administrative actions will be recorded here.'} />}
          />
          {data && data.total > 0 && <Pagination page={ls.page} pageSize={ls.pageSize} total={data.total} onPageChange={ls.setPage} onPageSizeChange={ls.setPageSize} />}
        </div>
      )}
    </>
  );
}
