'use client';

import { SimpleSelect } from '@/components/ui/select';
import { ALL } from '@/lib/hooks/use-list-state';
import { useClientOptions, usePortalOptions } from '@/lib/hooks/use-options';

interface BaseProps {
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  className?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
}

/** Client picker. With `allowAll`, an "All clients" option maps to `undefined`. */
export function ClientSelect({ value, onChange, allowAll, placeholder = 'Select a client', className, ...rest }: BaseProps & { allowAll?: boolean; placeholder?: string }) {
  const { data, isPending } = useClientOptions();
  const options = [
    ...(allowAll ? [{ value: ALL, label: 'All clients' }] : []),
    ...(data?.items.map((c) => ({ value: c.id, label: c.company ? `${c.name} · ${c.company}` : c.name })) ?? []),
  ];
  return (
    <SimpleSelect
      {...rest}
      aria-label={rest['aria-label'] ?? 'Client'}
      className={className}
      value={value ?? (allowAll ? ALL : undefined)}
      onValueChange={(v) => onChange(v === ALL ? undefined : v)}
      options={options}
      placeholder={isPending ? 'Loading clients…' : placeholder}
    />
  );
}

/** Portal picker, optionally scoped to a client. */
export function PortalSelect({ value, onChange, clientId, allowAll, placeholder = 'Select a portal', className, ...rest }: BaseProps & { clientId?: string; allowAll?: boolean; placeholder?: string }) {
  const { data, isPending } = usePortalOptions(clientId);
  const options = [
    ...(allowAll ? [{ value: ALL, label: 'All portals' }] : []),
    ...(data?.items.map((p) => ({ value: p.id, label: clientId ? p.name : `${p.name} · ${p.clientName}` })) ?? []),
  ];
  return (
    <SimpleSelect
      {...rest}
      aria-label={rest['aria-label'] ?? 'Portal'}
      className={className}
      value={value ?? (allowAll ? ALL : undefined)}
      onValueChange={(v) => onChange(v === ALL ? undefined : v)}
      options={options}
      placeholder={isPending ? 'Loading portals…' : placeholder}
    />
  );
}
