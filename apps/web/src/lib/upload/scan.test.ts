import { describe, expect, it } from 'vitest';
import { entryRelativePath, filesFromFileList, isJunkFile, scanEntries, type EntryLike, type PickedFile } from './scan';

const file = (name: string, size = 1) => new File([new Uint8Array(size)], name);

function fileEntry(fullPath: string, f = file(fullPath.split('/').pop()!)): EntryLike {
  return { isFile: true, isDirectory: false, name: f.name, fullPath, file: (ok) => ok(f) };
}

/** readEntries returns `batchSize` entries per call, like Chrome's 100-entry batches. */
function dirEntry(fullPath: string, children: EntryLike[], batchSize = 100): EntryLike & { reads: number } {
  const e = {
    isFile: false,
    isDirectory: true,
    name: fullPath.split('/').pop()!,
    fullPath,
    reads: 0,
    createReader() {
      let i = 0;
      return {
        readEntries: (ok: (b: EntryLike[]) => void) => {
          e.reads++;
          const batch = children.slice(i, i + batchSize);
          i += batchSize;
          ok(batch);
        },
      };
    },
  };
  return e;
}

const collect = async (roots: EntryLike[]) => {
  const out: PickedFile[] = [];
  const progress: number[] = [];
  const n = await scanEntries(roots, {
    onFiles: (f) => out.push(...f),
    onProgress: (c) => progress.push(c),
    progressEvery: 50,
    yieldFn: async () => undefined,
  });
  return { out, n, progress };
};

describe('isJunkFile', () => {
  it('flags OS metadata files', () => {
    for (const n of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '._photo.jpg', 'THUMBS.DB']) expect(isJunkFile(n)).toBe(true);
    for (const n of ['photo.jpg', 'my.DS_Store.txt', '.gitignore']) expect(isJunkFile(n)).toBe(false);
  });
});

describe('entryRelativePath', () => {
  it('maps fullPath to the folder part only', () => {
    expect(entryRelativePath('/a.jpg')).toBe('');
    expect(entryRelativePath('/Shoot/a.jpg')).toBe('Shoot');
    expect(entryRelativePath('/Shoot/Day 1/raw/a.jpg')).toBe('Shoot/Day 1/raw');
  });
});

describe('filesFromFileList', () => {
  it('uses webkitRelativePath when present and drops junk', () => {
    const a = file('a.txt');
    Object.defineProperty(a, 'webkitRelativePath', { value: 'Folder/sub/a.txt' });
    const loose = file('b.txt');
    const junk = file('.DS_Store');
    const out = filesFromFileList([a, loose, junk]);
    expect(out.map((p) => [p.relativePath, p.name])).toEqual([['Folder/sub', 'a.txt'], ['', 'b.txt']]);
  });
});

describe('scanEntries', () => {
  it('walks nested folders, preserves structure and skips junk', async () => {
    const tree = dirEntry('/Project', [
      fileEntry('/Project/readme.txt'),
      fileEntry('/Project/.DS_Store'),
      dirEntry('/Project/img', [fileEntry('/Project/img/a.png'), fileEntry('/Project/img/Thumbs.db'), dirEntry('/Project/img/raw', [fileEntry('/Project/img/raw/b.cr3')])]),
      dirEntry('/Project/empty', []),
    ]);
    const { out, n } = await collect([tree, fileEntry('/loose.pdf')]);
    expect(n).toBe(4);
    expect(out.map((p) => `${p.relativePath}|${p.name}`).sort()).toEqual(
      ['|loose.pdf', 'Project/img/raw|b.cr3', 'Project/img|a.png', 'Project|readme.txt'].sort(),
    );
  });

  it('calls readEntries repeatedly until an empty batch (>100 entries per directory)', async () => {
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`/big/f${i}.txt`));
    const dir = dirEntry('/big', children, 100);
    const { out } = await collect([dir]);
    expect(out).toHaveLength(250);
    expect(dir.reads).toBe(4); // 100 + 100 + 50 + empty
  });

  it('handles 10,000+ files and reports progress while yielding', async () => {
    const dirs = Array.from({ length: 20 }, (_, d) =>
      dirEntry(`/d${d}`, Array.from({ length: 600 }, (_, i) => fileEntry(`/d${d}/f${i}.bin`))),
    );
    let yields = 0;
    const out: PickedFile[] = [];
    const progress: number[] = [];
    const n = await scanEntries(dirs, {
      onFiles: (f) => out.push(...f),
      onProgress: (c) => progress.push(c),
      yieldFn: async () => void yields++,
    });
    expect(n).toBe(12_000);
    expect(out).toHaveLength(12_000);
    expect(yields).toBeGreaterThan(20);
    expect(progress[progress.length - 1]).toBe(12_000);
  });

  it('skips unreadable files and respects abort', async () => {
    const bad: EntryLike = { isFile: true, isDirectory: false, name: 'x', fullPath: '/x', file: (_ok, err) => err?.('denied') };
    const { out } = await collect([bad, fileEntry('/ok.txt')]);
    expect(out.map((p) => p.name)).toEqual(['ok.txt']);

    const ac = new AbortController();
    ac.abort();
    const picked: PickedFile[] = [];
    await scanEntries([fileEntry('/a.txt')], { signal: ac.signal, onFiles: (f) => picked.push(...f) });
    expect(picked).toHaveLength(0);
  });
});
