'use client';

import * as React from 'react';
import { ChevronRight, Folder, FolderOpen, LayoutGrid, List, Loader2, MessageSquare, MoreVertical, SearchX, Trash2, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { formatBytes, formatNumber, type ClientFileDTO } from '@scenox/shared';
import {
  Button, Card, Checkbox, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, Pagination, SearchInput, Skeleton, SimpleSelect, StatusBadge,
} from '@/components/ui';
import type { BrowseParams, BrowseSort } from '@/lib/portal/api';
import { collectFolder, collectView, PartialDeleteError, type FileEntry } from '@/lib/portal/bulk';
import { friendlyError, plural, whenFull, whenShort } from '@/lib/portal/format';
import { useBrowse, useDeleteFile, useDeleteFiles } from '@/lib/portal/hooks';
import { canThumbnail, previewKind, previewUrl } from '@/lib/portal/preview';
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

type ViewMode = 'list' | 'grid';
const VIEW_KEY = 'sv:portal-files-view';
const loadViewMode = (): ViewMode => {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
};

type FolderInfo = { name: string; path: string; fileCount: number; totalBytes: number };
type Confirm = { kind: 'selection' } | { kind: 'folder'; folder: FolderInfo };
type Bulk = { phase: 'finding'; found: number } | { phase: 'deleting'; done: number; total: number };

const EMPTY_SEL: ReadonlyMap<string, number> = new Map();

export function FilesTab() {
  const { token, view, navigate, canDelete, canMessage, openFileComments, openPreview } = usePortal();
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

  /* list / grid, remembered per browser */
  const [mode, setMode] = React.useState<ViewMode>('list');
  React.useEffect(() => setMode(loadViewMode()), []);
  const chooseMode = (m: ViewMode) => {
    setMode(m);
    try {
      window.localStorage.setItem(VIEW_KEY, m);
    } catch {
      /* storage unavailable: just don't remember */
    }
  };

  /* selection (id → size). It follows the folder / search / type, not the sort order or page, and is cleared when those change. */
  const selSig = `${path}|${type}|${q}`;
  const [selState, setSelState] = React.useState<{ sig: string; items: ReadonlyMap<string, number>; collected: boolean }>({ sig: selSig, items: EMPTY_SEL, collected: false });
  const current = selState.sig === selSig ? selState : { sig: selSig, items: EMPTY_SEL, collected: false };
  const selected = current.items;
  const updateSel = (fn: (m: Map<string, number>) => void, collected = false) =>
    setSelState((cur) => {
      const m = new Map(cur.sig === selSig ? cur.items : EMPTY_SEL);
      fn(m);
      return { sig: selSig, items: m, collected: collected && m.size > 0 };
    });
  const clearSel = () => setSelState({ sig: selSig, items: EMPTY_SEL, collected: false });
  const selectedBytes = React.useMemo(() => {
    let n = 0;
    for (const s of selected.values()) n += s;
    return n;
  }, [selected]);

  const [target, setTarget] = React.useState<ClientFileDTO | null>(null);
  const del = useDeleteFile();
  const deleteMany = useDeleteFiles();
  const [confirm, setConfirm] = React.useState<Confirm | null>(null);
  const [bulk, setBulk] = React.useState<Bulk | null>(null);
  const [selectingAll, setSelectingAll] = React.useState(false);

  const filtering = !!q || (!!type && type !== 'all');
  const crumbs = React.useMemo(() => {
    const raw = data?.breadcrumbs ?? path.split('/').filter(Boolean).map((name, i, a) => ({ name, path: a.slice(0, i + 1).join('/') }));
    const rest = raw.filter((c) => c.path !== '');
    return [{ name: 'All files', path: '' }, ...rest];
  }, [data?.breadcrumbs, path]);

  const files = data?.files.items ?? [];
  const folders = data?.folders ?? [];
  const total = data?.files.total ?? 0;

  const deletable = canDelete ? files.filter((f) => f.canDelete) : [];
  const selectable = deletable.length > 0;
  const pageAll = selectable && deletable.every((f) => selected.has(f.id));
  const pageSome = selectable && deletable.some((f) => selected.has(f.id));
  const selectBarId = React.useId();

  const toggle = (f: ClientFileDTO, on: boolean) =>
    updateSel((m) => {
      if (on) m.set(f.id, f.size);
      else m.delete(f.id);
    });
  const togglePage = (on: boolean) =>
    updateSel((m) => {
      for (const f of deletable) {
        if (on) m.set(f.id, f.size);
        else m.delete(f.id);
      }
    });

  async function selectEverything() {
    setSelectingAll(true);
    try {
      const entries = await collectView(token, { path, q, type: type || 'all' });
      updateSel((m) => {
        for (const e of entries) m.set(e.id, e.size);
      }, true);
    } catch (e) {
      toast.error(friendlyError(e, 'We couldn’t select all the files. Please try again.'));
    } finally {
      setSelectingAll(false);
    }
  }

  async function runConfirmed() {
    if (!confirm) return;
    let entries: FileEntry[] = [];
    try {
      if (confirm.kind === 'selection') {
        entries = [...selected].map(([id, size]) => ({ id, size }));
      } else {
        setBulk({ phase: 'finding', found: 0 });
        entries = await collectFolder(token, confirm.folder.path, (found) => setBulk({ phase: 'finding', found }));
      }
      if (entries.length === 0) {
        toast.info('There’s nothing here that can be deleted.');
        return;
      }
      setBulk({ phase: 'deleting', done: 0, total: entries.length });
      const deleted = await deleteMany(entries.map((e) => e.id), (done, all) => setBulk({ phase: 'deleting', done, total: all }));
      const gone = new Set(entries.map((e) => e.id));
      if (confirm.kind === 'selection') clearSel();
      else updateSel((m) => gone.forEach((id) => m.delete(id)));
      toast.success(`Deleted ${formatNumber(deleted)} ${plural(deleted, 'file')}`, {
        description: deleted < entries.length ? 'Some files had already been removed or can’t be deleted.' : undefined,
      });
    } catch (e) {
      if (e instanceof PartialDeleteError) {
        const done = new Set(e.completedIds);
        updateSel((m) => done.forEach((id) => m.delete(id)));
        toast.error(`Deleted ${formatNumber(e.deleted)} of ${formatNumber(entries.length)} files, then something went wrong. ${friendlyError(e.cause, 'Please try again.')}`);
      } else {
        toast.error(friendlyError(e, 'We couldn’t delete those files. Please try again.'));
      }
      throw e;
    } finally {
      setBulk(null);
    }
  }

  const confirmCopy = (() => {
    if (!confirm) return { title: '', description: '' };
    const count = confirm.kind === 'selection' ? selected.size : confirm.folder.fileCount;
    const bytes = confirm.kind === 'selection' ? selectedBytes : confirm.folder.totalBytes;
    const title = `Delete ${formatNumber(count)} ${plural(count, 'file')} (${formatBytes(bytes)})?`;
    if (bulk?.phase === 'finding') return { title, description: `Finding files… ${formatNumber(bulk.found)} so far` };
    if (bulk?.phase === 'deleting') return { title, description: `Deleting… ${formatNumber(bulk.done)} of ${formatNumber(bulk.total)}. Please keep this page open.` };
    return {
      title,
      description: confirm.kind === 'folder' ? `Everything in “${confirm.folder.name}”, including its sub-folders, will be permanently deleted. This can’t be undone.` : 'This can’t be undone.',
    };
  })();

  const open = (f: ClientFileDTO) => openPreview(files, f.id);
  const showBar = canDelete && selected.size > 0;

  return (
    <div className={cn('flex flex-col gap-5', showBar && 'pb-20')}>
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
          <div className="flex items-center gap-2 sm:ml-auto">
            <SimpleSelect aria-label="Sort files" value={sortKey} onValueChange={setSortKey} options={SORTS.map((s) => ({ value: s.value, label: s.label }))} className="min-w-0 flex-1 sm:w-44 sm:flex-none" />
            <div role="group" aria-label="View" className="inline-flex shrink-0 rounded-md border border-border-strong bg-surface p-0.5 shadow-xs">
              {([['list', 'List', List], ['grid', 'Grid', LayoutGrid]] as const).map(([m, label, Icon]) => (
                <button
                  key={m} type="button" aria-pressed={mode === m} aria-label={`${label} view`} title={`${label} view`} onClick={() => chooseMode(m)}
                  className={cn(
                    'inline-flex h-8 w-9 items-center justify-center rounded-[5px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring',
                    mode === m ? 'bg-primary-soft text-primary-soft-fg' : 'text-fg-subtle hover:bg-surface-muted hover:text-fg',
                  )}
                >
                  <Icon aria-hidden className="size-4" />
                </button>
              ))}
            </div>
          </div>
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
                  <li key={f.path} className="relative">
                    <button
                      type="button" onClick={() => navigate({ path: f.path, q: '' })}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left shadow-xs transition-colors duration-150 hover:border-border-strong hover:bg-surface-muted/60 focus-visible:outline-2 focus-visible:outline-ring',
                        canDelete && 'pr-12',
                      )}
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
                      {!canDelete && <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />}
                    </button>
                    {canDelete && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button" aria-label={`Actions for folder ${f.name}`}
                            className="absolute right-2 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-surface-muted"
                          >
                            <MoreVertical aria-hidden className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => navigate({ path: f.path, q: '' })}>
                            <FolderOpen aria-hidden /> Open folder
                          </DropdownMenuItem>
                          <DropdownMenuItem destructive onSelect={() => setConfirm({ kind: 'folder', folder: f })}>
                            <Trash2 aria-hidden /> Delete folder
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
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
              {selectable && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-surface-muted/60 px-4 py-2.5 sm:px-5">
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      id={selectBarId} checked={pageAll ? true : pageSome ? 'indeterminate' : false} onCheckedChange={(v) => togglePage(v === true)}
                      className="relative size-5 after:absolute after:-inset-2 after:content-[''] md:size-4"
                    />
                    <label htmlFor={selectBarId} className="cursor-pointer select-none text-sm text-fg-muted">Select all on this page</label>
                  </div>
                  {pageAll && total > files.length && !current.collected && selected.size < total && (
                    <button
                      type="button" onClick={() => void selectEverything()} disabled={selectingAll}
                      className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
                    >
                      {selectingAll && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
                      Select all {formatNumber(total)} files in this view
                    </button>
                  )}
                  {current.collected && <span className="text-sm text-fg-muted">All {formatNumber(selected.size)} {plural(selected.size, 'file')} in this view are selected.</span>}
                </div>
              )}

              {mode === 'list' ? (
                <>
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
                        key={f.id} file={f} onOpen={() => open(f)}
                        selectable={selectable} selected={selected.has(f.id)} onToggle={(on) => toggle(f, on)}
                        onComments={canMessage ? () => openFileComments(f) : undefined}
                        onDelete={canDelete && f.canDelete ? () => setTarget(f) : undefined}
                      />
                    ))}
                  </ul>
                </>
              ) : (
                <ul aria-label="Files" className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 sm:gap-4 sm:p-4 lg:grid-cols-4 xl:grid-cols-5">
                  {files.map((f) => (
                    <FileCard
                      key={f.id} file={f} token={token} onOpen={() => open(f)}
                      selectable={selectable && f.canDelete} selecting={selected.size > 0} selected={selected.has(f.id)} onToggle={(on) => toggle(f, on)}
                      onComments={canMessage ? () => openFileComments(f) : undefined}
                    />
                  ))}
                </ul>
              )}

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

      {showBar && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 px-3 sm:px-6 md:bottom-4">
          <div role="region" aria-label="Selected files" className="pointer-events-auto mx-auto flex max-w-3xl items-center gap-2 rounded-xl border border-border-strong bg-surface p-2.5 pl-4 shadow-lg animate-pop-in sm:gap-3">
            <p className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums text-fg" aria-live="polite">
              {formatNumber(selected.size)} selected <span className="text-fg-muted">· {formatBytes(selectedBytes)}</span>
            </p>
            <Button variant="ghost" size="sm" onClick={clearSel} disabled={!!bulk}>Clear</Button>
            <Button variant="danger" size="sm" onClick={() => setConfirm({ kind: 'selection' })} disabled={!!bulk}>
              <Trash2 aria-hidden /> Delete selected
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} destructive title={confirmCopy.title} description={confirmCopy.description} confirmLabel="Delete"
        onConfirm={runConfirmed}
      />

      <ConfirmDialog
        open={!!target} onOpenChange={(o) => !o && setTarget(null)} destructive title="Delete this file?"
        description={target ? `“${target.name}” will be permanently removed. This can’t be undone.` : undefined} confirmLabel="Delete"
        onConfirm={async () => {
          if (!target) return;
          try {
            await del.mutateAsync(target.id);
            updateSel((m) => m.delete(target.id), current.collected);
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

const checkboxClass = 'relative size-5 after:absolute after:-inset-2 after:content-[\'\'] md:size-4';

function FileRow({
  file: f, onOpen, selectable, selected, onToggle, onComments, onDelete,
}: {
  file: ClientFileDTO;
  onOpen: () => void;
  selectable: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onComments?: () => void;
  onDelete?: () => void;
}) {
  const meta = categoryMeta(f.type);
  const by = f.uploadedBy ? ` by ${f.uploadedBy}` : '';
  return (
    <li className={cn('flex items-center gap-3 px-4 py-3 transition-colors duration-150 sm:px-5 md:py-2.5', COLS, selected && 'bg-primary-soft/60')}>
      <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-none">
        {selectable &&
          (f.canDelete ? (
            <Checkbox checked={selected} onCheckedChange={(v) => onToggle(v === true)} aria-label={`Select ${f.name}`} className={checkboxClass} />
          ) : (
            <span aria-hidden className="size-5 shrink-0 md:size-4" />
          ))}
        <button
          type="button" onClick={onOpen} title={previewKind(f) ? 'Preview' : 'View details'}
          className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-md p-1 text-left transition-colors hover:bg-surface-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <FileTile icon={meta.icon} />
          <span className="block min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg" title={f.name}>
              <span className="sr-only">{meta.label}: </span>
              {f.name}
            </span>
            {/* phone / tablet meta line (columns take over from md) */}
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-fg-muted md:hidden">
              <span>{formatBytes(f.size)}</span>
              <span aria-hidden>·</span>
              <span title={whenFull(f.uploadedAt)}>{whenShort(f.uploadedAt)}{by}</span>
            </span>
            <span className="mt-1.5 block md:hidden">
              <StatusBadge kind="file" status={f.status} />
            </span>
          </span>
        </button>
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

function FileCard({
  file: f, token, onOpen, selectable, selecting, selected, onToggle, onComments,
}: {
  file: ClientFileDTO;
  token: string;
  onOpen: () => void;
  selectable: boolean;
  /** Something is selected somewhere: keep every checkbox visible. */
  selecting: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onComments?: () => void;
}) {
  const meta = categoryMeta(f.type);
  const Icon = meta.icon;
  const [broken, setBroken] = React.useState(false);
  const showThumb = canThumbnail(f) && !broken;
  return (
    <li
      className={cn(
        'group relative overflow-hidden rounded-lg border bg-surface shadow-xs transition-colors duration-150',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-border-strong',
      )}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <span className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-surface-muted">
          {showThumb ? (
            <img src={previewUrl(token, f.id)} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-full object-cover" />
          ) : (
            <Icon aria-hidden className="size-9 text-fg-subtle" strokeWidth={1.5} />
          )}
          {f.status !== 'ready' && <StatusBadge kind="file" status={f.status} className="absolute bottom-2 left-2" />}
        </span>
        <span className={cn('block px-3 pb-2.5 pt-2', onComments && 'pr-11')}>
          <span className="block truncate text-sm font-medium text-fg" title={f.name}>
            <span className="sr-only">{meta.label}: </span>
            {f.name}
          </span>
          <span className="block truncate text-xs tabular-nums text-fg-muted">{formatBytes(f.size)} · {whenShort(f.uploadedAt)}</span>
        </span>
      </button>
      {selectable && (
        <span
          className={cn(
            'absolute left-2 top-2 flex size-7 items-center justify-center rounded-md bg-surface/95 shadow-xs transition-opacity duration-150',
            selected || selecting ? 'opacity-100' : 'md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100',
          )}
        >
          <Checkbox checked={selected} onCheckedChange={(v) => onToggle(v === true)} aria-label={`Select ${f.name}`} className={checkboxClass} />
        </span>
      )}
      {onComments && (
        <button
          type="button" onClick={onComments} title="Comments"
          aria-label={f.commentCount > 0 ? `Comments on ${f.name}, ${f.commentCount}` : `Add a comment on ${f.name}`}
          className={cn(
            'absolute bottom-1.5 right-1.5 inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-xs tabular-nums transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring',
            f.commentCount > 0 ? 'font-medium text-primary-soft-fg' : 'text-fg-subtle hover:text-fg',
          )}
        >
          <MessageSquare aria-hidden className="size-4" />
          {f.commentCount > 0 && f.commentCount}
        </button>
      )}
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
