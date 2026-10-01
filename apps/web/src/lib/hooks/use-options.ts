'use client';

import { useQuery } from '@tanstack/react-query';
import type { ClientDTO, Paginated, PortalDTO } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** All clients (up to 200) for selects. */
export function useClientOptions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.clients.options,
    queryFn: ({ signal }) => api.get<Paginated<ClientDTO>>(`/clients${qs({ pageSize: 200, sort: 'name', order: 'asc' })}`, { signal }),
    staleTime: 60_000,
    enabled,
  });
}

/** Portals (up to 200), optionally for one client, for selects. */
export function usePortalOptions(clientId?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.portals.options(clientId),
    queryFn: ({ signal }) => api.get<Paginated<PortalDTO>>(`/portals${qs({ pageSize: 200, clientId })}`, { signal }),
    staleTime: 60_000,
    enabled,
  });
}
