import { ApiClientError } from '@/lib/api';
import { format, formatDistanceToNowStrict, isToday, isYesterday } from 'date-fns';

/** "3 minutes ago" for recent times, "Sep 28, 2026" otherwise. */
export function whenShort(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 24 * 3_600_000 && isToday(d)) return `${formatDistanceToNowStrict(d)} ago`;
  if (isYesterday(d)) return `Yesterday, ${format(d, 'h:mm a')}`;
  return format(d, d.getFullYear() === now.getFullYear() ? 'MMM d, h:mm a' : 'MMM d, yyyy');
}

export const whenFull = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'PPPp');
};

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** Plain-language message for a failed request (never shows codes or stack traces to clients). */
export function friendlyError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof ApiClientError) {
    if (e.status === 0) return 'We couldn’t reach the server. Check your connection and try again.';
    if (e.status === 429) return 'You’re doing that a little too quickly. Please wait a moment and try again.';
    if (e.status === 401) return 'Your session has ended. Please reload the page.';
    if (e.status === 403) return 'You don’t have access to this right now.';
    if (e.status === 404) return 'We couldn’t find that. It may have been removed.';
    if (e.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  }
  return fallback;
}
