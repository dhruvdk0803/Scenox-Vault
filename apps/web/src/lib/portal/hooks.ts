'use client';

import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ClientDashboardDTO, MessageDTO, MessageListResponse, PostClientMessageRequest } from '@scenox/shared';
import { ApiClientError } from '@/lib/api';
import { usePortal } from '@/components/portal/portal-context';
import { clientApi, type BrowseParams } from './api';
import { portalKeys } from './keys';
import { mergeMessages } from './messages';

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * Turns API failures into capability changes: 401 → the access token is gone (back to the password screen);
 * 403 on a feature endpoint (e.g. `files_hidden`) → hide that feature's tabs.
 */
function useErrorGuard(error: unknown, feature: 'files' | 'messages' | null) {
  const { hideFeature, accessLost, reloadPortal } = usePortal();
  React.useEffect(() => {
    if (!(error instanceof ApiClientError)) return;
    if (error.status === 401) accessLost();
    else if (error.status === 403 && (error.code === 'portal_expired' || error.code === 'portal_disabled')) reloadPortal();
    else if (error.status === 403 && feature) hideFeature(feature);
  }, [error, feature, hideFeature, accessLost, reloadPortal]);
}

export function useDashboard() {
  const { token, canMessage } = usePortal();
  const q = useQuery({
    queryKey: portalKeys.dashboard(token),
    queryFn: ({ signal }) => clientApi.dashboard(token, signal),
    staleTime: 10_000,
    // keeps the unread badge fresh without opening the Messages tab
    refetchInterval: () => (canMessage && visible() ? 30_000 : false),
  });
  useErrorGuard(q.error, null);
  return q;
}

export function useBrowse(params: BrowseParams) {
  const { token } = usePortal();
  const q = useQuery({
    queryKey: portalKeys.browse(token, params),
    queryFn: ({ signal }) => clientApi.browse(token, params, signal),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  useErrorGuard(q.error, 'files');
  return q;
}

export function useUploadHistory() {
  const { token } = usePortal();
  const q = useQuery({ queryKey: portalKeys.uploads(token), queryFn: ({ signal }) => clientApi.uploads(token, signal), staleTime: 10_000 });
  useErrorGuard(q.error, 'files');
  return q;
}

/** Refresh everything that shows counts or file lists (after uploads, deletes, new comments). */
export function invalidatePortalData(qc: QueryClient, token: string) {
  void qc.invalidateQueries({ queryKey: portalKeys.dashboard(token) });
  void qc.invalidateQueries({ queryKey: portalKeys.browseAll(token) });
  void qc.invalidateQueries({ queryKey: portalKeys.uploads(token) });
}

export function useDeleteFile() {
  const { token } = usePortal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => clientApi.deleteFile(token, fileId),
    onSuccess: () => invalidatePortalData(qc, token),
  });
}

const PAGE = 50;

/**
 * A message thread (the general conversation, or the comments on one file).
 * The newest page is polled every 15 s while the tab is visible; "Load earlier" walks backwards with `before`.
 */
export function useThread(fileId: string | null) {
  const { token } = usePortal();
  const qc = useQueryClient();
  const key = portalKeys.messages(token, fileId);
  const latest = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => clientApi.messages(token, { fileId, limit: PAGE }, signal),
    staleTime: 0,
    refetchInterval: () => (visible() ? 15_000 : false),
    refetchOnWindowFocus: 'always',
  });
  useErrorGuard(latest.error, 'messages');

  const [older, setOlder] = React.useState<MessageDTO[]>([]);
  const [olderHasMore, setOlderHasMore] = React.useState<boolean | null>(null);
  const [loadingEarlier, setLoadingEarlier] = React.useState(false);
  const [earlierError, setEarlierError] = React.useState(false);

  const messages = React.useMemo(() => mergeMessages(older, latest.data?.items ?? []), [older, latest.data]);
  const hasMoreEarlier = olderHasMore ?? latest.data?.hasMore ?? false;

  /** Resolves true when older messages were added. */
  const loadEarlier = React.useCallback(async (): Promise<boolean> => {
    const oldest = messages[0];
    if (!oldest || loadingEarlier) return false;
    setLoadingEarlier(true);
    setEarlierError(false);
    try {
      const r = await clientApi.messages(token, { fileId, before: oldest.createdAt, limit: PAGE });
      setOlder((prev) => mergeMessages(r.items, prev));
      setOlderHasMore(r.hasMore);
      return r.items.length > 0;
    } catch {
      setEarlierError(true);
      return false;
    } finally {
      setLoadingEarlier(false);
    }
  }, [messages, loadingEarlier, token, fileId]);

  // The server marks staff messages as read when we fetch; refresh the unread badge afterwards.
  const stamp = latest.dataUpdatedAt;
  React.useEffect(() => {
    if (!stamp) return;
    const d = qc.getQueryData<ClientDashboardDTO>(portalKeys.dashboard(token));
    if (d && d.messages.unread > 0) void qc.invalidateQueries({ queryKey: portalKeys.dashboard(token) });
  }, [stamp, qc, token]);

  const post = useMutation({
    mutationFn: (body: PostClientMessageRequest) => clientApi.postMessage(token, { ...body, fileId }),
    onSuccess: (msg) => {
      qc.setQueryData<MessageListResponse>(key, (old) => ({ hasMore: old?.hasMore ?? false, items: mergeMessages(old?.items ?? [], [msg]) }));
      void qc.invalidateQueries({ queryKey: portalKeys.dashboard(token) });
      if (fileId) void qc.invalidateQueries({ queryKey: portalKeys.browseAll(token) }); // comment counts
    },
  });

  return { latest, messages, hasMoreEarlier, loadEarlier, loadingEarlier, earlierError, post };
}
