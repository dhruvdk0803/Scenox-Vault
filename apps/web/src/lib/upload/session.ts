import type { StartSessionRequest } from '@scenox/shared';
import { ApiClientError } from '@/lib/api';
import type { KV } from './kv';
import { clearStoredSession, loadStoredSession, saveStoredSession, type StoredSession } from './queue-store';
import type { PortalApi } from './portal-api';

export interface EnsureSessionInput {
  kv: KV;
  api: Pick<PortalApi, 'startSession' | 'currentSession'>;
  portalToken: string;
  accessToken?: string | null;
  intake: Omit<StartSessionRequest, 'totalFiles' | 'totalBytes'>;
  totals: { totalFiles: number; totalBytes: number };
  /** Skip reuse of a stored session (e.g. after a 401). */
  forceNew?: boolean;
}

/** Reuse the persisted session if the server still considers it active; otherwise create (and persist) a new one. */
export async function ensureSession(input: EnsureSessionInput): Promise<StoredSession> {
  const { kv, api, portalToken } = input;
  if (!input.forceNew) {
    const stored = await loadStoredSession(kv, portalToken);
    if (stored) {
      try {
        const cur = await api.currentSession(portalToken, stored.sessionToken);
        if (cur.status === 'active') return { ...stored, expiresAt: cur.expiresAt ?? stored.expiresAt };
      } catch (e) {
        // Server unreachable: surface it instead of discarding a possibly valid session.
        if (e instanceof ApiClientError && e.status === 0) throw e;
      }
      await clearStoredSession(kv, portalToken).catch(() => undefined);
    }
  }
  const created = await api.startSession(portalToken, { ...input.intake, ...input.totals }, input.accessToken);
  const session: StoredSession = { sessionId: created.sessionId, sessionToken: created.sessionToken, expiresAt: created.expiresAt };
  await saveStoredSession(kv, portalToken, session).catch(() => undefined);
  return session;
}

/** Validate a stored session on page load (for "Your uploaded files" + resume). */
export async function validateStoredSession(
  kv: KV,
  api: Pick<PortalApi, 'currentSession'>,
  portalToken: string,
): Promise<(StoredSession & { status: string }) | null> {
  const stored = await loadStoredSession(kv, portalToken);
  if (!stored) return null;
  try {
    const cur = await api.currentSession(portalToken, stored.sessionToken);
    return { ...stored, expiresAt: cur.expiresAt ?? stored.expiresAt, status: cur.status };
  } catch (e) {
    if (e instanceof ApiClientError && e.status >= 400 && e.status < 500) await clearStoredSession(kv, portalToken).catch(() => undefined);
    return null;
  }
}
