'use client';

import * as React from 'react';
import { ArrowDown, FileText, MessageSquarePlus } from 'lucide-react';
import { format } from 'date-fns';
import type { MessageDTO } from '@scenox/shared';
import { Avatar, Button, Skeleton } from '@/components/ui';
import { friendlyError } from '@/lib/portal/format';
import { useThread } from '@/lib/portal/hooks';
import { buildThread, isOwn } from '@/lib/portal/messages';
import { whenFull } from '@/lib/portal/format';
import { cn } from '@/lib/utils';
import { MessageComposer } from './message-composer';
import { usePortal } from './portal-context';
import { InlineError } from './ui-bits';

/**
 * Chat-style thread: the general conversation (fileId null) or the comments on one file.
 * Message text is rendered as plain text (React escapes it); line breaks are preserved with CSS only.
 */
export function MessageThread({ fileId, emptyTitle, emptyHint, placeholder, autoFocusComposer, className }: {
  fileId: string | null;
  emptyTitle: string;
  emptyHint: string;
  placeholder: string;
  autoFocusComposer?: boolean;
  className?: string;
}) {
  const { token, branding } = usePortal();
  const thread = useThread(fileId);
  const { messages, latest } = thread;
  const entries = React.useMemo(() => buildThread(messages), [messages]);

  const scroller = React.useRef<HTMLDivElement>(null);
  const atBottom = React.useRef(true);
  const lastId = React.useRef<string | null>(null);
  const anchor = React.useRef<{ height: number; top: number } | null>(null);
  const [newBelow, setNewBelow] = React.useState(false);

  const toBottom = React.useCallback((behavior: ScrollBehavior) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottom.current = true;
    setNewBelow(false);
  }, []);

  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      // older messages were prepended: keep what the reader was looking at in place
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
      return;
    }
    const last = messages[messages.length - 1];
    if (!last) return;
    if (lastId.current === null) toBottom('auto');
    else if (last.id !== lastId.current) {
      if (atBottom.current || isOwn(last)) toBottom('smooth');
      else setNewBelow(true);
    }
    lastId.current = last.id;
  }, [messages, toBottom]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) setNewBelow(false);
  }

  async function loadEarlier() {
    const el = scroller.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    const added = await thread.loadEarlier();
    if (!added) anchor.current = null; // nothing was prepended; don't let the anchor hijack the next update
  }

  async function send(body: string, who: { name: string; email: string }) {
    try {
      await thread.post.mutateAsync({ body, name: who.name, email: who.email || null });
    } catch (e) {
      throw new Error(friendlyError(e, 'Your message couldn’t be sent. Please try again.'));
    }
  }

  const loading = latest.isLoading;
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label={fileId ? 'Comments' : 'Conversation'}
          className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-5"
        >
          {thread.hasMoreEarlier && (
            <div className="mb-4 flex flex-col items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => void loadEarlier()} loading={thread.loadingEarlier}>
                Load earlier messages
              </Button>
              {thread.earlierError && <p role="alert" className="text-xs text-danger">Couldn’t load earlier messages. Try again.</p>}
            </div>
          )}

          {loading ? (
            <ThreadSkeleton />
          ) : latest.isError && messages.length === 0 ? (
            <InlineError message={friendlyError(latest.error, 'We couldn’t load the conversation.')} onRetry={() => void latest.refetch()} />
          ) : messages.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-4 text-center">
              <span aria-hidden className="flex size-11 items-center justify-center rounded-full border border-border bg-surface-muted text-fg-subtle">
                <MessageSquarePlus className="size-5" />
              </span>
              <div className="flex max-w-xs flex-col gap-1">
                <p className="text-base font-semibold text-fg">{emptyTitle}</p>
                <p className="text-sm text-fg-muted">{emptyHint.replace('{team}', branding.companyName || 'the team')}</p>
              </div>
            </div>
          ) : (
            <ol className="flex flex-col">
              {entries.map((e) =>
                e.kind === 'day' ? (
                  <li key={e.key} className="my-3 flex items-center gap-3 first:mt-0" aria-label={e.label}>
                    <span aria-hidden className="h-px flex-1 bg-border" />
                    <span className="text-xs font-medium text-fg-subtle">{e.label}</span>
                    <span aria-hidden className="h-px flex-1 bg-border" />
                  </li>
                ) : (
                  <Bubble key={e.key} m={e.message} first={e.first} last={e.last} showFileChip={!fileId} />
                ),
              )}
            </ol>
          )}
        </div>
        {newBelow && (
          <Button size="sm" onClick={() => toBottom('smooth')} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md">
            <ArrowDown aria-hidden /> New messages
          </Button>
        )}
      </div>
      <MessageComposer token={token} sending={thread.post.isPending} placeholder={placeholder} autoFocus={autoFocusComposer} onSend={send} />
    </div>
  );
}

function Bubble({ m, first, last, showFileChip }: { m: MessageDTO; first: boolean; last: boolean; showFileChip: boolean }) {
  const { openFileComments } = usePortal();
  const own = isOwn(m);
  const time = format(new Date(m.createdAt), 'h:mm a');
  return (
    <li className={cn('flex gap-2', own ? 'justify-end' : 'justify-start', first ? 'mt-3 first:mt-0' : 'mt-0.5')}>
      {!own && (
        <span className="w-6 shrink-0 pt-0.5">
          {first && <Avatar name={m.authorName} size="sm" />}
        </span>
      )}
      <div className={cn('flex min-w-0 max-w-[85%] flex-col sm:max-w-[72%]', own ? 'items-end' : 'items-start')}>
        {!own && first && <span className="mb-0.5 truncate px-1 text-xs font-medium text-fg-muted">{m.authorName}</span>}
        <div
          className={cn(
            'min-w-0 max-w-full rounded-2xl border px-3.5 py-2 text-sm leading-[22px]',
            own ? 'border-primary-soft-border bg-primary-soft text-fg' : 'border-border bg-surface-muted/70 text-fg',
            own ? (last ? 'rounded-br-md' : '') : last ? 'rounded-bl-md' : '',
          )}
        >
          {showFileChip && m.fileId && (
            <button
              type="button" onClick={() => openFileComments({ id: m.fileId!, name: m.fileName ?? 'File' })}
              className="mb-1 inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            >
              <FileText aria-hidden className="size-3 shrink-0" />
              <span className="truncate">On {m.fileName ?? 'a file'}</span>
            </button>
          )}
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>
        </div>
        {last && (
          <time dateTime={m.createdAt} title={whenFull(m.createdAt)} className="mt-1 px-1 text-[11px] tabular-nums text-fg-subtle">
            {time}
          </time>
        )}
      </div>
    </li>
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading messages">
      <div className="flex items-end gap-2"><Skeleton className="size-6 rounded-full" /><Skeleton className="h-12 w-3/5 rounded-2xl" /></div>
      <div className="flex justify-end"><Skeleton className="h-9 w-2/5 rounded-2xl" /></div>
      <div className="flex items-end gap-2"><Skeleton className="size-6 rounded-full" /><Skeleton className="h-16 w-1/2 rounded-2xl" /></div>
    </div>
  );
}

