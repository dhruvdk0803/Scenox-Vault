'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, isToday, isYesterday } from 'date-fns';
import { ArrowDown, MessagesSquare, Paperclip, Send } from 'lucide-react';
import type { MessageDTO, MessageListResponse } from '@scenox/shared';
import { api, errorMessage, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { Tooltip } from '@/components/ui/tooltip';
import { ErrorState } from '../query-state';

export const MESSAGE_MAX_LENGTH = 5000;
const PAGE_SIZE = 50;
const GROUP_GAP_MS = 10 * 60_000;

interface PendingMessage {
  tempId: string;
  body: string;
  createdAt: string;
}

function mergeMessages(...lists: MessageDTO[][]): MessageDTO[] {
  const byId = new Map<string, MessageDTO>();
  for (const list of lists) for (const m of list) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function dayLabel(d: Date): string {
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, d.getFullYear() === new Date().getFullYear() ? 'EEEE, MMMM d' : 'MMMM d, yyyy');
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

function MessageTime({ iso, className }: { iso: string; className?: string }) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <Tooltip content={format(d, 'PPpp')}>
      <time dateTime={d.toISOString()} className={cn('whitespace-nowrap text-[11px] tabular-nums text-fg-subtle', className)}>
        {format(d, 'p')}
      </time>
    </Tooltip>
  );
}

function FileChip({ message, onOpenFile }: { message: MessageDTO; onOpenFile?: (fileId: string) => void }) {
  if (!message.fileId) return null;
  const label = (
    <>
      <Paperclip className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0 text-fg-muted">On file:</span>
      <span className="min-w-0 truncate">{message.fileName ?? 'Deleted file'}</span>
    </>
  );
  const cls = 'mb-1.5 inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-xs font-medium text-fg';
  if (!onOpenFile) return <span className={cls}>{label}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenFile(message.fileId!)}
      className={cn(cls, 'transition-colors duration-150 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring')}
      aria-label={`Open file details for ${message.fileName ?? 'deleted file'}`}
    >
      {label}
    </button>
  );
}

function Bubble({
  message, showHeader, showTime, onOpenFile, sending,
}: { message: MessageDTO; showHeader: boolean; showTime: boolean; onOpenFile?: (fileId: string) => void; sending?: boolean }) {
  const staff = message.authorType === 'staff';
  return (
    <div className={cn('flex gap-2', staff ? 'justify-end' : 'justify-start', showHeader ? 'mt-3' : 'mt-0.5')}>
      {!staff && (
        <div className="w-6 shrink-0 pt-5">{showHeader && <Avatar name={message.authorName} size="sm" />}</div>
      )}
      <div className={cn('flex min-w-0 max-w-[85%] flex-col sm:max-w-[75%]', staff ? 'items-end' : 'items-start')}>
        {showHeader && <span className="mb-1 max-w-full truncate px-1 text-xs font-medium text-fg-muted">{message.authorName}</span>}
        <div
          className={cn(
            'min-w-0 max-w-full rounded-2xl border px-3.5 py-2 text-sm text-fg',
            staff ? 'rounded-br-md border-primary-soft-border bg-primary-soft' : 'rounded-bl-md border-border bg-surface-muted',
            sending && 'opacity-60',
          )}
        >
          <FileChip message={message} onOpenFile={onOpenFile} />
          {/* Plain text only — never HTML. Line breaks are preserved by whitespace-pre-wrap. */}
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</p>
        </div>
        {sending ? (
          <span className="mt-0.5 px-1 text-[11px] text-fg-subtle">Sending…</span>
        ) : (
          showTime && <MessageTime iso={message.createdAt} className="mt-0.5 px-1" />
        )}
      </div>
    </div>
  );
}

function Composer({
  placeholder, sending, onSend, draft, setDraft, compact, canSend,
}: {
  placeholder: string;
  sending: boolean;
  onSend: () => void;
  draft: string;
  setDraft: (v: string) => void;
  compact?: boolean;
  canSend: boolean;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);
  const remaining = MESSAGE_MAX_LENGTH - draft.length;
  return (
    <div className="shrink-0 border-t border-border bg-surface p-3">
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          value={draft}
          rows={1}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-h-9 resize-none py-[7px] leading-5"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <Button onClick={onSend} disabled={!canSend} aria-label="Send message">
          {sending ? <Spinner className="size-4" label="" /> : <Send aria-hidden />}
          <span className={compact ? 'sr-only' : 'hidden sm:inline'}>Send</span>
        </Button>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 px-0.5 text-[11px] text-fg-subtle">
        <span className={cn(compact && 'sr-only', 'hidden sm:inline')}>Enter to send · Shift+Enter for a new line</span>
        {draft.length > MESSAGE_MAX_LENGTH - 500 && (
          <span className={cn('ml-auto tabular-nums', remaining <= 0 && 'font-medium text-danger')} aria-live="polite">
            {remaining.toLocaleString('en-US')} characters left
          </span>
        )}
      </div>
    </div>
  );
}

