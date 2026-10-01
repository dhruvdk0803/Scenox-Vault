'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { inputBase } from '@/components/ui/input';

export interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Clickable suggestions (already-added ones are hidden). */
  suggestions?: string[];
  /** Normalise a raw entry (e.g. lowercase, strip dots). Return '' to reject. */
  normalize?: (raw: string) => string;
  /** Return an error message to reject an entry. */
  validate?: (tag: string) => string | null;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  maxTags?: number;
  className?: string;
}

export function TagInput({
  value, onChange, placeholder, suggestions, normalize, validate, disabled, id, className, maxTags = 200, ...aria
}: TagInputProps) {
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  function commit(raw: string) {
    const parts = raw.split(/[,\s;]+/).filter(Boolean);
    if (parts.length === 0) return true;
    let next = [...value];
    let err: string | null = null;
    for (const p of parts) {
      const tag = normalize ? normalize(p) : p.trim();
      if (!tag || next.includes(tag)) continue;
      const v = validate?.(tag) ?? null;
      if (v) {
        err = v;
        continue;
      }
      if (next.length >= maxTags) break;
      next = [...next, tag];
    }
    onChange(next);
    setError(err);
    return !err;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ' || e.key === 'Tab') {
      if (draft.trim()) {
        if (e.key !== 'Tab') e.preventDefault();
        if (commit(draft)) setDraft('');
      } else if (e.key === 'Enter') {
        e.preventDefault();
      }
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  const remaining = suggestions?.filter((s) => !value.includes(s)) ?? [];

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        className={cn(inputBase, 'flex min-h-9 flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:border-primary focus-within:outline-2 focus-within:outline-ring', disabled && 'cursor-not-allowed bg-surface-muted opacity-60')}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-muted py-0.5 pl-2 pr-1 text-xs font-medium text-fg">
            {tag}
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((t) => t !== tag));
                }}
                className="rounded p-0.5 text-fg-subtle transition-colors hover:bg-border hover:text-fg"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
            if (/[,;]$/.test(e.target.value)) {
              if (commit(e.target.value)) setDraft('');
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (draft.trim() && commit(draft)) setDraft('');
          }}
          placeholder={value.length === 0 ? placeholder : undefined}
          className="min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-fg-subtle"
          autoComplete="off"
          spellCheck={false}
          {...aria}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
      {!disabled && remaining.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Suggestions">
          <span className="text-xs text-fg-subtle">Suggestions:</span>
          {remaining.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange([...value, s])}
              className="rounded-md border border-dashed border-border-strong px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:border-primary hover:bg-primary-soft hover:text-primary-soft-fg"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validateEmailTag = (t: string) => (EMAIL_RE.test(t) ? null : `"${t}" is not a valid email address`);
export const normalizeExtension = (raw: string) => raw.trim().toLowerCase().replace(/^[*.]+/, '');
export const validateExtensionTag = (t: string) => (/^[a-z0-9]{1,16}$/.test(t) ? null : `"${t}" is not a valid file extension`);
