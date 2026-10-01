'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageIcon, Trash2, Upload } from 'lucide-react';
import type { Branding, SettingsDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { HEX_RE, readableTextColor } from '@/lib/color';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { EMAIL_RE } from '../tag-input';
import { SaveFooter, SettingsCard, useForm, useSaveSettings } from './settings-shared';

function ImageUpload({ label, hint, src, endpoint, canEdit, removable, accept }: { label: string; hint: string; src: string | null; endpoint: 'logo' | 'favicon'; canEdit: boolean; removable: boolean; accept: string }) {
  const qc = useQueryClient();
  const ref = React.useRef<HTMLInputElement>(null);
  const [local, setLocal] = React.useState<string | null>(null);
  React.useEffect(() => () => { if (local) URL.revokeObjectURL(local); }, [local]);
  const done = (s: SettingsDTO) => { qc.setQueryData(queryKeys.settings, s); void qc.invalidateQueries({ queryKey: queryKeys.branding }); };

  const upload = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post<SettingsDTO>(`/settings/${endpoint}`, fd); },
    onSuccess: (s) => { toast.success(`${label} updated`); done(s); },
    onError: (e) => { setLocal(null); toast.error(`Couldn't upload the ${label.toLowerCase()}`, { description: errorMessage(e) }); },
  });
  const remove = useMutation({
    mutationFn: () => api.delete<SettingsDTO>(`/settings/${endpoint}`),
    onSuccess: (s) => { toast.success(`${label} removed`); setLocal(null); done(s); },
    onError: (e) => toast.error(`Couldn't remove the ${label.toLowerCase()}`, { description: errorMessage(e) }),
  });

  const shown = local ?? src;
  return (
    <div className="flex items-center gap-4">
      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-muted">
        {shown ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={shown} alt={`${label} preview`} className="max-h-full max-w-full object-contain" /> : <ImageIcon className="size-5 text-fg-subtle" aria-hidden />}
      </div>
      <div className="min-w-0 space-y-2">
        <div><p className="text-sm font-medium">{label}</p><p className="text-xs text-fg-subtle">{hint}</p></div>
        {canEdit && (
          <div className="flex gap-2">
            <input ref={ref} type="file" accept={accept} className="sr-only" tabIndex={-1} aria-label={`Choose ${label.toLowerCase()} file`} onChange={(e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              if (f.size > 2 * 1024 * 1024) return void toast.error('Image is too large', { description: 'Use an image up to 2 MB.' });
              setLocal(URL.createObjectURL(f)); upload.mutate(f);
            }} />
            <Button type="button" size="sm" variant="outline" onClick={() => ref.current?.click()} loading={upload.isPending}><Upload aria-hidden /> {shown ? 'Replace' : 'Upload'}</Button>
            {removable && shown && <Button type="button" size="sm" variant="ghost" onClick={() => remove.mutate()} loading={remove.isPending}><Trash2 aria-hidden /> Remove</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

export function BrandingTab({ settings, canEdit }: { settings: SettingsDTO; canEdit: boolean }) {
  const b = settings.branding;
  const init = { companyName: b.companyName, portalTitle: b.portalTitle, primaryColor: b.primaryColor, supportEmail: b.supportEmail ?? '' };
  const form = useForm(init);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const save = useSaveSettings((s) => form.commit({ companyName: s.branding.companyName, portalTitle: s.branding.portalTitle, primaryColor: s.branding.primaryColor, supportEmail: s.branding.supportEmail ?? '' }));
  const v = form.value;
  const validHex = HEX_RE.test(v.primaryColor);
  const color = validHex ? v.primaryColor : b.primaryColor;
  const fg = readableTextColor(color);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!v.companyName.trim()) next.companyName = 'Enter your company name';
    if (!validHex) next.primaryColor = 'Use a 6-digit hex colour, e.g. #4f46e5';
    if (v.supportEmail.trim() && !EMAIL_RE.test(v.supportEmail.trim())) next.supportEmail = 'Enter a valid email address';
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate({ branding: { companyName: v.companyName.trim(), portalTitle: v.portalTitle.trim(), primaryColor: v.primaryColor, supportEmail: v.supportEmail.trim() || null } as Partial<Omit<Branding, 'logoUrl' | 'faviconUrl'>> });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-6 lg:grid-cols-5">
      <div className="lg:col-span-3">
        <fieldset disabled={!canEdit} className="contents">
          <SettingsCard title="Branding" description="How your company appears to clients on upload portals and in the admin." footer={<SaveFooter dirty={form.dirty} saving={save.isPending} canEdit={canEdit} onReset={() => { form.reset(); setErrors({}); }} />}>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Company name" required error={errors.companyName}><Input value={v.companyName} onChange={(e) => form.patch({ companyName: e.target.value })} /></Field>
              <Field label="Portal title" hint="Default heading on client portals."><Input value={v.portalTitle} onChange={(e) => form.patch({ portalTitle: e.target.value })} /></Field>
            </div>
            <Field label="Support email" error={errors.supportEmail} hint="Shown to clients if they need help."><Input type="email" value={v.supportEmail} onChange={(e) => form.patch({ supportEmail: e.target.value })} className="sm:max-w-sm" /></Field>
            <div>
              <p className="mb-1.5 text-sm font-medium">Primary colour</p>
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Pick primary colour" value={validHex ? v.primaryColor : '#4f46e5'} onChange={(e) => form.patch({ primaryColor: e.target.value })} className="size-9 shrink-0 cursor-pointer rounded-md border border-border-strong bg-surface p-0.5 disabled:cursor-not-allowed disabled:opacity-60" />
                <Input aria-label="Primary colour hex" aria-invalid={!!errors.primaryColor} value={v.primaryColor} onChange={(e) => form.patch({ primaryColor: e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}` })} maxLength={7} className="w-32 font-mono uppercase" spellCheck={false} />
              </div>
              {errors.primaryColor && <p role="alert" className="mt-1.5 text-xs font-medium text-danger">{errors.primaryColor}</p>}
            </div>
            <div className="grid gap-5 border-t border-border pt-5 sm:grid-cols-2">
              <ImageUpload label="Logo" hint="PNG, JPG, SVG or WebP, up to 2 MB." src={b.logoUrl} endpoint="logo" canEdit={canEdit} removable accept="image/png,image/jpeg,image/svg+xml,image/webp" />
              <ImageUpload label="Favicon" hint="Square PNG or ICO, up to 2 MB." src={b.faviconUrl} endpoint="favicon" canEdit={canEdit} removable={false} accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml" />
            </div>
          </SettingsCard>
        </fieldset>
      </div>

      <div className="lg:col-span-2">
        <div className="sticky top-6 space-y-2">
          <p className="text-sm font-medium text-fg-muted">Live preview</p>
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm" aria-hidden>
            <div className="flex items-center gap-2.5 px-4 py-3" style={{ background: color, color: fg }}>
              {b.logoUrl ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={b.logoUrl} alt="" className="size-6 rounded bg-white/90 object-contain p-0.5" /> : <span className="flex size-6 items-center justify-center rounded bg-white/20 text-xs font-bold">{(v.companyName || 'S').charAt(0).toUpperCase()}</span>}
              <span className="text-sm font-semibold">{v.companyName || 'Your company'}</span>
            </div>
            <div className="space-y-3 p-5">
              <p className="text-base font-semibold text-fg">{v.portalTitle || 'Secure File Upload'}</p>
              <p className="text-sm text-fg-muted">Drag and drop files here to send them securely.</p>
              <span className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium shadow-xs" style={{ background: color, color: fg }}>Choose files</span>
              <div className="h-2 overflow-hidden rounded-full bg-surface-muted"><div className="h-full w-2/3 rounded-full" style={{ background: color }} /></div>
            </div>
          </div>
          <p className="text-xs text-fg-subtle">Text colour is chosen automatically for readable contrast.</p>
        </div>
      </div>
    </form>
  );
}
