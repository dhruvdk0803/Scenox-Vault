'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, MinusCircle, Send } from 'lucide-react';
import { DEFAULT_BLOCKED_EXTENSIONS, type SettingsDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks/use-me';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { SizeInput } from '../size-input';
import { EMAIL_RE, normalizeExtension, TagInput, validateEmailTag, validateExtensionTag } from '../tag-input';
import { SaveFooter, SettingsCard, SwitchRow, useForm, useSaveSettings } from './settings-shared';

function IntField({ label, hint, value, onChange, min, max, error, suffix }: { label: string; hint?: string; value: number; onChange: (n: number) => void; min: number; max?: number; error?: string; suffix: string }) {
  return (
    <Field label={label} hint={hint} error={error}>
      <div className="relative sm:max-w-48">
        <Input type="number" inputMode="numeric" min={min} max={max} step={1} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Math.round(Number(e.target.value)))} className="pr-16 tabular-nums" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{suffix}</span>
      </div>
    </Field>
  );
}

export function NotificationsTab({ settings, canEdit }: { settings: SettingsDTO; canEdit: boolean }) {
  const form = useForm(settings.notifications);
  const save = useSaveSettings((s) => form.commit(s.notifications));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const v = form.value;
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!(v.diskWarningPercent >= 1 && v.diskWarningPercent <= 99)) next.warn = 'Enter a percentage between 1 and 99';
    if (!(v.diskCriticalPercent >= 1 && v.diskCriticalPercent <= 100)) next.crit = 'Enter a percentage between 1 and 100';
    else if (v.diskCriticalPercent <= v.diskWarningPercent) next.crit = 'Must be higher than the warning level';
    if (v.adminEmails.some((x) => !EMAIL_RE.test(x))) next.emails = 'One of the addresses is not valid';
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate({ notifications: v });
  }
  return (
    <form onSubmit={submit} noValidate className="max-w-3xl">
      <fieldset disabled={!canEdit} className="contents">
        <SettingsCard title="Notifications" description="Who gets emailed and when." footer={<SaveFooter dirty={form.dirty} saving={save.isPending} canEdit={canEdit} onReset={() => { form.reset(); setErrors({}); }} />}>
          <Field label="Admin email recipients" error={errors.emails} hint="Used when a portal doesn’t list its own recipients.">
            <TagInput value={v.adminEmails} onChange={(adminEmails) => form.patch({ adminEmails })} normalize={(r) => r.trim().toLowerCase()} validate={validateEmailTag} placeholder="name@company.com" disabled={!canEdit} aria-label="Admin email recipients" />
          </Field>
          <SwitchRow label="Upload completed" description="Email when a client finishes uploading." checked={v.notifyOnUploadComplete} onChange={(x) => form.patch({ notifyOnUploadComplete: x })} />
          <SwitchRow label="Upload failed" description="Email when an upload session ends with failures." checked={v.notifyOnUploadFailed} onChange={(x) => form.patch({ notifyOnUploadFailed: x })} />
          <SwitchRow label="Client receipts" description="Email uploaders a receipt when they provide an address." checked={v.notifyClientReceipt} onChange={(x) => form.patch({ notifyClientReceipt: x })} />
          <div className="grid gap-5 border-t border-border pt-5 sm:grid-cols-2">
            <IntField label="Disk warning at" hint="Show a warning banner when disk usage reaches this level." value={v.diskWarningPercent} onChange={(n) => form.patch({ diskWarningPercent: n })} min={1} max={99} suffix="% used" error={errors.warn} />
            <IntField label="Disk critical at" hint="Escalate to a critical alert." value={v.diskCriticalPercent} onChange={(n) => form.patch({ diskCriticalPercent: n })} min={1} max={100} suffix="% used" error={errors.crit} />
          </div>
        </SettingsCard>
      </fieldset>
    </form>
  );
}

