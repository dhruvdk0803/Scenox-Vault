import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ByteRange, MultipartUpload, StorageService, StoredObjectMeta } from './types';

export class LocalStorage implements StorageService {
  readonly driver = 'local' as const;

  constructor(private readonly root: string) {}

  /** Resolve a key to an absolute path, refusing anything that escapes the root. */
  localPath(key: string): string {
    if (typeof key !== 'string' || key === '' || key.includes('\0')) throw new Error('Invalid storage key');
    const resolved = path.resolve(this.root, key);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) throw new Error('Storage key escapes root');
    return resolved;
  }

  async init(): Promise<void> {
    for (const dir of ['tus', 'staging', 'uploads', 'quarantine', 'exports', 'branding']) {
      await fs.mkdir(path.join(this.root, dir), { recursive: true, mode: 0o750 });
    }
  }

  async put(key: string, body: Readable | Buffer): Promise<StoredObjectMeta> {
    const target = this.localPath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.part-${process.pid}-${Date.now()}`;
    try {
      await pipeline(Buffer.isBuffer(body) ? Readable.from(body) : body, createWriteStream(tmp, { mode: 0o640 }));
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return (await this.getMetadata(key))!;
  }

  async get(key: string, range?: ByteRange) {
    const p = this.localPath(key);
    const st = await fs.stat(p);
    const stream = createReadStream(p, range ? { start: range.start, end: range.end, highWaterMark: 1 << 20 } : { highWaterMark: 1 << 20 });
    return { stream, size: st.size };
  }

  async delete(key: string) {
    await fs.rm(this.localPath(key), { force: true });
    await this.pruneEmptyDirs(path.dirname(this.localPath(key)));
  }

  async deletePrefix(prefix: string) {
    await fs.rm(this.localPath(prefix), { recursive: true, force: true });
  }

  async exists(key: string) {
    try {
      await fs.access(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(key: string): Promise<StoredObjectMeta | null> {
    try {
      const st = await fs.stat(this.localPath(key));
      return { key, size: st.size, modifiedAt: st.mtime };
    } catch {
      return null;
    }
  }

  async move(fromKey: string, toKey: string) {
    const from = this.localPath(fromKey);
    const to = this.localPath(toKey);
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
    } catch (err: unknown) {
      // cross-device (e.g. tus dir on a different volume): copy + unlink, streamed
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await pipeline(createReadStream(from), createWriteStream(to, { mode: 0o640 }));
      await fs.rm(from, { force: true });
    }
  }

  async copy(fromKey: string, toKey: string) {
    const to = this.localPath(toKey);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(this.localPath(fromKey), to);
  }

  async sizeOfPrefix(prefix: string) {
    let bytes = 0;
    let files = 0;
    const walk = async (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          const st = await fs.stat(p).catch(() => null);
          if (st) {
            bytes += st.size;
            files++;
          }
        }
      }
    };
    await walk(this.localPath(prefix));
    return { bytes, files };
  }

  async createMultipartUpload(): Promise<MultipartUpload> {
    throw new Error('Multipart uploads are handled by tus on the local driver');
  }
  async completeMultipartUpload(): Promise<StoredObjectMeta> {
    throw new Error('Multipart uploads are handled by tus on the local driver');
  }
  async abortUpload(): Promise<void> {
    throw new Error('Multipart uploads are handled by tus on the local driver');
  }

  async getSignedDownloadUrl(): Promise<string | null> {
    return null; // local files are streamed through the authorised API route
  }

  async capacity() {
    const st = await fs.statfs(this.root);
    const totalBytes = st.blocks * st.bsize;
    const freeBytes = st.bavail * st.bsize;
    return { totalBytes, freeBytes, usedBytes: totalBytes - st.bfree * st.bsize, path: this.root };
  }

  private async pruneEmptyDirs(dir: string) {
    // remove now-empty parents up to (not including) the top-level prefix dirs
    let cur = dir;
    while (cur.startsWith(this.root + path.sep) && path.relative(this.root, cur).split(path.sep).length > 1) {
      try {
        await fs.rmdir(cur);
      } catch {
        return;
      }
      cur = path.dirname(cur);
    }
  }
}
