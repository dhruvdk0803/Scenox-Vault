import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadManager, type TusUploadLike } from './manager';
import { createMemoryKV } from './kv';
import { createTusUrlStorage } from './url-storage';

type Opts = Record<string, (...a: any[]) => any> & { metadata: Record<string, string>; chunkSize: number };

class FakeUpload implements TusUploadLike {
  started = 0;
  aborted: boolean[] = [];
  resumedFrom: unknown = null;
  constructor(public file: File, public o: Opts, public previous: unknown[] = []) {}
  start() { this.started++; }
  async abort(t?: boolean) { this.aborted.push(!!t); }
  async findPreviousUploads() { return this.previous; }
  resumeFromPreviousUpload(p: never) { this.resumedFrom = p; }
  progress(n: number) { this.o.onProgress(n, this.file.size); }
  succeed() { this.o.onSuccess({}); }
  fail(status?: number) { this.o.onError({ originalResponse: status === undefined ? null : { getStatus: () => status } }); }
}

const mkFile = (name: string, size = 100) => new File([new Uint8Array(size)], name, { lastModified: 1000 });
const tick = () => new Promise((r) => setTimeout(r, 0));

let uploads: FakeUpload[];
let previous: unknown[];
let t: number;

function make(over: Partial<ConstructorParameters<typeof UploadManager>[0]> = {}) {
  const m = new UploadManager({
    portalToken: 'p',
    config: { endpoint: '/api/tus', maxConcurrentUploads: 6, defaultChunkSize: 64 * 1024 * 1024, minChunkSize: 8 * 1024 * 1024, maxChunkSize: 256 * 1024 * 1024, retryDelays: [10, 20] },
    session: { sessionId: 'sess', sessionToken: 'secret' },
    throttleMs: 0,
    now: () => t,
    urlStorage: createTusUrlStorage(createMemoryKV()),
    queueStore: null,
    tusFactory: (file, options) => {
      const u = new FakeUpload(file, options as Opts, previous);
      uploads.push(u);
      return u;
    },
    ...over,
  });
  return m;
}
const files = (n: number, size = 100) => Array.from({ length: n }, (_, i) => ({ file: mkFile(`f${i}.bin`, size), relativePath: i % 2 ? 'dir/sub' : '' }));
const byName = (n: string) => uploads.filter((u) => u.file.name === n).at(-1)!;

