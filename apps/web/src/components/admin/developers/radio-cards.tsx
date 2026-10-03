'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface RadioCardOption<T extends string> {
  value: T;
  title: string;
  description: string;
  icon?: React.ReactNode;
}

/** Native radio inputs styled as selectable cards (keyboard + screen-reader friendly). */
export function RadioCards<T extends string>({
  label, name, value, onChange, options, disabled,
}: { label: string; name: string; value: T; onChange: (v: T) => void; options: RadioCardOption<T>[]; disabled?: boolean }) {
  const labelId = React.useId();
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="grid gap-1.5">
      <p id={labelId} className="text-sm font-medium leading-none text-fg">{label}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'relative flex cursor-pointer items-start gap-3 rounded-lg border border-border-strong bg-surface p-3 shadow-xs transition-colors duration-150 hover:border-fg-subtle/60 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} disabled={disabled} className="peer sr-only" />
            {o.icon && <span className="mt-0.5 text-fg-subtle peer-checked:text-primary [&_svg]:size-4" aria-hidden>{o.icon}</span>}
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">{o.title}</span>
              <span className="mt-0.5 block text-xs leading-5 text-fg-muted">{o.description}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
