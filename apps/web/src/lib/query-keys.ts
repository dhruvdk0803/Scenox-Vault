/**
 * Central React Query key factory. Feature agents: add your namespace here
 * (e.g. clients: { all: ['clients'] as const, list: (p) => ['clients','list',p] as const }).
 */
export const queryKeys = {
  me: ['auth', 'me'] as const,
  setupStatus: ['auth', 'setup-status'] as const,
};
