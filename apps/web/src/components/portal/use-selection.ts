'use client';

import * as React from 'react';
import { scanDataTransfer, selectionKey, type PickedFile } from '@/lib/upload';

export interface SelectedFile {
  id: number;
  file: File;
  name: string;
  relativePath: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface ScanState {
  found: number;
}

/**
 * Files chosen but not yet uploading. Appends are buffered and flushed ~6x/s so scanning 10k+ files
 * causes a handful of renders, not thousands. De-duplicates identical files.
 */
export function useSelection() {
  const [items, setItems] = React.useState<SelectedFile[]>([]);
  const [scan, setScan] = React.useState<ScanState | null>(null);
  const keys = React.useRef(new Set<string>());
  const buffer = React.useRef<PickedFile[]>([]);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = React.useRef(0);
  const abort = React.useRef<AbortController | null>(null);

  const flush = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const picked = buffer.current;
    buffer.current = [];
    if (picked.length === 0) return;
    const fresh: SelectedFile[] = [];
    for (const p of picked) {
      const k = selectionKey(p.relativePath, p.name, p.file.size, p.file.lastModified);
      if (keys.current.has(k)) continue;
      keys.current.add(k);
      fresh.push({
        id: ++seq.current, file: p.file, name: p.name, relativePath: p.relativePath, size: p.file.size,
        type: p.file.type || '', lastModified: p.file.lastModified,
      });
    }
    if (fresh.length) setItems((prev) => prev.concat(fresh));
  }, []);

  const add = React.useCallback(
    (picked: PickedFile[]) => {
      if (picked.length === 0) return;
      buffer.current.push(...picked);
      if (!timer.current) timer.current = setTimeout(flush, 150);
    },
    [flush],
  );

  const scanDrop = React.useCallback(
    async (dt: DataTransfer) => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setScan({ found: 0 });
      try {
        await scanDataTransfer(dt, { signal: ac.signal, onFiles: add, onProgress: (found) => setScan({ found }) });
      } finally {
        flush();
        if (abort.current === ac) {
          abort.current = null;
          setScan(null);
        }
      }
    },
    [add, flush],
  );

  const cancelScan = React.useCallback(() => {
    abort.current?.abort();
  }, []);

  const rebuildKeys = (list: SelectedFile[]) => {
    keys.current = new Set(list.map((f) => selectionKey(f.relativePath, f.name, f.size, f.lastModified)));
  };

  const removeIds = React.useCallback((ids: Set<number>) => {
    setItems((prev) => {
      const next = prev.filter((f) => !ids.has(f.id));
      rebuildKeys(next);
      return next;
    });
  }, []);

  const removeFolder = React.useCallback((path: string) => {
    setItems((prev) => {
      const next = prev.filter((f) => f.relativePath !== path && !f.relativePath.startsWith(`${path}/`));
      rebuildKeys(next);
      return next;
    });
  }, []);

  const clear = React.useCallback(() => {
    abort.current?.abort();
    buffer.current = [];
    keys.current = new Set();
    setItems([]);
  }, []);

  React.useEffect(
    () => () => {
      abort.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const totalBytes = React.useMemo(() => items.reduce((n, f) => n + f.size, 0), [items]);

  return { items, totalBytes, scan, add, scanDrop, cancelScan, removeIds, removeFolder, clear };
}
