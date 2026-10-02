'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatBytes, formatNumber, type UploadSessionDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toaster';

/** Confirms and performs DELETE /api/uploads/:id (cancels transfers, removes the upload and all of its files). */
export function DeleteUploadDialog({
  session, onOpenChange, onDeleted,
}: { session: UploadSessionDTO | null; onOpenChange: (open: boolean) => void; onDeleted?: (id: string) => void }) {
  const qc = useQueryClient();
  // Keep the last session so the copy doesn't blank out while the dialog animates away.
  const last = React.useRef<UploadSessionDTO | null>(null);
  if (session) last.current = session;
  const s = session ?? last.current;

  async function remove() {
    if (!session) return;
    try {
      await api.delete(`/uploads/${session.id}`);
    } catch (err) {
      toast.error("Couldn't delete the upload", { description: errorMessage(err) });
      throw err;
    }
    toast.success('Upload deleted', { description: `${formatNumber(session.totalFiles)} ${session.totalFiles === 1 ? 'file' : 'files'} removed` });
    // Let the owner of the open session close it first, so nothing refetches a session that no longer exists.
    onDeleted?.(session.id);
    qc.removeQueries({ queryKey: queryKeys.uploads.detail(session.id) });
    void qc.invalidateQueries({ queryKey: queryKeys.uploads.all });
    void qc.invalidateQueries({ queryKey: queryKeys.files.all });
    void qc.invalidateQueries({ queryKey: queryKeys.clients.all });
    void qc.invalidateQueries({ queryKey: queryKeys.portals.all });
    void qc.invalidateQueries({ queryKey: queryKeys.dashboard });
    void qc.invalidateQueries({ queryKey: queryKeys.storage });
  }

  return (
    <ConfirmDialog
      open={!!session}
      onOpenChange={onOpenChange}
      title="Delete this upload?"
      description={
        s
          ? `Delete this upload and its ${formatNumber(s.totalFiles)} ${s.totalFiles === 1 ? 'file' : 'files'} (${formatBytes(s.totalBytes)})? In-progress transfers are cancelled. The client can upload again.`
          : undefined
      }
      confirmLabel="Delete upload"
      destructive
      onConfirm={remove}
    />
  );
}
