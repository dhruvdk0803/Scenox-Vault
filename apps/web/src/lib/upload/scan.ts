import { sanitizeFilename, splitRelativeFilePath } from '@scenox/shared';

export interface PickedFile {
  file: File;
  name: string;
  /** Folder part only ('' for files at the root), e.g. "Shoot/Day 1". */
  relativePath: string;
}

const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized', 'icon\r', '.fseventsd', '.spotlight-v100', '.trashes']);

/** OS metadata files nobody wants uploaded (.DS_Store, Thumbs.db, desktop.ini, AppleDouble "._x"). */
export function isJunkFile(name: string): boolean {
  const n = name.toLowerCase();
  return JUNK_NAMES.has(n) || n.startsWith('._');
}

/** Folder part of a FileSystemEntry.fullPath ("/Shoot/Day 1/a.jpg" → "Shoot/Day 1"). */
export function entryRelativePath(fullPath: string): string {
  return splitRelativeFilePath(fullPath.replace(/^\/+/, '')).dir;
}

/** Map a File from <input type=file> (webkitRelativePath when a folder was chosen). */
export function pickFromFile(file: File): PickedFile {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (rel) {
    const { dir, name } = splitRelativeFilePath(rel);
    return { file, name: name || sanitizeFilename(file.name), relativePath: dir };
  }
  return { file, name: sanitizeFilename(file.name), relativePath: '' };
}

export function filesFromFileList(list: FileList | File[] | null | undefined): PickedFile[] {
  if (!list) return [];
  const out: PickedFile[] = [];
  for (const f of Array.from(list)) {
    const p = pickFromFile(f);
    if (!isJunkFile(f.name)) out.push(p);
  }
  return out;
}

/* ───────── drag & drop folder traversal (FileSystemEntry API) ───────── */

export interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(success: (f: File) => void, error?: (e: unknown) => void): void;
  createReader?(): { readEntries(success: (e: EntryLike[]) => void, error?: (e: unknown) => void): void };
}

export interface ScanOptions {
  signal?: AbortSignal;
  /** Called with each batch of files as soon as it's read (so the UI can stream results). */
  onFiles: (files: PickedFile[]) => void;
  /** Called with the running total roughly every `progressEvery` files. */
  onProgress?: (found: number) => void;
  progressEvery?: number;
  /** Yield to the event loop; injectable for tests. */
  yieldFn?: () => Promise<void>;
}

export function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function readFile(entry: EntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    try {
      entry.file!(
        (f) => resolve(f),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** readEntries returns at most ~100 entries per call — must be called until it yields an empty batch. */
async function readAllEntries(entry: EntryLike): Promise<EntryLike[]> {
  const reader = entry.createReader!();
  const all: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve) => {
      try {
        reader.readEntries(
          (e) => resolve(e),
          () => resolve([]),
        );
      } catch {
        resolve([]);
      }
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

/**
 * Walk dropped entries recursively (iteratively, with an explicit stack) in async batches so thousands of
 * files never freeze the page. Returns the number of files emitted.
 */
export async function scanEntries(roots: EntryLike[], opts: ScanOptions): Promise<number> {
  const yieldFn = opts.yieldFn ?? defaultYield;
  const every = opts.progressEvery ?? 100;
  let found = 0;
  let sinceYield = 0;
  const stack: EntryLike[] = [...roots].reverse();

  while (stack.length > 0) {
    if (opts.signal?.aborted) break;
    const entry = stack.pop()!;
    if (entry.isFile) {
      if (isJunkFile(entry.name)) continue;
      const file = await readFile(entry);
      if (!file) continue;
      const relativePath = entryRelativePath(entry.fullPath);
      opts.onFiles([{ file, name: sanitizeFilename(entry.name || file.name), relativePath }]);
      found += 1;
      sinceYield += 1;
    } else if (entry.isDirectory) {
      const children = await readAllEntries(entry);
      // Read this directory's files concurrently (bounded by directory size), subfolders go on the stack.
      const fileEntries = children.filter((c) => c.isFile && !isJunkFile(c.name));
      const dirs = children.filter((c) => c.isDirectory);
      for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]!);
      for (let i = 0; i < fileEntries.length; i += 64) {
        if (opts.signal?.aborted) break;
        const slice = fileEntries.slice(i, i + 64);
        const files = await Promise.all(slice.map(readFile));
        const picked: PickedFile[] = [];
        files.forEach((f, idx) => {
          if (!f) return;
          const e = slice[idx]!;
          picked.push({ file: f, name: sanitizeFilename(e.name || f.name), relativePath: entryRelativePath(e.fullPath) });
        });
        if (picked.length) {
          opts.onFiles(picked);
          found += picked.length;
          sinceYield += picked.length;
        }
        if (sinceYield >= every) {
          opts.onProgress?.(found);
          sinceYield = 0;
          await yieldFn();
        }
      }
    }
    if (found > 0 && sinceYield >= every) {
      opts.onProgress?.(found);
      sinceYield = 0;
      await yieldFn();
    }
  }
  opts.onProgress?.(found);
  return found;
}

/** Scan a drop event's DataTransfer. Entries MUST be captured synchronously, before any await. */
export async function scanDataTransfer(dt: DataTransfer, opts: ScanOptions): Promise<number> {
  const roots: EntryLike[] = [];
  const looseFiles: File[] = [];
  const items = dt.items ? Array.from(dt.items) : [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const getEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry;
    const entry = typeof getEntry === 'function' ? getEntry.call(item) : null;
    if (entry) roots.push(entry);
    else {
      const f = item.getAsFile();
      if (f) looseFiles.push(f);
    }
  }
  if (items.length === 0) looseFiles.push(...Array.from(dt.files ?? []));
  const direct = filesFromFileList(looseFiles);
  if (direct.length) opts.onFiles(direct);
  const n = await scanEntries(roots, opts);
  return n + direct.length;
}

export function supportsFolderPicker(): boolean {
  if (typeof document === 'undefined') return false;
  // iOS Safari exposes the attribute but can't pick folders.
  if (typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent)) return false;
  const input = document.createElement('input');
  return 'webkitdirectory' in input;
}
