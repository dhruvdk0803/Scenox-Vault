import type { FileDTO, Paginated } from '@scenox/shared';
import { api } from '@/lib/api';

/** Ids per POST /files/delete call (the API accepts more; this keeps each request quick and safely under limits). */
export const DELETE_CHUNK_SIZE = 500;
/** Page size used when walking a listing (the API caps pageSize at 200). */
export const LIST_PAGE_SIZE = 200;

export type PageFetcher = (page: number, pageSize: number) => Promise<Paginated<FileDTO>>;

/**
 * Walks a paginated file listing page by page and returns every file (optionally filtered client-side).
 * Stops when a page comes back empty or everything the server reported has been seen.
 */
export async function collectFiles(
  fetchPage: PageFetcher,
  opts: { filter?: (f: FileDTO) => boolean; onProgress?: (found: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<FileDTO[]> {
  const out: FileDTO[] = [];
  let seen = 0;
  for (let page = 1; ; page++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await fetchPage(page, LIST_PAGE_SIZE);
    for (const f of res.items) if (!opts.filter || opts.filter(f)) out.push(f);
    seen += res.items.length;
    opts.onProgress?.(out.length, res.total);
    if (res.items.length === 0 || seen >= res.total) break;
  }
  // Pages can overlap if rows change mid-walk; de-duplicate by id.
  const map = new Map(out.map((f) => [f.id, f]));
  return Array.from(map.values());
}

export interface DeleteResult {
  /** Ids confirmed deleted (every chunk that returned 204). */
  deleted: string[];
  /** Set when a chunk failed; the remaining ids were not attempted. */
  error?: unknown;
}

/** Deletes ids in chunks of 500 via POST /files/delete, reporting progress after each chunk. Never throws. */
export async function deleteFileIds(ids: string[], onProgress?: (done: number, total: number) => void): Promise<DeleteResult> {
  const deleted: string[] = [];
  onProgress?.(0, ids.length);
  for (let i = 0; i < ids.length; i += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + DELETE_CHUNK_SIZE);
    try {
      await api.post('/files/delete', { fileIds: chunk });
    } catch (error) {
      return { deleted, error };
    }
    deleted.push(...chunk);
    onProgress?.(deleted.length, ids.length);
  }
  return { deleted };
}
