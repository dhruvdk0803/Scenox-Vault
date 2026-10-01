'use client';

import * as React from 'react';
import type { SortState } from '@/components/ui/data-table';

export interface ListStateInit {
  pageSize?: number;
  sort?: SortState | null;
}

/** Page / page size / search / sort / filter state for server-paginated lists. Any change except page resets to page 1. */
export function useListState<F extends Record<string, string | undefined> = Record<string, string | undefined>>(init: ListStateInit = {}, initialFilters?: F) {
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSizeState] = React.useState(init.pageSize ?? 25);
  const [q, setQState] = React.useState('');
  const [sort, setSortState] = React.useState<SortState | null>(init.sort ?? null);
  const [filters, setFilters] = React.useState<F>((initialFilters ?? {}) as F);

  const setQ = React.useCallback((v: string) => {
    setQState(v);
    setPage(1);
  }, []);
  const setPageSize = React.useCallback((n: number) => {
    setPageSizeState(n);
    setPage(1);
  }, []);
  const setSort = React.useCallback((s: SortState | null) => {
    setSortState(s);
    setPage(1);
  }, []);
  const setFilter = React.useCallback(<K extends keyof F>(key: K, value: F[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }, []);

  return { page, setPage, pageSize, setPageSize, q, setQ, sort, setSort, filters, setFilter };
}

/** Radix Select can't use "" as a value; filters use this sentinel for "all". */
export const ALL = 'all';
export const fromSelect = (v: string | undefined) => (!v || v === ALL ? undefined : v);
