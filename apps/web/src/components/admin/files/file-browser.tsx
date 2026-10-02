'use client';

import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, Folder, FolderOpen, Home, Image as ImageIcon, LayoutGrid, List, MoreHorizontal, Rows3, Trash2 } from 'lucide-react';
import { formatBytes, formatNumber, type BrowseResponse } from '@scenox/shared';
import { api, qs } from '@/lib/api';
import { usePermission } from '@/lib/hooks/use-me';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '../query-state';
import { DeleteFolderDialog, type FolderToDelete } from './delete-folder-dialog';
import { ExportsTray } from './exports-tray';
import { FileGrid } from './file-grid';
import { FileBulkBar } from './file-bulk-bar';
import { FileTable } from './file-table';

const PAGE_SIZE = 50;
const LAYOUT_KEY = 'sv.files.layout';

type FileLayout = 'table' | 'thumbnails';

/**
 * Folder-style browser for one client (optionally one portal): breadcrumbs, folders (grid/list) and a files table.
 * Backed by GET /api/files/browse.
 */
export function FileBrowser({ clientId, portalId, className }: { clientId: string; portalId?: string; className?: string }) {
  const [path, setPath] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [q, setQ] = React.useState('');
  const [view, setView] = React.useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [layout, setLayout] = React.useState<FileLayout>('table');
  const [deleteFolder, setDeleteFolder] = React.useState<FolderToDelete | null>(null);
  const canDelete = usePermission('files.delete');

  // Remember the table / thumbnails choice per browser (table stays the default).
  React.useEffect(() => {
    try {
      if (localStorage.getItem(LAYOUT_KEY) === 'thumbnails') setLayout('thumbnails');
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);
  function changeLayout(next: FileLayout) {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* ignore */
    }
  }

  React.useEffect(() => {
    setPath('');
    setPage(1);
    setSelected(new Set());
  }, [clientId, portalId]);

  const params = { clientId, portalId, path: path || undefined, page, pageSize: PAGE_SIZE, q: q || undefined };
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.files.browse(params),
    queryFn: ({ signal }) => api.get<BrowseResponse>(`/files/browse${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
  });

  function goTo(next: string) {
    setPath(next);
    setPage(1);
    setSelected(new Set());
  }

  const fetchMatching = (pg: number, pageSize: number) =>
    api.get<BrowseResponse>(`/files/browse${qs({ clientId, portalId, path: path || undefined, q: q || undefined, page: pg, pageSize })}`).then((r) => r.files);

  const crumbs = data?.breadcrumbs ?? [];
  const folders = data?.folders ?? [];
  const files = data?.files.items ?? [];
  const nothing = !isPending && folders.length === 0 && files.length === 0;

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1 sm:max-w-sm">
          <SearchInput placeholder="Search files in this client…" aria-label="Search files" onChange={(v) => { setQ(v); setPage(1); }} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div role="group" aria-label="Folder layout" className="inline-flex rounded-md border border-border-strong bg-surface p-0.5 shadow-xs">
            {([['grid', LayoutGrid, 'Grid view'], ['list', List, 'List view']] as const).map(([v, Icon, label]) => (
              <button
                key={v}
                type="button"
                aria-label={label}
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn('rounded-sm p-1.5 transition-colors', view === v ? 'bg-surface-muted text-fg' : 'text-fg-subtle hover:text-fg')}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            ))}
          </div>
          <ExportsTray />
        </div>
      </div>

      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" onClick={() => goTo('')} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-muted', !path ? 'font-medium text-fg' : 'text-fg-muted')} aria-current={!path ? 'page' : undefined}>
          <Home className="size-3.5" aria-hidden /> All files
        </button>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <React.Fragment key={c.path}>
              <ChevronRight className="size-3.5 text-fg-subtle" aria-hidden />
              <button type="button" onClick={() => goTo(c.path)} aria-current={last ? 'page' : undefined} className={cn('rounded-md px-1.5 py-1 transition-colors hover:bg-surface-muted', last ? 'font-medium text-fg' : 'text-fg-muted')}>
                {c.name}
              </button>
            </React.Fragment>
          );
        })}
      </nav>

      {error && !data ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load files" />
        </div>
      ) : (
        <>
          {isPending ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true">
              {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16" />)}
            </div>
          ) : (
            folders.length > 0 && (
              <section aria-label="Folders">
                <ul className={view === 'grid' ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface'}>
                  {folders.map((f) => (
                    <li key={f.path} className="relative">
                      <button
                        type="button"
                        onClick={() => goTo(f.path)}
                        className={cn(
                          'group flex w-full items-center gap-3 text-left transition-colors',
                          view === 'grid' ? 'rounded-lg border border-border bg-surface p-3 shadow-xs hover:border-border-strong hover:bg-surface-muted/60' : 'px-3 py-2.5 hover:bg-surface-muted/60',
                          canDelete && 'pr-12',
                        )}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
                          <Folder className="size-4.5 group-hover:hidden" aria-hidden />
                          <FolderOpen className="hidden size-4.5 group-hover:block" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">{f.name}</span>
                          <span className="block text-xs tabular-nums text-fg-subtle">{formatNumber(f.fileCount)} {f.fileCount === 1 ? 'file' : 'files'} · {formatBytes(f.totalBytes)}</span>
                        </span>
                      </button>
                      {canDelete && (
                        <div className="absolute right-2 top-1/2 -translate-y-1/2">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for folder ${f.name}`}>
                                <MoreHorizontal aria-hidden />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem destructive onSelect={() => setDeleteFolder(f)}><Trash2 aria-hidden /> Delete folder</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          )}

          {nothing ? (
            <div className="rounded-lg border border-border bg-surface">
              <EmptyState
                icon={<Folder />}
                title={q ? 'No matching files' : path ? 'This folder is empty' : 'No files yet'}
                description={q ? 'Try a different search term.' : path ? 'Move files here or go back to a parent folder.' : 'Files uploaded through portals will show up here.'}
                action={path ? <Button variant="outline" onClick={() => goTo('')}>Back to all files</Button> : undefined}
              />
            </div>
          ) : (
            (isPending || files.length > 0) && (
              <section aria-label="Files" className="space-y-3">
                <div className="flex justify-end">
                  <div role="group" aria-label="Files layout" className="inline-flex rounded-md border border-border-strong bg-surface p-0.5 shadow-xs">
                    {([['table', Rows3, 'Table'], ['thumbnails', ImageIcon, 'Thumbnails']] as const).map(([v, Icon, label]) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={layout === v}
                        onClick={() => changeLayout(v)}
                        className={cn('inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium transition-colors', layout === v ? 'bg-surface-muted text-fg' : 'text-fg-subtle hover:text-fg')}
                      >
                        <Icon className="size-3.5" aria-hidden /> {label}
                      </button>
                    ))}
                  </div>
                </div>
                {layout === 'thumbnails' ? (
                  <FileGrid files={files} loading={isPending} selectedIds={selected} onSelectionChange={setSelected} />
                ) : (
                  <FileTable files={files} loading={isPending} selectedIds={selected} onSelectionChange={setSelected} />
                )}
                {data && data.files.total > PAGE_SIZE && (
                  <Pagination page={page} pageSize={PAGE_SIZE} total={data.files.total} onPageChange={setPage} />
                )}
              </section>
            )
          )}
        </>
      )}
      <FileBulkBar
        selectedIds={selected}
        onClear={() => setSelected(new Set())}
        onSelectionChange={setSelected}
        initialMovePath={path}
        files={files}
        matching={data ? { total: data.files.total, fetchPage: fetchMatching } : undefined}
      />
      <DeleteFolderDialog
        folder={deleteFolder}
        clientId={clientId}
        portalId={portalId}
        onOpenChange={(o) => !o && setDeleteFolder(null)}
        onDeleted={(deletedPath) => {
          setSelected(new Set());
          // If we're standing inside the folder that was just deleted, step back out to its parent.
          if (path === deletedPath || path.startsWith(`${deletedPath}/`)) goTo(deletedPath.split('/').slice(0, -1).join('/'));
        }}
      />
    </div>
  );
}
