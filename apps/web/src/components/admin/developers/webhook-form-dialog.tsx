'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { WEBHOOK_EVENTS, type CreateWebhookRequest, type CreateWebhookResponse, type UpdateWebhookRequest, type WebhookDTO, type WebhookEvent } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { ClientSelect } from '../client-select';
import { EVENT_INFO } from './webhook-events';

function validateUrl(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return 'Enter the URL that should receive events';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'Enter a full URL, like https://example.com/hooks/scenox';
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:' && local) return undefined;
  return 'The URL must start with https://';
}

function EventRow({ id, label, description, checked, disabled, onChange, mono = true }: { id: string; label: string; description: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-surface-muted">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(c) => onChange(c === true)} className="mt-0.5" />
      <div className="min-w-0">
        <Label htmlFor={id} className={mono ? 'cursor-pointer font-mono text-[13px]' : 'cursor-pointer'}>{label}</Label>
        <p className="mt-1 text-xs text-fg-muted">{description}</p>
      </div>
    </div>
  );
}

/** Create (webhook = null) or edit a webhook. On create, `onCreated` receives the one-time signing secret. */
export function WebhookFormDialog({
  open, webhook, onOpenChange, onCreated,
}: { open: boolean; webhook: WebhookDTO | null; onOpenChange: (o: boolean) => void; onCreated: (r: CreateWebhookResponse) => void }) {
  const qc = useQueryClient();
  const idBase = React.useId();
  const editing = !!webhook;
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [all, setAll] = React.useState(true);
  const [events, setEvents] = React.useState<Set<WebhookEvent>>(new Set());
  const [clientId, setClientId] = React.useState<string>();
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    setName(webhook?.name ?? '');
    setUrl(webhook?.url ?? '');
    const isAll = !webhook || webhook.events.includes('*');
    setAll(isAll);
    setEvents(new Set(webhook ? webhook.events.filter((e): e is WebhookEvent => e !== '*') : []));
    setClientId(webhook?.clientId ?? undefined);
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, webhook?.id]);

  const save = useMutation({
    gcTime: 0, // the create response carries the signing secret
    mutationFn: async (body: CreateWebhookRequest) => {
      if (webhook) {
        const patch: UpdateWebhookRequest = body;
        return { webhook: await api.patch<WebhookDTO>(`/developer/webhooks/${webhook.id}`, patch), secret: null as string | null };
      }
      const r = await api.post<CreateWebhookResponse>('/developer/webhooks', body);
      return { webhook: r.webhook, secret: r.secret as string | null };
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: queryKeys.developer.webhooks });
      onOpenChange(false);
      if (r.secret) onCreated({ webhook: r.webhook, secret: r.secret });
      else toast.success('Webhook updated');
    },
    onError: (e) => toast.error(editing ? "Couldn't update the webhook" : "Couldn't create the webhook", { description: errorMessage(e) }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Give the webhook a name';
    const urlError = validateUrl(url);
    if (urlError) next.url = urlError;
    if (!all && events.size === 0) next.events = 'Choose at least one event, or select “All events”';
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate({
      name: name.trim(),
      url: url.trim(),
      events: all ? ['*'] : WEBHOOK_EVENTS.filter((ev) => events.has(ev)),
      clientId: clientId ?? null,
    });
  }

  function toggleEvent(ev: WebhookEvent, on: boolean) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (on) next.add(ev);
      else next.delete(ev);
      return next;
    });
    setErrors((er) => ({ ...er, events: '' }));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} noValidate className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit webhook' : 'Add webhook'}</DialogTitle>
            <DialogDescription>
              {editing ? 'Change where and when events are delivered. The signing secret stays the same.' : 'Scenox Vault sends a signed HTTPS POST to your URL whenever one of the selected events happens.'}
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus autoComplete="off" placeholder="Shopify sync" />
          </Field>
          <Field label="Endpoint URL" required error={errors.url} hint="Must be https://. We send a POST with a JSON body and an X-Scenox-Signature header.">
            <Input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="https://example.com/hooks/scenox" className="font-mono text-[13px]" />
          </Field>
          <fieldset className="grid gap-1.5" aria-describedby={errors.events ? `${idBase}-events-error` : undefined}>
            <legend className="mb-1.5 text-sm font-medium leading-none text-fg">Events</legend>
            <div className="rounded-lg border border-border-strong p-1">
              <EventRow id={`${idBase}-all`} label="All events" mono={false} description="Including any events we add in the future." checked={all} onChange={setAll} />
              <div className="my-1 h-px bg-border" />
              <div className="grid gap-0.5 sm:grid-cols-1">
                {WEBHOOK_EVENTS.map((ev) => (
                  <EventRow key={ev} id={`${idBase}-${ev}`} label={ev} description={EVENT_INFO[ev]} checked={all || events.has(ev)} disabled={all} onChange={(on) => toggleEvent(ev, on)} />
                ))}
              </div>
            </div>
            {errors.events && <p id={`${idBase}-events-error`} role="alert" className="text-xs font-medium text-danger">{errors.events}</p>}
          </fieldset>
          <Field label="Client filter" hint="Optional. Only send events for one client's uploads, files and messages.">
            <ClientSelect allowAll value={clientId} onChange={setClientId} placeholder="All clients" aria-label="Client filter" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{editing ? 'Save changes' : 'Add webhook'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
