import { api, qs } from '@/lib/api';
import { accessStore } from '@/components/portal/branding';
import {
  PORTAL_ACCESS_HEADER,
  type ClientBrowseResponse, type ClientDashboardDTO, type ClientUploadDTO, type MessageDTO, type MessageListResponse, type PostClientMessageRequest,
} from '@scenox/shared';

/** Client dashboard endpoints (docs/API.md "Client dashboard (public)"). No upload session needed, only the portal access header. */

const base = (token: string) => `/public/portals/${encodeURIComponent(token)}`;
const opts = (token: string, signal?: AbortSignal) => {
  const a = accessStore.load(token)?.accessToken;
  return { redirectOn401: false, signal, headers: a ? { [PORTAL_ACCESS_HEADER]: a } : undefined };
};

export type BrowseSort = 'name' | 'size' | 'uploadedAt';
export interface BrowseParams {
  path: string;
  q: string;
  /** '' or 'all' = no filter; otherwise a shared fileCategory value. */
  type: string;
  sort: BrowseSort;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export const clientApi = {
  dashboard: (token: string, signal?: AbortSignal) => api.get<ClientDashboardDTO>(`${base(token)}/dashboard`, opts(token, signal)),
  browse: (token: string, p: BrowseParams, signal?: AbortSignal) =>
    api.get<ClientBrowseResponse>(
      `${base(token)}/browse${qs({ path: p.path, q: p.q, type: p.type && p.type !== 'all' ? p.type : undefined, sort: p.sort, order: p.order, page: p.page, pageSize: p.pageSize })}`,
      opts(token, signal),
    ),
  uploads: (token: string, signal?: AbortSignal) => api.get<ClientUploadDTO[]>(`${base(token)}/uploads`, opts(token, signal)),
  deleteFile: (token: string, fileId: string) => api.delete<void>(`${base(token)}/files/${encodeURIComponent(fileId)}`, undefined, opts(token)),
  messages: (token: string, q: { fileId?: string | null; before?: string | null; limit?: number }, signal?: AbortSignal) =>
    api.get<MessageListResponse>(`${base(token)}/messages${qs({ fileId: q.fileId, before: q.before, limit: q.limit })}`, opts(token, signal)),
  postMessage: (token: string, body: PostClientMessageRequest) => api.post<MessageDTO>(`${base(token)}/messages`, body, opts(token)),
};
