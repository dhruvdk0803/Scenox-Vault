'use client';

import * as React from 'react';
import { Download, FolderInput, Info, MoreHorizontal, Pencil, Trash2, ClipboardCopy } from 'lucide-react';
import { formatBytes, type FileDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableColumn, type SortState } from '@/components/ui/data-table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toaster';
import { RelativeTime } from '../relative-time';
import { FileDetailsDialog } from './file-details-dialog';
import { MoveFilesDialog, RenameFileDialog, useInvalidateFiles } from './file-dialogs';
import { downloadUrl, FileTypeIcon, filePath } from './file-utils';

export interface FileTableProps {
  files: FileDTO[];
  loading?: boolean;
  empty?: React.ReactNode;
  selectedIds: ReadonlySet<string>;
  onSelectionChange: (ids: Set<string>) => void;
  /** Show client + portal columns (hidden when browsing a single client). */
  showClient?: boolean;
  sort?: SortState | null;
  onSortChange?: (s: SortState) => void;
  /** Row selection checkboxes (default true). */
  selectable?: boolean;
}

/** Reusable file table with selection, row actions and a details dialog. */
export function FileTable({ files, loading, empty, selectedIds, onSelectionChange, showClient, sort, onSortChange, selectable = true }: FileTableProps) {
  const canDownload = usePermission('files.download');
  const canManage = usePermission('files.manage');
  const canDelete = usePermission('files.delete');
  const invalidate = useInvalidateFiles();

  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [detailInitial, setDetailInitial] = React.useState<FileDTO | null>(null);
  const [renameFile, setRenameFile] = React.useState<FileDTO | null>(null);
  const [moveFile, setMoveFile] = React.useState<FileDTO | null>(null);
  const [deleteFile, setDeleteFile] = React.useState<FileDTO | null>(null);

  const openDetails = (f: FileDTO) => {
    setDetailInitial(f);
    setDetailId(f.id);
  };

  async function copyPath(f: FileDTO) {
    try {
      await navigator.clipboard.writeText(filePath(f));
      toast.success('Path copied');
    } catch {
      toast.error("Couldn't copy the path");
    }
  }

  const columns: DataTableColumn<FileDTO>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      className: 'min-w-64 max-w-md',
      cell: (f) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <FileTypeIcon extension={f.extension} className="size-4 shrink-0 text-fg-subtle" />
          <div className="min-w-0">
            <button type="button" onClick={() => openDetails(f)} className="block max-w-full truncate rounded-sm text-left font-medium text-fg hover:underline" title={f.name}>
              {f.name}
            </button>
            {f.relativePath && <p className="truncate text-xs text-fg-subtle" title={f.relativePath}>{f.relativePath}</p>}
          </div>
        </div>
      ),
    },
    ...(showClient
      ? ([
          {
            key: 'client',
            header: 'Client / portal',
            className: 'hidden lg:table-cell',
            cell: (f) => (
              <div className="min-w-0 max-w-48">
                <p className="truncate text-sm">{f.clientName}</p>
                <p className="truncate text-xs text-fg-subtle">{f.portalName}</p>
              </div>
            ),
          },
        ] as DataTableColumn<FileDTO>[])
      : []),
    { key: 'size', header: 'Size', sortable: true, align: 'right', cell: (f) => <span className="tabular-nums">{formatBytes(f.size)}</span> },
    {
      key: 'status',
      header: 'Status',
      className: 'hidden sm:table-cell',
      cell: (f) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge kind="file" status={f.status} />
          {(f.scanStatus === 'infected' || f.scanStatus === 'failed') && <StatusBadge kind="scan" status={f.scanStatus} />}
        </div>
      ),
    },
    {
      key: 'uploader',
      header: 'Uploaded by',
      className: 'hidden xl:table-cell',
      cell: (f) => <span className="block max-w-40 truncate text-fg-muted">{f.uploaderName ?? f.uploaderEmail ?? '—'}</span>,
    },
    { key: 'createdAt', header: 'Uploaded', sortable: true, className: 'hidden md:table-cell', cell: (f) => <RelativeTime date={f.completedAt ?? f.createdAt} className="whitespace-nowrap tabular-nums text-fg-muted" /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: 'w-12',
      cell: (f) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${f.name}`}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => openDetails(f)}><Info aria-hidden /> View details</DropdownMenuItem>
            {canDownload && (
              <DropdownMenuItem asChild disabled={f.status === 'quarantined'}>
                <a href={downloadUrl(f.id)}><Download aria-hidden /> Download</a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => void copyPath(f)}><ClipboardCopy aria-hidden /> Copy path</DropdownMenuItem>
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setRenameFile(f)}><Pencil aria-hidden /> Rename</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setMoveFile(f)}><FolderInput aria-hidden /> Move</DropdownMenuItem>
              </>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDeleteFile(f)}><Trash2 aria-hidden /> Delete</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <DataTable
        caption="Files"
        columns={columns}
        rows={files}
        getRowId={(f) => f.id}
        loading={loading}
        empty={empty}
        selectable={selectable}
        selectedIds={selectedIds}
        onSelectionChange={onSelectionChange}
        sort={sort}
        onSortChange={onSortChange}
      />
      <FileDetailsDialog fileId={detailId} initial={detailInitial} onOpenChange={(o) => !o && setDetailId(null)} />
      <RenameFileDialog file={renameFile} onOpenChange={(o) => !o && setRenameFile(null)} />
      <MoveFilesDialog open={!!moveFile} onOpenChange={(o) => !o && setMoveFile(null)} fileIds={moveFile ? [moveFile.id] : []} initialPath={moveFile?.relativePath} />
      <ConfirmDialog
        open={!!deleteFile}
        onOpenChange={(o) => !o && setDeleteFile(null)}
        title="Delete this file?"
        description={deleteFile ? `“${deleteFile.name}” will be permanently removed from the vault. This can't be undone.` : undefined}
        confirmLabel="Delete file"
        destructive
        onConfirm={async () => {
          if (!deleteFile) return;
          try {
            await api.delete(`/files/${deleteFile.id}`);
            toast.success('File deleted');
            invalidate();
          } catch (err) {
            toast.error("Couldn't delete the file", { description: errorMessage(err) });
            throw err;
          }
        }}
      />
    </>
  );
}
