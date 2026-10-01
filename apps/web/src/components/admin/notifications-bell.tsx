'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, MessagesSquare } from 'lucide-react';
import type { NotificationDTO, Paginated } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toaster';
import { RelativeTime } from './relative-time';

export function NotificationsBell({ className }: { className?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const { data, isPending, error } = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ signal }) => api.get<Paginated<NotificationDTO>>('/notifications?pageSize=20', { signal, redirectOn401: false }),
    refetchInterval: 30_000,
    retry: false,
  });
  const items = data?.items ?? [];
  const unread = items.filter((n) => !n.readAt).length;

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.post('/notifications/read', ids ? { ids } : {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.notifications }),
    onError: (e) => toast.error("Couldn't update notifications", { description: errorMessage(e) }),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('relative', className)} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
          <Bell aria-hidden />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-[10px] font-semibold leading-4 tabular-nums text-white" aria-hidden>
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <Button variant="ghost" size="sm" disabled={unread === 0} loading={markRead.isPending && !markRead.variables} onClick={() => markRead.mutate(undefined)}>
            <CheckCheck aria-hidden /> Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {isPending ? (
            <div className="space-y-3 p-4">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : error ? (
            <p className="p-6 text-center text-sm text-fg-muted">Couldn&apos;t load notifications.</p>
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-fg-muted">You&apos;re all caught up.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((n) => {
                const body = (
                  <>
                    {n.type === 'client_message' ? (
                      <MessagesSquare className={cn('mt-0.5 size-4 shrink-0', n.readAt ? 'text-fg-subtle' : 'text-primary')} aria-hidden />
                    ) : (
                      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm', n.readAt ? 'text-fg-muted' : 'font-medium text-fg')}>{n.subject}{!n.readAt && <span className="sr-only"> (unread)</span>}</span>
                      {n.body && <span className="line-clamp-2 text-xs text-fg-subtle">{n.body}</span>}
                      <RelativeTime date={n.createdAt} className="text-xs tabular-nums text-fg-subtle" />
                    </span>
                  </>
                );
                const cls = 'flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface-muted/60';
                const onClick = () => {
                  if (!n.readAt) markRead.mutate([n.id]);
                  setOpen(false);
                };
                return (
                  <li key={n.id}>
                    {n.link ? (
                      <Link href={n.link} className={cls} onClick={onClick}>{body}</Link>
                    ) : (
                      <button type="button" className={cls} onClick={onClick}>{body}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
