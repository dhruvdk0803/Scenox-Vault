'use client';

import * as React from 'react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { CalendarClock, Clock, Files, HardDrive, History, MessageSquare, MessageSquarePlus, MessagesSquare, UploadCloud } from 'lucide-react';
import { formatBytes, formatNumber, formatPercent, type ClientDashboardDTO, type ClientFileDTO, type ClientUploadDTO } from '@scenox/shared';
import { Avatar, Button, Card, EmptyState, ProgressBar, Skeleton, StatCard, StatusBadge, StorageMeter } from '@/components/ui';
import { friendlyError, plural, whenFull, whenShort } from '@/lib/portal/format';
import { useDashboard } from '@/lib/portal/hooks';
import { categoryMeta } from './file-types';
import { usePortal } from './portal-context';
import { PortalNotes } from './portal-notes';
import { UnreadBadge } from './tab-nav';
import { FileTile, InlineError, LinkButton, Section } from './ui-bits';

export function OverviewTab() {
  const { portal, branding, canViewFiles, canMessage, navigate } = usePortal();
  const q = useDashboard();
  const d = q.data;
  const goUpload = () => navigate({ tab: 'upload' });
  const brandNew = !!d && d.stats.files === 0 && d.stats.uploads === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Welcome, {portal.clientName}</h1>
          <p className="text-sm text-fg-muted sm:text-base">{portal.title}</p>
        </div>
        <Button size="lg" onClick={goUpload} className="w-full sm:w-auto">
          <UploadCloud aria-hidden /> Upload files
        </Button>
      </div>

      <PortalNotes portal={portal} />

      {q.isError && !d && <InlineError message={friendlyError(q.error, 'We couldn’t load your overview.')} onRetry={() => void q.refetch()} />}

      {!brandNew && (
        <div role="group" aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stats d={d} loading={q.isLoading} />
        </div>
      )}

      {q.isLoading ? (
        <OverviewSkeleton />
      ) : d ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
            {brandNew ? (
              <Card className="animate-fade-in">
                <EmptyState
                  className="py-16"
                  icon={<UploadCloud />}
                  title="Nothing uploaded yet"
                  description={`Send your files securely to ${branding.companyName || 'us'}. Large files and whole folders are fine.`}
                  action={
                    <Button size="lg" onClick={goUpload}>
                      <UploadCloud aria-hidden /> Upload your first files
                    </Button>
                  }
                />
              </Card>
            ) : (
              <>
                <RecentUploads uploads={d.recentUploads} canViewAll={canViewFiles} />
                {canViewFiles && <RecentFiles files={d.recentFiles} />}
              </>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            <StorageCard d={d} />
            {!brandNew && <Breakdown d={d} />}
            {canMessage && <LatestMessage d={d} />}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stats({ d, loading }: { d: ClientDashboardDTO | undefined; loading: boolean }) {
  const last = d?.stats.lastUploadAt ?? null;
  const items = [
    { label: 'Files', icon: <Files />, value: d ? formatNumber(d.stats.files) : '', sub: d && d.stats.folders > 0 ? `${formatNumber(d.stats.folders)} ${plural(d.stats.folders, 'folder')}` : undefined },
    { label: 'Total size', icon: <HardDrive />, value: d ? formatBytes(d.stats.totalBytes) : '', sub: undefined },
    { label: 'Uploads', icon: <History />, value: d ? formatNumber(d.stats.uploads) : '', sub: undefined },
    { label: 'Last upload', icon: <Clock />, value: d ? (last ? whenShortAgo(last) : 'Never') : '', sub: last ? format(new Date(last), 'MMM d, yyyy · h:mm a') : undefined },
  ];
  return (
    <>
      {items.map((s) => (
        <div key={s.label}>
          <StatCard label={s.label} value={s.value} icon={s.icon} subText={s.sub} loading={loading && !d} className="h-full p-4 sm:p-5 [&_.text-2xl]:text-xl sm:[&_.text-2xl]:text-2xl" />
        </div>
      ))}
    </>
  );
}

const whenShortAgo = (iso: string) => {
  const d = new Date(iso);
  return Date.now() - d.getTime() < 60_000 ? 'Just now' : `${formatDistanceToNowStrict(d)} ago`;
};

function OverviewSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-3" role="status" aria-label="Loading overview">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-36 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
      </div>
    </div>
  );
}

/* ───────── storage ───────── */

function StorageCard({ d }: { d: ClientDashboardDTO }) {
  const exp = d.expiresAt ? new Date(d.expiresAt) : null;
  return (
    <Section title="Storage" bodyClassName="flex flex-col gap-4 px-5 pb-5">
      <StorageMeter usedBytes={d.quota.usedBytes} limitBytes={d.quota.limitBytes} />
      <p className="flex items-center gap-2 text-xs text-fg-muted">
        <CalendarClock aria-hidden className="size-4 shrink-0 text-fg-subtle" />
        {exp ? (
          exp.getTime() < Date.now() ? (
            <span>This link expired on {format(exp, 'MMM d, yyyy')}</span>
          ) : (
            <span>
              This link stays open until <span className="font-medium text-fg">{format(exp, 'MMM d, yyyy')}</span> ({formatDistanceToNowStrict(exp)} left)
            </span>
          )
        ) : (
          <span>This link doesn’t expire</span>
        )}
      </p>
    </Section>
  );
}

/* ───────── file types ───────── */

function Breakdown({ d }: { d: ClientDashboardDTO }) {
  const { canViewFiles, navigate } = usePortal();
  const rows = [...d.byType].filter((r) => r.files > 0).sort((a, b) => b.bytes - a.bytes || b.files - a.files);
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  return (
    <Section title="File types" bodyClassName="px-5 pb-5">
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No files yet.</p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {rows.map((r) => {
            const meta = categoryMeta(r.type);
            const Icon = meta.icon;
            const share = total > 0 ? r.bytes / total : 0;
            const body = (
              <>
                <div className="flex items-center gap-2.5">
                  <Icon aria-hidden className="size-4 shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{meta.plural}</span>
                  <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                    {formatNumber(r.files)} {plural(r.files, 'file')} · {formatBytes(r.bytes)}
                  </span>
                </div>
                <ProgressBar value={Math.max(share * 100, r.bytes > 0 ? 2 : 0)} size="sm" label={`${meta.plural}: ${formatPercent(share, 0)} of your storage`} className="mt-1.5" />
              </>
            );
            return (
              <li key={r.type}>
                {canViewFiles ? (
                  <button
                    type="button" onClick={() => navigate({ tab: 'files', type: r.type })} title={`Show ${meta.plural.toLowerCase()}`}
                    className="-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="py-1">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/* ───────── recent uploads / files ───────── */

function RecentUploads({ uploads, canViewAll }: { uploads: ClientUploadDTO[]; canViewAll: boolean }) {
  const { navigate } = usePortal();
  return (
    <Section title="Recent uploads" action={canViewAll && uploads.length > 0 ? <LinkButton onClick={() => navigate({ tab: 'uploads' })}>View all</LinkButton> : undefined}>
      {uploads.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">Uploads you send will appear here.</p>
      ) : (
        <ul className="divide-y divide-border/60 border-t border-border/60">
          {uploads.map((u) => {
            const who = u.uploaderName || 'Upload';
            return (
              <li key={u.id} className="flex items-start gap-3 px-5 py-3">
                <Avatar name={who} size="md" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium text-fg">{u.uploaderName ? `Upload by ${u.uploaderName}` : 'File upload'}</span>
                    <StatusBadge kind="session" status={u.status} />
                  </div>
                  <p className="text-xs tabular-nums text-fg-muted">
                    {formatNumber(u.files)} {plural(u.files, 'file')} · {formatBytes(u.bytes)} · <time dateTime={u.startedAt} title={whenFull(u.startedAt)}>{whenShort(u.completedAt ?? u.startedAt)}</time>
                  </p>
                  {u.message && <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-fg-muted">“{u.message}”</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function RecentFiles({ files }: { files: ClientFileDTO[] }) {
  const { navigate, canMessage, openFileComments } = usePortal();
  return (
    <Section title="Recent files" action={files.length > 0 ? <LinkButton onClick={() => navigate({ tab: 'files' })}>Browse all files</LinkButton> : undefined}>
      {files.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">Your latest files will appear here.</p>
      ) : (
        <ul className="divide-y divide-border/60 border-t border-border/60">
          {files.map((f) => {
            const Icon = categoryMeta(f.type).icon;
            return (
              <li key={f.id} className="flex items-center gap-3 px-5 py-2.5">
                <FileTile icon={Icon} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg" title={f.name}>{f.name}</p>
                  <p className="truncate text-xs tabular-nums text-fg-muted">
                    {formatBytes(f.size)} · {whenShort(f.uploadedAt)}
                    {f.uploadedBy ? ` · ${f.uploadedBy}` : ''}
                  </p>
                </div>
                {f.status !== 'ready' && <StatusBadge kind="file" status={f.status} className="hidden sm:inline-flex" />}
                {canMessage && (
                  <button
                    type="button" onClick={() => openFileComments(f)} aria-label={`Comments on ${f.name}${f.commentCount ? ` (${f.commentCount})` : ''}`}
                    className="-mr-2 inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-md px-2 text-xs tabular-nums text-fg-subtle transition-colors hover:bg-surface-muted hover:text-fg"
                  >
                    <MessageSquare aria-hidden className="size-4" />
                    {f.commentCount > 0 && f.commentCount}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/* ───────── latest message ───────── */

function LatestMessage({ d }: { d: ClientDashboardDTO }) {
  const { navigate } = usePortal();
  const { latest, unread } = d.messages;
  const open = () => navigate({ tab: 'messages' });
  return (
    <Section title="Messages" action={<UnreadBadge count={unread} />} bodyClassName="flex flex-col gap-3 px-5 pb-5">
      {latest ? (
        <>
          <button
            type="button" onClick={open} aria-label="Open messages"
            className="flex gap-3 rounded-lg border border-border bg-surface-muted/50 p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Avatar name={latest.authorName} size="md" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-fg">{latest.own || latest.authorType === 'client' ? 'You' : latest.authorName}</span>
                <time dateTime={latest.createdAt} title={whenFull(latest.createdAt)} className="shrink-0 text-xs text-fg-subtle">{whenShort(latest.createdAt)}</time>
              </span>
              <span className="line-clamp-3 whitespace-pre-line break-words text-sm text-fg-muted">{latest.body}</span>
            </span>
          </button>
          <Button variant="outline" size="sm" onClick={open} className="self-start">
            <MessagesSquare aria-hidden /> {unread > 0 ? `Read ${unread} new ${plural(unread, 'message')}` : 'Open conversation'}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-fg-muted">Have a question or an update? Send the team a message here.</p>
          <Button variant="outline" size="sm" onClick={open} className="self-start">
            <MessageSquarePlus aria-hidden /> Start a conversation
          </Button>
        </>
      )}
    </Section>
  );
}
