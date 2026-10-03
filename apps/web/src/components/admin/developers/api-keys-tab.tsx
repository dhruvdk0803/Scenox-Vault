'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Eye, KeyRound, MoreHorizontal, Pencil, Plus, TimerOff, Trash2 } from 'lucide-react';
import type { ApiKeyDTO, CreateApiKeyRequest, CreateApiKeyResponse } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useApiKeys, useOrigin } from '@/lib/hooks/use-developer';
import { usePermission } from '@/lib/hooks/use-me';
import { withToast } from '@/lib/hooks/use-confirm-mutation';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SimpleSelect } from '@/components/ui/select';
import { toast } from '@/components/ui/toaster';
import { ErrorState } from '../query-state';
import { formatDate, RelativeTime } from '../relative-time';
import { CodeBlock } from './code-block';
import { RadioCards } from './radio-cards';
import { SecretDialog } from './secret-dialog';

type Access = 'read' | 'write';
type KeyStatus = 'active' | 'revoked' | 'expired';

export function keyStatus(k: ApiKeyDTO, now = Date.now()): KeyStatus {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

const STATUS: Record<KeyStatus, { label: string; tone: BadgeTone; icon: typeof CheckCircle2 }> = {
  active: { label: 'Active', tone: 'success', icon: CheckCircle2 },
  revoked: { label: 'Revoked', tone: 'neutral', icon: Ban },
  expired: { label: 'Expired', tone: 'warning', icon: TimerOff },
};

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never expires' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '365 days' },
];

function CreateApiKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: CreateApiKeyResponse) => void }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [access, setAccess] = React.useState<Access>('read');
  const [expiry, setExpiry] = React.useState('never');
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    if (open) {
      setName('');
      setAccess('read');
      setExpiry('never');
      setError(undefined);
    }
  }, [open]);

  // gcTime 0: the response holds the full key, so don't keep it in the mutation cache.
  const create = useMutation({
    gcTime: 0,
    mutationFn: (body: CreateApiKeyRequest) => api.post<CreateApiKeyResponse>('/developer/api-keys', body),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: queryKeys.developer.apiKeys });
      onOpenChange(false);
      onCreated(r);
    },
    onError: (e) => toast.error("Couldn't create the API key", { description: errorMessage(e) }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Give the key a name so you can recognise it later');
    setError(undefined);
    create.mutate({
      name: trimmed,
      scopes: access === 'write' ? ['read', 'write'] : ['read'],
      expiresInDays: expiry === 'never' ? null : Number(expiry),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} noValidate className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>Keys let scripts, integrations and AI agents use your vault without a login.</DialogDescription>
          </DialogHeader>
          <Field label="Name" required error={error} hint="For example “Shopify sync” or “Claude agent”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus autoComplete="off" placeholder="Shopify sync" />
          </Field>
          <RadioCards<Access>
            label="Access"
            name="api-key-access"
            value={access}
            onChange={setAccess}
            options={[
              { value: 'read', title: 'Read only', description: 'Read: list clients, portals and files, download files, create share links.', icon: <Eye /> },
              { value: 'write', title: 'Read & write', description: 'Read & write: also tag, rename, move and delete files, manage clients and portals.', icon: <Pencil /> },
            ]}
          />
          <Field label="Expiry" hint="Shorter-lived keys are safer. Expired keys stop working automatically.">
            <SimpleSelect value={expiry} onValueChange={setExpiry} options={EXPIRY_OPTIONS} className="sm:max-w-56" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create key</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysTab() {
  const canManage = usePermission('settings.manage');
  const qc = useQueryClient();
  const origin = useOrigin();
  const { data, isPending, error, refetch, isFetching } = useApiKeys();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [created, setCreated] = React.useState<CreateApiKeyResponse | null>(null);
  const [revoke, setRevoke] = React.useState<ApiKeyDTO | null>(null);

  const rows = data ?? [];
  const columns: DataTableColumn<ApiKeyDTO>[] = [
    {
      key: 'name',
      header: 'Name',
      className: 'min-w-44 max-w-xs',
      cell: (k) => <span className="block truncate font-medium" title={k.name}>{k.name}</span>,
    },
    {
      key: 'prefix',
      header: 'Key',
      cell: (k) => <code className="rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-fg-muted">{k.prefix}…</code>,
    },
    {
      key: 'scopes',
      header: 'Access',
      cell: (k) => (
        <Badge tone={k.scopes.includes('write') ? 'primary' : 'neutral'}>
          {k.scopes.includes('write') ? <><Pencil aria-hidden /> Read &amp; write</> : <><Eye aria-hidden /> Read</>}
        </Badge>
      ),
    },
    {
      key: 'createdBy',
      header: 'Created by',
      className: 'hidden lg:table-cell',
      cell: (k) => (
        <div className="min-w-0 max-w-40">
          <p className="truncate text-sm">{k.createdBy?.name ?? <span className="text-fg-subtle">Unknown</span>}</p>
          <p className="text-xs text-fg-subtle">{formatDate(k.createdAt)}</p>
        </div>
      ),
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      className: 'hidden md:table-cell',
      cell: (k) => (k.lastUsedAt ? <RelativeTime date={k.lastUsedAt} className="whitespace-nowrap tabular-nums text-fg-muted" /> : <span className="text-fg-subtle">Never used</span>),
    },
    {
      key: 'expires',
      header: 'Expires',
      className: 'hidden md:table-cell',
      cell: (k) => (k.expiresAt ? <span className="whitespace-nowrap tabular-nums text-fg-muted">{formatDate(k.expiresAt)}</span> : <span className="text-fg-subtle">Never</span>),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (k) => {
        const s = STATUS[keyStatus(k)];
        const Icon = s.icon;
        return <Badge tone={s.tone}><Icon aria-hidden /> {s.label}</Badge>;
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: 'w-12',
      cell: (k) =>
        canManage && keyStatus(k) !== 'revoked' ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${k.name}`}><MoreHorizontal aria-hidden /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem destructive onSelect={() => setRevoke(k)}><Trash2 aria-hidden /> Revoke key</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-fg-muted">
          API keys authenticate requests with <code className="rounded bg-surface-muted px-1 font-mono text-xs">Authorization: Bearer svk_…</code>. Each key is shown in full only once, when you create it.
        </p>
        {canManage && <Button onClick={() => setCreateOpen(true)}><Plus aria-hidden /> Create API key</Button>}
      </div>

      {error && !data ? (
        <Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load API keys" /></Card>
      ) : (
        <DataTable
          caption="API keys"
          columns={columns}
          rows={rows}
          getRowId={(k) => k.id}
          loading={isPending}
          skeletonRows={3}
          empty={
            <EmptyState
              icon={<KeyRound />}
              title="No API keys yet"
              description="Create a key to let a script, integration or AI agent read and manage files in your vault."
              action={canManage ? <Button onClick={() => setCreateOpen(true)}><Plus aria-hidden /> Create API key</Button> : undefined}
            />
          }
        />
      )}

      <CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setCreated} />

      <SecretDialog
        secret={created?.key ?? null}
        title="Your new API key"
        secretLabel="API key"
        description={created ? <>“{created.apiKey.name}” · {created.apiKey.scopes.includes('write') ? 'Read & write' : 'Read only'}</> : null}
        onClose={() => setCreated(null)}
      >
        {created && (
          <div className="grid gap-1.5">
            <p className="text-xs font-medium text-fg-muted">Quick test — run this in a terminal</p>
            <CodeBlock language="bash" label="Copy command" code={`curl -H "Authorization: Bearer ${created.key}" ${origin}/api/clients`} preClassName="whitespace-pre-wrap break-all" />
          </div>
        )}
      </SecretDialog>

      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title="Revoke this API key?"
        description={revoke ? <>Anything using “{revoke.name}” ({revoke.prefix}…) will stop working immediately. This can&apos;t be undone.</> : undefined}
        confirmLabel="Revoke key"
        destructive
        onConfirm={withToast(
          async () => {
            if (!revoke) return;
            await api.delete(`/developer/api-keys/${revoke.id}`);
            await qc.invalidateQueries({ queryKey: queryKeys.developer.apiKeys });
          },
          { success: 'API key revoked', error: "Couldn't revoke the key" },
        )}
      />
    </div>
  );
}
