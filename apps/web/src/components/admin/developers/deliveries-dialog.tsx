'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Clock, Inbox, RefreshCw, RotateCw, Send, XCircle } from 'lucide-react';
import type { WebhookDeliveryDTO, WebhookDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useWebhookDeliveries } from '@/lib/hooks/use-developer';
import { cn } from '@/lib/utils';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toaster';
import { ErrorState } from '../query-state';
import { formatDateTime, RelativeTime } from '../relative-time';
import { formatMs } from './webhook-events';

const STATUS: Record<WebhookDeliveryDTO['status'], { label: string; tone: BadgeTone; icon: typeof Clock }> = {
  pending: { label: 'Pending', tone: 'info', icon: Clock },
  success: { label: 'Delivered', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
};

export function DeliveryStatusBadge({ status }: { status: WebhookDeliveryDTO['status'] }) {
  const s = STATUS[status] ?? STATUS.pending;
  const Icon = s.icon;
  return <Badge tone={s.tone}><Icon aria-hidden /> {s.label}</Badge>;
}

export function HttpStatusBadge({ code }: { code: number | null }) {
  if (code == null) return <span className="text-fg-subtle">—</span>;
  const tone: BadgeTone = code >= 200 && code < 300 ? 'success' : code >= 300 && code < 400 ? 'warning' : 'danger';
  return <Badge tone={tone} className="font-mono tabular-nums">{code}</Badge>;
}

const PREVIEW_CHARS = 6000;

/** Plain-text JSON/text viewer. Long content is clipped (the copy button always copies everything). */
function TextBlock({ title, text }: { title: string; text: string }) {
  const [full, setFull] = React.useState(false);
  const clipped = !full && text.length > PREVIEW_CHARS;
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-3 py-1">
        <span className="text-xs font-medium text-fg-muted">{title}</span>
        <CopyButton value={text} label={`Copy ${title.toLowerCase()}`} className="size-7" />
      </div>
      <pre tabIndex={0} className="max-h-72 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-xs leading-5 text-fg focus-visible:outline-2 focus-visible:outline-ring">
        {clipped ? text.slice(0, PREVIEW_CHARS) : text}
      </pre>
      {clipped && (
        <div className="border-t border-border bg-surface-muted px-3 py-1.5">
          <Button type="button" variant="link" className="text-xs" onClick={() => setFull(true)}>
            Show all {text.length.toLocaleString('en-US')} characters
          </Button>
        </div>
      )}
    </div>
  );
}

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function DeliveryDetail({ d, id, onRedeliver, redelivering }: { d: WebhookDeliveryDTO; id: string; onRedeliver: () => void; redelivering: boolean }) {
  const payload = React.useMemo(() => JSON.stringify(d.payload, null, 2), [d.payload]);
  return (
    <div id={id} className="grid gap-3 border-t border-border bg-surface-muted/50 px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-muted">
        <span>Delivery <code className="font-mono text-fg">{d.id}</code></span>
        <span className="tabular-nums">{d.attempts} {d.attempts === 1 ? 'attempt' : 'attempts'}</span>
        <span className="tabular-nums">Created {formatDateTime(d.createdAt)}</span>
        {d.deliveredAt && <span className="tabular-nums">Delivered {formatDateTime(d.deliveredAt)}</span>}
        <Button size="sm" variant="outline" className="ml-auto" onClick={onRedeliver} loading={redelivering}>
          {!redelivering && <RotateCw aria-hidden />} Redeliver
        </Button>
      </div>
      {d.error && (
        <div role="status" className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
          <span className="font-medium">Delivery error: </span><span className="break-words">{d.error}</span>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <TextBlock title="Request payload" text={payload} />
        <TextBlock title={d.responseStatus != null ? `Response (HTTP ${d.responseStatus})` : 'Response'} text={d.responseBody ? prettyBody(d.responseBody) : d.responseStatus != null ? '(empty body)' : '(no response received)'} />
      </div>
    </div>
  );
}

/** Recent deliveries for a webhook, polled every 5 s while open. */
export function DeliveriesDialog({ webhook, onClose }: { webhook: WebhookDTO | null; onClose: () => void }) {
  const qc = useQueryClient();
  const open = !!webhook;
  const { data, isPending, error, refetch, isFetching, dataUpdatedAt } = useWebhookDeliveries(webhook?.id ?? null, open);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const baseId = React.useId();

  React.useEffect(() => {
    if (!open) setExpanded(new Set());
  }, [open]);

  const refresh = () => {
    if (!webhook) return;
    void qc.invalidateQueries({ queryKey: queryKeys.developer.deliveries(webhook.id) });
    void qc.invalidateQueries({ queryKey: queryKeys.developer.webhooks });
  };
  const report = (d: WebhookDeliveryDTO, verb: string) => {
    if (d.status === 'success') toast.success(`${verb} — delivered`, { description: d.responseStatus ? `Your endpoint answered HTTP ${d.responseStatus}.` : undefined });
    else if (d.status === 'pending') toast.info(`${verb} — queued`, { description: 'It will appear here once it has been delivered.' });
    else toast.error(`${verb} — failed`, { description: d.error ?? (d.responseStatus ? `Your endpoint answered HTTP ${d.responseStatus}.` : 'No response from your endpoint.') });
  };

  const test = useMutation({
    mutationFn: () => api.post<WebhookDeliveryDTO>(`/developer/webhooks/${webhook!.id}/test`),
    onSuccess: (d) => { report(d, 'Test sent'); refresh(); },
    onError: (e) => toast.error("Couldn't send a test", { description: errorMessage(e) }),
  });
  const redeliver = useMutation({
    mutationFn: (id: string) => api.post<WebhookDeliveryDTO>(`/developer/webhooks/deliveries/${id}/redeliver`),
    onSuccess: (d) => { report(d, 'Redelivered'); refresh(); },
    onError: (e) => toast.error("Couldn't redeliver", { description: errorMessage(e) }),
  });

  const rows = data ?? [];
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{webhook?.name ?? 'Webhook'}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{webhook?.url}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Recent deliveries</h3>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 text-xs text-fg-subtle sm:inline-flex" aria-live="off">
              <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} aria-hidden /> Auto-refreshing every 5 s
              {dataUpdatedAt ? <span className="sr-only"> (last updated {new Date(dataUpdatedAt).toLocaleTimeString()})</span> : null}
            </span>
            <Button size="sm" variant="outline" onClick={() => test.mutate()} loading={test.isPending}>
              {!test.isPending && <Send aria-hidden />} Send test
            </Button>
          </div>
        </div>

        {error && !data ? (
          <ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load deliveries" />
        ) : isPending ? (
          <div className="space-y-2" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-strong">
            <EmptyState icon={<Inbox />} title="No deliveries yet" description="Send a test to check that your endpoint receives and verifies events." action={<Button variant="outline" onClick={() => test.mutate()} loading={test.isPending}><Send aria-hidden /> Send test</Button>} className="py-10" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="hidden grid-cols-[1.25rem_minmax(0,1.6fr)_7.5rem_4rem_5rem_6.5rem] items-center gap-3 border-b border-border bg-surface-muted px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-subtle md:grid" aria-hidden>
              <span /><span>Event</span><span>Status</span><span>HTTP</span><span>Duration</span><span className="text-right">Time</span>
            </div>
            <ul className="divide-y divide-border">
              {rows.map((d) => {
                const isOpen = expanded.has(d.id);
                const panelId = `${baseId}-${d.id}`;
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      onClick={() => toggle(d.id)}
                      className="grid w-full grid-cols-[1.25rem_1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:grid-cols-[1.25rem_minmax(0,1.6fr)_7.5rem_4rem_5rem_6.5rem]"
                    >
                      <ChevronRight className={cn('size-4 text-fg-subtle transition-transform duration-150', isOpen && 'rotate-90')} aria-hidden />
                      <span className="min-w-0 truncate font-mono text-[13px] font-medium text-fg">{d.event}</span>
                      <span className="justify-self-end md:justify-self-start"><DeliveryStatusBadge status={d.status} /></span>
                      <span className="col-start-2 text-xs md:col-start-auto md:text-sm"><HttpStatusBadge code={d.responseStatus} /></span>
                      <span className="hidden text-sm tabular-nums text-fg-muted md:block">{formatMs(d.durationMs)}</span>
                      <span className="col-start-3 justify-self-end text-xs text-fg-muted md:col-start-auto md:text-sm"><RelativeTime date={d.createdAt} className="whitespace-nowrap tabular-nums" /></span>
                    </button>
                    {isOpen && <DeliveryDetail d={d} id={panelId} onRedeliver={() => redeliver.mutate(d.id)} redelivering={redeliver.isPending && redeliver.variables === d.id} />}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
