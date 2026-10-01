'use client';

import * as React from 'react';
import { FolderUp, Loader2, UploadCloud, X } from 'lucide-react';
import { formatBytes, formatNumber } from '@scenox/shared';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { filesFromFileList, supportsFolderPicker, type PickedFile } from '@/lib/upload';

export interface DropzoneHandle {
  openFiles(): void;
  openFolder(): void;
}

export interface DropzoneProps {
  allowFolders: boolean;
  onPick: (files: PickedFile[]) => void;
  scanning?: { found: number } | null;
  onCancelScan?: () => void;
  maxFileSizeBytes?: number | null;
  allowedExtensions?: string[] | null;
  compact?: boolean;
  className?: string;
}

function useFolderSupport(allowFolders: boolean) {
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => setOk(allowFolders && supportsFolderPicker()), [allowFolders]);
  return ok;
}

/** Just the (visually hidden) file / folder inputs, for "Add files" buttons elsewhere on the page. */
export const HiddenPickers = React.forwardRef<DropzoneHandle, { allowFolders: boolean; onPick: (files: PickedFile[]) => void }>(function HiddenPickers({ allowFolders, onPick }, ref) {
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);
  const folderOk = useFolderSupport(allowFolders);
  React.useImperativeHandle(ref, () => ({ openFiles: () => fileInput.current?.click(), openFolder: () => (folderOk ? folderInput.current : fileInput.current)?.click() }), [folderOk]);
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = filesFromFileList(e.target.files);
    e.target.value = '';
    onPick(picked);
  };
  return (
    <>
      <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={handle} />
      {folderOk && <input ref={folderInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={handle} {...({ webkitdirectory: '' } as Record<string, string>)} />}
    </>
  );
});

export const Dropzone = React.forwardRef<DropzoneHandle, DropzoneProps>(function Dropzone(
  { allowFolders, onPick, scanning, onCancelScan, maxFileSizeBytes, allowedExtensions, compact, className },
  ref,
) {
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);
  const folderOk = useFolderSupport(allowFolders);

  React.useImperativeHandle(ref, () => ({ openFiles: () => fileInput.current?.click(), openFolder: () => (folderOk ? folderInput.current : fileInput.current)?.click() }), [folderOk]);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = filesFromFileList(e.target.files);
    e.target.value = ''; // allow re-selecting the same files
    onPick(picked);
  };

  const hint = [
    allowedExtensions?.length ? `Accepted: ${allowedExtensions.slice(0, 8).map((x) => x.toUpperCase()).join(', ')}${allowedExtensions.length > 8 ? '…' : ''}` : 'Any file type',
    maxFileSizeBytes ? `up to ${formatBytes(maxFileSizeBytes)} per file` : 'any size',
  ].join(' · ');

  return (
    <div
      className={cn(
        'group relative flex flex-col items-center gap-5 rounded-xl border-2 border-dashed border-border-strong bg-surface px-5 text-center transition-colors duration-150 hover:border-primary/50 hover:bg-primary-soft/40',
        compact ? 'py-6' : 'py-12 sm:py-16',
        className,
      )}
      onClick={(e) => {
        if (scanning) return;
        if ((e.target as HTMLElement).closest('button')) return;
        fileInput.current?.click();
      }}
    >
      <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={handle} />
      {folderOk && (
        <input
          ref={folderInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={handle}
          {...({ webkitdirectory: '' } as Record<string, string>)}
        />
      )}
      <div className={cn('flex items-center justify-center rounded-full bg-primary-soft text-primary', compact ? 'size-11' : 'size-16')} aria-hidden>
        {scanning ? <Loader2 className="size-6 animate-spin" /> : <UploadCloud className={compact ? 'size-5' : 'size-8'} />}
      </div>
      {scanning ? (
        <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
          <p className="text-lg font-semibold text-fg">Scanning folder… <span className="tabular-nums">{formatNumber(scanning.found)}</span> files</p>
          <p className="text-sm text-fg-muted">Large folders can take a moment. You can keep this tab open.</p>
          {onCancelScan && (
            <Button variant="outline" size="sm" onClick={onCancelScan}>
              <X aria-hidden /> Stop scanning
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <p className={cn('font-semibold tracking-tight text-fg', compact ? 'text-base' : 'text-lg sm:text-xl')}>
              {folderOk ? 'Drag & drop files or folders here' : 'Drag & drop files here'}
            </p>
            <p className="text-sm text-fg-muted">or choose them from your device</p>
          </div>
          <div className="flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row">
            <Button size="lg" onClick={() => fileInput.current?.click()} className="sm:min-w-40">
              Browse files
            </Button>
            {folderOk && (
              <Button size="lg" variant="outline" onClick={() => folderInput.current?.click()} className="sm:min-w-40">
                <FolderUp aria-hidden /> Browse folder
              </Button>
            )}
          </div>
          {!compact && <p className="text-xs text-fg-subtle">{hint}</p>}
        </>
      )}
    </div>
  );
});

/** Full-window drag & drop. Returns whether files are being dragged over the window. */
export function useWindowDrop(enabled: boolean, onDrop: (dt: DataTransfer) => void): boolean {
  const [dragging, setDragging] = React.useState(false);
  const depth = React.useRef(0);
  const cb = React.useRef(onDrop);
  cb.current = onDrop;

  React.useEffect(() => {
    if (!enabled) {
      depth.current = 0;
      setDragging(false);
      return;
    }
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // required to allow dropping
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (e.dataTransfer) cb.current(e.dataTransfer);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);

  return dragging;
}

export function DragOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex animate-fade-in items-center justify-center bg-primary-soft/90 p-6 backdrop-blur-sm" aria-hidden>
      <div className="flex w-full max-w-xl flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-primary bg-surface px-8 py-14 text-center shadow-lg">
        <div className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <UploadCloud className="size-8" />
        </div>
        <p className="text-xl font-semibold tracking-tight text-fg">Drop to add your files</p>
        <p className="text-sm text-fg-muted">Folders are welcome too</p>
      </div>
    </div>
  );
}
