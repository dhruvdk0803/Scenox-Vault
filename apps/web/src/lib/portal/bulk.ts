import type { ClientBrowseResponse } from '@scenox/shared';
import { clientApi, type BrowseParams } from './api';

export interface FileEntry {
  id: string;
  size: number;
}

export const BROWSE_PAGE_SIZE = 200;
export const DELETE_CHUNK = 500;

type BrowsePage = (page: number) => Promise<ClientBrowseResponse>;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Pages through one /browse query and collects every deletable file (id + size). */
export async function collectPages(
  browse: BrowsePage, onProgress?: (found: number) => void, signal?: AbortSignal,
): Promise<{ files: FileEntry[]; folders: ClientBrowseResponse['folders'] }> {
  const seen = new Map<string, FileEntry>();
  let folders: ClientBrowseResponse['folders'] = [];
  for (let page = 1; ; page++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const r = await browse(page);
    if (page === 1) folders = r.folders;
    for (const f of r.files.items) if (f.canDelete && !seen.has(f.id)) seen.set(f.id, { id: f.id, size: f.size });
    onProgress?.(seen.size);
    if (r.files.items.length === 0 || page * r.files.pageSize >= r.files.total) break;
  }
  return { files: [...seen.values()], folders };
}

/** Every deletable file in the current view (same path / search / type filter). */
export async function collectView(token: string, view: Pick<BrowseParams, 'path' | 'q' | 'type'>, onProgress?: (n: number) => void, signal?: AbortSignal): Promise<FileEntry[]> {
  const { files } = await collectPages(
    (page) => clientApi.browse(token, { ...view, sort: 'uploadedAt', order: 'desc', page, pageSize: BROWSE_PAGE_SIZE }, signal),
    onProgress, signal,
  );
  return files;
}

/** Every deletable file in a folder, including all sub-folders. */
export async function collectFolder(token: string, folderPath: string, onProgress?: (n: number) => void, signal?: AbortSignal): Promise<FileEntry[]> {
  const all = new Map<string, FileEntry>();
  const queue = [folderPath];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const { files, folders } = await collectPages(
      (page) => clientApi.browse(token, { path, q: '', type: 'all', sort: 'uploadedAt', order: 'desc', page, pageSize: BROWSE_PAGE_SIZE }, signal),
      undefined, signal,
    );
    for (const f of files) all.set(f.id, f);
    for (const f of folders) if (!visited.has(f.path)) queue.push(f.path);
    onProgress?.(all.size);
  }
  return [...all.values()];
}

/**
 * Deletes in sequential chunks of 500. Resolves with the number the server reports as deleted;
 * if a chunk fails it throws a `PartialDeleteError` carrying how many were already gone.
 */
export class PartialDeleteError extends Error {
  /** `completedIds` are the ids from chunks that finished before the failure. */
  constructor(readonly deleted: number, readonly cause: unknown, readonly completedIds: string[] = []) {
    super('Delete failed part-way');
    this.name = 'PartialDeleteError';
  }
}

export async function deleteInChunks(
  deleteChunk: (ids: string[]) => Promise<{ deleted: number }>, ids: readonly string[], onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let deleted = 0;
  let done = 0;
  const completed: string[] = [];
  onProgress?.(0, ids.length);
  for (const part of chunk(ids, DELETE_CHUNK)) {
    try {
      deleted += (await deleteChunk(part)).deleted;
    } catch (e) {
      throw new PartialDeleteError(deleted, e, completed);
    }
    done += part.length;
    completed.push(...part);
    onProgress?.(done, ids.length);
  }
  return deleted;
}
