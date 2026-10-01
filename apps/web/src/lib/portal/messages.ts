import { format, isSameDay, isSameYear, subDays } from 'date-fns';
import type { MessageDTO } from '@scenox/shared';

export const MESSAGE_MAX = 5000;
/** The character counter only appears once the draft is this long. */
export const MESSAGE_COUNTER_AT = 4500;

/** Merge older pages with the latest page: de-duplicated by id, oldest first. */
export function mergeMessages(older: readonly MessageDTO[], latest: readonly MessageDTO[]): MessageDTO[] {
  const byId = new Map<string, MessageDTO>();
  for (const m of older) byId.set(m.id, m);
  for (const m of latest) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

export function dayLabel(d: Date, now: Date = new Date()): string {
  if (isSameDay(d, now)) return 'Today';
  if (isSameDay(d, subDays(now, 1))) return 'Yesterday';
  return format(d, isSameYear(d, now) ? 'EEEE, MMM d' : 'MMM d, yyyy');
}

export type ThreadEntry =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; message: MessageDTO; /** first of a run by the same author */ first: boolean; /** last of a run */ last: boolean };

const RUN_GAP_MS = 5 * 60_000;

/** Flatten messages into day separators + messages, marking runs of consecutive messages by one author. */
export function buildThread(messages: readonly MessageDTO[], now: Date = new Date()): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  let prev: MessageDTO | null = null;
  messages.forEach((m, i) => {
    const d = new Date(m.createdAt);
    const newDay = !prev || !isSameDay(new Date(prev.createdAt), d);
    if (newDay) out.push({ kind: 'day', key: `day-${format(d, 'yyyy-MM-dd')}`, label: dayLabel(d, now) });
    const sameRun = (a: MessageDTO | null, b: MessageDTO) =>
      !!a && isSameDay(new Date(a.createdAt), new Date(b.createdAt)) && a.authorType === b.authorType && a.authorName === b.authorName &&
      !!a.own === !!b.own && Math.abs(Date.parse(b.createdAt) - Date.parse(a.createdAt)) < RUN_GAP_MS;
    const next: MessageDTO | null = messages[i + 1] ?? null;
    out.push({ kind: 'message', key: m.id, message: m, first: !sameRun(prev, m), last: !next || !sameRun(m, next) });
    prev = m;
  });
  return out;
}

/** True for a message the client wrote (`own` from the public API, falling back to authorType). */
export const isOwn = (m: MessageDTO) => m.own ?? m.authorType === 'client';
