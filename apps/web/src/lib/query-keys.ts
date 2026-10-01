/**
 * Central React Query key factory. Invalidate by namespace (e.g. queryKeys.files.all) after mutations.
 */
export const queryKeys = {
  me: ['auth', 'me'] as const,
  setupStatus: ['auth', 'setup-status'] as const,
  branding: ['branding'] as const,
  dashboard: ['dashboard'] as const,
  analytics: (days: number) => ['analytics', days] as const,
  clients: {
    all: ['clients'] as const,
    list: (p: object) => ['clients', 'list', p] as const,
    options: ['clients', 'options'] as const,
    detail: (id: string) => ['clients', 'detail', id] as const,
  },
  portals: {
    all: ['portals'] as const,
    list: (p: object) => ['portals', 'list', p] as const,
    options: (clientId?: string) => ['portals', 'options', clientId ?? null] as const,
    detail: (id: string) => ['portals', 'detail', id] as const,
  },
  uploads: {
    all: ['uploads'] as const,
    list: (p: object) => ['uploads', 'list', p] as const,
    detail: (id: string) => ['uploads', 'detail', id] as const,
  },
  files: {
    all: ['files'] as const,
    list: (p: object) => ['files', 'list', p] as const,
    browse: (p: object) => ['files', 'browse', p] as const,
    detail: (id: string) => ['files', 'detail', id] as const,
  },
  exports: {
    all: ['exports'] as const,
    list: ['exports', 'list'] as const,
    detail: (id: string) => ['exports', 'detail', id] as const,
  },
  activity: (p: object) => ['activity', p] as const,
  activityAll: ['activity'] as const,
  audit: (p: object) => ['audit', p] as const,
  notifications: ['notifications'] as const,
  storage: ['storage'] as const,
  system: ['system'] as const,
  settings: ['settings'] as const,
  users: ['users'] as const,
};