export function SecurityTab({ settings, canEdit }: { settings: SettingsDTO; canEdit: boolean }) {
  const form = useForm(settings.security);
  const save = useSaveSettings((s) => form.commit(s.security));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const v = form.value;
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!(v.adminSessionHours >= 1)) next.admin = 'Enter at least 1 hour';
    if (!(v.portalSessionHours >= 1)) next.portal = 'Enter at least 1 hour';
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate({ security: v });
  }
  return (
    <form onSubmit={submit} noValidate className="max-w-3xl">
      <fieldset disabled={!canEdit} className="contents">
        <SettingsCard title="Security" description="Control which files are accepted and how long sessions last." footer={<SaveFooter dirty={form.dirty} saving={save.isPending} canEdit={canEdit} onReset={() => { form.reset(); setErrors({}); }} />}>
          <SwitchRow label="Block executable files" description="Reject programs and scripts (.exe, .bat, .js, …) on every portal." checked={v.blockExecutables} onChange={(x) => form.patch({ blockExecutables: x })} />
          <Field label="Blocked extensions" hint="Files with these extensions are always rejected, even if a portal allows them.">
            <TagInput value={v.blockedExtensions} onChange={(blockedExtensions) => form.patch({ blockedExtensions })} normalize={normalizeExtension} validate={validateExtensionTag} suggestions={DEFAULT_BLOCKED_EXTENSIONS.slice(0, 10)} placeholder="exe" disabled={!canEdit} aria-label="Blocked extensions" />
          </Field>
          <div className="grid gap-5 border-t border-border pt-5 sm:grid-cols-2">
            <IntField label="Admin session length" hint="How long you stay signed in." value={v.adminSessionHours} onChange={(n) => form.patch({ adminSessionHours: n })} min={1} suffix="hours" error={errors.admin} />
            <IntField label="Portal session length" hint="How long an uploader’s session stays valid." value={v.portalSessionHours} onChange={(n) => form.patch({ portalSessionHours: n })} min={1} suffix="hours" error={errors.portal} />
          </div>
        </SettingsCard>
      </fieldset>
    </form>
  );
}

export function RetentionTab({ settings, canEdit }: { settings: SettingsDTO; canEdit: boolean }) {
  const form = useForm(settings.retention);
  const save = useSaveSettings((s) => form.commit(s.retention));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const v = form.value;
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!(v.incompleteUploadHours >= 1)) next.inc = 'Enter at least 1 hour';
    if (!(v.exportHours >= 1)) next.exp = 'Enter at least 1 hour';
    if (!(v.activityLogDays >= 0)) next.log = 'Enter 0 or more days';
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate({ retention: v });
  }
  return (
    <form onSubmit={submit} noValidate className="max-w-3xl">
      <fieldset disabled={!canEdit} className="contents">
        <SettingsCard title="Retention" description="Automatic cleanup keeps temporary data from filling your disk." footer={<SaveFooter dirty={form.dirty} saving={save.isPending} canEdit={canEdit} onReset={() => { form.reset(); setErrors({}); }} />}>
          <IntField label="Incomplete uploads" hint="Abandoned partial uploads are deleted after this long." value={v.incompleteUploadHours} onChange={(n) => form.patch({ incompleteUploadHours: n })} min={1} suffix="hours" error={errors.inc} />
          <IntField label="ZIP exports" hint="Generated download archives are deleted after this long." value={v.exportHours} onChange={(n) => form.patch({ exportHours: n })} min={1} suffix="hours" error={errors.exp} />
          <IntField label="Activity log" hint="Entries older than this are removed. Use 0 to keep everything." value={v.activityLogDays} onChange={(n) => form.patch({ activityLogDays: n })} min={0} suffix="days" error={errors.log} />
        </SettingsCard>
      </fieldset>
    </form>
  );
}

export function UploadDefaultsTab({ settings, canEdit }: { settings: SettingsDTO; canEdit: boolean }) {
  const form = useForm(settings.uploads);
  const save = useSaveSettings((s) => form.commit(s.uploads));
  const v = form.value;
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate({ uploads: v }); }} className="max-w-3xl">
      <fieldset disabled={!canEdit} className="contents">
        <SettingsCard title="Upload defaults" description="Pre-filled when you create a new portal. Existing portals aren’t changed." footer={<SaveFooter dirty={form.dirty} saving={save.isPending} canEdit={canEdit} onReset={form.reset} />}>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Default max file size" hint="Largest single file."><SizeInput value={v.defaultMaxFileSizeBytes} onChange={(x) => form.patch({ defaultMaxFileSizeBytes: x })} disabled={!canEdit} /></Field>
            <Field label="Default portal quota" hint="Total data per portal."><SizeInput value={v.defaultPortalQuotaBytes} onChange={(x) => form.patch({ defaultPortalQuotaBytes: x })} disabled={!canEdit} /></Field>
          </div>
        </SettingsCard>
      </fieldset>
    </form>
  );
}

