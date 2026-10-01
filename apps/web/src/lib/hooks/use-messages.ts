'use client';

import { useQuery } from '@tanstack/react-query';
import type { InboxThreadDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** GET /api/messages/inbox response. */
export interface InboxResponse {
  items: InboxThreadDTO[];
  unreadTotal: number;
}

/** The message inbox (one row per portal with messages). Polled every 30s while the tab is visible. */
export function useInbox(enabled = true) {
  return useQuery({
    queryKey: queryKeys.messages.inbox,
    queryFn: ({ signal }) => api.get<InboxResponse>('/messages/inbox', { signal, redirectOn401: false }),
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: false,
    enabled,
  });
}

/** Total unread client messages (0 while loading or on error). Pass `enabled=false` when the user lacks portals.view. */
export function useUnreadMessages(enabled = true): number {
  const { data } = useInbox(enabled);
  return data?.unreadTotal ?? 0;
}
