'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatNumber } from '@scenox/shared';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { SimpleSelect } from './select';

export interface PaginationProps {
  page: number; // 1-based
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, pageSizeOptions = [25, 50, 100], className }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className={cn('flex flex-wrap items-center justify-between gap-3 text-sm text-fg-muted', className)}>
      <p className="tabular-nums" aria-live="polite">
        {total === 0 ? 'No results' : `${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}`}
      </p>
      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <SimpleSelect
            aria-label="Rows per page"
            className="h-8 w-[5.5rem] text-xs"
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
            options={pageSizeOptions.map((n) => ({ value: String(n), label: `${n} / page` }))}
          />
        )}
        <span className="px-1 tabular-nums">
          Page {page} of {pageCount}
        </span>
        <Button variant="outline" size="icon" className="size-8" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft aria-hidden />
        </Button>
        <Button variant="outline" size="icon" className="size-8" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount} aria-label="Next page">
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
