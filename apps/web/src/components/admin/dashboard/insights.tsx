'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { BarChart3 } from 'lucide-react';
import { formatBytes, formatNumber, formatSpeed, type AnalyticsDTO } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '../query-state';

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

interface DailyPoint { date: string; label: string; bytes: number; files: number; sessions: number }

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: DailyPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-fg">{format(parseISO(p.date), 'EEE, MMM d, yyyy')}</p>
      <p className="tabular-nums text-fg-muted"><span className="font-semibold text-fg">{formatBytes(p.bytes)}</span> received</p>
      <p className="tabular-nums text-fg-muted">{formatNumber(p.files)} files · {formatNumber(p.sessions)} sessions</p>
    </div>
  );
}

function RankedBars({ rows, empty }: { rows: { key: string; label: string; href?: string; value: number; sub: string }[]; empty: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-fg-subtle">{empty}</p>;
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            {r.href ? <Link href={r.href} className="min-w-0 truncate font-medium text-fg hover:underline">{r.label}</Link> : <span className="min-w-0 truncate font-medium text-fg">{r.label}</span>}
            <span className="shrink-0 text-xs tabular-nums text-fg-muted">{r.sub}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted" role="presentation">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function InsightsSection() {
  const [days, setDays] = React.useState<Range>(30);
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.analytics(days),
    queryFn: ({ signal }) => api.get<AnalyticsDTO>(`/analytics${qs({ days })}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.totals.activeSessions ? 5000 : 60_000),
  });

  const daily: DailyPoint[] = (data?.daily ?? []).map((d) => ({ ...d, label: format(parseISO(d.date), 'MMM d') }));
  const hasData = daily.some((d) => d.bytes > 0);

  return (
    <section aria-labelledby="insights-title" className="mt-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="insights-title" className="text-lg font-semibold tracking-tight">Insights</h2>
          <p className="text-sm text-fg-muted">Upload volume and who sends you the most data.</p>
        </div>
        <div role="group" aria-label="Date range" className="inline-flex rounded-lg border border-border bg-surface-muted p-0.5">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)} className={cn('rounded-md px-3 py-1 text-sm font-medium tabular-nums transition-colors', days === r ? 'bg-surface text-fg shadow-xs' : 'text-fg-muted hover:text-fg')}>
              {r} days
            </button>
          ))}
        </div>
      </div>

      {error && !data ? (
        <Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load insights" /></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-3">
            <CardHeader className="pb-0">
              <CardTitle>Data received</CardTitle>
              <CardDescription>Per day over the last {days} days</CardDescription>
            </CardHeader>
            <CardContent>
              {isPending ? (
                <Skeleton className="h-60" />
              ) : (
                <>
                  <dl className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {[
                      ['Upload sessions', formatNumber(data!.totals.sessions)],
                      ['Files uploaded', formatNumber(data!.totals.filesUploaded)],
                      ['Data received', formatBytes(data!.totals.bytesUploaded)],
                      ['Average speed', data!.totals.avgSpeedBps ? formatSpeed(data!.totals.avgSpeedBps) : '—'],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs text-fg-subtle">{k}</dt>
                        <dd className="text-lg font-semibold tabular-nums">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {hasData ? (
                    <div role="img" aria-label={`Bar chart of data received per day over the last ${days} days. Total ${formatBytes(data!.totals.bytesUploaded)}.`} className="h-60">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                          <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
                          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: 'var(--border)' }} tick={{ fill: 'var(--fg-subtle)', fontSize: 12 }} minTickGap={days === 7 ? 8 : 28} />
                          <YAxis tickLine={false} axisLine={false} width={64} tick={{ fill: 'var(--fg-subtle)', fontSize: 12 }} tickFormatter={(v: number) => formatBytes(v, 0)} allowDecimals={false} />
                          <RTooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-muted)' }} isAnimationActive={false} />
                          <Bar dataKey="bytes" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={days === 7 ? 40 : 24} isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <EmptyState icon={<BarChart3 />} title="No uploads in this period" description="Data received from client uploads will be charted here." className="py-8" />
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Top clients</CardTitle><CardDescription>By data received in this period</CardDescription></CardHeader>
            <CardContent>
              {isPending ? <Skeleton className="h-40" /> : (
                <RankedBars
                  empty="No client uploads in this period."
                  rows={data!.topClients.slice(0, 6).map((c) => ({ key: c.clientId, label: c.clientName, href: `/clients/${c.clientId}`, value: c.bytes, sub: `${formatBytes(c.bytes)} · ${formatNumber(c.files)} files` }))}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>File types</CardTitle><CardDescription>By size</CardDescription></CardHeader>
            <CardContent>
              {isPending ? <Skeleton className="h-40" /> : (
                <RankedBars
                  empty="No files in this period."
                  rows={data!.fileTypes.slice(0, 6).map((t) => ({ key: t.type, label: t.type.charAt(0).toUpperCase() + t.type.slice(1), value: t.bytes, sub: `${formatBytes(t.bytes)} · ${formatNumber(t.files)}` }))}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}