export interface MessageThreadProps {
  portalId: string;
  /** Scope the thread to comments on one file. */
  fileId?: string | null;
  /** Opens the file details for "On file" chips. Chips render as plain labels when omitted. */
  onOpenFile?: (fileId: string) => void;
  /** Tighter layout for embedding in dialogs. */
  compact?: boolean;
  /** Mark client messages as read while this thread is visible. Defaults to true for portal-level threads. */
  markRead?: boolean;
  className?: string;
}

/**
 * A live conversation: chat bubbles, day separators, "Load earlier", composer, 10s polling and mark-read.
 * Fills its parent's height — give the parent (or `className`) a fixed/flexible height.
 */
export function MessageThread(props: MessageThreadProps) {
  return <ThreadInner key={`${props.portalId}:${props.fileId ?? ''}`} {...props} />;
}

function ThreadInner({ portalId, fileId, onOpenFile, compact, markRead, className }: MessageThreadProps) {
  const qc = useQueryClient();
  const canPost = usePermission('portals.manage');
  const visible = useDocumentVisible();
  const shouldMarkRead = markRead ?? !fileId;

  const listPath = fileId ? `/files/${fileId}/comments` : `/portals/${portalId}/messages`;
  const key = queryKeys.messages.thread(portalId, fileId);

  const latest = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<MessageListResponse>(`${listPath}${qs({ limit: PAGE_SIZE })}`, { signal }),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const [older, setOlder] = React.useState<MessageDTO[]>([]);
  const [olderHasMore, setOlderHasMore] = React.useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [pending, setPending] = React.useState<PendingMessage[]>([]);
  const [draft, setDraft] = React.useState('');
  const [atBottom, setAtBottom] = React.useState(true);

  const items = React.useMemo(() => mergeMessages(older, latest.data?.items ?? []), [older, latest.data]);
  const hasMore = olderHasMore ?? latest.data?.hasMore ?? false;

  // ── scrolling ──
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const stickRef = React.useRef(true);
  const prependRef = React.useRef<number | null>(null);

  const scrollToBottom = React.useCallback((smooth = false) => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (prependRef.current !== null) {
      el.scrollTop += el.scrollHeight - prependRef.current;
      prependRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items.length, pending.length, latest.isPending]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = near;
    setAtBottom(near);
  }

  // ── older messages ──
  async function loadEarlier() {
    const oldest = items[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await api.get<MessageListResponse>(`${listPath}${qs({ before: oldest.createdAt, limit: PAGE_SIZE })}`);
      const known = new Set(items.map((m) => m.id));
      const fresh = res.items.filter((m) => !known.has(m.id));
      prependRef.current = scrollerRef.current?.scrollHeight ?? null;
      stickRef.current = false;
      setOlder((o) => mergeMessages(o, fresh));
      // If the server returned nothing new, stop offering "Load earlier" so we never loop.
      setOlderHasMore(fresh.length > 0 && res.hasMore);
    } catch (e) {
      toast.error("Couldn't load earlier messages", { description: errorMessage(e) });
    } finally {
      setLoadingOlder(false);
    }
  }

  // ── mark read (portal threads only) ──
  const newestUnreadClientId = React.useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i]!;
      if (m.authorType === 'client' && !m.readAt) return m.id;
    }
    return null;
  }, [items]);
  const markedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!shouldMarkRead || !visible || !newestUnreadClientId || markedRef.current === newestUnreadClientId) return;
    markedRef.current = newestUnreadClientId;
    api
      .post(`/portals/${portalId}/messages/read`)
      .then(() => {
        void qc.invalidateQueries({ queryKey: queryKeys.messages.inbox });
        void qc.invalidateQueries({ queryKey: key });
      })
      .catch(() => {
        markedRef.current = null; // allow a retry on the next poll
      });
  }, [shouldMarkRead, visible, newestUnreadClientId, portalId, qc]);

  // ── sending ──
  async function send() {
    const body = draft.trim();
    if (!body || body.length > MESSAGE_MAX_LENGTH) return;
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    stickRef.current = true;
    setDraft('');
    setPending((p) => [...p, { tempId, body, createdAt: new Date().toISOString() }]);
    try {
      const msg = await api.post<MessageDTO>(`/portals/${portalId}/messages`, fileId ? { body, fileId } : { body });
      qc.setQueryData<MessageListResponse>(key, (old) => (old ? { ...old, items: mergeMessages(old.items, [msg]) } : old));
      setPending((p) => p.filter((x) => x.tempId !== tempId));
      void qc.invalidateQueries({ queryKey: queryKeys.messages.inbox });
    } catch (e) {
      setPending((p) => p.filter((x) => x.tempId !== tempId));
      setDraft((d) => (d ? d : body)); // give the text back so nothing is lost
      toast.error("Message wasn't sent", { description: errorMessage(e) });
    }
  }

  const sending = pending.length > 0;
  const canSend = canPost && draft.trim().length > 0 && draft.length <= MESSAGE_MAX_LENGTH;

  // Day separators + grouping
  const rows: React.ReactNode[] = [];
  const all: Array<{ m: MessageDTO; sending?: boolean }> = [
    ...items.map((m) => ({ m })),
    ...pending.map((p) => ({
      sending: true,
      m: { id: p.tempId, portalId, fileId: fileId ?? null, fileName: null, authorType: 'staff' as const, authorName: 'You', body: p.body, createdAt: p.createdAt, readAt: null },
    })),
  ];
  all.forEach(({ m, sending: isSending }, i) => {
    const d = new Date(m.createdAt);
    const prev = all[i - 1]?.m;
    const next = all[i + 1]?.m;
    const prevD = prev ? new Date(prev.createdAt) : null;
    const newDay = !prevD || prevD.toDateString() !== d.toDateString();
    if (newDay) {
      rows.push(
        <div key={`day-${m.id}`} className="my-4 flex items-center gap-3 first:mt-1" role="separator" aria-label={dayLabel(d)}>
          <span className="h-px flex-1 bg-border" aria-hidden />
          <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11px] font-medium text-fg-muted">{dayLabel(d)}</span>
          <span className="h-px flex-1 bg-border" aria-hidden />
        </div>,
      );
    }
    const sameAsPrev = !!prev && !newDay && prev.authorType === m.authorType && prev.authorName === m.authorName && d.getTime() - new Date(prev.createdAt).getTime() < GROUP_GAP_MS;
    const sameAsNext =
      !!next && next.authorType === m.authorType && next.authorName === m.authorName && new Date(next.createdAt).toDateString() === d.toDateString() && new Date(next.createdAt).getTime() - d.getTime() < GROUP_GAP_MS;
    rows.push(<Bubble key={m.id} message={m} showHeader={!sameAsPrev} showTime={!sameAsNext} onOpenFile={fileId ? undefined : onOpenFile} sending={isSending} />);
  });

  return (
    <div className={cn('flex min-h-0 flex-col bg-surface', className)}>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollerRef} onScroll={onScroll} role="log" aria-label={fileId ? 'File comments' : 'Conversation'} className={cn('h-full overflow-y-auto overscroll-contain', compact ? 'px-3 py-2' : 'px-4 py-3 sm:px-5')}>
          {latest.isPending ? (
            <div className="space-y-4 py-2" aria-busy="true">
              <Skeleton className="h-12 w-2/3" />
              <Skeleton className="ml-auto h-10 w-1/2" />
              <Skeleton className="h-16 w-3/5" />
            </div>
          ) : latest.error && !latest.data ? (
            <ErrorState error={latest.error} onRetry={() => void latest.refetch()} retrying={latest.isFetching} title="Couldn't load messages" />
          ) : all.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare />}
              title={fileId ? 'No comments yet' : 'No messages yet'}
              description={fileId ? 'Comments about this file from you and the client will appear here.' : 'Send a message to start the conversation. Client replies appear here.'}
              className={compact ? 'py-8' : 'py-14'}
            />
          ) : (
            <>
              {hasMore && (
                <div className="flex justify-center pb-2">
                  <Button variant="outline" size="sm" onClick={() => void loadEarlier()} loading={loadingOlder}>Load earlier</Button>
                </div>
              )}
              {rows}
            </>
          )}
        </div>
        {!atBottom && all.length > 0 && (
          <Button
            variant="outline"
            size="icon"
            className="absolute bottom-3 right-4 size-8 rounded-full shadow-md"
            aria-label="Jump to latest message"
            onClick={() => {
              stickRef.current = true;
              scrollToBottom(true);
            }}
          >
            <ArrowDown aria-hidden />
          </Button>
        )}
      </div>
      {latest.isError && latest.data && (
        <p role="status" className="shrink-0 border-t border-warning-border bg-warning-bg px-4 py-1.5 text-xs text-warning">Having trouble refreshing — retrying…</p>
      )}
      {canPost ? (
        <Composer
          placeholder={fileId ? 'Write a comment…' : 'Write a message to the client…'}
          draft={draft}
          setDraft={setDraft}
          onSend={() => void send()}
          sending={sending}
          canSend={canSend}
          compact={compact}
        />
      ) : (
        <p className="shrink-0 border-t border-border bg-surface-muted px-4 py-3 text-center text-xs text-fg-muted">You have read-only access, so you can&apos;t reply here.</p>
      )}
    </div>
  );
}
