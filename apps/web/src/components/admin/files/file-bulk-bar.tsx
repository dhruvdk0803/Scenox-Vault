'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FolderInput, ListChecks, Trash2, X } from 'lucide-react';
import { formatBytes, formatNumber, type ExportJobDTO, type FileDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toaster';
import { collectFiles, deleteFileIds, type PageFetcher } from './bulk-delete';
import { openExportsTray } from './exports-tray';
import { MoveFilesDialog, useInvalidateFiles } from './file-dialogs';
import { downloadUrl } from './file-utils';

export interface FileBulkBarProps {
  selectedIds: ReadonlySet<string>;
  onClear: () => void;
  /** Enables "Select all N matching" and lets a partial delete keep the leftovers selected. */
  onSelectionChange?: (ids: Set<string>) => void;
  initialMovePath?: string;
  /** The rows currently listed; used to remember sizes so the delete confirmation can state the total. */
  files?: FileDTO[];
  /** The full result set behind the current page (same filters), fetched page by page for "Select all N matching". */
  matching?: { total: number; fetchPage: PageFetcher };
}

const plural = (n: number) => `${formatNumber(n)} ${n === 1 ? 'file' : 'files'}`;

/** Sticky action bar shown while files are selected. */
export function FileBulkBar({ selectedIds, onClear, onSelectionChange, initialMovePath, files, matching }: FileBulkBarProps) {
  const canDownload = usePermission('files.download');
  const canManage = usePermission('files.manage');
  const canDelete = usePermission('files.delete');
  const qc = useQueryClient();
  const invalidate = useInvalidateFiles();
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [selecting, setSelecting] = React.useState<{ found: number; total: number } | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const ids = React.useMemo(() => Array.from(selectedIds), [selectedIds]);
  const n = ids.length;

  // id → size for everything we've seen (selection can span pages), so the confirmation can state the total size.
  const sizes = React.useRef(new Map<string, number>());
  const totalBytes = React.useMemo(() => {
    if (files) for (const f of files) sizes.current.set(f.id, f.size);
    let sum = 0;
    for (const id of ids) {
      const s = sizes.current.get(id);
      if (s === undefined) return null;
      sum += s;
    }
    return sum;
  }, [ids, files]);

  React.useEffect(() => {
    if (!deleteOpen) setProgress(null);
  }, [deleteOpen]);

  if (n === 0) return null;

  const canSelectAll = !!matching && !!onSelectionChange && matching.total > n;

  async function selectAll() {
    if (!matching || !onSelectionChange) return;
    setSelecting({ found: 0, total: matching.total });
    try {
      const all = await collectFiles(matching.fetchPage, { onProgress: (found, total) => setSelecting({ found, total }) });
      for (const f of all) sizes.current.set(f.id, f.size);
      onSelectionChange(new Set(all.map((f) => f.id)));
      toast.success(`Selected ${plural(all.length)}`);
    } catch (err) {
      toast.error("Couldn't select all matching files", { description: errorMessage(err) });
    } finally {
      setSelecting(null);
    }
  }

  async function download() {
    if (n === 1) {
      const a = document.createElement('a');
      a.href = downloadUrl(ids[0]!);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    setExporting(true);
    try {
      await api.post<ExportJobDTO>('/exports', { fileIds: ids });
      void qc.invalidateQueries({ queryKey: queryKeys.exports.list });
      openExportsTray();
      toast.success('Preparing your ZIP', { description: 'You can keep working. It will appear in Exports when it is ready.' });
    } catch (err) {
      toast.error("Couldn't start the export", { description: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  }

  async function remove() {
    const res = await deleteFileIds(ids, (done, total) => setProgress({ done, total }));
    if (res.deleted.length > 0) invalidate();
    if (res.error) {
      const gone = new Set(res.deleted);
      if (gone.size > 0) onSelectionChange?.(new Set(ids.filter((id) => !gone.has(id))));
      setProgress(null);
      toast.error(gone.size > 0 ? `Deleted ${formatNumber(gone.size)} of ${plural(n)} before an error` : "Couldn't delete files", { description: errorMessage(res.error) });
      throw res.error; // keeps the dialog open so the remaining files can be retried
    }
    toast.success(`Deleted ${plural(n)}`);
    onClear();
  }

  return (
    <>
      <div role="region" aria-label="Bulk actions" className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border-strong bg-surface px-3 py-2 shadow-lg animate-pop-in">
        <span className="px-1 text-sm font-medium tabular-nums text-fg" aria-live="polite">
          {formatNumber(n)} selected{totalBytes !== null && n > 1 ? <span className="font-normal text-fg-subtle"> · {formatBytes(totalBytes)}</span> : null}
        </span>
        {canSelectAll && matching && (
          <Button size="sm" variant="ghost" className="text-primary hover:text-primary" onClick={() => void selectAll()} loading={!!selecting}>
            {!selecting && <ListChecks aria-hidden />}
            {selecting ? `Selecting… ${formatNumber(selecting.found)} / ${formatNumber(selecting.total)}` : `Select all ${formatNumber(matching.total)} matching`}
          </Button>
        )}
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
        {canDownload && (
          <Button size="sm" variant="outline" onClick={download} loading={exporting} disabled={!!selecting}>
            <Download aria-hidden /> {n === 1 ? 'Download' : 'Download as ZIP'}
          </Button>
        )}
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setMoveOpen(true)} disabled={!!selecting}>
            <FolderInput aria-hidden /> Move
          </Button>
        )}
        {canDelete && (
          <Button size="sm" variant="outline" className="text-danger hover:text-danger" onClick={() => setDeleteOpen(true)} disabled={!!selecting}>
            <Trash2 aria-hidden /> Delete
          </Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear} disabled={!!selecting}>
          <X aria-hidden /> Clear
        </Button>
      </div>
      <MoveFilesDialog open={moveOpen} onOpenChange={setMoveOpen} fileIds={ids} initialPath={initialMovePath} onMoved={onClear} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${plural(n)}?`}
        description={
          <>
            <span className="block">This permanently deletes {plural(n)}{totalBytes !== null ? ` (${formatBytes(totalBytes)})` : ''}. This can&apos;t be undone.</span>
            {progress && (
              <span className="mt-3 block" role="status">
                <span className="block h-1.5 overflow-hidden rounded-full bg-surface-muted">
                  <span className="block h-full rounded-full bg-danger-solid transition-[width] duration-150" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                </span>
                <span className="mt-1 block text-xs tabular-nums text-fg-subtle">Deleted {formatNumber(progress.done)} of {formatNumber(progress.total)}…</span>
              </span>
            )}
          </>
        }
        confirmLabel={n === 1 ? 'Delete file' : `Delete ${formatNumber(n)} files`}
        destructive
        onConfirm={remove}
      />
    </>
  );
}
