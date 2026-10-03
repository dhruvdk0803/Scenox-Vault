'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiKeyDTO, WebhookDeliveryDTO, WebhookDTO } from '@scenox/shared';
import { ApiClientError, api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

export function useApiKeys(enabled = true) {
  return useQuery({
    queryKey: queryKeys.developer.apiKeys,
    queryFn: ({ signal }) => api.get<ApiKeyDTO[]>('/developer/api-keys', { signal }),
    enabled,
  });
}

export function useWebhooks(enabled = true) {
  return useQuery({
    queryKey: queryKeys.developer.webhooks,
    queryFn: ({ signal }) => api.get<WebhookDTO[]>('/developer/webhooks', { signal }),
    enabled,
  });
}

/** Recent deliveries for one webhook. Polls every 5 s while `enabled` (i.e. while the drawer is open). */
export function useWebhookDeliveries(webhookId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.developer.deliveries(webhookId ?? ''),
    queryFn: ({ signal }) => api.get<WebhookDeliveryDTO[]>(`/developer/webhooks/${webhookId}/deliveries?limit=50`, { signal }),
    enabled: enabled && !!webhookId,
    refetchInterval: 5_000,
  });
}

/** The developer guide (markdown, public). */
export function useDeveloperDocs(enabled = true) {
  return useQuery({
    queryKey: queryKeys.developer.docs,
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch('/api/docs', { headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' }, signal });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        throw new ApiClientError({ status: 0, code: 'network_error', message: 'Could not reach the server. Check your connection and try again.' });
      }
      if (!res.ok) throw new ApiClientError({ status: res.status, code: 'docs_unavailable', message: `The developer guide could not be loaded (${res.status}).` });
      return res.text();
    },
    enabled,
    staleTime: 5 * 60_000,
  });
}

const noopSubscribe = () => () => {};
/** `window.location.origin`, '' during SSR (no hydration mismatch). */
export function useOrigin(): string {
  return React.useSyncExternalStore(noopSubscribe, () => window.location.origin, () => '');
}
