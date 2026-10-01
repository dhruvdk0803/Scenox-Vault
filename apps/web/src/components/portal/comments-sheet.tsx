'use client';

import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { FolderOpen, X } from 'lucide-react';
import { formatBytes } from '@scenox/shared';
import { Button } from '@/components/ui';
import { categoryMeta } from './file-types';
import { MessageThread } from './message-thread';
import { usePortal, type FileRef } from './portal-context';
import { FileTile } from './ui-bits';

/** Side sheet (full-screen on phones) with the comment thread for one file. */
export function CommentsSheet({ file, onClose }: { file: FileRef | null; onClose: () => void }) {
  const { navigate, canViewFiles } = usePortal();
  // keep the last file around so the content doesn't blank out while the sheet unmounts
  const open = !!file;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-zinc-950/40 animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-lg animate-fade-in sm:max-w-md"
        >
          {file && (
            <>
              <div className="flex items-start gap-3 border-b border-border px-4 py-3.5 sm:px-5">
                <FileTile icon={categoryMeta(file.type ?? '').icon} />
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Comments</DialogPrimitive.Title>
                  <p className="truncate text-sm font-semibold text-fg" title={file.name}>{file.name}</p>
                  {(file.size != null || file.relativePath) && (
                    <p className="truncate text-xs tabular-nums text-fg-muted">
                      {file.size != null && formatBytes(file.size)}
                      {file.size != null && file.relativePath ? ' · ' : ''}
                      {file.relativePath ? `in ${file.relativePath}` : ''}
                    </p>
                  )}
                  {canViewFiles && file.relativePath !== undefined && (
                    <Button
                      variant="link" size="sm" className="mt-1 h-auto text-xs"
                      onClick={() => {
                        onClose();
                        navigate({ tab: 'files', path: file.relativePath ?? '', q: file.name });
                      }}
                    >
                      <FolderOpen aria-hidden /> Show in Files
                    </Button>
                  )}
                </div>
                <DialogPrimitive.Close
                  aria-label="Close comments"
                  className="-mr-1.5 rounded-md p-2 text-fg-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <X className="size-4" aria-hidden />
                </DialogPrimitive.Close>
              </div>
              <MessageThread
                fileId={file.id} autoFocusComposer placeholder="Add a comment on this file…" emptyTitle="No comments yet"
                emptyHint="Leave a note about this file for {team}."
              />
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
