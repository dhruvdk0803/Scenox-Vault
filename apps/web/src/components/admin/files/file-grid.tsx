'use client';

import * as React from 'react';
import { Play } from 'lucide-react';
import { formatBytes, type FileDTO } from '@scenox/shared';
import { usePermission } from '@/lib/hooks/use-me';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { FileDetailsDialog } from './file-details-dialog';
import { FilePreview } from './file-preview';
import { FileTypeIcon, inlineUrl, previewKind, THUMBNAIL_MAX_BYTES } from './file-utils';

export interface FileGridProps {
  files: FileDTO[];
  loading?: boolean;
  selectedIds: ReadonlySet<string>;
  onSelectionChange: (ids: Set<string>) => void;
}

/** Thumbnail cards for the files in a folder. Images load lazily (originals ≤ 25 MB only); everything else shows a type icon. */
export function FileGrid({ files, loading, selectedIds, onSelectionChange }: FileGridProps) {
  const canDownload = usePermission('files.download');
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<FileDTO | null>(null);
  const closePreview = React.useCallback(() => setPreviewId(null), []);

  const allSelected = files.length > 0 && files.every((f) => selectedIds.has(f.id));
  const someSelected = !allSelected && files.some((f) => selectedIds.has(f.id));

  function toggle(id: string, on: boolean) {
    const next = new Set(selectedIds);
    if (on) next.add(id);
    else next.delete(id);
    onSelectionChange(next);
  }
  function toggleAll(on: boolean) {
    const next = new Set(selectedIds);
    for (const f of files) {
      if (on) next.add(f.id);
      else next.delete(f.id);
    }
    onSelectionChange(next);
  }

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-busy="true">
        {Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="aspect-[4/3]" />)}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
        <Checkbox
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onCheckedChange={(c) => toggleAll(c === true)}
          disabled={files.length === 0}
        />
        Select all on this page
      </label>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {files.map((f) => {
          const selected = selectedIds.has(f.id);
          return (
            <li
              key={f.id}
              data-state={selected ? 'selected' : undefined}
              className="group relative overflow-hidden rounded-lg border border-border bg-surface shadow-xs transition-colors duration-150 hover:border-border-strong data-[state=selected]:border-primary data-[state=selected]:bg-primary-soft"
            >
              <button
                type="button"
                onClick={() => (canDownload ? setPreviewId(f.id) : setDetail(f))}
                className="block w-full text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                aria-label={`${canDownload ? 'Preview' : 'View details for'} ${f.name}`}
              >
                <Thumb file={f} canLoad={canDownload} />
                <span className="block min-w-0 px-2.5 py-2">
                  <span className="block truncate text-sm font-medium text-fg" title={f.name}>{f.name}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums text-fg-subtle">
                    {formatBytes(f.size)}
                    {f.status !== 'ready' && <StatusBadge kind="file" status={f.status} />}
                  </span>
                </span>
              </button>
              <div
                className={cn(
                  'absolute left-2 top-2 rounded-sm bg-surface/90 p-1 shadow-xs backdrop-blur transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100',
                  selected || selectedIds.size > 0 ? 'opacity-100' : 'opacity-0 [@media(hover:none)]:opacity-100',
                )}
              >
                <Checkbox checked={selected} onCheckedChange={(c) => toggle(f.id, c === true)} aria-label={`Select ${f.name}`} />
              </div>
            </li>
          );
        })}
      </ul>
      <FilePreview files={files} fileId={previewId} onFileChange={setPreviewId} onClose={closePreview} onOpenDetails={setDetail} />
      <FileDetailsDialog fileId={detail?.id ?? null} initial={detail} onOpenChange={(o) => !o && setDetail(null)} />
    </div>
  );
}

function Thumb({ file, canLoad }: { file: FileDTO; canLoad: boolean }) {
  const [failed, setFailed] = React.useState(false);
  const kind = previewKind(file);
  const showImage = canLoad && kind === 'image' && file.status === 'ready' && file.size <= THUMBNAIL_MAX_BYTES && !failed;

  return (
    <span className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-surface-muted">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin stream, not an optimisable static asset
        <img
          src={inlineUrl(file.id)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover transition-transform duration-150 group-hover:scale-[1.02]"
        />
      ) : (
        <FileTypeIcon extension={file.extension} className="size-9 text-fg-subtle" />
      )}
      {kind === 'video' && file.status === 'ready' && (
        <span className="absolute bottom-2 right-2 flex size-6 items-center justify-center rounded-full bg-zinc-950/70 text-white" aria-hidden>
          <Play className="size-3 fill-current" />
        </span>
      )}
    </span>
  );
}
