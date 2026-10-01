'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Lock, Pause } from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { UploadSnapshot } from '@/lib/upload';
import { BrandLogo } from './shell';

/**
 * Compact upload status that stays visible from every tab while the engine runs.
 * Not a live region (percentages would be noisy); the button label carries the state.
 */
export function UploadPill({ snapshot, onOpen }: { snapshot: UploadSnapshot; onOpen: () => void }) {
  const { stats } = snapshot;
  if (snapshot.items.length === 0) return null;
  const pct = Math.floor(stats.percent);
  let tone = 'border-primary-soft-border bg-primary-soft text-primary-soft-fg';
  let icon: React.ReactNode;
  let label: string;
  if (stats.running) {
    const stopped = snapshot.paused || snapshot.offline;
    label = snapshot.offline ? `Waiting for connection · ${pct}%` : snapshot.paused ? `Upload paused · ${pct}%` : `Uploading ${pct}%`;
    icon = stopped ? <Pause aria-hidden className="size-3.5" /> : <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
  } else if (stats.failedFiles > 0) {
    tone = 'border-warning-border bg-warning-bg text-warning';
    label = stats.completedFiles > 0 ? `${stats.failedFiles} failed` : 'Upload incomplete';
    icon = <AlertTriangle aria-hidden className="size-3.5" />;
  } else {
    tone = 'border-success-border bg-success-bg text-success';
    label = 'Upload complete';
    icon = <CheckCircle2 aria-hidden className="size-3.5" />;
  }
  const detail = stats.running ? `${label}. ${stats.completedFiles} of ${stats.totalFiles} files done.` : label;
  return (
    <button
      type="button" onClick={onOpen} aria-label={`${detail} Open the Upload tab.`} title="Go to Upload"
      className={cn('relative inline-flex h-8 shrink-0 animate-fade-in items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-xs font-medium tabular-nums transition-colors duration-150 hover:brightness-[0.98]', tone)}
    >
      {icon}
      <span className="max-w-[9.5rem] truncate">{label}</span>
      {stats.running && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-primary/15">
          <span className="block h-full bg-primary transition-[width] duration-300" style={{ width: `${Math.min(100, stats.percent)}%` }} />
        </span>
      )}
    </button>
  );
}

export function DashboardHeader({
  companyName, title, logoUrl, pill, children,
}: {
  companyName: string;
  title: string;
  logoUrl: string | null;
  pill?: React.ReactNode;
  /** Desktop tab strip rendered under the brand row. */
  children?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <BrandLogo src={logoUrl} />
          <div className="flex min-w-0 items-baseline gap-2.5">
            {companyName && <span className="truncate text-[15px] font-semibold tracking-tight text-fg">{companyName}</span>}
            {title && (
              <>
                <span aria-hidden className="hidden text-border-strong sm:inline">/</span>
                <span className="hidden min-w-0 truncate text-sm text-fg-muted sm:inline">{title}</span>
              </>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {pill}
          <Badge tone="neutral" className="gap-1.5 py-1 pl-2 pr-2.5">
            <Lock aria-hidden className="size-3" />
            <span className="max-sm:sr-only">Secure portal</span>
          </Badge>
        </div>
      </div>
      {children && <div className="hidden border-t border-border/60 md:block"><div className="mx-auto w-full max-w-6xl px-6">{children}</div></div>}
    </header>
  );
}