export function EmailTab({ settings, canEdit }: { settings: SettingsDTO; canEdit: boolean }) {
  const { data: me } = useMe();
  const [to, setTo] = React.useState(me?.user.email ?? '');
  React.useEffect(() => { if (!to && me) setTo(me.user.email); }, [me, to]);
  const [error, setError] = React.useState<string>();
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/settings/test-email', { to: to.trim() }),
    onSuccess: (r) => (r.ok ? toast.success('Test email sent', { description: r.message }) : toast.error('Test email failed', { description: r.message })),
    onError: (e) => toast.error("Couldn't send the test email", { description: errorMessage(e) }),
  });
  return (
    <div className="max-w-3xl space-y-6">
      <SettingsCard title="Email delivery" description="SMTP is configured on the server through environment variables.">
        <div className="flex items-center justify-between gap-4">
          <div><p className="text-sm font-medium">SMTP</p><p className="text-xs text-fg-subtle">{settings.smtpConfigured ? 'Emails can be sent.' : 'Not configured. Set the SMTP_* variables in your deployment to enable email.'}</p></div>
          {settings.smtpConfigured ? <Badge tone="success"><CheckCircle2 aria-hidden /> Configured</Badge> : <Badge tone="neutral"><MinusCircle aria-hidden /> Not configured</Badge>}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border pt-5">
          <div><p className="text-sm font-medium">Virus scanning (ClamAV)</p><p className="text-xs text-fg-subtle">Uploaded files are scanned when enabled.</p></div>
          {settings.clamavEnabled ? <Badge tone="success"><CheckCircle2 aria-hidden /> Enabled</Badge> : <Badge tone="neutral"><MinusCircle aria-hidden /> Disabled</Badge>}
        </div>
      </SettingsCard>
      {canEdit && (
        <SettingsCard title="Send a test email" description="Verify that your SMTP settings work.">
          <form onSubmit={(e) => { e.preventDefault(); if (!EMAIL_RE.test(to.trim())) return setError('Enter a valid email address'); setError(undefined); test.mutate(); }} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Send to" error={error} className="flex-1"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} disabled={!settings.smtpConfigured} /></Field>
            <Button type="submit" loading={test.isPending} disabled={!settings.smtpConfigured}><Send aria-hidden /> Send test email</Button>
          </form>
        </SettingsCard>
      )}
    </div>
  );
}

export function AccountTab() {
  const [f, setF] = React.useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const change = useMutation({
    mutationFn: () => api.post('/auth/password', { currentPassword: f.current, newPassword: f.next }),
    onSuccess: () => { toast.success('Password changed', { description: 'Your other sessions were signed out.' }); setF({ current: '', next: '', confirm: '' }); },
    onError: (e) => toast.error("Couldn't change your password", { description: errorMessage(e) }),
  });
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!f.current) next.current = 'Enter your current password';
    if (f.next.length < 12) next.next = 'Use at least 12 characters';
    if (f.confirm !== f.next) next.confirm = 'Passwords don’t match';
    setErrors(next);
    if (Object.keys(next).length) return;
    change.mutate();
  }
  return (
    <form onSubmit={submit} noValidate className="max-w-xl">
      <SettingsCard title="Change password" description="Use a long, unique password. Changing it signs you out everywhere else." footer={<Button type="submit" loading={change.isPending}>Update password</Button>}>
        <Field label="Current password" error={errors.current}><Input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" /></Field>
        <Field label="New password" error={errors.next} hint="At least 12 characters."><Input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" /></Field>
        <Field label="Confirm new password" error={errors.confirm}><Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" /></Field>
      </SettingsCard>
    </form>
  );
}
