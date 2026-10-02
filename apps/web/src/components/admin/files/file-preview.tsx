'use client';

import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Info, Loader2, Maximize2, Minimize2, X } from 'lucide-react';
import { formatBytes, type FileDTO } from '@scenox/shared';
import { usePermission } from '@/lib/hooks/use-me';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { downloadUrl, FileTypeIcon, inlineUrl, previewKind, type PreviewKind } from './file-utils';

export interface FilePreviewProps {
  /** The files currently listed; ← / → move through them. */
  files: FileDTO[];
  /** Id of the file being previewed, or null when closed. */
  fileId: string | null;
  onFileChange: (id: string) => void;
  onClose: () => void;
  /** Opens the details dialog for the current file (the preview stays open underneath). */
  onOpenDetails: (file: FileDTO) => void;
}

const ghostOnDark = 'text-zinc-200 hover:bg-white/10 hover:text-white';

function location(f: FileDTO): string {
  return [f.clientName, f.portalName, f.relativePath].filter(Boolean).join(' / ');
}

/** Full-screen lightbox. Only the current file renders media; nothing else is preloaded. */
export function FilePreview({ files, fileId, onFileChange, onClose, onOpenDetails }: FilePreviewProps) {
  const canDownload = usePermission('files.download');
  const index = fileId ? files.findIndex((f) => f.id === fileId) : -1;
  const file = index >= 0 ? files[index]! : null;
  const [zoomed, setZoomed] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);

  // The listed file vanished (deleted / list refreshed): close rather than show a stale item.
  React.useEffect(() => {
    if (fileId && index < 0) onClose();
  }, [fileId, index, onClose]);
  React.useEffect(() => setZoomed(false), [fileId]);

  const prev = index > 0 ? files[index - 1] : undefined;
  const next = index >= 0 && index < files.length - 1 ? files[index + 1] : undefined;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const el = e.target as HTMLElement;
    // Let media controls and form fields keep their own arrow-key behaviour (seeking, volume…).
    if (['VIDEO', 'AUDIO', 'INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    if (e.key === 'ArrowLeft' && prev) {
      e.preventDefault();
      onFileChange(prev.id);
    } else if (e.key === 'ArrowRight' && next) {
      e.preventDefault();
      onFileChange(next.id);
    }
  }

  const kind: PreviewKind = file ? previewKind(file) : 'none';
  const ready = file?.status === 'ready';
  const showMedia = !!file && ready && canDownload && kind !== 'none';

  return (
    <DialogPrimitive.Root open={!!file} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-zinc-950/95 animate-fade-in" />
        <DialogPrimitive.Content
          ref={contentRef}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            // Focus the viewer itself so ← / → work immediately.
            e.preventDefault();
            contentRef.current?.focus();
          }}
          className="fixed inset-0 z-50 flex flex-col text-white outline-none animate-fade-in"
        >
          {file && (
            <>
              <header className="flex items-center gap-2 border-b border-white/10 bg-black/40 px-3 py-2 sm:gap-3 sm:px-4">
                <FileTypeIcon extension={file.extension} className="hidden size-5 shrink-0 text-zinc-400 sm:block" />
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="truncate text-sm font-medium" title={file.name}>{file.name}</DialogPrimitive.Title>
                  <DialogPrimitive.Description className="truncate text-xs tabular-nums text-zinc-400" title={location(file)}>
                    {location(file) ? `${location(file)} · ` : ''}{formatBytes(file.size)}
                  </DialogPrimitive.Description>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-zinc-400" aria-label={`File ${index + 1} of ${files.length}`}>
                  {index + 1} / {files.length}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {showMedia && kind === 'image' && (
                    <Button variant="ghost" size="sm" className={ghostOnDark} onClick={() => setZoomed((z) => !z)} aria-pressed={zoomed} aria-label={zoomed ? 'Fit to screen' : 'View at 100%'}>
                      {zoomed ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
                      <span className="hidden md:inline">{zoomed ? 'Fit' : '100%'}</span>
                    </Button>
                  )}
                  {canDownload && ready && (
                    <Button variant="ghost" size="sm" className={ghostOnDark} asChild>
                      <a href={downloadUrl(file.id)} aria-label={`Download ${file.name}`}>
                        <Download aria-hidden /> <span className="hidden md:inline">Download</span>
                      </a>
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className={ghostOnDark} onClick={() => onOpenDetails(file)} aria-label="Details">
                    <Info aria-hidden /> <span className="hidden md:inline">Details</span>
                  </Button>
                  <DialogPrimitive.Close asChild>
                    <Button variant="ghost" size="sm" className={ghostOnDark} aria-label="Close preview">
                      <X aria-hidden /> <span className="hidden md:inline">Close</span>
                    </Button>
                  </DialogPrimitive.Close>
                </div>
              </header>

              <div className="relative min-h-0 flex-1">
                {showMedia ? (
                  <PreviewBody key={file.id} file={file} kind={kind} zoomed={zoomed} onToggleZoom={() => setZoomed((z) => !z)} onBackdropClick={onClose} />
                ) : (
                  <Unavailable file={file} kind={kind} canDownload={canDownload} />
                )}
                {prev && <NavButton side="left" label={`Previous file: ${prev.name}`} onClick={() => onFileChange(prev.id)} />}
                {next && <NavButton side="right" label={`Next file: ${next.name}`} onClick={() => onFileChange(next.id)} />}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function NavButton({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'absolute top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white shadow-md backdrop-blur transition-colors duration-150 hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:size-11',
        side === 'left' ? 'left-2 sm:left-4' : 'right-2 sm:right-4',
      )}
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}

function LoadingOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
      <Loader2 className="size-8 animate-spin text-zinc-400" aria-hidden />
      <span className="sr-only">Loading preview</span>
    </div>
  );
}

/** Renders the media for one file. Remounted (keyed by id) on every navigation, so state never leaks between files. */
function PreviewBody({
  file, kind, zoomed, onToggleZoom, onBackdropClick,
}: { file: FileDTO; kind: PreviewKind; zoomed: boolean; onToggleZoom: () => void; onBackdropClick: () => void }) {
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const src = inlineUrl(file.id);

  // An image served from cache can finish before React attaches onLoad.
  React.useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) setLoaded(true);
  }, []);

  if (failed) return <Unavailable file={file} kind="none" canDownload error />;

  const onLoad = () => setLoaded(true);
  const onError = () => setFailed(true);
  const backdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onBackdropClick();
  };

  if (kind === 'image') {
    return (
      <div className={cn('absolute inset-0 flex p-3 sm:p-8', zoomed ? 'overflow-auto' : 'items-center justify-center')} onClick={backdrop}>
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin stream, not an optimisable static asset */}
        <img
          ref={imgRef}
          src={src}
          alt={file.name}
          draggable={false}
          onLoad={onLoad}
          onError={onError}
          onClick={onToggleZoom}
          className={cn(
            'select-none rounded-sm shadow-lg transition-opacity duration-150',
            loaded ? 'opacity-100' : 'opacity-0',
            zoomed ? 'm-auto max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain',
          )}
        />
        {!loaded && <LoadingOverlay />}
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-3 sm:p-8" onClick={backdrop}>
        <video
          src={src}
          controls
          autoPlay
          playsInline
          preload="metadata"
          aria-label={file.name}
          onLoadedMetadata={onLoad}
          onError={onError}
          className="max-h-full max-w-full rounded-md bg-black shadow-lg"
        />
        {!loaded && <LoadingOverlay />}
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-4" onClick={backdrop}>
        <div className="flex w-full max-w-xl flex-col items-center gap-5 rounded-xl border border-white/10 bg-white/5 p-6 sm:p-8">
          <FileTypeIcon extension={file.extension} className="size-12 text-zinc-400" />
          <p className="max-w-full truncate text-sm font-medium" title={file.name}>{file.name}</p>
          <audio src={src} controls autoPlay preload="metadata" aria-label={file.name} onLoadedMetadata={onLoad} onError={onError} className="w-full" />
        </div>
      </div>
    );
  }

  // pdf | text
  return (
    <div className="absolute inset-0 sm:p-3">
      <iframe
        src={src}
        title={`Preview of ${file.name}`}
        onLoad={onLoad}
        className={cn('size-full border-0 bg-white sm:rounded-md', kind === 'text' && 'bg-zinc-100')}
      />
      {!loaded && <LoadingOverlay />}
    </div>
  );
}

