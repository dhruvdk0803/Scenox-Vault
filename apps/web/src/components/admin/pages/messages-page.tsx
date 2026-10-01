'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, MessagesSquare, Settings2 } from 'lucide-react';
import type { PortalDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { queryKeys } from '@/lib/query-keys';
import { useInbox } from '@/lib/hooks/use-messages';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { InboxList } from '../messages/inbox-list';
import { PortalMessageThread } from '../messages/portal-message-thread';
import { ErrorState } from '../query-state';

function ThreadPane({ portalId, fallback }: { portalId: string; fallback?: { clientId: string; clientName: string; portalName: string } }) {
  const { data: portal } = useQuery({
    queryKey: queryKeys.portals.detail(portalId),
    queryFn: ({ signal }) => api.get<PortalDTO>(`/portals/${portalId}`, { signal }),
    staleTime: 30_000,
  });
  const clientName = portal?.clientName ?? fallback?.clientName;
  const portalName = portal?.name ?? fallback?.portalName;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-3 sm:px-4">
        <Button asChild variant="ghost" size="icon" className="-ml-1 lg:hidden">
          <Link href="/messages" aria-label="Back to all conversations"><ArrowLeft aria-hidden /></Link>
        </Button>
        {clientName ? <Avatar name={clientName} size="lg" className="hidden sm:inline-flex" /> : <Skeleton className="hidden size-10 rounded-full sm:block" />}
        <div className="min-w-0 flex-1">
          {clientName ? (
            <>
              <h2 className="truncate text-sm font-semibold text-fg">{clientName}</h2>
              <p className="truncate text-xs text-fg-subtle">{portalName}</p>
            </>
          ) : (
            <><Skeleton className="mb-1.5 h-4 w-32" /><Skeleton className="h-3 w-24" /></>
          )}
        </div>
        {portal && !portal.allowClientMessages && <Badge tone="warning" className="hidden shrink-0 sm:inline-flex">Client messaging off</Badge>}
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/portals/${portalId}`}><Settings2 aria-hidden /><span className="sr-only sm:not-sr-only">Open portal settings</span></Link>
          </Button>
          {portal?.url && (
            <Button asChild variant="outline" size="sm">
              <a href={portal.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden /><span className="sr-only sm:not-sr-only">Open client portal</span><span className="sr-only"> (opens in a new tab)</span></a>
            </Button>
          )}
        </div>
      </div>
      <PortalMessageThread portalId={portalId} className="flex-1" />
    </div>
  );
}

export function MessagesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('portal');
  const [q, setQ] = React.useState('');
  const { data, isPending, error, refetch, isFetching } = useInbox();

  const threads = React.useMemo(() => {
    const items = data?.items ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((t) => `${t.clientName} ${t.portalName} ${t.lastMessage.body}`.toLowerCase().includes(needle));
  }, [data, q]);

  const selectedThread = data?.items.find((t) => t.portalId === selected);
  const noMessagesAtAll = !!data && data.items.length === 0 && !selected;

  // Keep the URL tidy if it points at nothing useful.
  React.useEffect(() => {
    if (params.has('portal') && !params.get('portal')) router.replace('/messages');
  }, [params, router]);

  return (
    <>
      <PageHeader
        title="Messages"
        description={data && data.unreadTotal > 0 ? `${data.unreadTotal} unread ${data.unreadTotal === 1 ? 'message' : 'messages'} from clients.` : 'Conversations with your clients, from their portals.'}
      />
      {error && !data ? (
        <Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load messages" /></Card>
      ) : noMessagesAtAll ? (
        <Card><EmptyState icon={<MessagesSquare />} title="No messages yet" description="When clients write to you from their portal, conversations appear here." className="py-20" /></Card>
      ) : (
        <Card className="flex h-[calc(100dvh-14rem)] min-h-[30rem] overflow-hidden">
          <section aria-label="Conversations" className={cn('min-h-0 w-full flex-col border-border lg:flex lg:w-[22rem] lg:shrink-0 lg:border-r', selected ? 'hidden' : 'flex')}>
            <div className="shrink-0 border-b border-border p-3">
              <SearchInput onChange={setQ} debounceMs={150} placeholder="Search conversations…" aria-label="Search conversations" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {isPending ? (
                <div className="space-y-4 p-4" aria-busy="true">
                  {Array.from({ length: 5 }, (_, i) => (
                    <div key={i} className="flex gap-3"><Skeleton className="size-10 shrink-0 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-full" /></div></div>
                  ))}
                </div>
              ) : (
                <InboxList threads={threads} selectedPortalId={selected} filtered={q.trim().length > 0} />
              )}
            </div>
          </section>
          <section aria-label="Conversation" className={cn('min-h-0 min-w-0 flex-1', selected ? 'block' : 'hidden lg:block')}>
            {selected ? (
              <ThreadPane
                key={selected}
                portalId={selected}
                fallback={selectedThread && { clientId: selectedThread.clientId, clientName: selectedThread.clientName, portalName: selectedThread.portalName }}
              />
            ) : (
              <EmptyState icon={<MessagesSquare />} title="Select a conversation" description="Choose a client on the left to read and reply." className="h-full" />
            )}
          </section>
        </Card>
      )}
    </>
  );
}
