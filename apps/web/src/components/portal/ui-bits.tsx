'use client';

import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { cn } from '@/lib/utils';

/** A titled card used across the dashboard. */
export function Section({
  title, action, children, className, bodyClassName, id,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const headingId = React.useId();
  return (
    <Card className={cn('flex flex-col overflow-hidden', className)} role="region" aria-labelledby={headingId} id={id}>
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
        <h2 id={headingId} className="text-sm font-semibold tracking-tight text-fg">{title}</h2>
        {action}
      </div>
      <div className={cn('flex-1', bodyClassName)}>{children}</div>
    </Card>
  );
}

export function InlineError({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-3 rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger sm:flex-row sm:items-center', className)}>
      <AlertCircle aria-hidden className="size-4 shrink-0" />
      <p className="flex-1">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="bg-surface text-fg">
          Try again
        </Button>
      )}
    </div>
  );
}

/** Quiet text-style action used in section headers ("View all"). */
export function LinkButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
      {children}
    </button>
  );
}

export function FileTile({ icon: Icon, className }: { icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; className?: string }) {
  return (
    <span aria-hidden className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-muted text-fg-muted', className)}>
      <Icon className="size-4" aria-hidden />
    </span>
  );
}
