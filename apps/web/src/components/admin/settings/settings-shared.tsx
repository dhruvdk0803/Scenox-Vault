'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SettingsDTO, UpdateSettingsRequest } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toaster';

export function useSaveSettings(onSaved?: (s: SettingsDTO) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettingsRequest) => api.patch<SettingsDTO>('/settings', body),
    onSuccess: (s) => {
      toast.success('Settings saved');
      qc.setQueryData(queryKeys.settings, s);
      void qc.invalidateQueries({ queryKey: queryKeys.branding });
      onSaved?.(s);
    },
    onError: (e) => toast.error("Couldn't save settings", { description: errorMessage(e) }),
  });
}

export function SettingsCard({
  title, description, children, footer,
}: { title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <Card>
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
      </div>
      <div className="grid gap-5 p-5">{children}</div>
      {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
    </Card>
  );
}

export function SaveFooter({ dirty, saving, canEdit, onReset }: { dirty: boolean; saving: boolean; canEdit: boolean; onReset: () => void }) {
  if (!canEdit) return <p className="mr-auto text-sm text-fg-muted">You have read-only access to settings.</p>;
  return (
    <>
      {dirty && <span className="mr-auto text-sm text-fg-muted">Unsaved changes</span>}
      <Button type="button" variant="outline" onClick={onReset} disabled={!dirty || saving}>Discard</Button>
      <Button type="submit" loading={saving} disabled={!dirty}>Save changes</Button>
    </>
  );
}

export function SwitchRow({ label, description, checked, onChange, disabled }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
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

/** Local form state initialised from server data, with dirty tracking and reset. */
export function useForm<T extends object>(initial: T) {
  const [base, setBase] = React.useState(initial);
  const [value, setValue] = React.useState(initial);
  const dirty = JSON.stringify(base) !== JSON.stringify(value);
  const patch = React.useCallback((p: Partial<T>) => setValue((v) => ({ ...v, ...p })), []);
  const reset = React.useCallback(() => setValue(base), [base]);
  const commit = React.useCallback((next: T) => { setBase(next); setValue(next); }, []);
  return { value, patch, dirty, reset, commit };
}
