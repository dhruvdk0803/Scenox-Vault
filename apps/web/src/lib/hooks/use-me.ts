'use client';

import { useQuery } from '@tanstack/react-query';
import { hasPermission, type MeDTO, type Permission } from '@scenox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.get<MeDTO>('/auth/me', { signal }),
    staleTime: 60_000,
    retry: false,
  });
}

/** True when the signed-in user's role grants `permission`. False while loading. */
export function usePermission(permission: Permission): boolean {
  const { data } = useMe();
  return data ? hasPermission(data.user.role, permission) : false;
}
