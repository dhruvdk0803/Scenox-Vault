'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import type { ActivityDTO, Paginated } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { ALL, fromSelect, useListState } from '@/lib/hooks/use-list-state';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar } from '@/components/ui/filter-bar';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { SimpleSelect } from '@/components/ui/select';
import { ACTION_FAMILIES, ActivityFeed } from '../activity-feed';
import { ClientSelect } from '../client-select';
import { ErrorState } from '../query-state';

export function ActivityPage() {
  const ls = useListState<{ clientId?: string; action?: string }>({ pageSize: 50 });
  // `action` accepts an action family prefix (e.g. "upload" matches upload.*).
  const params = { page: ls.page, pageSize: ls.pageSize, clientId: ls.filters.clientId, action: ls.filters.action };
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.activity(params),
    queryFn: ({ signal }) => api.get<Paginated<ActivityDTO>>(`/activity${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const hasFilter = !!(params.clientId || params.action);

  return (
    <>
      <PageHeader title="Activity" description="A timeline of everything happening across clients, portals and files." />
      <FilterBar>
        <ClientSelect allowAll value={ls.filters.clientId} onChange={(v) => ls.setFilter('clientId', v)} className="w-52" aria-label="Filter by client" />
        <SimpleSelect aria-label="Filter by type" className="w-44" value={ls.filters.action ?? ALL} onValueChange={(v) => ls.setFilter('action', fromSelect(v))} options={[{ value: ALL, label: 'All activity' }, ...ACTION_FAMILIES.map((f) => ({ value: f.value, label: f.label }))]} />
      </FilterBar>
      <Card>
        <CardContent className="space-y-4">
          {error && !data ? (
            <ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load activity" />
          ) : (
            <>
              <ActivityFeed
                items={data?.items}
                loading={isPending}
                grouped
                skeletonRows={8}
                empty={<EmptyState icon={<Activity />} title={hasFilter ? 'No activity matches your filters' : 'No activity yet'} description={hasFilter ? 'Try clearing a filter.' : 'Uploads, portal changes and other events will appear here.'} />}
              />
              {data && data.total > 0 && <Pagination page={ls.page} pageSize={ls.pageSize} total={data.total} onPageChange={ls.setPage} onPageSizeChange={ls.setPageSize} pageSizeOptions={[25, 50, 100]} />}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