beforeEach(() => {
  uploads = [];
  previous = [];
  t = 1_000_000;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe('UploadManager scheduling', () => {
  it('starts at min(config, 4) concurrent uploads and starts the next file immediately on completion', async () => {
    const m = make();
    m.add(files(10));
    await tick();
    expect(uploads).toHaveLength(4);
    expect(m.getSnapshot().stats.activeFiles).toBe(4);
    expect(m.getSnapshot().stats.queuedFiles).toBe(6);
    byName('f0.bin').succeed();
    await tick();
    expect(uploads).toHaveLength(5);
    expect(m.getSnapshot().stats.completedFiles).toBe(1);
  });

  it('does not start before a session exists', async () => {
    const m = make({ session: null });
    m.add(files(2));
    await tick();
    expect(uploads).toHaveLength(0);
    m.setSession({ sessionId: 's', sessionToken: 't' });
    m.start();
    await tick();
    expect(uploads).toHaveLength(2);
  });

  it('sends tus metadata, session header and chunk size', async () => {
    const m = make();
    const f = mkFile('clip.mov', 100);
    m.add([{ file: f, relativePath: 'Shoot/Day 1', duplicateAction: 'keep_both', clientKey: 'ck1' }]);
    await tick();
    const u = uploads[0]!;
    expect(u.o.metadata).toMatchObject({
      filename: 'clip.mov', relativePath: 'Shoot/Day 1', sessionId: 'sess', clientKey: 'ck1', duplicateAction: 'keep_both', lastModified: '1000',
    });
    expect(u.o.chunkSize).toBe(100);
    const headers: Record<string, string> = {};
    u.o.onBeforeRequest({ setHeader: (k: string, v: string) => (headers[k] = v) });
    expect(headers['x-upload-session']).toBe('secret');
    expect(await u.o.fingerprint()).toBe('p|Shoot/Day 1|clip.mov|100|1000');
  });

  it('resumes from a previous tus upload for the same fingerprint', async () => {
    previous = [{ uploadUrl: '/api/tus/abc' }];
    const m = make();
    m.add(files(1));
    await tick();
    expect(uploads[0]!.resumedFrom).toEqual({ uploadUrl: '/api/tus/abc' });
    expect(uploads[0]!.started).toBe(1);
  });

  it('reduces concurrency after repeated retryable failures and recovers after a stable period', async () => {
    vi.useFakeTimers();
    const m = make();
    m.add(files(8));
    await vi.advanceTimersByTimeAsync(0);
    const first = uploads[0]!;
    expect(first.o.onShouldRetry({ originalResponse: { getStatus: () => 503 } }, 0)).toBe(true);
    expect(first.o.onShouldRetry({ originalResponse: { getStatus: () => 503 } }, 1)).toBe(true);
    expect(m.concurrency.current).toBe(3);
    for (let i = 0; i < 62; i++) {
      t += 1000;
      for (const u of uploads) u.progress(i + 1); // keep uploads alive (no stall / sleep detection)
      m.tick();
    }
    expect(m.concurrency.current).toBe(4);
  });
});

describe('UploadManager progress & status', () => {
  it('derives progress from bytes, moves to processing at 100%, then completed', async () => {
    const m = make();
    m.add(files(1, 1000));
    await tick();
    const u = uploads[0]!;
    t += 500; u.progress(100);
    t += 500; u.progress(500);
    let s = m.getSnapshot();
    expect(s.items[0]!.status).toBe('uploading');
    expect(s.items[0]!.progress).toBe(50);
    expect(s.stats.percent).toBe(50);
    t += 500; u.progress(1000);
    s = m.getSnapshot();
    expect(s.items[0]!.status).toBe('processing');
    u.succeed();
    s = m.getSnapshot();
    expect(s.items[0]!.status).toBe('completed');
    expect(s.stats.finished).toBe(true);
    expect(s.stats.percent).toBe(100);
  });

  it('reports ETA only after the speed has been stable', async () => {
    const m = make();
    m.add(files(1, 10_000_000));
    await tick();
    const u = uploads[0]!;
    u.progress(0);
    t += 500; u.progress(500_000);
    expect(m.getSnapshot().stats.etaSeconds).toBeNull();
    for (let i = 0; i < 6; i++) { t += 500; u.progress(500_000 * (i + 2)); }
    const s = m.getSnapshot();
    expect(s.stats.speed).toBeGreaterThan(900_000);
    expect(s.stats.etaSeconds).not.toBeNull();
    expect(s.items[0]!.speed).toBeGreaterThan(0);
  });

  it('increments runId when new work arrives after the queue drained', async () => {
    const m = make();
    m.add(files(1));
    await tick();
    const run1 = m.getSnapshot().runId;
    uploads[0]!.succeed();
    expect(m.getSnapshot().stats.finished).toBe(true);
    m.add(files(1));
    expect(m.getSnapshot().runId).toBe(run1 + 1);
  });

  it('throttles change notifications', async () => {
    vi.useFakeTimers();
    const m = make({ throttleMs: 100, now: () => Date.now() });
    m.add(files(1, 1_000_000));
    await vi.advanceTimersByTimeAsync(0);
    const listener = vi.fn();
    m.subscribe(listener);
    for (let i = 0; i < 100; i++) { await vi.advanceTimersByTimeAsync(5); uploads[0]!.progress(i * 1000); }
    expect(listener.mock.calls.length).toBeLessThanOrEqual(7);
    expect(listener.mock.calls.length).toBeGreaterThan(2);
  });

  it('keeps snapshots immutable between emits', async () => {
    const m = make();
    m.add(files(2));
    await tick();
    const a = m.getSnapshot();
    const itemRef = a.items[0];
    uploads[1]!.progress(50);
    const b = m.getSnapshot();
    expect(b).not.toBe(a);
    expect(b.items[0]).toBe(itemRef); // unchanged item keeps identity
    expect(a.items[1]!.bytesUploaded).toBe(0);
  });
});

describe('UploadManager controls', () => {
  it('pause aborts without terminating; resume continues via findPreviousUploads', async () => {
    previous = [];
    const m = make();
    const [id] = m.add(files(1, 1000));
    await tick();
    const u = uploads[0]!;
    u.progress(400);
    m.pause(id!);
    expect(u.aborted).toEqual([false]);
    expect(m.getSnapshot().items[0]!.status).toBe('paused');
    u.progress(900); // late callback from the aborted run is ignored
    expect(m.getSnapshot().items[0]!.bytesUploaded).toBe(400);
    previous = [{ uploadUrl: '/api/tus/x' }];
    m.resume(id!);
    await tick();
    expect(uploads).toHaveLength(2);
    expect(uploads[1]!.resumedFrom).toEqual({ uploadUrl: '/api/tus/x' });
    expect(m.getSnapshot().items[0]!.status).toBe('uploading');
  });

  it('pauseAll stops starting new files; resumeAll continues', async () => {
    const m = make();
    m.add(files(6));
    await tick();
    m.pauseAll();
    expect(m.getSnapshot().stats.pausedFiles).toBe(4);
    expect(m.getSnapshot().paused).toBe(true);
    m.resumeAll();
    await tick();
    expect(m.getSnapshot().stats.activeFiles).toBe(4);
    expect(m.getSnapshot().paused).toBe(false);
  });

  it('cancel terminates the upload (abort(true)) and frees the slot', async () => {
    const m = make();
    const ids = m.add(files(5));
    await tick();
    m.cancel(ids[0]!);
    expect(uploads[0]!.aborted).toEqual([true]);
    await tick();
    expect(uploads).toHaveLength(5);
    expect(m.getSnapshot().stats.cancelledFiles).toBe(1);
    m.cancelAll();
    expect(m.getSnapshot().stats.finished).toBe(true);
  });

  it('cancelling a queued file never starts it', async () => {
    const m = make();
    const ids = m.add(files(6));
    await tick();
    m.cancel(ids[5]!);
    for (const u of [...uploads]) u.succeed();
    await tick();
    expect(uploads).toHaveLength(5);
  });
});

describe('UploadManager errors', () => {
  it('only asks tus to retry network errors, 5xx and 408/409/423/429', async () => {
    const m = make();
    m.add(files(1));
    await tick();
    const o = uploads[0]!.o;
    const r = (s?: number) => o.onShouldRetry(s === undefined ? { originalResponse: null } : { originalResponse: { getStatus: () => s } }, 0);
    expect([r(), r(500), r(409), r(429), r(408), r(423)]).toEqual([true, true, true, true, true, true]);
    expect([r(400), r(403), r(404), r(413)]).toEqual([false, false, false, false]);
    expect(m.getSnapshot().items[0]!.warning).toMatch(/retry automatically/);
  });

  it('marks a file failed after retries are exhausted, and retry() resumes it', async () => {
    const m = make();
    const [id] = m.add(files(1));
    await tick();
    uploads[0]!.fail(503);
    let item = m.getSnapshot().items[0]!;
    expect(item.status).toBe('failed');
    expect(item.error).toMatch(/paused after several attempts/);
    expect(item.autoRetrying).toBe(true);
    expect(m.getSnapshot().stats.finished).toBe(false); // waiting for automatic retry
    m.retry(id!);
    await tick();
    expect(uploads).toHaveLength(2);
    item = m.getSnapshot().items[0]!;
    expect(item.status).toBe('uploading');
  });

  it('automatically retries failed files after the backoff', async () => {
    vi.useFakeTimers();
    const m = make({ now: () => Date.now() });
    m.add(files(1));
    await vi.advanceTimersByTimeAsync(0);
    uploads[0]!.fail(502);
    expect(m.getSnapshot().items[0]!.status).toBe('failed');
    await vi.advanceTimersByTimeAsync(16_000);
    m.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.getSnapshot().items[0]!.status).toBe('uploading');
  });

  it('does not auto-retry rejected files (4xx) and shows a friendly message', async () => {
    const m = make();
    m.add(files(1));
    await tick();
    uploads[0]!.fail(413);
    const item = m.getSnapshot().items[0]!;
    expect(item.status).toBe('failed');
    expect(item.autoRetrying).toBe(false);
    expect(item.error).toMatch(/larger than this link allows/);
    expect(m.getSnapshot().stats.finished).toBe(true);
  });

  it('on 401 renews the session once and continues; otherwise reports the expired-session message', async () => {
    const renew = vi.fn(async () => ({ sessionId: 's2', sessionToken: 'secret2' }));
    const m = make({ renewSession: renew });
    m.add(files(2));
    await tick();
    uploads[0]!.fail(401);
    await tick();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(m.getSession()?.sessionToken).toBe('secret2');
    expect(m.getSnapshot().stats.activeFiles).toBe(2);

    const m2 = make({ renewSession: async () => null });
    uploads = [];
    m2.add(files(2));
    await tick();
    uploads[0]!.fail(401);
    await tick();
    const s = m2.getSnapshot();
    expect(s.sessionExpired).toBe(true);
    expect(s.items.every((i) => i.status === 'failed' && /session expired/.test(i.error ?? ''))).toBe(true);
  });
});

describe('UploadManager connectivity', () => {
  it('pauses active uploads when offline and resumes them automatically when back online', async () => {
    const m = make();
    m.add(files(6));
    await tick();
    m.setOnline(false);
    let s = m.getSnapshot();
    expect(s.offline).toBe(true);
    expect(s.stats.activeFiles).toBe(0);
    expect(s.items.filter((i) => i.pausedBy === 'offline')).toHaveLength(4);
    expect(uploads.slice(0, 4).every((u) => u.aborted[0] === false)).toBe(true);
    m.setOnline(true);
    await tick();
    s = m.getSnapshot();
    expect(s.offline).toBe(false);
    expect(s.stats.activeFiles).toBe(4);
  });

  it('treats a network error while navigator is offline as a pause, not a failure', async () => {
    const m = make();
    m.add(files(1));
    await tick();
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    uploads[0]!.fail();
    await tick();
    const s = m.getSnapshot();
    expect(s.offline).toBe(true);
    expect(s.items[0]!.status).toBe('paused');
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
    m.setOnline(true);
    await tick();
    expect(m.getSnapshot().items[0]!.status).toBe('uploading');
  });

  it('restarts stalled uploads (no progress for stallMs)', async () => {
    vi.useFakeTimers();
    const m = make({ now: () => Date.now(), stallMs: 30_000 });
    m.add(files(1, 1000));
    await vi.advanceTimersByTimeAsync(0);
    uploads[0]!.progress(100);
    await vi.advanceTimersByTimeAsync(31_000);
    m.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(uploads[0]!.aborted).toEqual([false]);
    expect(uploads).toHaveLength(2);
  });
});
