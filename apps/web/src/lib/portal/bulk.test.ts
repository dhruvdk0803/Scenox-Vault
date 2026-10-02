import { describe, expect, it, vi } from 'vitest';
import type { ClientBrowseResponse, ClientFileDTO } from '@scenox/shared';
import { chunk, collectPages, deleteInChunks, PartialDeleteError } from './bulk';

const file = (id: string, canDelete = true): ClientFileDTO => ({
  id, name: id, relativePath: '', extension: 'jpg', type: 'image', size: 10, status: 'ready', uploadedAt: null, uploadedBy: null, commentCount: 0, canDelete,
});
const page = (items: ClientFileDTO[], p: number, total: number, pageSize = 2): ClientBrowseResponse => ({
  path: '', breadcrumbs: [], folders: p === 1 ? [{ name: 'a', path: 'a', fileCount: 1, totalBytes: 1 }] : [], files: { items, total, page: p, pageSize },
});

describe('chunk', () => {
  it('splits into fixed-size parts', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('collectPages', () => {
  it('walks every page and keeps only deletable files', async () => {
    const pages = [page([file('1'), file('2', false)], 1, 3), page([file('3')], 2, 3)];
    const browse = vi.fn(async (n: number) => pages[n - 1]!);
    const r = await collectPages(browse);
    expect(browse).toHaveBeenCalledTimes(2);
    expect(r.files.map((f) => f.id)).toEqual(['1', '3']);
    expect(r.folders.map((f) => f.path)).toEqual(['a']);
  });
});

describe('deleteInChunks', () => {
  it('deletes in chunks of 500 and sums the result', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => String(i));
    const del = vi.fn(async (part: string[]) => ({ deleted: part.length }));
    const progress = vi.fn();
    expect(await deleteInChunks(del, ids, progress)).toBe(1201);
    expect(del.mock.calls.map((c) => c[0].length)).toEqual([500, 500, 201]);
    expect(progress).toHaveBeenLastCalledWith(1201, 1201);
  });
  it('reports how many were deleted when a chunk fails', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => String(i));
    const del = vi.fn().mockResolvedValueOnce({ deleted: 500 }).mockRejectedValueOnce(new Error('boom'));
    await expect(deleteInChunks(del, ids)).rejects.toMatchObject({ name: 'PartialDeleteError', deleted: 500 });
    expect(PartialDeleteError).toBeDefined();
  });
});
