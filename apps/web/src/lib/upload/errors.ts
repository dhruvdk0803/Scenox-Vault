export type ErrorKind = 'network' | 'server' | 'auth' | 'rejected' | 'other';

export interface TusErrorLike {
  originalResponse?: { getStatus(): number } | null;
  message?: string;
}

export const RETRYABLE_4XX = new Set([408, 409, 423, 429]);

export function errorStatus(err: TusErrorLike): number | undefined {
  try {
    return err.originalResponse?.getStatus();
  } catch {
    return undefined;
  }
}

/** Whether tus should retry the failed request: network errors, 5xx, and 408/409/423/429. Never other 4xx. */
export function shouldRetryStatus(status: number | undefined): boolean {
  if (status === undefined || status === 0) return true;
  if (status >= 500) return true;
  if (status >= 400) return RETRYABLE_4XX.has(status);
  return true;
}

export function classifyError(err: TusErrorLike): { kind: ErrorKind; status?: number } {
  const status = errorStatus(err);
  if (status === undefined || status === 0) return { kind: 'network' };
  if (status === 401) return { kind: 'auth', status };
  if (status >= 500 || RETRYABLE_4XX.has(status)) return { kind: 'server', status };
  if (status >= 400) return { kind: 'rejected', status };
  return { kind: 'other', status };
}

export const MESSAGES = {
  retrying: 'Something went wrong while uploading this file. We’ll retry automatically.',
  exhausted: 'Upload paused after several attempts.',
  sessionExpired: 'Your upload session expired. Refresh the page to continue.',
  tooLarge: 'This file is larger than this link allows.',
  rejected: 'This file isn’t accepted by this upload link.',
  offline: 'Waiting for your connection…',
} as const;

export function rejectedMessage(status: number | undefined): string {
  return status === 413 ? MESSAGES.tooLarge : MESSAGES.rejected;
}
