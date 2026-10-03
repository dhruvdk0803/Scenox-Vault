'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { CopyButton } from '@/components/ui/copy-button';

/** Monospace block with a copy button. Content is always rendered as plain text. */
export function CodeBlock({
  code, language, label = 'Copy code', className, preClassName, maxHeight,
}: { code: string; language?: string; label?: string; className?: string; preClassName?: string; maxHeight?: string }) {
  return (
    <div className={cn('group overflow-hidden rounded-lg border border-border bg-surface-muted', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1">
        <span className="font-mono text-[11px] uppercase tracking-wide text-fg-subtle">{language ?? 'text'}</span>
        <CopyButton value={code} label={label} showLabel size="sm" className="h-7 text-fg-muted" />
      </div>
      <pre
        tabIndex={0}
        className={cn('overflow-auto px-3 py-3 font-mono text-[12.5px] leading-5 text-fg focus-visible:outline-2 focus-visible:outline-ring', preClassName)}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** A single-line value (URL, key…) in a monospace pill with a trailing copy button. */
export function CopyField({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-1 rounded-lg border border-border-strong bg-surface-muted py-1 pl-3 pr-1', className)}>
      <code className="min-w-0 flex-1 select-all break-all font-mono text-[13px] leading-5 text-fg">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}
