'use client';

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Ban, CheckCircle2, FileText, Hourglass, Loader2, PauseCircle, Pause, Play, RotateCw, Upload, X, XCircle, type LucideIcon } from 'lucide-react';
import { formatBytes, formatSpeed } from '@scenox/shared';
import { Badge, ConfirmDialog, ProgressBar, Tabs, TabsList, TabsTrigger, type BadgeTone } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatEta, type UploadFileSnapshot, type UploadItemStatus } from '@/lib/upload';

const STATUS: Record<UploadItemStatus, { label: string; tone: BadgeTone; icon: LucideIcon; spin?: boolean }> = {
  queued: { label: 'Queued', tone: 'neutral', icon: Hourglass },
  uploading: { label: 'Uploading', tone: 'info', icon: Upload },
  paused: { label: 'Paused', tone: 'warning', icon: PauseCircle },
  processing: { label: 'Processing', tone: 'info', icon: Loader2, spin: true },
  completed: { label: 'Completed', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
};

export type QueueFilter = 'all' | 'active' | 'failed' | 'completed';

const ACTIVE = new Set<UploadItemStatus>(['queued', 'uploading', 'paused', 'processing']);
export function matchesFilter(item: UploadFileSnapshot, f: QueueFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'active': return ACTIVE.has(item.status) || (item.status === 'failed' && item.autoRetrying);
    case 'failed': return item.status === 'failed';
    case 'completed': return item.status === 'completed';
  }
}

export interface QueueActions {
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}

const IconButton = ({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) => (
  <button
    type="button" aria-label={label} title={label} onClick={onClick}
    className={cn(
      'inline-flex size-10 items-center justify-center rounded-md text-fg-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-fg sm:size-8 [&_svg]:size-4',
      danger && 'hover:bg-danger-bg hover:text-danger',
    )}
  >
    {children}
  </button>
);

const QueueRow = React.memo(function QueueRow({ item, actions }: { item: UploadFileSnapshot; actions: QueueActions }) {
  const s = STATUS[item.status];
  const Icon = s.icon;
  const showBar = item.status === 'uploading' || item.status === 'processing' || item.status === 'paused' || (item.status === 'failed' && item.progress > 0);
  const live = item.status === 'uploading';
  const message = item.status === 'failed' ? (item.autoRetrying ? `${item.error ?? ''} We’ll try again shortly.` : item.error) : item.warning;
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 border-b border-border/60 px-4 sm:px-5">
      <div className="flex items-center gap-3">
        <FileText aria-hidden className="hidden size-5 shrink-0 text-fg-subtle sm:block" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg" title={item.name}>{item.name}</p>
          <p className="flex min-w-0 gap-1.5 truncate text-xs tabular-nums text-fg-subtle">
            {item.relativePath && <span className="truncate" title={item.relativePath}>{item.relativePath} ·</span>}
            <span className="shrink-0">
              {live || item.status === 'paused' || item.status === 'processing' ? `${formatBytes(item.bytesUploaded)} / ${formatBytes(item.size)}` : formatBytes(item.size)}
            </span>
            {live && item.speed > 0 && <span className="hidden shrink-0 sm:inline">· {formatSpeed(item.speed)}</span>}
            {live && item.etaSeconds != null && <span className="hidden shrink-0 sm:inline">· {formatEta(item.etaSeconds)} left</span>}
          </p>
        </div>
        <Badge tone={s.tone} className="shrink-0">
          <Icon aria-hidden className={s.spin ? 'animate-spin' : undefined} />
          <span className="hidden min-[420px]:inline">{s.label}</span>
          <span className="sr-only min-[420px]:hidden">{s.label}</span>
        </Badge>
        <div className="-mr-2 flex shrink-0 items-center">
          {(item.status === 'uploading' || item.status === 'queued' || item.status === 'processing') && (
            <IconButton label={`Pause ${item.name}`} onClick={() => actions.onPause(item.id)}><Pause aria-hidden /></IconButton>
          )}
          {item.status === 'paused' && item.pausedBy !== 'offline' && (
            <IconButton label={`Resume ${item.name}`} onClick={() => actions.onResume(item.id)}><Play aria-hidden /></IconButton>
          )}
          {item.status === 'failed' && <IconButton label={`Retry ${item.name}`} onClick={() => actions.onRetry(item.id)}><RotateCw aria-hidden /></IconButton>}
          {item.status !== 'completed' && item.status !== 'cancelled' && (
            <IconButton danger label={`Cancel ${item.name}`} onClick={() => actions.onCancel(item.id)}><X aria-hidden /></IconButton>
          )}
        </div>
      </div>
      {showBar ? (
        <ProgressBar
          value={item.progress} size="sm" label={`${item.name} progress`}
          tone={item.status === 'failed' ? 'danger' : item.status === 'paused' ? 'neutral' : 'primary'}
        />
      ) : null}
      {message && <p className={cn('truncate text-xs', item.status === 'failed' ? 'text-danger' : 'text-warning')} title={message}>{message}</p>}
    </div>
  );
});

