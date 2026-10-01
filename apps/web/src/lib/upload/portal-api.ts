import { api, ApiClientError } from '@/lib/api';
import {
  PORTAL_ACCESS_HEADER, UPLOAD_SESSION_HEADER,
  type CompleteSessionRequest, type PortalUnlockResponse, type PreflightFile, type PreflightResponse, type PreflightResult,
  type PublicFileDTO, type PublicPortalDTO, type StartSessionRequest, type StartSessionResponse,
} from '@scenox/shared';

const base = (token: string) => `/public/portals/${encodeURIComponent(token)}`;
const opts = (headers?: Record<string, string>) => ({ redirectOn401: false, headers });
const access = (a?: string | null) => (a ? { [PORTAL_ACCESS_HEADER]: a } : undefined);
const sess = (s: string) => ({ [UPLOAD_SESSION_HEADER]: s });

export interface CurrentSession {
  sessionId: string;
  status: string;
  expiresAt: string;
}

export const PREFLIGHT_BATCH = 1000;

export function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const portalApi = {
  get: (token: string, accessToken?: string | null, signal?: AbortSignal) =>
    api.get<PublicPortalDTO>(base(token), { ...opts(access(accessToken)), signal }),
  unlock: (token: string, password: string) => api.post<PortalUnlockResponse>(`${base(token)}/unlock`, { password }, opts()),
  startSession: (token: string, body: StartSessionRequest, accessToken?: string | null) =>
    api.post<StartSessionResponse>(`${base(token)}/sessions`, body, opts(access(accessToken))),
  currentSession: (token: string, sessionToken: string) => api.get<CurrentSession>(`${base(token)}/sessions/current`, opts(sess(sessionToken))),
  preflightBatch: (token: string, sessionToken: string, files: PreflightFile[]) =>
    api.post<PreflightResponse>(`${base(token)}/preflight`, { files }, opts(sess(sessionToken))),
  complete: (token: string, sessionToken: string, body: CompleteSessionRequest) =>
    api.post<void>(`${base(token)}/sessions/complete`, body, opts(sess(sessionToken))),
  files: (token: string, sessionToken: string) => api.get<PublicFileDTO[]>(`${base(token)}/files`, opts(sess(sessionToken))),
  deleteFile: (token: string, sessionToken: string, fileId: string) =>
    api.delete<void>(`${base(token)}/files/${encodeURIComponent(fileId)}`, undefined, opts(sess(sessionToken))),
};

export type PortalApi = typeof portalApi;

/** Preflight any number of files in sequential batches of <= 1000. Returns all results + the last quota info. */
export async function preflightAll(
  token: string,
  sessionToken: string,
  files: PreflightFile[],
  onProgress?: (done: number, total: number) => void,
  call: (t: string, s: string, f: PreflightFile[]) => Promise<PreflightResponse> = portalApi.preflightBatch,
): Promise<{ results: PreflightResult[]; quota: PreflightResponse['quota'] | null }> {
  const results: PreflightResult[] = [];
  let quota: PreflightResponse['quota'] | null = null;
  let done = 0;
  for (const batch of chunkArray(files, PREFLIGHT_BATCH)) {
    const res = await call(token, sessionToken, batch);
    results.push(...res.results);
    quota = res.quota;
    done += batch.length;
    onProgress?.(done, files.length);
  }
  return { results, quota };
}

export { ApiClientError };
