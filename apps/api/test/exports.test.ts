import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { getDb } from '../src/db';
import { activityLogs, exportJobs } from '../src/db/schema';
import { buildExportZip } from '../src/jobs';
import { closeQueues, getQueue, QUEUES } from '../src/queue';
import { resetDatabase, setupTestApp } from './helpers';
import { adminHeaders, seedPortal, seedReadyFile, seedSession } from './upload-utils';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  await getQueue(QUEUES.exports).obliterate({ force: true });
});
afterAll(async () => {
  await app.close();
  await closeQueues();
});

/** Minimal ZIP reader: walks the central directory (store method only). */
function readZip(buf: Buffer) {
  expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304'); // local file header
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: { name: string; method: number; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    entries.push({ name, method, data: buf.subarray(start, start + csize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe('exports', () => {
  it('creates a job for ready files only, builds a valid stored ZIP, and serves it to its owner', async () => {
    const { portal } = await seedPortal();
    const session = await seedSession(portal);
    const a = await seedReadyFile(portal, session, { name: 'a.txt', relativePath: '', data: Buffer.from('alpha') });
    const b = await seedReadyFile(portal, session, { name: 'b.txt', relativePath: 'dir/sub', data: Buffer.from('bravo!') });
    const c = await seedReadyFile(portal, session, { name: 'a.txt', relativePath: '', data: Buffer.from('charlie') }); // same name → de-duplicated
    const q = await seedReadyFile(portal, session, { name: 'bad.txt', status: 'quarantined' });
    const admin = await adminHeaders('member');

    const res = await app.inject({ method: 'POST', url: '/api/exports', headers: admin.headers, payload: { fileIds: [a.file.id, b.file.id, c.file.id, q.file.id, a.file.id] } });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto).toMatchObject({ status: 'queued', fileCount: 3, totalBytes: 5 + 6 + 7, progress: 0, downloadUrl: null });
    expect((await getQueue(QUEUES.exports).getJobs(['waiting', 'delayed', 'active'])).length).toBe(1);

    await buildExportZip(dto.id);
    const poll = await app.inject({ method: 'GET', url: `/api/exports/${dto.id}`, headers: admin.headers });
    expect(poll.json()).toMatchObject({ status: 'ready', progress: 1, downloadUrl: `/api/exports/${dto.id}/download` });
    expect(poll.json().outputSize).toBeGreaterThan(0);
    expect(new Date(poll.json().expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);

    const dl = await app.inject({ method: 'GET', url: `/api/exports/${dto.id}/download`, headers: admin.headers });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(Number(dl.headers['content-length'])).toBe(dl.rawPayload.length);
    expect(dl.headers['content-disposition']).toContain('.zip');
    const entries = readZip(dl.rawPayload);
    expect(entries.every((e) => e.method === 0)).toBe(true); // stored, not recompressed
    expect(Object.fromEntries(entries.map((e) => [e.name, e.data.toString()]))).toEqual({
      'a.txt': 'alpha',
      'a (1).txt': 'charlie',
      'dir/sub/b.txt': 'bravo!',
    });
    // temp part file is gone; zip lives at the export key
    const files = await fs.readdir(path.join(config().storage.path, 'exports'));
    expect(files).toEqual([`${dto.id}.zip`]);
    expect(await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'export.downloaded'))).toHaveLength(1);

    // listing: own exports only
    expect((await app.inject({ method: 'GET', url: '/api/exports', headers: admin.headers })).json()).toHaveLength(1);
    const other = await adminHeaders('member');
    expect((await app.inject({ method: 'GET', url: '/api/exports', headers: other.headers })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/exports/${dto.id}`, headers: other.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/exports/${dto.id}/download`, headers: other.headers })).statusCode).toBe(404);
    // settings.manage (owner/admin) may fetch anyone's export
    const owner = await adminHeaders('owner');
    expect((await app.inject({ method: 'GET', url: `/api/exports/${dto.id}/download`, headers: owner.headers })).statusCode).toBe(200);
  });

  it('streams large entries without recompression and reports checksums intact', async () => {
    const { portal } = await seedPortal();
    const session = await seedSession(portal);
    const big = Buffer.alloc(5 * 1024 * 1024, 9);
    const f = await seedReadyFile(portal, session, { name: 'big.bin', data: big });
    const admin = await adminHeaders('owner');
    const job = (await app.inject({ method: 'POST', url: '/api/exports', headers: admin.headers, payload: { fileIds: [f.file.id] } })).json();
    await buildExportZip(job.id);
    const dl = await app.inject({ method: 'GET', url: `/api/exports/${job.id}/download`, headers: admin.headers });
    const [entry] = readZip(dl.rawPayload);
    expect(createHash('sha256').update(entry!.data).digest('hex')).toBe(createHash('sha256').update(big).digest('hex'));
  });

  it('validates input and handles missing files / expiry', async () => {
    const { portal } = await seedPortal();
    const session = await seedSession(portal);
    const admin = await adminHeaders('owner');
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/exports', headers: admin.headers, payload: payload as object });
    expect((await post({ fileIds: [] })).statusCode).toBe(400);
    expect((await post({ fileIds: ['nope'] })).statusCode).toBe(400);
    expect((await post({ fileIds: Array.from({ length: 10_001 }, () => '00000000-0000-4000-8000-000000000000') })).statusCode).toBe(400);
    const none = await post({ fileIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.message).toMatch(/ready/);

    // a file that vanished from disk is skipped and noted; if nothing can be read the job fails gracefully
    const gone = await seedReadyFile(portal, session, { name: 'gone.txt' });
    const here = await seedReadyFile(portal, session, { name: 'here.txt' });
    await fs.rm(gone.abs);
    const job = (await post({ fileIds: [gone.file.id, here.file.id] })).json();
    await buildExportZip(job.id);
    const done = (await app.inject({ method: 'GET', url: `/api/exports/${job.id}`, headers: admin.headers })).json();
    expect(done.status).toBe('ready');
    expect(done.error).toMatch(/1 file was unavailable/);

    const job2 = (await post({ fileIds: [gone.file.id] })).json();
    await buildExportZip(job2.id);
    const failed = (await app.inject({ method: 'GET', url: `/api/exports/${job2.id}`, headers: admin.headers })).json();
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('The ZIP could not be created. Please try again.');

    // not ready → 409; expired → 410
    const queued = (await post({ fileIds: [here.file.id] })).json();
    expect((await app.inject({ method: 'GET', url: `/api/exports/${queued.id}/download`, headers: admin.headers })).statusCode).toBe(409);
    await getDb().update(exportJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(exportJobs.id, job.id));
    expect((await app.inject({ method: 'GET', url: `/api/exports/${job.id}/download`, headers: admin.headers })).statusCode).toBe(410);
  });
});
