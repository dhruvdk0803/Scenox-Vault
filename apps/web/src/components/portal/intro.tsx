'use client';

import { CalendarClock, Info } from 'lucide-react';
import { format } from 'date-fns';
import { formatBytes, type PublicPortalDTO } from '@scenox/shared';
import { ProgressBar } from '@/components/ui';

type Portal = NonNullable<PublicPortalDTO['portal']>;

export function PortalIntro({ portal, compact }: { portal: Portal; compact?: boolean }) {
  const { quota } = portal;
  const limited = quota.limitBytes != null && quota.limitBytes > 0;
  const fraction = limited ? quota.usedBytes / quota.limitBytes! : 0;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{portal.title}</h1>
        {portal.description && !compact && <p className="whitespace-pre-line text-base text-fg-muted">{portal.description}</p>}
      </div>
      {portal.instructions && !compact && (
        <div className="flex gap-3 rounded-lg border border-primary-soft-border bg-primary-soft p-4 text-sm text-primary-soft-fg">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p className="whitespace-pre-line">{portal.instructions}</p>
        </div>
      )}
      {(limited || portal.expiresAt) && (
        <div className="flex flex-col gap-3 text-sm text-fg-muted sm:flex-row sm:items-center sm:gap-6">
          {limited && (
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="tabular-nums">
                <span className="font-medium text-fg">{formatBytes(quota.usedBytes)}</span> / {formatBytes(quota.limitBytes)} used
              </span>
              <ProgressBar value={fraction * 100} size="sm" tone={fraction >= 0.95 ? 'danger' : fraction >= 0.8 ? 'warning' : 'primary'} label="Space used" />
            </div>
          )}
          {portal.expiresAt && (
            <span className="inline-flex items-center gap-1.5 text-fg-subtle">
              <CalendarClock aria-hidden className="size-4" />
              Link expires {format(new Date(portal.expiresAt), 'MMM d, yyyy')}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
