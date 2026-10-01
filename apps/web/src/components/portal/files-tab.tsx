'use client';

import * as React from 'react';
import { ChevronRight, Folder, FolderOpen, MessageSquare, SearchX, Trash2, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { formatBytes, formatNumber, type ClientFileDTO } from '@scenox/shared';
import { Button, Card, ConfirmDialog, EmptyState, Pagination, SearchInput, Skeleton, SimpleSelect, StatusBadge } from '@/components/ui';
import type { BrowseParams, BrowseSort } from '@/lib/portal/api';
import { friendlyError, plural, whenFull, whenShort } from '@/lib/portal/format';
import { useBrowse, useDeleteFile } from '@/lib/portal/hooks';
import { cn } from '@/lib/utils';
import { categoryMeta, TYPE_FILTERS } from './file-types';
import { usePortal } from './portal-context';
import { FileTile, InlineError } from './ui-bits';

const SORTS: { value: string; label: string; sort: BrowseSort; order: 'asc' | 'desc' }[] = [
  { value: 'uploadedAt:desc', label: 'Newest first', sort: 'uploadedAt', order: 'desc' },
  { value: 'uploadedAt:asc', label: 'Oldest first', sort: 'uploadedAt', order: 'asc' },
  { value: 'name:asc', label: 'Name A–Z', sort: 'name', order: 'asc' },
  { value: 'name:desc', label: 'Name Z–A', sort: 'name', order: 'desc' },
  { value: 'size:desc', label: 'Largest first', sort: 'size', order: 'desc' },
  { value: 'size:asc', label: 'Smallest first', sort: 'size', order: 'asc' },
];

const COLS = 'md:grid md:grid-cols-[minmax(0,1fr)_7.5rem_5.5rem_11rem_5.5rem] md:items-center md:gap-4';

export function FilesTab() {
  const { view, navigate, canDelete, canMessage, openFileComments } = usePortal();
  const { path, type, q } = view;
  const [sortKey, setSortKey] = React.useState(SORTS[0]!.value);
  const pageSize = 50;
  const sig = `${path}|${type}|${q}|${sortKey}`;
  const [pageState, setPageState] = React.useState({ sig, page: 1 });
  const page = pageState.sig === sig ? pageState.page : 1;
  const setPage = (p: number) => setPageState({ sig, page: p });

  const sort = SORTS.find((s) => s.value === sortKey) ?? SORTS[0]!;
  const params: BrowseParams = { path, q, type: type || 'all', sort: sort.sort, order: sort.order, page, pageSize };
  const query = useBrowse(params);
  const data = query.data;
  const listTop = React.useRef<HTMLDivElement>(null);

  // after deleting the last file of a page, step back
  React.useEffect(() => {
    if (data && data.files.items.length === 0 && data.files.total > 0 && page > 1) setPageState({ sig, page: page - 1 });
  }, [data, page, sig]);

  /* the search box is uncontrolled; remount it when the URL changes q from outside (e.g. "view in files") */
  const lastQ = React.useRef(q);
  const [searchKey, setSearchKey] = React.useState(0);
  React.useEffect(() => {
    if (q !== lastQ.current) {
      lastQ.current = q;
      setSearchKey((k) => k + 1);
    }
  }, [q]);

  const [target, setTarget] = React.useState<ClientFileDTO | null>(null);
  const del = useDeleteFile();

  const filtering = !!q || (!!type && type !== 'all');
  const crumbs = React.useMemo(() => {
    const raw = data?.breadcrumbs ?? path.split('/').filter(Boolean).map((name, i, a) => ({ name, path: a.slice(0, i + 1).join('/') }));
    const rest = raw.filter((c) => c.path !== '');
    return [{ name: 'All files', path: '' }, ...rest];
  }, [data?.breadcrumbs, path]);

  const files = data?.files.items ?? [];
  const folders = data?.folders ?? [];
  const total = data?.files.total ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Files</h1>
        <p className="text-sm text-fg-muted" aria-live="polite">
          {data ? (filtering ? `${formatNumber(total)} ${plural(total, 'match', 'matches')}` : `${formatNumber(total)} ${plural(total, 'file')}${path ? ' in this folder' : ''}`) : 'Everything you’ve sent us'}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchInput
            key={searchKey} defaultValue={q} placeholder="Search files by name" aria-label="Search files" className="sm:max-w-sm sm:flex-1"
            onChange={(v) => {
              lastQ.current = v;
              navigate({ q: v }, 'replace');
            }}
          />
          <SimpleSelect aria-label="Sort files" value={sortKey} onValueChange={setSortKey} options={SORTS.map((s) => ({ value: s.value, label: s.label }))} className="sm:ml-auto sm:w-44" />
        </div>
        <div role="group" aria-label="Filter by file type" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {TYPE_FILTERS.map((f) => {
            const active = (type || 'all') === f.value;
            return (
              <button
                key={f.value} type="button" aria-pressed={active} onClick={() => navigate({ type: f.value === 'all' ? '' : f.value }, 'replace')}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring',
                  active ? 'border-primary-soft-border bg-primary-soft font-medium text-primary-soft-fg' : 'border-border bg-surface text-fg-muted hover:bg-surface-muted hover:text-fg',
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {crumbs.length > 1 && (
        <nav aria-label="Folder path">
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <li key={c.path || 'root'} className="flex min-w-0 items-center gap-1">
                  {last ? (
                    <span aria-current="page" className="truncate font-medium text-fg">{c.name}</span>
                  ) : (
                    <button type="button" onClick={() => navigate({ path: c.path, q: '' })} className="truncate rounded-sm text-fg-muted transition-colors hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                      {c.name}
                    </button>
                  )}
                  {!last && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      {query.isError && !data && <InlineError message={friendlyError(query.error, 'We couldn’t load your files.')} onRetry={() => void query.refetch()} />}

      {query.isLoading ? (
        <FilesSkeleton />
      ) : data ? (
        <div ref={listTop} className={cn('flex scroll-mt-32 flex-col gap-5 transition-opacity duration-150', query.isPlaceholderData && 'opacity-60')}>
          {folders.length > 0 && (
            <section aria-label="Folders">
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {folders.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button" onClick={() => navigate({ path: f.path, q: '' })}
                      className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left shadow-xs transition-colors duration-150 hover:border-border-strong hover:bg-surface-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                        <Folder className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg" title={f.name}>{f.name}</span>
                        <span className="block truncate text-xs tabular-nums text-fg-muted">
                          {formatNumber(f.fileCount)} {plural(f.fileCount, 'file')} · {formatBytes(f.totalBytes)}
                        </span>
                      </span>
                      <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {files.length === 0 ? (
            folders.length > 0 ? null : (
              <Card>
                {filtering ? (
                  <EmptyState
                    icon={<SearchX />} title="No files match" description="Try a different name or file type."
                    action={<Button variant="outline" size="sm" onClick={() => navigate({ q: '', type: '' }, 'replace')}>Clear search and filters</Button>}
                  />
                ) : (
                  <EmptyState
                    icon={<FolderOpen />} title={path ? 'This folder is empty' : 'No files yet'}
                    description={path ? 'There’s nothing in here.' : 'Files you upload will show up here.'}
                    action={path ? <Button variant="outline" size="sm" onClick={() => navigate({ path: '' })}>Back to all files</Button> : <Button onClick={() => navigate({ tab: 'upload' })}><UploadCloud aria-hidden /> Upload files</Button>}
                  />
                )}
              </Card>
            )
          ) : (
            <Card className="overflow-hidden">
              <div aria-hidden className={cn('hidden border-b border-border bg-surface-muted/60 px-5 py-2 text-xs font-medium text-fg-subtle', COLS)}>
                <span>Name</span>
                <span>Status</span>
                <span>Size</span>
                <span>Uploaded</span>
                <span />
              </div>
              <ul aria-label="Files" className="divide-y divide-border/60">
                {files.map((f) => (
                  <FileRow
                    key={f.id} file={f}
                    onComments={canMessage ? () => openFileComments(f) : undefined}
                    onDelete={canDelete && f.canDelete ? () => setTarget(f) : undefined}
                  />
                ))}
              </ul>
              {total > 0 && (
                <div className="border-t border-border px-4 py-3 sm:px-5">
                  <Pagination
                    page={page} pageSize={pageSize} total={total}
                    onPageChange={(p) => {
                      setPage(p);
                      listTop.current?.scrollIntoView({ block: 'start' });
                    }}
                  />
                </div>
              )}
            </Card>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={!!target} onOpenChange={(o) => !o && setTarget(null)} destructive title="Delete this file?"
        description={target ? `“${target.name}” will be permanently removed. This can’t be undone.` : undefined} confirmLabel="Delete"
        onConfirm={async () => {
          if (!target) return;
          try {
            await del.mutateAsync(target.id);
            toast.success('File deleted');
          } catch (e) {
            toast.error(friendlyError(e, 'We couldn’t delete that file. Please try again.'));
            throw e;
          }
        }}
      />
    </div>
  );
}

function FileRow({
  file: f, onComments, onDelete,
}: {
  file: ClientFileDTO;
  onComments?: () => void;
  onDelete?: () => void;
}) {
  const meta = categoryMeta(f.type);
  const by = f.uploadedBy ? ` by ${f.uploadedBy}` : '';
  return (
    <li className={cn('flex items-center gap-3 px-4 py-3 sm:px-5 md:py-2.5', COLS)}>
      <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-none">
        <FileTile icon={meta.icon} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg" title={f.name}>
            <span className="sr-only">{meta.label}: </span>
            {f.name}
          </p>
          {/* phone / tablet meta line (columns take over from md) */}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-fg-muted md:hidden">
            <span>{formatBytes(f.size)}</span>
            <span aria-hidden>·</span>
            <span title={whenFull(f.uploadedAt)}>{whenShort(f.uploadedAt)}{by}</span>
          </p>
          <div className="mt-1.5 md:hidden">
            <StatusBadge kind="file" status={f.status} />
          </div>
        </div>
      </div>
      <div className="hidden md:block"><StatusBadge kind="file" status={f.status} /></div>
      <span className="hidden text-sm tabular-nums text-fg-muted md:block">{formatBytes(f.size)}</span>
      <div className="hidden min-w-0 md:block">
        <p className="truncate text-sm text-fg-muted" title={whenFull(f.uploadedAt)}>{whenShort(f.uploadedAt)}</p>
        {f.uploadedBy && <p className="truncate text-xs text-fg-subtle">{f.uploadedBy}</p>}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-0.5 self-start md:self-auto">
        {onComments && (
          <button
            type="button" onClick={onComments} title="Comments"
            aria-label={f.commentCount > 0 ? `Comments on ${f.name}, ${f.commentCount}` : `Add a comment on ${f.name}`}
            className={cn(
              'inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-md px-2 text-xs tabular-nums transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring md:h-8 md:min-w-8',
              f.commentCount > 0 ? 'font-medium text-primary-soft-fg' : 'text-fg-subtle hover:text-fg',
            )}
          >
            <MessageSquare aria-hidden className="size-4" />
            {f.commentCount > 0 && f.commentCount}
          </button>
        )}
        {onDelete && (
          <button
            type="button" onClick={onDelete} title="Delete" aria-label={`Delete ${f.name}`}
            className="inline-flex size-10 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger focus-visible:outline-2 focus-visible:outline-ring md:size-8"
          >
            <Trash2 aria-hidden className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function FilesSkeleton() {
  return (
    <Card className="overflow-hidden" role="status" aria-label="Loading files">
      <ul className="divide-y divide-border/60">
        {Array.from({ length: 7 }, (_, i) => (
          <li key={i} className="flex items-center gap-3 px-5 py-3">
            <Skeleton className="size-9" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
