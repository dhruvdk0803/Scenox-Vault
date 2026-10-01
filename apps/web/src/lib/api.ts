import type { ApiError } from '@scenox/shared';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(init: { status: number; code: string; message: string; details?: unknown; requestId?: string }) {
    super(init.message);
    this.name = 'ApiClientError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
  }
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
  /** Extra headers (e.g. portal tokens for the public client portal). */
  headers?: Record<string, string>;
  /**
   * On 401, redirect to /login?next=... Default true (admin app).
   * The public client portal MUST pass `redirectOn401: false`.
   */
  redirectOn401?: boolean;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function redirectToLogin() {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (pathname === '/login' || pathname === '/setup') return;
  const next = encodeURIComponent(pathname + search);
  window.location.assign(`/login?next=${next}`);
}

async function request<T>(method: Method, path: string, body?: unknown, opts: ApiRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob) {
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'include', signal: opts.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiClientError({ status: 0, code: 'network_error', message: 'Could not reach the server. Check your connection and try again.' });
  }

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  let parsed: Partial<ApiError> | undefined;
  try {
    parsed = (await res.json()) as Partial<ApiError>;
  } catch {
    parsed = undefined;
  }
  const e = parsed?.error;
  const error = new ApiClientError({
    status: res.status,
    code: e?.code ?? (res.status === 401 ? 'unauthorized' : 'unknown_error'),
    message: e?.message ?? `Request failed (${res.status})`,
    details: e?.details,
    requestId: e?.requestId ?? res.headers.get('x-request-id') ?? undefined,
  });
  if (res.status === 401 && (opts.redirectOn401 ?? true)) redirectToLogin();
  throw error;
}

export const api = {
  get: <T>(path: string, opts?: ApiRequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: ApiRequestOptions) => request<T>('POST', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: ApiRequestOptions) => request<T>('PATCH', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: ApiRequestOptions) => request<T>('PUT', path, body, opts),
  delete: <T>(path: string, body?: unknown, opts?: ApiRequestOptions) => request<T>('DELETE', path, body, opts),
};

/** Builds a query string, skipping undefined/null/empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  return err instanceof ApiClientError ? err.message : fallback;
}
