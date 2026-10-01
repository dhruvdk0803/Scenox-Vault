'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FolderInput, Trash2, X } from 'lucide-react';
import type { ExportJobDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toaster';
import { openExportsTray } from './exports-tray';
import { MoveFilesDialog, useInvalidateFiles } from './file-dialogs';
import { downloadUrl } from './file-utils';

/** Sticky action bar shown while files are selected. */
export function FileBulkBar({ selectedIds, onClear, initialMovePath }: { selectedIds: ReadonlySet<string>; onClear: () => void; initialMovePath?: string }) {
  const canDownload = usePermission('files.download');
  const canManage = usePermission('files.manage');
  const canDelete = usePermission('files.delete');
  const qc = useQueryClient();
  const invalidate = useInvalidateFiles();
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const ids = React.useMemo(() => Array.from(selectedIds), [selectedIds]);
  const n = ids.length;
  if (n === 0) return null;

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
    try {
      await api.post('/files/delete', { fileIds: ids });
      toast.success(`Deleted ${n} ${n === 1 ? 'file' : 'files'}`);
      invalidate();
      onClear();
    } catch (err) {
      toast.error("Couldn't delete files", { description: errorMessage(err) });
      throw err;
    }
  }

  return (
    <>
      <div role="region" aria-label="Bulk actions" className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border-strong bg-surface px-3 py-2 shadow-lg animate-pop-in">
        <span className="px-1 text-sm font-medium tabular-nums text-fg">{n} selected</span>
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
        {canDownload && (
          <Button size="sm" variant="outline" onClick={download} loading={exporting}>
            <Download aria-hidden /> {n === 1 ? 'Download' : 'Download as ZIP'}
          </Button>
        )}
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setMoveOpen(true)}>
            <FolderInput aria-hidden /> Move
          </Button>
        )}
        {canDelete && (
          <Button size="sm" variant="outline" className="text-danger hover:text-danger" onClick={() => setDeleteOpen(true)}>
            <Trash2 aria-hidden /> Delete
          </Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
          <X aria-hidden /> Clear
        </Button>
      </div>
      <MoveFilesDialog open={moveOpen} onOpenChange={setMoveOpen} fileIds={ids} initialPath={initialMovePath} onMoved={onClear} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${n} ${n === 1 ? 'file' : 'files'}?`}
        description="The selected files will be permanently removed from the vault. This can't be undone."
        confirmLabel="Delete files"
        destructive
        onConfirm={remove}
      />
    </>
  );
}
