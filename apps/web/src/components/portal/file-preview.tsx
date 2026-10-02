'use client';

import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { ChevronLeft, ChevronRight, EyeOff, Folder, Loader2, MessageSquare, X } from 'lucide-react';
import { formatBytes, type ClientFileDTO } from '@scenox/shared';
import { previewKind, previewUrl } from '@/lib/portal/preview';
import { cn } from '@/lib/utils';
import { categoryMeta } from './file-types';
import { usePortal } from './portal-context';

const iconBtn =
  'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors duration-150 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:pointer-events-none disabled:opacity-30';

/** Full-screen dark viewer. `files` is the list that was on screen when it opened; ←/→ move through it. */
export function FilePreview({
  files, index, onIndexChange, onClose,
}: {
  files: ClientFileDTO[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  const { token, canMessage, openFileComments } = usePortal();
  const file = files[index];
  const count = files.length;
  const contentRef = React.useRef<HTMLDivElement>(null);

  const go = React.useCallback((i: number) => i >= 0 && i < count && onIndexChange(i), [count, onIndexChange]);

  if (!file) return null;
  const meta = categoryMeta(file.type);
  const kind = previewKind(file);

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-zinc-950 animate-fade-in" />
        <DialogPrimitive.Content
          ref={contentRef}
          tabIndex={-1}
          aria-describedby="file-preview-help"
          onOpenAutoFocus={(e) => {
            // focus the viewer itself so the arrow keys work straight away
            e.preventDefault();
            contentRef.current?.focus();
          }}
          onKeyDown={(e) => {
            if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            const t = e.target as HTMLElement;
            // let media controls / form fields keep their own arrow-key behaviour (seeking, caret…)
            if (t.closest('video, audio, input, textarea, select, [contenteditable="true"]')) return;
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              go(index - 1);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              go(index + 1);
            }
          }}
          className="fixed inset-0 z-50 flex flex-col text-white outline-none animate-fade-in"
        >
          <p id="file-preview-help" className="sr-only">Use the left and right arrow keys to move between files. Press Escape to close.</p>

          <header className="flex items-center gap-2 border-b border-white/10 bg-zinc-950/80 px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:gap-3 sm:px-5">
            <span aria-hidden className="hidden size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white/80 sm:flex">
              <meta.icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-sm font-semibold" title={file.name}>{file.name}</DialogPrimitive.Title>
              <p className="flex min-w-0 items-center gap-1.5 text-xs tabular-nums text-white/60">
                <Folder aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{file.relativePath || 'All files'}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{formatBytes(file.size)}</span>
              </p>
            </div>
            {count > 1 && (
              <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium tabular-nums text-white/80" aria-label={`File ${index + 1} of ${count}`}>
                {index + 1} / {count}
              </span>
            )}
            {canMessage && (
              <button
                type="button" onClick={() => openFileComments(file)}
                aria-label={file.commentCount > 0 ? `Comments on ${file.name}, ${file.commentCount}` : `Add a comment on ${file.name}`}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium text-white/80 transition-colors duration-150 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <MessageSquare aria-hidden className="size-4" />
                <span className="hidden sm:inline">Comments</span>
                {file.commentCount > 0 && <span className="text-xs tabular-nums">{file.commentCount}</span>}
              </button>
            )}
            <DialogPrimitive.Close aria-label="Close preview" className={iconBtn}>
              <X aria-hidden className="size-5" />
            </DialogPrimitive.Close>
          </header>

          <div
            className="relative flex min-h-0 flex-1 items-center justify-center px-2 py-3 sm:px-16 sm:py-5"
            onClick={(e) => e.target === e.currentTarget && onClose()}
          >
            {count > 1 && (
              <>
                <button type="button" aria-label="Previous file" disabled={index === 0} onClick={() => go(index - 1)} className={cn(iconBtn, 'absolute left-1.5 top-1/2 z-10 -translate-y-1/2 bg-black/50 sm:left-3 sm:size-11')}>
                  <ChevronLeft aria-hidden className="size-6" />
                </button>
                <button type="button" aria-label="Next file" disabled={index === count - 1} onClick={() => go(index + 1)} className={cn(iconBtn, 'absolute right-1.5 top-1/2 z-10 -translate-y-1/2 bg-black/50 sm:right-3 sm:size-11')}>
                  <ChevronRight aria-hidden className="size-6" />
                </button>
              </>
            )}
            {/* only the current file is ever rendered; the key resets load/error state when it changes */}
            <Stage key={file.id} file={file} kind={kind} src={kind ? previewUrl(token, file.id) : ''} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Stage({ file, kind, src }: { file: ClientFileDTO; kind: ReturnType<typeof previewKind>; src: string }) {
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const ready = () => setState('ready');
  const failed = () => setState('error');

  if (!kind || state === 'error') return <Unavailable file={file} />;

  const spinner = state === 'loading' && (
    <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/70">
      <Loader2 aria-hidden className="size-8 animate-spin" />
      <span className="sr-only">Loading preview</span>
    </div>
  );

  switch (kind) {
    case 'image':
      return (
        <div className="relative flex size-full items-center justify-center">
          {spinner}
          <img
            src={src} alt={file.name} decoding="async" onLoad={ready} onError={failed}
            className={cn('max-h-full max-w-full select-none object-contain transition-opacity duration-150', state === 'ready' ? 'opacity-100' : 'opacity-0')}
          />
        </div>
      );
    case 'video':
      return (
        <div className="relative flex size-full items-center justify-center">
          {spinner}
          <video
            src={src} controls autoPlay playsInline preload="metadata" aria-label={file.name} onLoadedMetadata={ready} onError={failed}
            className="max-h-full max-w-full rounded-md bg-black"
          />
        </div>
      );
    case 'audio':
      return (
        <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-xl border border-white/10 bg-white/5 p-6 text-center">
          <span aria-hidden className="flex size-16 items-center justify-center rounded-2xl bg-white/10 text-white/80">
            {React.createElement(categoryMeta('audio').icon, { className: 'size-7' })}
          </span>
          <div className="min-w-0 max-w-full">
            <p className="truncate text-sm font-semibold" title={file.name}>{file.name}</p>
            <p className="text-xs tabular-nums text-white/60">{formatBytes(file.size)}</p>
          </div>
          <audio src={src} controls autoPlay preload="metadata" aria-label={file.name} onError={failed} className="w-full" />
        </div>
      );
    case 'pdf':
    case 'text':
      return (
        <div className={cn('relative size-full', kind === 'text' && 'max-w-4xl')}>
          {spinner}
          <iframe
            src={src} title={file.name} onLoad={ready}
            // text is untrusted: lock it down. PDFs need the browser's viewer, so they can't be sandboxed.
            {...(kind === 'text' ? { sandbox: '' } : {})}
            className="size-full rounded-md border-0 bg-white"
          />
        </div>
      );
  }
}

function Unavailable({ file }: { file: ClientFileDTO }) {
  const meta = categoryMeta(file.type);
  const processing = file.status !== 'ready';
  return (
    <div role="status" className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-white/10 bg-white/5 p-8 text-center">
      <span aria-hidden className="relative flex size-16 items-center justify-center rounded-2xl bg-white/10 text-white/80">
        <meta.icon className="size-7" />
        <EyeOff className="absolute -bottom-1.5 -right-1.5 size-6 rounded-full bg-zinc-950 p-1 text-white/70" />
      </span>
      <div className="flex min-w-0 max-w-full flex-col gap-1">
        <p className="text-base font-semibold">{processing ? 'This file is still being processed' : 'Preview isn’t available for this file type'}</p>
        <p className="text-sm text-white/60">{processing ? 'Try again in a moment.' : `${meta.label} files like this can’t be shown in the browser.`}</p>
      </div>
      <div className="min-w-0 max-w-full rounded-lg bg-white/5 px-3 py-2">
        <p className="truncate text-sm font-medium" title={file.name}>{file.name}</p>
        <p className="text-xs tabular-nums text-white/60">{formatBytes(file.size)}</p>
      </div>
    </div>
  );
}
