'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, History, MoreHorizontal, PauseCircle, Pencil, PlayCircle, Plus, RotateCw, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import type { CreateWebhookResponse, WebhookDeliveryDTO, WebhookDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useWebhooks } from '@/lib/hooks/use-developer';
import { usePermission } from '@/lib/hooks/use-me';
import { withToast } from '@/lib/hooks/use-confirm-mutation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from '@/components/ui/toaster';
import { ErrorState } from '../query-state';
import { RelativeTime } from '../relative-time';
import { DeliveriesDialog, HttpStatusBadge } from './deliveries-dialog';
import { SecretDialog } from './secret-dialog';
import { SignatureHelp } from './signature-help';
import { WebhookFormDialog } from './webhook-form-dialog';

function EventsCell({ events }: { events: WebhookDTO['events'] }) {
  if (events.includes('*')) return <Badge tone="primary">All events</Badge>;
  const shown = events.slice(0, 2);
  const rest = events.length - shown.length;
  return (
    <div className="flex max-w-64 flex-wrap gap-1" title={events.join(', ')}>
      {shown.map((e) => <Badge key={e} className="font-mono">{e}</Badge>)}
      {rest > 0 && <Badge>+{rest} more</Badge>}
    </div>
  );
}

export function WebhooksTab() {
  const canManage = usePermission('settings.manage');
  const qc = useQueryClient();
  const { data, isPending, error, refetch, isFetching } = useWebhooks();

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<WebhookDTO | null>(null);
  const [viewId, setViewId] = React.useState<string | null>(null);
  const [remove, setRemove] = React.useState<WebhookDTO | null>(null);
  const [rotate, setRotate] = React.useState<WebhookDTO | null>(null);
  const [secret, setSecret] = React.useState<{ title: string; webhook: WebhookDTO; value: string } | null>(null);
  const [testingId, setTestingId] = React.useState<string | null>(null);

  const rows = data ?? [];
  const viewing = viewId ? rows.find((w) => w.id === viewId) ?? null : null;
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.developer.webhooks });

  const toggle = useMutation({
    mutationFn: (w: WebhookDTO) => api.patch<WebhookDTO>(`/developer/webhooks/${w.id}`, { enabled: !w.enabled }),
    onSuccess: (w) => { toast.success(w.enabled ? 'Webhook enabled' : 'Webhook disabled'); void refresh(); },
    onError: (e) => toast.error("Couldn't update the webhook", { description: errorMessage(e) }),
  });

  async function sendTest(w: WebhookDTO) {
    setTestingId(w.id);
    try {
      const d = await api.post<WebhookDeliveryDTO>(`/developer/webhooks/${w.id}/test`);
      if (d.status === 'success') toast.success('Test delivered', { description: d.responseStatus ? `${w.name} answered HTTP ${d.responseStatus}.` : undefined });
      else if (d.status === 'pending') toast.info('Test queued', { description: 'Open the delivery log to see the result.' });
      else toast.error('Test failed', { description: d.error ?? (d.responseStatus ? `${w.name} answered HTTP ${d.responseStatus}.` : 'No response from your endpoint.') });
      void refresh();
      void qc.invalidateQueries({ queryKey: queryKeys.developer.deliveries(w.id) });
    } catch (err) {
      toast.error("Couldn't send a test", { description: errorMessage(err) });
    } finally {
      setTestingId(null);
    }
  }

  const openCreate = () => { setEditing(null); setFormOpen(true); };

  const columns: DataTableColumn<WebhookDTO>[] = [
    {
      key: 'name',
      header: 'Webhook',
      className: 'min-w-56 max-w-sm',
      cell: (w) => (
        <div className="min-w-0">
          <p className="truncate font-medium" title={w.name}>{w.name}</p>
          <p className="truncate font-mono text-xs text-fg-subtle" title={w.url}>{w.url}</p>
        </div>
      ),
    },
    { key: 'events', header: 'Events', className: 'hidden md:table-cell', cell: (w) => <EventsCell events={w.events} /> },
    {
      key: 'client',
      header: 'Client',
      className: 'hidden xl:table-cell',
      cell: (w) => (w.clientName ? <span className="block max-w-40 truncate">{w.clientName}</span> : <span className="text-fg-subtle">All clients</span>),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (w) => (
        <div className="flex flex-col items-start gap-1">
          {w.enabled ? <Badge tone="success"><CheckCircle2 aria-hidden /> Enabled</Badge> : <Badge tone="neutral"><PauseCircle aria-hidden /> Disabled</Badge>}
          {w.consecutiveFailures > 0 && (
            <span className="text-xs font-medium tabular-nums text-danger">{w.consecutiveFailures} {w.consecutiveFailures === 1 ? 'failure' : 'failures'} in a row</span>
          )}
        </div>
      ),
    },
    {
      key: 'last',
      header: 'Last delivery',
      className: 'hidden sm:table-cell',
      cell: (w) =>
        w.lastDeliveryAt ? (
          <div className="flex items-center gap-2">
            {w.lastStatus != null ? <HttpStatusBadge code={w.lastStatus} /> : <Badge tone="danger">No response</Badge>}
            <RelativeTime date={w.lastDeliveryAt} className="whitespace-nowrap tabular-nums text-fg-muted" />
          </div>
        ) : (
          <span className="text-fg-subtle">No deliveries yet</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: 'w-12',
      cell: (w) => (
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${w.name}`} loading={testingId === w.id}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setViewId(w.id)}><History aria-hidden /> View deliveries</DropdownMenuItem>
              {canManage && (
                <>
                  <DropdownMenuItem onSelect={() => { setEditing(w); setFormOpen(true); }}><Pencil aria-hidden /> Edit</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => toggle.mutate(w)}>
                    {w.enabled ? <><PauseCircle aria-hidden /> Disable</> : <><PlayCircle aria-hidden /> Enable</>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void sendTest(w)}><Send aria-hidden /> Send test</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRotate(w)}><RotateCw aria-hidden /> Rotate secret</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setRemove(w)}><Trash2 aria-hidden /> Delete</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm text-fg-muted">
            Webhooks push events to your own systems the moment they happen, so you don&apos;t have to poll. Failed deliveries are retried automatically.
          </p>
          {canManage && <Button onClick={openCreate}><Plus aria-hidden /> Add webhook</Button>}
        </div>

        {error && !data ? (
          <Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load webhooks" /></Card>
        ) : (
          <DataTable
            caption="Webhooks"
            columns={columns}
            rows={rows}
            getRowId={(w) => w.id}
            loading={isPending}
            skeletonRows={3}
            onRowClick={(w) => setViewId(w.id)}
            empty={
              <EmptyState
                icon={<WebhookIcon />}
                title="No webhooks yet"
                description="Add an endpoint to be notified when clients finish uploading, files become ready, and more."
                action={canManage ? <Button onClick={openCreate}><Plus aria-hidden /> Add webhook</Button> : undefined}
              />
            }
          />
        )}
      </div>

      <SignatureHelp />

      <WebhookFormDialog
        open={formOpen}
        webhook={editing}
        onOpenChange={setFormOpen}
        onCreated={(r: CreateWebhookResponse) => setSecret({ title: 'Webhook created', webhook: r.webhook, value: r.secret })}
      />
      <DeliveriesDialog webhook={viewing} onClose={() => setViewId(null)} />

      <SecretDialog
        secret={secret?.value ?? null}
        title={secret?.title ?? 'Signing secret'}
        secretLabel="Signing secret"
        description={secret ? <>Use this secret to verify that requests to “{secret.webhook.name}” really come from Scenox Vault.</> : null}
        onClose={() => setSecret(null)}
      />

      <ConfirmDialog
        open={!!rotate}
        onOpenChange={(o) => !o && setRotate(null)}
        title="Rotate the signing secret?"
        description={rotate ? <>A new secret is generated for “{rotate.name}”. The current one stops working immediately, so update your endpoint right after copying the new one.</> : undefined}
        confirmLabel="Rotate secret"
        destructive
        onConfirm={async () => {
          if (!rotate) return;
          try {
            const r = await api.post<{ secret: string }>(`/developer/webhooks/${rotate.id}/rotate-secret`);
            setSecret({ title: 'New signing secret', webhook: rotate, value: r.secret });
          } catch (err) {
            toast.error("Couldn't rotate the secret", { description: errorMessage(err) });
            throw err;
          }
        }}
      />
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title="Delete this webhook?"
        description={remove ? <>“{remove.name}” will stop receiving events and its delivery history will be removed. This can&apos;t be undone.</> : undefined}
        confirmLabel="Delete webhook"
        destructive
        onConfirm={withToast(
          async () => {
            if (!remove) return;
            await api.delete(`/developer/webhooks/${remove.id}`);
            if (viewId === remove.id) setViewId(null);
            await refresh();
          },
          { success: 'Webhook deleted', error: "Couldn't delete the webhook" },
        )}
      />
    </div>
  );
}
