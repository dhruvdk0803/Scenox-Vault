import { describe, expect, it } from 'vitest';
import { classifyError, shouldRetryStatus } from './errors';
import { makeClientKey, makeFingerprint, selectionKey } from './fingerprint';
import { chunkArray, preflightAll } from './portal-api';
import { createMemoryKV } from './kv';
import { createTusUrlStorage } from './url-storage';
import { QueueStore, summarizePending } from './queue-store';
import { ensureSession } from './session';

const resp = (status?: number) => ({ originalResponse: status === undefined ? null : { getStatus: () => status } });

describe('retry policy', () => {
  it('retries network errors, 5xx and 408/409/423/429 but never other 4xx', () => {
    for (const s of [undefined, 0, 500, 502, 503, 408, 409, 423, 429]) expect(shouldRetryStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 410, 413, 415, 422]) expect(shouldRetryStatus(s)).toBe(false);
  });
  it('classifies errors', () => {
    expect(classifyError(resp()).kind).toBe('network');
    expect(classifyError(resp(401)).kind).toBe('auth');
    expect(classifyError(resp(503)).kind).toBe('server');
    expect(classifyError(resp(429)).kind).toBe('server');
    expect(classifyError(resp(413)).kind).toBe('rejected');
  });
});

describe('fingerprint', () => {
  const base = { portalToken: 'tok', relativePath: 'a/b', name: 'x.mov', size: 10, lastModified: 5 };
  it('is stable and changes with any component', () => {
    expect(makeFingerprint(base)).toBe(makeFingerprint({ ...base }));
    expect(makeFingerprint(base)).toBe('tok|a/b|x.mov|10|5');
    for (const patch of [{ portalToken: 't2' }, { relativePath: 'a' }, { name: 'y.mov' }, { size: 11 }, { lastModified: 6 }]) {
      expect(makeFingerprint({ ...base, ...patch })).not.toBe(makeFingerprint(base));
    }
  });
  it('generates unique client keys and selection keys', () => {
    expect(new Set(Array.from({ length: 1000 }, makeClientKey)).size).toBe(1000);
    expect(selectionKey('a', 'b', 1, 2)).not.toBe(selectionKey('a', 'b', 1, 3));
  });
});

describe('preflightAll', () => {
  it('batches in groups of at most 1000 and merges results', async () => {
    const files = Array.from({ length: 2500 }, (_, i) => ({ clientKey: `k${i}`, name: `f${i}`, relativePath: '', size: 1 }));
    const sizes: number[] = [];
    const { results, quota } = await preflightAll('t', 's', files, undefined, async (_t, _s, batch) => {
      sizes.push(batch.length);
      return { results: batch.map((f) => ({ clientKey: f.clientKey, ok: true })), quota: { usedBytes: 0, limitBytes: null, requestedBytes: batch.length } };
    });
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(results).toHaveLength(2500);
    expect(quota?.requestedBytes).toBe(500);
    expect(chunkArray([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});

describe('tus url storage + queue store', () => {
  it('stores and finds uploads by fingerprint and removes them', async () => {
    const kv = createMemoryKV();
    const s = createTusUrlStorage(kv);
    const key = await s.addUpload('fp1', { size: 5, metadata: {}, creationTime: 'now', urlStorageKey: '', uploadUrl: '/api/tus/abc', parallelUploadUrls: null });
    const found = await s.findUploadsByFingerprint('fp1');
    expect(found[0]?.uploadUrl).toBe('/api/tus/abc');
    expect(found[0]?.urlStorageKey).toBe(key);
    expect(await s.findUploadsByFingerprint('other')).toEqual([]);
    await s.removeUpload(key);
    expect(await s.findAllUploads()).toEqual([]);
  });

  it('tracks pending files per portal and clears them with their tus urls', async () => {
    const kv = createMemoryKV();
    const q = new QueueStore(kv, 'tokA');
    const other = new QueueStore(kv, 'tokB');
    const rec = (n: string, size: number) => ({ fingerprint: `tokA|${n}`, name: n, relativePath: '', size, lastModified: 1, addedAt: 0 });
    await q.put([rec('a', 10), rec('b', 20)]);
    await other.put([{ ...rec('z', 1), fingerprint: 'tokB|z' }]);
    await createTusUrlStorage(kv).addUpload('tokA|a', { size: 10, metadata: {}, creationTime: '', urlStorageKey: '', uploadUrl: 'u', parallelUploadUrls: null });
    expect(summarizePending(await q.list())).toEqual({ count: 2, bytes: 30 });
    await q.remove(['tokA|a']);
    expect((await q.list()).map((r) => r.name)).toEqual(['b']);
    await q.clear();
    expect(await q.list()).toEqual([]);
    expect(await createTusUrlStorage(kv).findAllUploads()).toEqual([]);
    expect(await other.list()).toHaveLength(1);
  });
});

describe('ensureSession', () => {
  const intake = { name: 'Ann' };
  const totals = { totalFiles: 2, totalBytes: 10 };
  const created = { sessionId: 'new', sessionToken: 'tok-new', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

  it('reuses a stored session that the server still reports active', async () => {
    const kv = createMemoryKV();
    await kv.set('session:p', { sessionId: 'old', sessionToken: 'tok-old', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    let started = 0;
    const s = await ensureSession({
      kv, portalToken: 'p', intake, totals,
      api: { currentSession: async () => ({ sessionId: 'old', status: 'active', expiresAt: created.expiresAt }), startSession: async () => (started++, created) },
    });
    expect(s.sessionToken).toBe('tok-old');
    expect(started).toBe(0);
  });

  it('creates and persists a new session when the stored one is invalid', async () => {
    const kv = createMemoryKV();
    await kv.set('session:p', { sessionId: 'old', sessionToken: 'tok-old', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    let body: unknown;
    const s = await ensureSession({
      kv, portalToken: 'p', intake, totals,
      api: { currentSession: async () => ({ sessionId: 'old', status: 'completed', expiresAt: '' }), startSession: async (_t, b) => ((body = b), created) },
    });
    expect(s.sessionToken).toBe('tok-new');
    expect(body).toEqual({ name: 'Ann', totalFiles: 2, totalBytes: 10 });
    expect((await kv.get<{ sessionToken: string }>('session:p'))?.sessionToken).toBe('tok-new');
  });
});
