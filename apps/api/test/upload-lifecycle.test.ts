import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { getDb } from '../src/db';
import { activityLogs, clients, files, portals, uploadSessions } from '../src/db/schema';
import { processFile } from '../src/jobs';
import { closeQueues } from '../src/queue';
import { KEYS } from '../src/storage';
import { setupTestApp } from './helpers';
import { adminHeaders, seedPortal, sha256Hex, sleep, startSession, tusCreate, tusHead, tusPatch, type TusCtx } from './upload-utils';

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = await setupTestApp();
  app.server.requestTimeout = 0;
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await app.close();
  await closeQueues();
});

describe('upload lifecycle', () => {
  it('uploads with an interruption + resume, processes, lists, downloads (full + Range) and deletes', async () => {
    const { client, portal, token } = await seedPortal();
    const { body: session } = await startSession(app, token, { name: 'Jane' });
    const ctx: TusCtx = { base, sessionToken: session.sessionToken, sessionId: session.sessionId };

    const data = randomBytes(3 * 1024 * 1024 + 123);
    const c = await tusCreate(ctx, { name: 'photo.jpg', size: data.length, relativePath: 'shoot/day1' });
    expect(c.status).toBe(201);
    expect(c.location).toMatch(/^\/api\/tus\/[0-9a-f]{32}$/);

    // chunk 1 completes normally
    const first = 1024 * 1024;
    const p1 = await tusPatch(ctx, c.url!, 0, data.subarray(0, first));
    expect(p1).toEqual({ status: 204, offset: first });

    // chunk 2 is interrupted mid-body (connection aborted)
    const ac = new AbortController();
    const partial = data.subarray(first, first + 300_000);
    const body = new ReadableStream<Uint8Array>({ start: (cn) => cn.enqueue(new Uint8Array(partial)) });
    const aborted = fetch(c.url!, {
      method: 'PATCH',
      headers: { 'tus-resumable': '1.0.0', 'x-upload-session': ctx.sessionToken, 'upload-offset': String(first), 'content-type': 'application/offset+octet-stream' },
      body,
      duplex: 'half',
      signal: ac.signal,
    } as RequestInit);
    await sleep(400);
    ac.abort();
    await aborted.catch(() => {});
    await sleep(500);

    // resume: ask the server where we are, then send the rest
    const head = await tusHead(ctx, c.url!);
    expect(head.status).toBe(200);
    expect(head.length).toBe(data.length);
    expect(head.offset).toBeGreaterThanOrEqual(first);
    expect(head.offset).toBeLessThan(data.length);
    const p3 = await tusPatch(ctx, c.url!, head.offset, data.subarray(head.offset));
    expect(p3.status).toBe(204);
    expect(p3.offset).toBe(data.length);

    // file moved to staging, sidecar removed, counters updated
    const [row] = await getDb().select().from(files).where(eq(files.tusId, c.location!.split('/').pop()!));
    expect(row!.status).toBe('processing');
    expect(row!.relativePath).toBe('shoot/day1');
    const storageRoot = config().storage.path;
    await expect(fs.stat(path.join(storageRoot, KEYS.stagingKey(row!.storedFilename)))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(storageRoot, 'tus', `${row!.tusId}.json`))).rejects.toThrow();
    const [sess1] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, session.sessionId));
    expect(sess1!.uploadedFiles).toBe(1);
    expect(Number(sess1!.uploadedBytes)).toBe(data.length);

    // a HEAD for the finished upload reports it complete
    const doneHead = await tusHead(ctx, c.url!);
    expect(doneHead).toMatchObject({ status: 200, offset: data.length, length: data.length });

    // background processing
    await processFile(row!.id);
    await processFile(row!.id); // idempotent
    const [ready] = await getDb().select().from(files).where(eq(files.id, row!.id));
    expect(ready!.status).toBe('ready');
    expect(ready!.checksumSha256).toBe(sha256Hex(data));
    expect(ready!.storageKey).toBe(KEYS.fileKey(client.id, portal.id, session.sessionId, row!.storedFilename));
    expect(ready!.scanStatus).toBe('skipped');
    const onDisk = await fs.readFile(path.join(storageRoot, ready!.storageKey!));
    expect(sha256Hex(onDisk)).toBe(sha256Hex(data));
    await expect(fs.stat(path.join(storageRoot, KEYS.stagingKey(row!.storedFilename)))).rejects.toThrow();

    const [cl] = await getDb().select().from(clients).where(eq(clients.id, client.id));
    const [po] = await getDb().select().from(portals).where(eq(portals.id, portal.id));
    expect([cl!.fileCount, Number(cl!.storageUsedBytes), po!.fileCount, Number(po!.storageUsedBytes)]).toEqual([1, data.length, 1, data.length]);

    // admin lists it
    const admin = await adminHeaders('owner');
    const list = await app.inject({ method: 'GET', url: `/api/files?clientId=${client.id}`, headers: admin.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ name: 'photo.jpg', relativePath: 'shoot/day1', status: 'ready', uploaderName: 'Jane', clientName: 'ABC Company' });

    // full download
    const dl = await app.inject({ method: 'GET', url: `/api/files/${row!.id}/download`, headers: admin.headers });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''photo.jpg");
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['accept-ranges']).toBe('bytes');
    expect(sha256Hex(dl.rawPayload)).toBe(sha256Hex(data));

    // Range
    const r = await app.inject({ method: 'GET', url: `/api/files/${row!.id}/download`, headers: { ...admin.headers, range: 'bytes=1000-2999' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 1000-2999/${data.length}`);
    expect(r.headers['content-length']).toBe('2000');
    expect(r.rawPayload.equals(data.subarray(1000, 3000))).toBe(true);
    const suffix = await app.inject({ method: 'GET', url: `/api/files/${row!.id}/download`, headers: { ...admin.headers, range: 'bytes=-100' } });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.equals(data.subarray(data.length - 100))).toBe(true);
    const bad = await app.inject({ method: 'GET', url: `/api/files/${row!.id}/download`, headers: { ...admin.headers, range: `bytes=${data.length + 5}-` } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${data.length}`);

    // downloaded activity logged for the full download and for Range starting at 0 only
    const logs = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.downloaded'));
    expect(logs).toHaveLength(1);

    // complete the session (idempotent), enqueue job
    const hdr = { 'x-upload-session': session.sessionToken };
    const complete = await app.inject({ method: 'POST', url: `/api/public/portals/${token}/sessions/complete`, headers: hdr, payload: { filesUploaded: 1, bytesUploaded: data.length, filesFailed: 0 } });
    expect(complete.statusCode).toBe(204);
    const again = await app.inject({ method: 'POST', url: `/api/public/portals/${token}/sessions/complete`, headers: hdr, payload: {} });
    expect(again.statusCode).toBe(204);
    const [sess2] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, session.sessionId));
    expect(sess2!.status).toBe('completed');
    expect(sess2!.completedAt).toBeTruthy();
    expect(Number(sess2!.avgSpeedBps)).toBeGreaterThan(0);

    // delete removes bytes and decrements counters
    const del = await app.inject({ method: 'DELETE', url: `/api/files/${row!.id}`, headers: admin.headers });
    expect(del.statusCode).toBe(204);
    await expect(fs.stat(path.join(storageRoot, ready!.storageKey!))).rejects.toThrow();
    const [cl2] = await getDb().select().from(clients).where(eq(clients.id, client.id));
    const [po2] = await getDb().select().from(portals).where(eq(portals.id, portal.id));
    const [s3] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, session.sessionId));
    expect([cl2!.fileCount, Number(cl2!.storageUsedBytes), po2!.fileCount, Number(po2!.storageUsedBytes), s3!.uploadedFiles]).toEqual([0, 0, 0, 0, 0]);
    expect((await app.inject({ method: 'GET', url: `/api/files/${row!.id}`, headers: admin.headers })).statusCode).toBe(404);
  });

  it('cancels an upload via DELETE (termination)', async () => {
    const { token } = await seedPortal();
    const { body: session } = await startSession(app, token);
    const ctx: TusCtx = { base, sessionToken: session.sessionToken, sessionId: session.sessionId };
    const c = await tusCreate(ctx, { name: 'x.bin', size: 1000 });
    expect(c.status).toBe(201);
    const del = await fetch(c.url!, { method: 'DELETE', headers: { 'tus-resumable': '1.0.0', 'x-upload-session': ctx.sessionToken } });
    expect(del.status).toBe(204);
    await sleep(200);
    const [row] = await getDb().select().from(files).where(eq(files.tusId, c.location!.split('/').pop()!));
    expect(row!.status).toBe('cancelled');
    expect((await tusHead(ctx, c.url!)).status).toBe(404);
  });
});
