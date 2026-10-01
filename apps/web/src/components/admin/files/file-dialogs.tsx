'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FileDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';

/** Refresh everything that depends on file data after a mutation. */
export function useInvalidateFiles() {
  const qc = useQueryClient();
  return React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: queryKeys.files.all });
    void qc.invalidateQueries({ queryKey: queryKeys.clients.all });
    void qc.invalidateQueries({ queryKey: queryKeys.portals.all });
    void qc.invalidateQueries({ queryKey: queryKeys.dashboard });
    void qc.invalidateQueries({ queryKey: queryKeys.storage });
  }, [qc]);
}

export function RenameFileDialog({ file, onOpenChange }: { file: FileDTO | null; onOpenChange: (open: boolean) => void }) {
  const invalidate = useInvalidateFiles();
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    if (file) {
      setName(file.name);
      setError(undefined);
    }
  }, [file]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const trimmed = name.trim();
    if (!trimmed) return setError('Enter a file name');
    if (/[\\/]/.test(trimmed)) return setError('A file name can’t contain slashes');
    setBusy(true);
    try {
      await api.patch<FileDTO>(`/files/${file.id}`, { name: trimmed });
      toast.success('File renamed');
      invalidate();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!file} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>Changes the name shown in the vault. The stored data is not touched.</DialogDescription>
          </DialogHeader>
          <Field label="File name" error={error} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" loading={busy}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MoveFilesDialog({
  open, onOpenChange, fileIds, initialPath = '', onMoved,
}: { open: boolean; onOpenChange: (open: boolean) => void; fileIds: string[]; initialPath?: string; onMoved?: () => void }) {
  const invalidate = useInvalidateFiles();
  const [path, setPath] = React.useState(initialPath);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setPath(initialPath);
  }, [open, initialPath]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const clean = path.split('/').map((s) => s.trim()).filter(Boolean).join('/');
    setBusy(true);
    try {
      await api.post('/files/move', { fileIds, relativePath: clean });
      toast.success(`Moved ${fileIds.length} ${fileIds.length === 1 ? 'file' : 'files'}`, { description: clean ? `To ${clean}` : 'To the portal root' });
      invalidate();
      onMoved?.();
      onOpenChange(false);
    } catch (err) {
      toast.error("Couldn't move files", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Move {fileIds.length === 1 ? 'file' : `${fileIds.length} files`}</DialogTitle>
            <DialogDescription>Choose a folder inside the same portal. Missing folders are created automatically.</DialogDescription>
          </DialogHeader>
          <Field label="Folder path" hint="Use / to separate folders, e.g. Photos/2025. Leave empty for the portal root.">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Photos/2025" autoFocus autoComplete="off" spellCheck={false} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" loading={busy}>Move</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
