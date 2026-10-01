'use client';

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, File as FileIcon, Folder, Plus, RotateCw, Trash2, X } from 'lucide-react';
import { formatBytes, formatNumber } from '@scenox/shared';
import { Button, Card, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { SelectedFile } from './use-selection';

type Row = { kind: 'folder'; path: string; count: number; bytes: number } | { kind: 'file'; item: SelectedFile };

const ROW_H = 44;

/** Group by folder (folders alphabetical, root files first), flattened for virtualization. */
export function buildRows(items: SelectedFile[]): Row[] {
  const groups = new Map<string, SelectedFile[]>();
  for (const it of items) {
    const g = groups.get(it.relativePath);
    if (g) g.push(it);
    else groups.set(it.relativePath, [it]);
  }
  const paths = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, undefined, { numeric: true })));
  const rows: Row[] = [];
  for (const path of paths) {
    const files = groups.get(path)!.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (path !== '' || paths.length > 1) rows.push({ kind: 'folder', path, count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) });
    for (const item of files) rows.push({ kind: 'file', item });
  }
  return rows;
}

export interface SelectionReviewProps {
  items: SelectedFile[];
  totalBytes: number;
  busy: null | { label: string };
  error?: string | null;
  resumeMatches?: number;
  onRemove: (id: number) => void;
  onRemoveFolder: (path: string) => void;
  onClear: () => void;
  onAddMore: () => void;
  onUpload: () => void;
}

export function SelectionReview({ items, totalBytes, busy, error, resumeMatches = 0, onRemove, onRemoveFolder, onClear, onAddMore, onUpload }: SelectionReviewProps) {
  const rows = React.useMemo(() => buildRows(items), [items]);
  const parent = React.useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => ROW_H, overscan: 10 });
  const uploadLabel = `Upload ${formatBytes(totalBytes)}`;

  return (
    <Card className="animate-fade-in overflow-hidden shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex flex-col">
          <span className="text-base font-semibold text-fg tabular-nums">
            {formatNumber(items.length)} {items.length === 1 ? 'file' : 'files'} · {formatBytes(totalBytes)}
          </span>
          {resumeMatches > 0 && (
            <span className="text-xs text-success">
              {formatNumber(resumeMatches)} {resumeMatches === 1 ? 'file' : 'files'} will continue where you left off
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onAddMore} disabled={!!busy}>
            <Plus aria-hidden /> Add more
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={!!busy}>
            <Trash2 aria-hidden /> Clear
          </Button>
        </div>
      </div>

      <div ref={parent} className="max-h-[min(50vh,420px)] overflow-auto" role="list" aria-label="Selected files">
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((v) => {
            const row = rows[v.index]!;
            return (
              <div key={v.key} role="listitem" className="absolute inset-x-0" style={{ height: v.size, transform: `translateY(${v.start}px)` }}>
                {row.kind === 'folder' ? (
                  <div className="flex h-full items-center gap-2 bg-surface-muted/70 px-4 text-sm font-medium text-fg sm:px-5">
                    <Folder aria-hidden className="size-4 shrink-0 text-fg-subtle" />
                    <span className="min-w-0 flex-1 truncate" title={row.path || 'Files'}>{row.path || 'Files'}</span>
                    <span className="shrink-0 text-xs font-normal tabular-nums text-fg-subtle">
                      {formatNumber(row.count)} · {formatBytes(row.bytes)}
                    </span>
                    <button
                      type="button" disabled={!!busy} onClick={() => onRemoveFolder(row.path)}
                      aria-label={row.path ? `Remove folder ${row.path}` : 'Remove loose files'}
                      className="-mr-2 inline-flex size-9 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-border hover:text-fg disabled:opacity-50"
                    >
                      <X aria-hidden className="size-4" />
                    </button>
                  </div>
                ) : (
                  <div className={cn('flex h-full items-center gap-3 border-b border-border/60 px-4 text-sm sm:px-5', row.item.relativePath && 'pl-8 sm:pl-10')}>
                    <FileIcon aria-hidden className="size-4 shrink-0 text-fg-subtle" />
                    <span className="min-w-0 flex-1 truncate text-fg" title={row.item.name}>{row.item.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-fg-subtle">{formatBytes(row.item.size)}</span>
                    <button
                      type="button" disabled={!!busy} onClick={() => onRemove(row.item.id)} aria-label={`Remove ${row.item.name}`}
                      className="-mr-2 inline-flex size-9 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-muted hover:text-fg disabled:opacity-50"
                    >
                      <X aria-hidden className="size-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 border-t border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger sm:px-5">
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button variant="ghost" size="sm" onClick={onUpload} className="-my-1 text-danger hover:bg-danger-border/50">
            <RotateCw aria-hidden /> Try again
          </Button>
        </div>
      )}

      {/* Desktop action row (mobile uses the sticky bar from the parent). */}
      <div className="hidden items-center justify-between gap-3 border-t border-border bg-surface px-5 py-4 sm:flex">
        <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
          {busy ? (
            <>
              <Spinner className="size-4" label="" /> {busy.label}
            </>
          ) : (
            'Ready when you are.'
          )}
        </p>
        <Button size="lg" onClick={onUpload} loading={!!busy} disabled={items.length === 0} className="min-w-44">
          {uploadLabel}
        </Button>
      </div>
    </Card>
  );
}

/** Sticky bottom action bar for phones. */
export function MobileUploadBar({ label, busyLabel, disabled, onClick }: { label: string; busyLabel?: string | null; disabled?: boolean; onClick: () => void }) {
  return (
    <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-surface/95 px-4 py-3 shadow-lg backdrop-blur sm:hidden">
      <Button size="lg" className="h-12 w-full text-base" onClick={onClick} loading={!!busyLabel} disabled={disabled}>
        {busyLabel ?? label}
      </Button>
    </div>
  );
}
