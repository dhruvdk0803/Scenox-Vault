'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox } from './checkbox';
import { Skeleton } from './skeleton';

export type SortOrder = 'asc' | 'desc';
export interface SortState {
  key: string;
  order: SortOrder;
}

export interface DataTableColumn<T> {
  /** Unique key; also the `sort` field name passed to onSortChange. */
  key: string;
  header: React.ReactNode;
  /** Plain-text header for aria when `header` is not a string. */
  headerLabel?: string;
  cell: (row: T) => React.ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Tailwind classes for width / hiding at breakpoints, e.g. "w-32 hidden md:table-cell". Applied to th and td. */
  className?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  loading?: boolean;
  skeletonRows?: number;
  /** Rendered (full width) when not loading and rows is empty. */
  empty?: React.ReactNode;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  onRowClick?: (row: T) => void;
  caption?: string;
  className?: string;
  /** Max height enabling an internally scrolling body with sticky header, e.g. "70vh". */
  maxHeight?: string;
}

const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

export function DataTable<T>({
  columns, rows, getRowId, loading, skeletonRows = 8, empty, sort, onSortChange, selectable, selectedIds, onSelectionChange,
  onRowClick, caption, className, maxHeight,
}: DataTableProps<T>) {
  const selected = selectedIds ?? new Set<string>();
  const ids = rows.map(getRowId);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const someSelected = !allSelected && ids.some((id) => selected.has(id));
  const colSpan = columns.length + (selectable ? 1 : 0);

  function toggleAll(checked: boolean) {
    const next = new Set(selected);
    for (const id of ids) checked ? next.add(id) : next.delete(id);
    onSelectionChange?.(next);
  }
  function toggleRow(id: string, checked: boolean) {
    const next = new Set(selected);
    checked ? next.add(id) : next.delete(id);
    onSelectionChange?.(next);
  }
  function handleSort(col: DataTableColumn<T>) {
    const order: SortOrder = sort?.key === col.key && sort.order === 'asc' ? 'desc' : 'asc';
    onSortChange?.({ key: col.key, order });
  }

  return (
    <div className={cn('overflow-auto rounded-lg border border-border bg-surface shadow-xs', className)} style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full min-w-max border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 z-10 bg-surface-muted">
          <tr className="border-b border-border">
            {selectable && (
              <th scope="col" className="w-10 px-3 py-2.5">
                <Checkbox
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={(c) => toggleAll(c === true)}
                  aria-label="Select all rows"
                  disabled={loading || rows.length === 0}
                />
              </th>
            )}
            {columns.map((col) => {
              const active = sort?.key === col.key;
              const ariaSort = active ? (sort!.order === 'asc' ? 'ascending' : 'descending') : col.sortable ? 'none' : undefined;
              const SortIcon = active ? (sort!.order === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn('whitespace-nowrap px-3 py-2.5 text-xs font-medium uppercase tracking-wide text-fg-subtle', alignClass[col.align ?? 'left'], col.className)}
                >
                  {col.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col)}
                      className={cn('-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 uppercase tracking-wide transition-colors hover:text-fg', active && 'text-fg', col.align === 'right' && 'flex-row-reverse')}
                    >
                      {col.header}
                      <SortIcon className={cn('size-3', !active && 'opacity-50')} aria-hidden />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                {selectable && (
                  <td className="px-3 py-3">
                    <Skeleton className="size-4" />
                  </td>
                )}
                {columns.map((col) => (
                  <td key={col.key} className={cn('px-3 py-3', col.className)}>
                    <Skeleton className={cn('h-4', i % 3 === 0 ? 'w-3/4' : i % 3 === 1 ? 'w-1/2' : 'w-2/3')} />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={colSpan}>{empty}</td>
            </tr>
          ) : (
            rows.map((row) => {
              const id = getRowId(row);
              const isSelected = selected.has(id);
              return (
                <tr
                  key={id}
                  data-state={isSelected ? 'selected' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn('border-b border-border transition-colors last:border-0 hover:bg-surface-muted/60 data-[state=selected]:bg-primary-soft', onRowClick && 'cursor-pointer')}
                >
                  {selectable && (
                    <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={isSelected} onCheckedChange={(c) => toggleRow(id, c === true)} aria-label="Select row" />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key} className={cn('px-3 py-3 align-middle text-fg', alignClass[col.align ?? 'left'], col.className)}>
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
