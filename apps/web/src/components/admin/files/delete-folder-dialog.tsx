'use client';

import * as React from 'react';
import { formatBytes, formatNumber, type FileDTO, type Paginated } from '@scenox/shared';
import { api, errorMessage, qs } from '@/lib/api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toaster';
import { collectFiles, deleteFileIds } from './bulk-delete';
import { useInvalidateFiles } from './file-dialogs';

export interface FolderToDelete {
  name: string;
  path: string;
  fileCount: number;
  totalBytes: number;
}

type Phase = { kind: 'scan'; found: number; total: number } | { kind: 'delete'; done: number; total: number } | null;

/**
 * Deletes every file at or below a folder for one client (optionally one portal). Walks GET /files for the client page by page
 * and keeps files whose relativePath is the folder or starts with "folder/", then deletes them in chunks of 500.
 */
export function DeleteFolderDialog({
  folder, clientId, portalId, onOpenChange, onDeleted,
}: { folder: FolderToDelete | null; clientId: string; portalId?: string; onOpenChange: (open: boolean) => void; onDeleted?: (path: string) => void }) {
  const invalidate = useInvalidateFiles();
  const [phase, setPhase] = React.useState<Phase>(null);
  // Keep the last folder around so the text doesn't flash empty while the dialog animates out.
  const last = React.useRef<FolderToDelete | null>(null);
  if (folder) last.current = folder;
  const f = folder ?? last.current;

  React.useEffect(() => {
    if (!folder) setPhase(null);
  }, [folder]);

  async function remove() {
    if (!folder) return;
    const { path } = folder;
    let targets: FileDTO[];
    try {
      setPhase({ kind: 'scan', found: 0, total: folder.fileCount });
      targets = await collectFiles(
        (page, pageSize) => api.get<Paginated<FileDTO>>(`/files${qs({ clientId, portalId, page, pageSize, sort: 'createdAt', order: 'asc' })}`),
        {
          filter: (x) => x.relativePath === path || x.relativePath.startsWith(`${path}/`),
          onProgress: (found, total) => setPhase({ kind: 'scan', found, total }),
        },
      );
    } catch (err) {
      setPhase(null);
      toast.error("Couldn't read the folder's files", { description: errorMessage(err) });
      throw err;
    }
    if (targets.length === 0) {
      setPhase(null);
      invalidate();
      toast.info('This folder has no files to delete');
      return;
    }
    const res = await deleteFileIds(targets.map((x) => x.id), (done, total) => setPhase({ kind: 'delete', done, total }));
    if (res.deleted.length > 0) invalidate();
    setPhase(null);
    if (res.error) {
      toast.error(res.deleted.length > 0 ? `Deleted ${formatNumber(res.deleted.length)} of ${formatNumber(targets.length)} files before an error` : "Couldn't delete the folder", {
        description: errorMessage(res.error),
      });
      throw res.error;
    }
    toast.success(`Deleted “${folder.name}”`, { description: `${formatNumber(targets.length)} ${targets.length === 1 ? 'file' : 'files'} removed` });
    onDeleted?.(path);
  }

  const pct = phase ? (phase.kind === 'scan' ? 0 : phase.total ? (phase.done / phase.total) * 100 : 0) : 0;

  return (
    <ConfirmDialog
      open={!!folder}
      onOpenChange={onOpenChange}
      title={f ? `Delete folder “${f.name}”?` : 'Delete folder?'}
      description={
        f && (
          <>
            <span className="block">
              This permanently deletes {formatNumber(f.fileCount)} {f.fileCount === 1 ? 'file' : 'files'} ({formatBytes(f.totalBytes)}) in this folder and its subfolders. This can&apos;t be undone.
            </span>
            {phase && (
              <span className="mt-3 block" role="status">
                <span className="block h-1.5 overflow-hidden rounded-full bg-surface-muted">
                  <span className="block h-full rounded-full bg-danger-solid transition-[width] duration-150" style={{ width: `${pct}%` }} />
                </span>
                <span className="mt-1 block text-xs tabular-nums text-fg-subtle">
                  {phase.kind === 'scan' ? `Finding files… ${formatNumber(phase.found)} in folder` : `Deleted ${formatNumber(phase.done)} of ${formatNumber(phase.total)}…`}
                </span>
              </span>
            )}
          </>
        )
      }
      confirmLabel="Delete folder"
      destructive
      onConfirm={remove}
    />
  );
}
