'use client';

import * as React from 'react';
import Link from 'next/link';
import { format, isToday, isYesterday } from 'date-fns';
import {
  Activity as ActivityIcon, FileText, KeyRound, Link2, Settings, ShieldAlert, Upload, UserCog, Users, Download, type LucideIcon,
} from 'lucide-react';
import type { ActivityDTO } from '@scenox/shared';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { RelativeTime } from './relative-time';

export const ACTION_FAMILIES = [
  { value: 'client', label: 'Clients' },
  { value: 'portal', label: 'Portals' },
  { value: 'upload', label: 'Uploads' },
  { value: 'file', label: 'Files' },
  { value: 'auth', label: 'Sign-ins' },
  { value: 'settings', label: 'Settings' },
] as const;

const FAMILY_ICON: Record<string, LucideIcon> = {
  client: Users,
  portal: Link2,
  upload: Upload,
  file: FileText,
  export: Download,
  auth: KeyRound,
  settings: Settings,
  user: UserCog,
  team: UserCog,
};

export function actionIcon(action: string): LucideIcon {
  const family = action.split('.')[0] ?? '';
  return FAMILY_ICON[family] ?? ActivityIcon;
}

function actorText(a: ActivityDTO): string {
  if (a.actorLabel) return a.actorLabel;
  return a.actorType === 'system' ? 'System' : a.actorType === 'client' ? 'A client' : 'An admin';
}

export function ActivityItem({ item, showClient = true }: { item: ActivityDTO; showClient?: boolean }) {
  const Icon = a11yIcon(item);
  const failed = item.result === 'failure';
  return (
    <li className="flex items-start gap-3 py-3">
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border [&_svg]:size-4', failed ? 'border-danger-border bg-danger-bg text-danger' : 'border-border bg-surface-muted text-fg-muted')} aria-hidden>
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">
          {item.summary}
          {failed && <span className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-danger-border bg-danger-bg px-1.5 text-xs font-medium text-danger"><ShieldAlert className="size-3" aria-hidden /> Failed</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
          <span>{actorText(item)}</span>
          {showClient && item.clientId && item.clientName && (
            <>
              <span aria-hidden>·</span>
              <Link href={`/clients/${item.clientId}`} className="font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                {item.clientName}
              </Link>
            </>
          )}
          <span aria-hidden>·</span>
          <RelativeTime date={item.createdAt} />
        </p>
      </div>
    </li>
  );
}

function a11yIcon(item: ActivityDTO) {
  return actionIcon(item.action);
}

export function dayLabel(d: Date): string {
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'EEEE, MMMM d, yyyy');
}

/** Activity list. With `grouped`, items are bucketed by day ("Today", "Yesterday", date). */
export function ActivityFeed({
  items, loading, grouped, showClient = true, skeletonRows = 5, empty,
}: { items: ActivityDTO[] | undefined; loading?: boolean; grouped?: boolean; showClient?: boolean; skeletonRows?: number; empty?: React.ReactNode }) {
  if (loading) {
    return (
      <ul className="divide-y divide-border" aria-busy="true">
        {Array.from({ length: skeletonRows }, (_, i) => (
          <li key={i} className="flex items-start gap-3 py-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (!items || items.length === 0) return <>{empty ?? null}</>;
  if (!grouped) {
    return (
      <ul className="divide-y divide-border">
        {items.map((i) => (
          <ActivityItem key={i.id} item={i} showClient={showClient} />
        ))}
      </ul>
    );
  }
  const groups: { key: string; label: string; items: ActivityDTO[] }[] = [];
  for (const item of items) {
    const d = new Date(item.createdAt);
    const key = format(d, 'yyyy-MM-dd');
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(d), items: [item] });
  }
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h3 className="sticky top-0 mb-1 border-b border-border bg-surface pb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{g.label}</h3>
          <ul className="divide-y divide-border">
            {g.items.map((i) => (
              <ActivityItem key={i.id} item={i} showClient={showClient} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
