'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { SimpleSelect } from '@/components/ui/select';

const UNITS = { MB: 1e6, GB: 1e9, TB: 1e12 } as const;
type Unit = keyof typeof UNITS;
const NONE = 'none';

function decompose(bytes: number | null): { amount: string; unit: Unit | typeof NONE } {
  if (bytes == null) return { amount: '', unit: NONE };
  const unit: Unit = bytes >= 1e12 ? 'TB' : bytes >= 1e9 ? 'GB' : 'MB';
  const amount = bytes / UNITS[unit];
  return { amount: String(Number(amount.toFixed(3))), unit };
}

function compose(amount: string, unit: Unit | typeof NONE): number | null | undefined {
  if (unit === NONE) return null;
  const n = Number(amount);
  if (amount.trim() === '' || !Number.isFinite(n) || n < 0) return undefined; // incomplete
  return Math.round(n * UNITS[unit]);
}

export interface SizeInputProps {
  /** Size in bytes; null = no limit. */
  value: number | null;
  onChange: (bytes: number | null) => void;
  /** Offer a "No limit" unit (default true). */
  allowNone?: boolean;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  className?: string;
}

/** Number + unit (MB/GB/TB) ↔ bytes. "No limit" maps to null. */
export function SizeInput({ value, onChange, allowNone = true, disabled, id, className, ...aria }: SizeInputProps) {
  const [state, setState] = React.useState(() => decompose(value));

  // Sync when the value is changed from outside (e.g. form reset / defaults loaded).
  React.useEffect(() => {
    const current = compose(state.amount, state.unit);
    if (current !== undefined && current !== value) setState(decompose(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function update(next: { amount: string; unit: Unit | typeof NONE }) {
    setState(next);
    const b = compose(next.amount, next.unit);
    if (b !== undefined) onChange(b);
  }

  const options = [
    ...(allowNone ? [{ value: NONE, label: 'No limit' }] : []),
    ...(Object.keys(UNITS) as Unit[]).map((u) => ({ value: u, label: u })),
  ];

  return (
    <div className={cn('flex gap-2', className)}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={state.amount}
        disabled={disabled || state.unit === NONE}
        placeholder={state.unit === NONE ? 'No limit' : '0'}
        onChange={(e) => update({ ...state, amount: e.target.value })}
        className="tabular-nums"
        {...aria}
      />
      <SimpleSelect
        aria-label="Unit"
        className="w-28 shrink-0"
        value={state.unit}
        disabled={disabled}
        options={options}
        onValueChange={(u) => {
          const unit = u as Unit | typeof NONE;
          update({ amount: unit !== NONE && state.amount === '' ? '1' : state.amount, unit });
        }}
      />
    </div>
  );
}
