'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClientDTO, CreateClientRequest } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { EMAIL_RE } from '../tag-input';
import { SizeInput } from '../size-input';

function useInvalidateClients() {
  const qc = useQueryClient();
  return React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: queryKeys.clients.all });
    void qc.invalidateQueries({ queryKey: queryKeys.dashboard });
  }, [qc]);
}

interface FormState {
  name: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
  quotaBytes: number | null;
}

const blank: FormState = { name: '', company: '', email: '', phone: '', notes: '', quotaBytes: null };

/** Create (no `client`) or edit a client. */
export function ClientFormDialog({
  open, onOpenChange, client, onSaved,
}: { open: boolean; onOpenChange: (o: boolean) => void; client?: ClientDTO | null; onSaved?: (c: ClientDTO) => void }) {
  const invalidate = useInvalidateClients();
  const [form, setForm] = React.useState<FormState>(blank);
  const [errors, setErrors] = React.useState<Partial<Record<keyof FormState, string>>>({});

  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(client ? { name: client.name, company: client.company ?? '', email: client.email ?? '', phone: client.phone ?? '', notes: client.notes ?? '', quotaBytes: client.quotaBytes } : blank);
  }, [open, client]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: (body: CreateClientRequest) => (client ? api.patch<ClientDTO>(`/clients/${client.id}`, body) : api.post<ClientDTO>('/clients', body)),
    onSuccess: (c) => {
      toast.success(client ? 'Client updated' : 'Client created', { description: client ? undefined : 'You can now create an upload portal for them.' });
      invalidate();
      onSaved?.(c);
      onOpenChange(false);
    },
    onError: (e) => toast.error(client ? "Couldn't update the client" : "Couldn't create the client", { description: errorMessage(e) }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!form.name.trim()) next.name = 'Enter a client name';
    if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) next.email = 'Enter a valid email address';
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate({
      name: form.name.trim(),
      company: form.company.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      notes: form.notes.trim() || null,
      quotaBytes: form.quotaBytes,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{client ? 'Edit client' : 'New client'}</DialogTitle>
            <DialogDescription>{client ? 'Update contact details and the storage quota.' : 'Add a client, then create an upload portal for them.'}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={errors.name}>
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus autoComplete="off" />
            </Field>
            <Field label="Company">
              <Input value={form.company} onChange={(e) => set('company', e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Email" error={errors.email}>
              <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Phone">
              <Input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="off" />
            </Field>
          </div>
          <Field label="Storage quota" hint="Optional. Uploads are refused once the client reaches this limit.">
            <SizeInput value={form.quotaBytes} onChange={(v) => set('quotaBytes', v)} />
          </Field>
          <Field label="Internal notes" hint="Only visible to your team.">
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{client ? 'Save changes' : 'Create client'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ClientDeleteDialog({
  client, onOpenChange, onDeleted,
}: { client: ClientDTO | null; onOpenChange: (o: boolean) => void; onDeleted?: () => void }) {
  const invalidate = useInvalidateClients();
  const qc = useQueryClient();
  return (
    <ConfirmDialog
      open={!!client}
      onOpenChange={onOpenChange}
      title="Delete client?"
      description={
        client ? (
          <>
            This will permanently remove the client&apos;s files. All of <strong>{client.name}</strong>&apos;s portals and uploaded files will be deleted from the vault. This can&apos;t be undone.
          </>
        ) : undefined
      }
      requireText={client?.name}
      confirmLabel="Delete client"
      destructive
      onConfirm={async () => {
        if (!client) return;
        try {
          await api.delete(`/clients/${client.id}`);
          toast.success('Client deleted', { description: `${client.name} and their files were removed.` });
          invalidate();
          void qc.invalidateQueries({ queryKey: queryKeys.portals.all });
          void qc.invalidateQueries({ queryKey: queryKeys.files.all });
          void qc.invalidateQueries({ queryKey: queryKeys.storage });
          onDeleted?.();
        } catch (e) {
          toast.error("Couldn't delete the client", { description: errorMessage(e) });
          throw e;
        }
      }}
    />
  );
}

/** Enable/disable a client. */
export function useToggleClientStatus() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (c: ClientDTO) => api.patch<ClientDTO>(`/clients/${c.id}`, { status: c.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: (c) => {
      toast.success(c.status === 'active' ? `${c.name} enabled` : `${c.name} disabled`, { description: c.status === 'active' ? undefined : 'Their portals no longer accept uploads.' });
      invalidate();
    },
    onError: (e) => toast.error("Couldn't update the client", { description: errorMessage(e) }),
  });
}
