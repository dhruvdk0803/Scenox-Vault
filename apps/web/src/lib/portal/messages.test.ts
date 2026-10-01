import { describe, expect, it } from 'vitest';
import type { MessageDTO } from '@scenox/shared';
import { buildThread, dayLabel, mergeMessages } from './messages';

const msg = (id: string, createdAt: string, over: Partial<MessageDTO> = {}): MessageDTO => ({
  id, portalId: 'p', fileId: null, fileName: null, authorType: 'client', authorName: 'Ann', body: id, createdAt, readAt: null, own: true, ...over,
});

describe('messages helpers', () => {
  it('merges and de-duplicates by id, oldest first', () => {
    const a = msg('a', '2026-01-01T10:00:00Z');
    const b = msg('b', '2026-01-01T11:00:00Z');
    const c = msg('c', '2026-01-01T12:00:00Z');
    expect(mergeMessages([b, a], [b, c]).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('labels days relative to now', () => {
    const now = new Date('2026-10-01T12:00:00');
    expect(dayLabel(new Date('2026-10-01T01:00:00'), now)).toBe('Today');
    expect(dayLabel(new Date('2026-09-30T23:00:00'), now)).toBe('Yesterday');
    expect(dayLabel(new Date('2026-09-20T09:00:00'), now)).toBe('Sunday, Sep 20');
    expect(dayLabel(new Date('2025-09-20T09:00:00'), now)).toBe('Sep 20, 2025');
  });

  it('inserts day separators and groups runs by author', () => {
    const now = new Date('2026-10-01T12:00:00');
    const items = [
      msg('1', '2026-09-30T10:00:00'),
      msg('2', '2026-09-30T10:01:00'),
      msg('3', '2026-09-30T10:02:00', { authorType: 'staff', authorName: 'Sam', own: false }),
      msg('4', '2026-10-01T09:00:00'),
    ];
    const t = buildThread(items, now);
    expect(t.map((e) => (e.kind === 'day' ? e.label : e.message.id))).toEqual(['Yesterday', '1', '2', '3', 'Today', '4']);
    const flags = t.filter((e) => e.kind === 'message').map((e) => (e.kind === 'message' ? [e.first, e.last] : []));
    expect(flags).toEqual([[true, false], [false, true], [true, true], [true, true]]);
  });
});