/** Friendly fallback: unsupported type, load failure, or a file that isn't ready / is quarantined. */
function Unavailable({ file, kind, canDownload, error }: { file: FileDTO; kind: PreviewKind; canDownload: boolean; error?: boolean }) {
  const quarantined = file.status === 'quarantined';
  const ready = file.status === 'ready';

  let title = "Preview isn't available for this file type";
  let body: React.ReactNode = 'Download the file to open it in an app that supports this format.';
  if (quarantined) {
    title = 'This file is quarantined';
    body = file.scanResult ? `${file.scanResult}. It can't be previewed or downloaded.` : "It was flagged during the security scan, so it can't be previewed or downloaded.";
  } else if (!ready) {
    title = 'This file isn’t ready to preview';
    body = 'Files can be previewed once their upload has finished and been processed.';
  } else if (!canDownload) {
    title = 'Preview unavailable';
    body = "You don't have permission to view or download file contents.";
  } else if (error) {
    title = "Preview couldn't be loaded";
    body = "The file couldn't be displayed in the browser. You can still download it.";
  } else if (kind !== 'none') {
    body = 'Download the file to view it.';
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-auto p-4">
      <div role={quarantined ? 'alert' : undefined} className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-white/10 bg-white/5 p-6 text-center sm:p-8">
        <div className={cn('flex size-14 items-center justify-center rounded-full border', quarantined ? 'border-red-400/40 bg-red-500/10 text-red-300' : 'border-white/10 bg-white/5 text-zinc-300')}>
          {quarantined ? <AlertTriangle className="size-7" aria-hidden /> : <FileTypeIcon extension={file.extension} className="size-7" />}
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-zinc-400">{body}</p>
        </div>
        <div className="w-full min-w-0 rounded-lg bg-black/30 px-3 py-2 text-left">
          <p className="truncate text-sm font-medium" title={file.name}>{file.name}</p>
          <p className="text-xs tabular-nums text-zinc-400">{formatBytes(file.size)}{file.extension ? ` · .${file.extension.toLowerCase()}` : ''}</p>
        </div>
        {!ready && <StatusBadge kind="file" status={file.status} />}
        {ready && canDownload && (
          <Button asChild>
            <a href={downloadUrl(file.id)}>
              <Download aria-hidden /> Download
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
