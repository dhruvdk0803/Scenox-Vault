'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Activity, ArrowRight, Database, Download, FileText, Link2, MessagesSquare, Plus, UploadCloud, Users, Zap } from 'lucide-react';
import { formatBytes, formatNumber, type DashboardDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useMe, usePermission } from '@/lib/hooks/use-me';
import { useUnreadMessages } from '@/lib/hooks/use-messages';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { StorageMeter } from '@/components/ui/storage-meter';
import { Skeleton } from '@/components/ui/skeleton';
import { ActivityFeed } from '../activity-feed';
import { InsightsSection } from '../dashboard/insights';
import { ErrorState } from '../query-state';
import { RelativeTime } from '../relative-time';
import { SessionProgress } from '../session-progress';
import { StorageBanner } from '../storage-banner';

function greeting(now: Date | null): string {
  if (!now) return 'Welcome back';
  const h = now.getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-fg-muted transition-colors hover:text-fg">
      {children} <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

export function DashboardPage() {
  const { data: me } = useMe();
  // Time-dependent copy is computed after mount to avoid server/client hydration mismatches.
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => setNow(new Date()), []);
  const canClients = usePermission('clients.manage');
  const canPortals = usePermission('portals.manage');
  const canActivity = usePermission('activity.view');
  const canViewPortals = usePermission('portals.view');
  const unreadMessages = useUnreadMessages(canViewPortals);
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: ({ signal }) => api.get<DashboardDTO>('/dashboard', { signal }),
    // Live while uploads are running; slower background refresh otherwise (so new sessions are noticed).
    refetchInterval: (q) => (q.state.data && q.state.data.totals.activeSessions > 0 ? 5000 : 30_000),
  });

  const t = data?.totals;
  const firstName = me?.user.name.split(' ')[0];

  return (
    <>
      <PageHeader
        title={`${greeting(now)}${firstName ? `, ${firstName}` : ''}`}
        description={`${now ? `${format(now, 'EEEE, MMMM d')} · ` : ''}Here's what's happening in your vault.`}
        actions={
          <>
            {canClients && <Button variant="outline" asChild><Link href="/clients?new=1"><Plus aria-hidden /> New client</Link></Button>}
            {canPortals && <Button asChild><Link href="/portals/new"><Link2 aria-hidden /> New portal</Link></Button>}
          </>
        }
      />

      {error && !data ? (
        <Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load the dashboard" /></Card>
      ) : (
        <div className="space-y-6">
          {unreadMessages > 0 && (
            <Link
              href="/messages"
              className="group flex items-center gap-3 rounded-lg border border-primary-soft-border bg-primary-soft px-4 py-3 transition-colors duration-150 hover:bg-primary-soft/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden><MessagesSquare className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-primary-soft-fg">Unread messages</span>
                <span className="block text-xs text-fg-muted"><span className="tabular-nums">{formatNumber(unreadMessages)}</span> new {unreadMessages === 1 ? 'message' : 'messages'} from clients waiting for a reply</span>
              </span>
              <span className="inline-flex items-center gap-1 text-sm font-medium text-primary-soft-fg">Open inbox <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden /></span>
            </Link>
          )}

          {data && <StorageBanner level={data.storage.warningLevel} usedBytes={data.storage.usedBytes} capacityBytes={data.storage.capacityBytes} />}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Clients" icon={<Users />} loading={isPending} value={formatNumber(t?.clients)} />
            <StatCard label="Active portals" icon={<Link2 />} loading={isPending} value={formatNumber(t?.activePortals)} />
            <StatCard label="Files" icon={<FileText />} loading={isPending} value={formatNumber(t?.files)} />
            <StatCard label="Storage used" icon={<Database />} loading={isPending} value={formatBytes(t?.storageUsedBytes)} subText={data ? `of ${formatBytes(data.storage.capacityBytes)} disk` : undefined} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Uploads today" icon={<UploadCloud />} loading={isPending} value={formatNumber(t?.uploadsToday)} />
            <StatCard label="Data received today" icon={<Download />} loading={isPending} value={formatBytes(t?.bytesToday)} />
            <StatCard label="Active uploads" icon={<Zap />} loading={isPending} value={formatNumber(t?.activeSessions)} subText={t && t.activeSessions > 0 ? 'Live — refreshing every 5s' : 'No uploads in progress'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader><CardTitle>Storage</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {isPending ? <Skeleton className="h-16" /> : (
                  <>
                    <StorageMeter usedBytes={data!.storage.usedBytes} limitBytes={data!.storage.capacityBytes} warnAt={0.85} criticalAt={0.95} />
                    <p className="text-sm tabular-nums text-fg-muted">{formatBytes(data!.storage.freeBytes)} free</p>
                    <CardLink href="/storage">Storage details</CardLink>
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between"><CardTitle>Recent uploads</CardTitle><CardLink href="/uploads">View all</CardLink></CardHeader>
              <CardContent className="pt-2">
                {isPending ? (
                  <div className="space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
                ) : data!.recentSessions.length === 0 ? (
                  <EmptyState icon={<UploadCloud />} title="No uploads yet" description="Uploads from your clients will appear here as soon as they start." className="py-8" />
                ) : (
                  <ul className="divide-y divide-border">
                    {data!.recentSessions.slice(0, 6).map((s) => (
                      <li key={s.id}>
                        <Link href={`/uploads?session=${s.id}`} className="-mx-2 grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-3 transition-colors hover:bg-surface-muted/60 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,12rem)_auto]">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-fg">{s.clientName}</p>
                            <p className="truncate text-xs text-fg-subtle">
                              {s.portalName} · {s.uploaderName ?? s.uploaderEmail ?? 'Anonymous'}
                            </p>
                          </div>
                          <div className="order-last col-span-2 sm:order-none sm:col-span-1"><SessionProgress session={s} /></div>
                          <div className="flex flex-col items-end gap-1">
                            <StatusBadge kind="session" status={s.status} />
                            <RelativeTime date={s.startedAt} className="text-xs tabular-nums text-fg-subtle" />
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center justify-between"><CardTitle>Recent clients</CardTitle><CardLink href="/clients">View all</CardLink></CardHeader>
              <CardContent className="pt-2">
                {isPending ? <Skeleton className="h-40" /> : data!.recentClients.length === 0 ? (
                  <EmptyState icon={<Users />} title="No clients yet" description="Create your first client to generate an upload portal." action={canClients ? <Button asChild><Link href="/clients?new=1"><Plus aria-hidden /> New client</Link></Button> : undefined} className="py-8" />
                ) : (
                  <ul className="divide-y divide-border">
                    {data!.recentClients.slice(0, 5).map((c) => (
                      <li key={c.id}>
                        <Link href={`/clients/${c.id}`} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-surface-muted/60">
                          <Avatar name={c.name} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{c.name}</p>
                            <p className="truncate text-xs text-fg-subtle">{c.company ?? c.email ?? 'No contact details'}</p>
                          </div>
                          <div className="text-right text-xs tabular-nums text-fg-subtle">
                            <p>{formatBytes(c.storageUsedBytes)}</p>
                            <p>{formatNumber(c.fileCount)} files</p>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between"><CardTitle>Recent activity</CardTitle>{canActivity && <CardLink href="/activity">View all</CardLink>}</CardHeader>
              <CardContent className="pt-2">
                <ActivityFeed items={data?.recentActivity.slice(0, 6)} loading={isPending} empty={<EmptyState icon={<Activity />} title="No activity yet" description="Events like uploads and portal changes will show up here." className="py-8" />} />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {canActivity && <InsightsSection />}
    </>
  );
}
