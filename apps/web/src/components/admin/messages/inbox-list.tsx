'use client';

import * as React from 'react';
import Link from 'next/link';
import { MessagesSquare, SearchX } from 'lucide-react';
import type { InboxThreadDTO } from '@scenox/shared';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { RelativeTime } from '../relative-time';

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span className={cn('inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-5 tabular-nums text-primary-foreground', className)}>
      <span aria-hidden>{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{count} unread</span>
    </span>
  );
}

export function snippetOf(t: InboxThreadDTO): string {
  const m = t.lastMessage;
  const text = m.body.replace(/\s+/g, ' ').trim();
  const prefix = m.authorType === 'staff' ? 'You: ' : '';
  return `${prefix}${m.fileName ? `[${m.fileName}] ` : ''}${text}`;
}

/** One row per conversation. Rows are links to /messages?portal=<id>. */
export function InboxList({ threads, selectedPortalId, filtered }: { threads: InboxThreadDTO[]; selectedPortalId: string | null; filtered?: boolean }) {
  if (threads.length === 0) {
    return filtered ? (
      <EmptyState icon={<SearchX />} title="No matching conversations" description="Try a different client, portal or word." className="py-12" />
    ) : (
      <EmptyState icon={<MessagesSquare />} title="No messages yet" description="When clients write to you from their portal, conversations appear here." className="py-12" />
    );
  }
  return (
    <ul className="divide-y divide-border">
      {threads.map((t) => {
        const selected = t.portalId === selectedPortalId;
        const unread = t.unread > 0;
        return (
          <li key={t.portalId}>
            <Link
              href={`/messages?portal=${encodeURIComponent(t.portalId)}`}
              scroll={false}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'flex items-start gap-3 px-4 py-3 transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                selected ? 'bg-primary-soft' : 'hover:bg-surface-muted/60',
              )}
            >
              <Avatar name={t.clientName} size="lg" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn('truncate text-sm', unread ? 'font-semibold text-fg' : 'font-medium text-fg')}>{t.clientName}</span>
                  <RelativeTime date={t.lastMessage.createdAt} className={cn('shrink-0 whitespace-nowrap text-xs tabular-nums', unread ? 'font-medium text-fg-muted' : 'text-fg-subtle')} />
                </span>
                <span className="block truncate text-xs text-fg-subtle">{t.portalName}</span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className={cn('line-clamp-1 min-w-0 flex-1 break-words text-sm', unread ? 'font-medium text-fg' : 'text-fg-muted')}>{snippetOf(t)}</span>
                  <UnreadBadge count={t.unread} className="shrink-0" />
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