export function QueueList({
  items, actions, filter: controlled, onFilterChange, showTabs = true, className, maxHeight = 'min(60vh, 520px)',
}: {
  items: readonly UploadFileSnapshot[];
  actions: QueueActions;
  filter?: QueueFilter;
  onFilterChange?: (f: QueueFilter) => void;
  showTabs?: boolean;
  className?: string;
  maxHeight?: string;
}) {
  const [inner, setInner] = React.useState<QueueFilter>('all');
  const filter = controlled ?? inner;
  const setFilter = (f: QueueFilter) => (onFilterChange ? onFilterChange(f) : setInner(f));
  const [cancelId, setCancelId] = React.useState<string | null>(null);

  const counts = React.useMemo(() => {
    const c = { all: items.length, active: 0, failed: 0, completed: 0 };
    for (const it of items) {
      if (matchesFilter(it, 'active')) c.active++;
      if (it.status === 'failed') c.failed++;
      else if (it.status === 'completed') c.completed++;
    }
    return c;
  }, [items]);

  const filtered = React.useMemo(() => (filter === 'all' ? items : items.filter((i) => matchesFilter(i, filter))), [items, filter]);
  const parent = React.useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: filtered.length, getScrollElement: () => parent.current, estimateSize: () => 76, overscan: 8,
    getItemKey: (i) => filtered[i]?.id ?? i,
  });

  const cancelTarget = cancelId ? items.find((i) => i.id === cancelId) : null;
  const wrapped = React.useMemo<QueueActions>(
    () => ({
      ...actions,
      onCancel: (id) => {
        const it = items.find((i) => i.id === id);
        if (it && it.bytesUploaded > 0 && it.status !== 'failed') setCancelId(id);
        else actions.onCancel(id);
      },
    }),
    [actions, items],
  );

  const tabs: { id: QueueFilter; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'failed', label: 'Failed' }, { id: 'completed', label: 'Completed' },
  ];

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-surface shadow-xs', className)}>
      {showTabs && (
        <Tabs value={filter} onValueChange={(v) => setFilter(v as QueueFilter)}>
          <TabsList className="px-2 sm:px-3">
            {tabs.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="px-2.5 sm:px-3">
                {t.label}
                <span className="rounded-full bg-surface-muted px-1.5 text-xs tabular-nums text-fg-subtle">{counts[t.id].toLocaleString('en-US')}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {filtered.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-fg-muted">Nothing here.</p>
      ) : (
        <div ref={parent} className="overflow-auto" style={{ maxHeight }} role="list" aria-label="Upload queue">
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((v) => (
              <div key={v.key} role="listitem" className="absolute inset-x-0" style={{ height: v.size, transform: `translateY(${v.start}px)` }}>
                <QueueRow item={filtered[v.index]!} actions={wrapped} />
              </div>
            ))}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!cancelTarget} onOpenChange={(o) => !o && setCancelId(null)} destructive
        title="Cancel this file?" description={cancelTarget ? `“${cancelTarget.name}” is partly uploaded. Cancelling discards what was sent.` : undefined}
        confirmLabel="Cancel file" cancelLabel="Keep uploading" onConfirm={() => { if (cancelId) actions.onCancel(cancelId); }}
      />
    </div>
  );
}
