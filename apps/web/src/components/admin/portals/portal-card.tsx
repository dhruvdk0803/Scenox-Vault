'use client';

import Link from 'next/link';
import { ExternalLink, Files, HardDrive, Clock } from 'lucide-react';
import { formatBytes, formatNumber, type PortalDTO } from '@scenox/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate } from '../relative-time';

export function PortalCard({ portal }: { portal: PortalDTO }) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/portals/${portal.id}`} className="block truncate font-medium text-fg hover:underline">{portal.name}</Link>
          <p className="truncate text-xs text-fg-subtle">{portal.title ?? portal.clientName}</p>
        </div>
        <StatusBadge kind="portal" status={portal.status} />
      </div>
      {portal.url && (
        <div className="flex items-center gap-1 rounded-md border border-border bg-surface-muted py-0.5 pl-2.5 pr-0.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted" title={portal.url}>{portal.url}</code>
          <CopyButton value={portal.url} label={`Copy link for ${portal.name}`} className="size-7" />
          <Button variant="ghost" size="icon" className="size-7" asChild>
            <a href={portal.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${portal.name} in a new tab`}><ExternalLink aria-hidden /></a>
          </Button>
        </div>
      )}
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div><dt className="flex items-center gap-1 text-fg-subtle"><Files className="size-3" aria-hidden /> Files</dt><dd className="mt-0.5 text-sm font-medium tabular-nums">{formatNumber(portal.fileCount)}</dd></div>
        <div><dt className="flex items-center gap-1 text-fg-subtle"><HardDrive className="size-3" aria-hidden /> Storage</dt><dd className="mt-0.5 text-sm font-medium tabular-nums">{formatBytes(portal.storageUsedBytes)}</dd></div>
        <div><dt className="flex items-center gap-1 text-fg-subtle"><Clock className="size-3" aria-hidden /> Expires</dt><dd className="mt-0.5 text-sm font-medium tabular-nums">{portal.expiresAt ? formatDate(portal.expiresAt) : 'Never'}</dd></div>
      </dl>
      {portal.maxTotalBytes ? (
        <ProgressBar value={(portal.storageUsedBytes / portal.maxTotalBytes) * 100} size="sm" label="Portal quota used" />
      ) : null}
    </Card>
  );
}
