'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, endOfDay, format, isBefore } from 'date-fns';
import { KeyRound, Trash2 } from 'lucide-react';
import type { CreatePortalRequest, PortalDTO, SettingsDTO, UpdatePortalRequest } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toaster';
import { ClientSelect } from '../client-select';
import { SizeInput } from '../size-input';
import { EMAIL_RE, normalizeExtension, TagInput, validateEmailTag, validateExtensionTag } from '../tag-input';
import { PortalReadyDialog } from './portal-ready-dialog';

const EXTENSION_SUGGESTIONS = ['jpg', 'png', 'pdf', 'csv', 'xlsx', 'zip', 'mp4'];
const PRESETS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
] as const;
const MIN_PASSWORD = 8;

interface FormState {
  clientId: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  expiry: string; // yyyy-MM-dd or ''
  pwMode: 'keep' | 'set' | 'remove';
  password: string;
  maxFileSizeBytes: number | null;
  maxTotalBytes: number | null;
  extensions: string[];
  allowZip: boolean;
  allowFolders: boolean;
  requireName: boolean;
  requireEmail: boolean;
  requireCompany: boolean;
  requireMessage: boolean;
  allowMultipleSessions: boolean;
  allowResume: boolean;
  allowClientViewFiles: boolean;
  allowClientDeleteFiles: boolean;
  allowClientMessages: boolean;
  notifyEmails: string[];
  notifyClient: boolean;
}

function fromPortal(p: PortalDTO | undefined, clientId?: string): FormState {
  return {
    clientId: p?.clientId ?? clientId ?? '',
    name: p?.name ?? '',
    title: p?.title ?? '',
    description: p?.description ?? '',
    instructions: p?.instructions ?? '',
    expiry: p?.expiresAt ? format(new Date(p.expiresAt), 'yyyy-MM-dd') : '',
    pwMode: 'keep',
    password: '',
    maxFileSizeBytes: p?.maxFileSizeBytes ?? null,
    maxTotalBytes: p?.maxTotalBytes ?? null,
    extensions: p?.allowedExtensions ?? [],
    allowZip: p?.allowZip ?? true,
    allowFolders: p?.allowFolders ?? true,
    requireName: p?.requireName ?? false,
    requireEmail: p?.requireEmail ?? false,
    requireCompany: p?.requireCompany ?? false,
    requireMessage: p?.requireMessage ?? false,
    allowMultipleSessions: p?.allowMultipleSessions ?? true,
    allowResume: p?.allowResume ?? true,
    allowClientViewFiles: p?.allowClientViewFiles ?? true,
    allowClientDeleteFiles: p?.allowClientDeleteFiles ?? false,
    allowClientMessages: p?.allowClientMessages ?? true,
    notifyEmails: p?.notifyEmails ?? [],
    notifyClient: p?.notifyClient ?? false,
  };
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
      </div>
      <div className="grid gap-5 p-5">{children}</div>
    </Card>
  );
}

