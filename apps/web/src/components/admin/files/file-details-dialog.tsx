'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Download, MessageSquare } from 'lucide-react';
import { formatBytes, type FileDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { MessageThread } from '../messages/message-thread';
import { ErrorState } from '../query-state';
import { formatDateTime } from '../relative-time';
import { downloadUrl, FileTypeIcon, filePath } from './file-utils';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-2.5 sm:grid-cols-4">
      <dt className="text-sm text-fg-subtle">{label}</dt>
      <dd className="col-span-2 min-w-0 break-words text-sm text-fg sm:col-span-3">{children}</dd>
    </div>
  );
}

/** All metadata for a file. `fileId` null closes the dialog. Follows "duplicate of" links in place. */
export function FileDetailsDialog({ fileId, onOpenChange, initial }: { fileId: string | null; onOpenChange: (open: boolean) => void; initial?: FileDTO | null }) {
  const [currentId, setCurrentId] = React.useState<string | null>(fileId);
  React.useEffect(() => setCurrentId(fileId), [fileId]);
  const canDownload = usePermission('files.download');

  const { data: file, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.files.detail(currentId ?? ''),
    queryFn: ({ signal }) => api.get<FileDTO>(`/files/${currentId}`, { signal }),
    enabled: !!currentId,
    initialData: initial && initial.id === currentId ? initial : undefined,
    staleTime: 10_000,
  });

  return (
    <Dialog open={!!fileId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            {file && <FileTypeIcon extension={file.extension} className="size-5 shrink-0 text-fg-subtle" />}
            <span className="truncate">{file?.name ?? 'File details'}</span>
          </DialogTitle>
          <DialogDescription>{file ? filePath(file) : 'Loading file metadata…'}</DialogDescription>
        </DialogHeader>

        {error && !file ? (
          <ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load this file" />
        ) : isPending || !file ? (
          <div className="space-y-3">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}
          </div>
        ) : (
          <>
            <dl className="divide-y divide-border">
              <Row label="Size"><span className="tabular-nums">{formatBytes(file.size)}</span> <span className="tabular-nums text-fg-subtle">({file.size.toLocaleString('en-US')} bytes)</span></Row>
              <Row label="Status">
                <div className="flex flex-wrap gap-1.5">
                  <StatusBadge kind="file" status={file.status} />
                  <StatusBadge kind="scan" status={file.scanStatus} />
                </div>
                {file.scanResult && <p className="mt-1 text-xs text-fg-muted">{file.scanResult}</p>}
              </Row>
              <Row label="Type">
                <span className="font-mono text-xs">{file.mimeType ?? 'unknown'}</span>
                <span className="text-fg-subtle"> declared</span>
                <br />
                <span className="font-mono text-xs">{file.detectedMime ?? 'not detected'}</span>
                <span className="text-fg-subtle"> detected</span>
              </Row>
              <Row label="SHA-256">
                {file.checksumSha256 ? (
                  <span className="flex items-start gap-1">
                    <code className="min-w-0 break-all font-mono text-xs">{file.checksumSha256}</code>
                    <CopyButton value={file.checksumSha256} label="Copy SHA-256" className="size-7" />
                  </span>
                ) : (
                  <span className="text-fg-subtle">Not computed yet</span>
                )}
              </Row>
              <Row label="Client">
                <Link href={`/clients/${file.clientId}`} className="font-medium underline-offset-2 hover:underline">{file.clientName}</Link>
              </Row>
              <Row label="Portal">
                <Link href={`/portals/${file.portalId}`} className="font-medium underline-offset-2 hover:underline">{file.portalName}</Link>
              </Row>
              <Row label="Folder">{file.relativePath || <span className="text-fg-subtle">Portal root</span>}</Row>
              <Row label="Uploaded by">
                {file.uploaderName || file.uploaderEmail ? (
                  <>
                    {file.uploaderName}
                    {file.uploaderEmail && <span className="text-fg-muted"> · {file.uploaderEmail}</span>}
                  </>
                ) : (
                  <span className="text-fg-subtle">Anonymous</span>
                )}
              </Row>
              <Row label="Upload session">
                <Link href={`/uploads?session=${file.uploadSessionId}`} className="font-medium underline-offset-2 hover:underline">View session</Link>
              </Row>
              <Row label="Uploaded"><span className="tabular-nums">{formatDateTime(file.completedAt ?? file.createdAt)}</span></Row>
              <Row label="Created"><span className="tabular-nums">{formatDateTime(file.createdAt)}</span></Row>
              {file.duplicateOfId && (
                <Row label="Duplicate of">
                  <Button variant="link" onClick={() => setCurrentId(file.duplicateOfId)}>View the original file</Button>
                </Row>
              )}
            </dl>
            <section aria-labelledby="file-comments-heading">
              <h3 id="file-comments-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg"><MessageSquare className="size-4 text-fg-subtle" aria-hidden /> Comments</h3>
              <MessageThread portalId={file.portalId} fileId={file.id} compact className="h-72 overflow-hidden rounded-lg border border-border" />
            </section>
            <div className="flex flex-wrap justify-end gap-2">
              <CopyButton value={filePath(file)} label="Copy path" showLabel variant="outline" />
              {canDownload && (
                file.status === 'quarantined' ? (
                  <Button size="sm" disabled>
                    <Download aria-hidden /> Quarantined
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <a href={downloadUrl(file.id)}>
                      <Download aria-hidden /> Download
                    </a>
                  </Button>
                )
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
