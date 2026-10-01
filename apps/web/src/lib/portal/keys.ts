import type { BrowseParams } from './api';

/** React Query keys for the client dashboard; everything is scoped by portal token. */
export const portalKeys = {
  root: (t: string) => ['client-portal', t] as const,
  dashboard: (t: string) => ['client-portal', t, 'dashboard'] as const,
  browseAll: (t: string) => ['client-portal', t, 'browse'] as const,
  browse: (t: string, p: BrowseParams) => ['client-portal', t, 'browse', p] as const,
  uploads: (t: string) => ['client-portal', t, 'uploads'] as const,
  messagesAll: (t: string) => ['client-portal', t, 'messages'] as const,
  /** fileId null = the general conversation. */
  messages: (t: string, fileId: string | null) => ['client-portal', t, 'messages', fileId ?? 'thread'] as const,
};