function ToggleRow({ label, description, checked, onChange, disabled }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="cursor-pointer">{label}</Label>
        {description && <p className="mt-1 text-xs text-fg-subtle">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export interface PortalFormProps {
  /** Present = edit mode. */
  portal?: PortalDTO;
  defaultClientId?: string;
}

export function PortalForm({ portal, defaultClientId }: PortalFormProps) {
  const router = useRouter();
  const qc = useQueryClient();
  const canManage = usePermission('portals.manage');
  const canSettings = usePermission('settings.view');
  const editing = !!portal;

  const [initial, setInitial] = React.useState(() => fromPortal(portal, defaultClientId));
  const [form, setForm] = React.useState(initial);
  const [errors, setErrors] = React.useState<Partial<Record<string, string>>>({});
  const [created, setCreated] = React.useState<PortalDTO | null>(null);
  const limitsTouched = React.useRef(false);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    if (k === 'maxFileSizeBytes' || k === 'maxTotalBytes') limitsTouched.current = true;
    setForm((f) => ({ ...f, [k]: v }));
  };

  // New portals start from the workspace's upload defaults (when the user may read settings).
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => api.get<SettingsDTO>('/settings', { signal }),
    enabled: !editing && canSettings,
    staleTime: 60_000,
  });
  React.useEffect(() => {
    if (editing || !settings.data || limitsTouched.current) return;
    const { defaultMaxFileSizeBytes, defaultPortalQuotaBytes } = settings.data.uploads;
    setInitial((i) => ({ ...i, maxFileSizeBytes: defaultMaxFileSizeBytes, maxTotalBytes: defaultPortalQuotaBytes }));
    setForm((f) => ({ ...f, maxFileSizeBytes: defaultMaxFileSizeBytes, maxTotalBytes: defaultPortalQuotaBytes }));
  }, [editing, settings.data]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: (body: CreatePortalRequest | UpdatePortalRequest) =>
      editing ? api.patch<PortalDTO>(`/portals/${portal!.id}`, body) : api.post<PortalDTO>('/portals', body),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: queryKeys.portals.all });
      void qc.invalidateQueries({ queryKey: queryKeys.clients.all });
      void qc.invalidateQueries({ queryKey: queryKeys.dashboard });
      if (editing) {
        toast.success('Portal saved');
        const next = fromPortal(p);
        setInitial(next);
        setForm(next);
      } else {
        setCreated(p);
      }
    },
    onError: (e) => toast.error(editing ? "Couldn't save the portal" : "Couldn't create the portal", { description: errorMessage(e) }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!editing && !form.clientId) next.clientId = 'Choose a client';
    if (!form.name.trim()) next.name = 'Give the portal an internal name';
    if (form.pwMode === 'set' && form.password.length < MIN_PASSWORD) next.password = `Use at least ${MIN_PASSWORD} characters`;
    if (form.expiry && isBefore(endOfDay(new Date(`${form.expiry}T00:00:00`)), new Date()) && form.expiry !== initial.expiry) next.expiry = 'Choose a date in the future';
    const badEmail = form.notifyEmails.find((x) => !EMAIL_RE.test(x));
    if (badEmail) next.notifyEmails = `"${badEmail}" is not a valid email address`;
    setErrors(next);
    if (Object.keys(next).length) {
      toast.error('Please fix the highlighted fields');
      return;
    }

    const base = {
      name: form.name.trim(),
      title: form.title.trim() || null,
      description: form.description.trim() || null,
      instructions: form.instructions.trim() || null,
      expiresAt: form.expiry ? endOfDay(new Date(`${form.expiry}T00:00:00`)).toISOString() : null,
      maxFileSizeBytes: form.maxFileSizeBytes,
      maxTotalBytes: form.maxTotalBytes,
      allowedExtensions: form.extensions.length ? form.extensions : null,
      allowZip: form.allowZip,
      allowFolders: form.allowFolders,
      requireName: form.requireName,
      requireEmail: form.requireEmail,
      requireCompany: form.requireCompany,
      requireMessage: form.requireMessage,
      allowMultipleSessions: form.allowMultipleSessions,
      allowResume: form.allowResume,
      allowClientViewFiles: form.allowClientViewFiles,
      allowClientDeleteFiles: form.allowClientDeleteFiles,
      allowClientMessages: form.allowClientMessages,
      notifyEmails: form.notifyEmails,
      notifyClient: form.notifyClient,
    };
    if (editing) {
      const body: UpdatePortalRequest = { ...base };
      if (form.pwMode === 'set') body.password = form.password;
      if (form.pwMode === 'remove') body.password = null;
      save.mutate(body);
    } else {
      save.mutate({ ...base, clientId: form.clientId, ...(form.pwMode === 'set' ? { password: form.password } : {}) });
    }
  }

  const disabled = !canManage || save.isPending;
  const today = format(new Date(), 'yyyy-MM-dd');
  const presetDate = (days: number) => format(addDays(new Date(), days), 'yyyy-MM-dd');

  return (
    <form onSubmit={submit} noValidate className="mx-auto grid max-w-3xl gap-6">
      <fieldset disabled={!canManage} className="contents">
        <Section title="Basics" description="What this portal is called internally and what your client sees.">
          <Field label="Client" required error={errors.clientId} hint={editing ? 'A portal can’t be moved to another client.' : undefined}>
            <ClientSelect value={form.clientId || undefined} onChange={(v) => set('clientId', v ?? '')} disabled={editing || disabled} aria-invalid={!!errors.clientId} />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Portal name" required error={errors.name} hint="Internal only, e.g. “Wedding footage 2025”.">
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Public title" hint="Heading shown to the client. Defaults to the client name.">
              <Input value={form.title} onChange={(e) => set('title', e.target.value)} autoComplete="off" />
            </Field>
          </div>
          <Field label="Description" hint="A short line shown under the title.">
            <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={2} />
          </Field>
          <Field label="Instructions" hint="Tell your client what to upload and how (supports plain text).">
            <Textarea value={form.instructions} onChange={(e) => set('instructions', e.target.value)} rows={3} />
          </Field>
        </Section>

        <Section title="Access" description="Control when the link works and who can open it.">
          <Field label="Expiration date" error={errors.expiry} hint={form.expiry ? undefined : 'The portal never expires.'}>
            <Input type="date" suppressHydrationWarning min={today} value={form.expiry} onChange={(e) => set('expiry', e.target.value)} className="w-full sm:w-56" />
          </Field>
          <div className="-mt-2 flex flex-wrap gap-2" role="group" aria-label="Expiration presets">
            {PRESETS.map((p) => {
              const active = form.expiry === presetDate(p.days);
              return (
                <Button key={p.days} type="button" size="sm" variant={active ? 'secondary' : 'outline'} aria-pressed={active} onClick={() => set('expiry', presetDate(p.days))}>
                  {p.label}
                </Button>
              );
            })}
            <Button type="button" size="sm" variant={!form.expiry ? 'secondary' : 'outline'} aria-pressed={!form.expiry} onClick={() => set('expiry', '')}>Never</Button>
          </div>

          <div className="space-y-3 border-t border-border pt-5">
            {editing && portal.hasPassword ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium"><KeyRound className="size-4 text-fg-subtle" aria-hidden /> Password protected</p>
                    <p className="mt-1 text-xs text-fg-subtle">
                      {form.pwMode === 'remove' ? 'The password will be removed when you save.' : 'Clients must enter a password before uploading.'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => set('pwMode', form.pwMode === 'set' ? 'keep' : 'set')} disabled={disabled}>
                      {form.pwMode === 'set' ? 'Keep current' : 'Change password'}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => set('pwMode', form.pwMode === 'remove' ? 'keep' : 'remove')} disabled={disabled}>
                      <Trash2 aria-hidden /> {form.pwMode === 'remove' ? 'Undo remove' : 'Remove password'}
                    </Button>
                  </div>
                </div>
                {form.pwMode === 'set' && (
                  <Field label="New password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`}>
                    <Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" className="sm:max-w-sm" />
                  </Field>
                )}
              </div>
            ) : (
              <>
                <ToggleRow
                  label="Password protection"
                  description="Clients must enter a password before they can open the portal."
                  checked={form.pwMode === 'set'}
                  onChange={(v) => setForm((f) => ({ ...f, pwMode: v ? 'set' : 'keep', password: v ? f.password : '' }))}
                  disabled={disabled}
                />
                {form.pwMode === 'set' && (
                  <Field label="Password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters. Share it separately from the link.`}>
                    <Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" className="sm:max-w-sm" />
                  </Field>
                )}
              </>
            )}
          </div>
        </Section>

        <Section title="Limits" description="Cap individual file sizes and total storage for this portal.">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Max file size" hint="Largest single file a client can upload.">
              <SizeInput value={form.maxFileSizeBytes} onChange={(v) => set('maxFileSizeBytes', v)} disabled={disabled} />
            </Field>
            <Field label="Portal quota" hint="Total data this portal can hold.">
              <SizeInput value={form.maxTotalBytes} onChange={(v) => set('maxTotalBytes', v)} disabled={disabled} />
            </Field>
          </div>
        </Section>

        <Section title="File types" description="Leave the list empty to accept everything except blocked file types (like executables).">
          <Field label="Allowed extensions" hint="Press Enter or comma to add. Example: pdf, jpg, mp4">
            <TagInput
              value={form.extensions}
              onChange={(v) => set('extensions', v)}
              normalize={normalizeExtension}
              validate={validateExtensionTag}
              suggestions={EXTENSION_SUGGESTIONS}
              placeholder="All file types"
              disabled={disabled}
              aria-label="Allowed extensions"
            />
          </Field>
          <ToggleRow label="Allow ZIP files" description="Archives such as .zip and .7z." checked={form.allowZip} onChange={(v) => set('allowZip', v)} disabled={disabled} />
          <ToggleRow label="Allow folders" description="Clients can drag in whole folders and keep the structure." checked={form.allowFolders} onChange={(v) => set('allowFolders', v)} disabled={disabled} />
        </Section>

        <Section title="Intake form" description="Information to collect from the uploader before they start.">
          <ToggleRow label="Require name" checked={form.requireName} onChange={(v) => set('requireName', v)} disabled={disabled} />
          <ToggleRow label="Require email" checked={form.requireEmail} onChange={(v) => set('requireEmail', v)} disabled={disabled} />
          <ToggleRow label="Require company" checked={form.requireCompany} onChange={(v) => set('requireCompany', v)} disabled={disabled} />
          <ToggleRow label="Require message" checked={form.requireMessage} onChange={(v) => set('requireMessage', v)} disabled={disabled} />
        </Section>

        <Section title="Client permissions" description="What people with the link are allowed to do.">
          <ToggleRow label="Allow multiple uploads" description="The link can be used for more than one upload session." checked={form.allowMultipleSessions} onChange={(v) => set('allowMultipleSessions', v)} disabled={disabled} />
          <ToggleRow label="Allow resume" description="Interrupted uploads can pick up where they left off." checked={form.allowResume} onChange={(v) => set('allowResume', v)} disabled={disabled} />
          <ToggleRow label="Client can view uploaded files" description="Shows the client a dashboard of everything uploaded through this link." checked={form.allowClientViewFiles} onChange={(v) => set('allowClientViewFiles', v)} disabled={disabled} />
          <ToggleRow label="Client can delete their own files" description="Only files from their current upload session." checked={form.allowClientDeleteFiles} onChange={(v) => set('allowClientDeleteFiles', v)} disabled={disabled} />
          <ToggleRow label="Client can send messages & comments" description="Lets the client write to your team and comment on files from their portal." checked={form.allowClientMessages} onChange={(v) => set('allowClientMessages', v)} disabled={disabled} />
        </Section>

        <Section title="Notifications" description="Who hears about uploads to this portal.">
          <Field label="Notify these emails" error={errors.notifyEmails} hint="Leave empty to use the default admin recipients from Settings.">
            <TagInput
              value={form.notifyEmails}
              onChange={(v) => set('notifyEmails', v)}
              normalize={(r) => r.trim().toLowerCase()}
              validate={validateEmailTag}
              placeholder="name@company.com"
              disabled={disabled}
              aria-label="Notification emails"
            />
          </Field>
          <ToggleRow label="Email the client a receipt" description="Sent when the uploader provided an email address." checked={form.notifyClient} onChange={(v) => set('notifyClient', v)} disabled={disabled} />
        </Section>
      </fieldset>

      {canManage ? (
        <div className={cn('sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6')}>
          {editing && dirty && <span className="mr-auto text-sm text-fg-muted">Unsaved changes</span>}
          {editing ? (
            <Button type="button" variant="outline" onClick={() => { setForm(initial); setErrors({}); }} disabled={!dirty || save.isPending}>Discard</Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => router.back()} disabled={save.isPending}>Cancel</Button>
          )}
          <Button type="submit" loading={save.isPending} disabled={editing && !dirty}>{editing ? 'Save changes' : 'Create portal'}</Button>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">You have view-only access to portal settings.</p>
      )}

      <PortalReadyDialog portal={created} onDone={() => { const id = created?.id; setCreated(null); if (id) router.push(`/portals/${id}`); }} />
    </form>
  );
}
