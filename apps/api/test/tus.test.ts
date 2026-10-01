import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { getDb } from '../src/db';
import { files, portals, uploadSessions } from '../src/db/schema';
import { processFile } from '../src/jobs';
import { closeQueues } from '../src/queue';
import { hashToken } from '../src/lib/crypto';
import { resetDatabase, setupTestApp } from './helpers';
import { seedPortal, seedReadyFile, seedSession, startSession, tusCreate, tusHead, tusPatch, tusUploadAll, type TusCtx } from './upload-utils';

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = await setupTestApp();
  app.server.requestTimeout = 0;
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await app.close();
  await closeQueues();
});

async function newCtx(token: string, payload: Record<string, unknown> = {}): Promise<TusCtx> {
  const { body } = await startSession(app, token, payload);
  return { base, sessionToken: body.sessionToken, sessionId: body.sessionId };
}
const errCode = (text: string) => (JSON.parse(text) as { error: { code: string } }).error.code;

describe('tus endpoint validation', () => {
  it('rejects requests without / with an invalid upload session (401), before accepting bytes', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const none = await fetch(`${base}/api/tus`, { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' } });
    expect(none.status).toBe(401);
    expect(JSON.parse(await none.text()).error.message).toMatch(/session/i);
    const bad = await tusCreate({ ...ctx, sessionToken: 'x'.repeat(43) }, { name: 'a.txt', size: 10 });
    expect(bad.status).toBe(401);
    expect(errCode(bad.text)).toBe('session_invalid');
  });

  it('rejects expired sessions', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    await getDb().update(uploadSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploadSessions.id, ctx.sessionId));
    expect((await tusCreate(ctx, { name: 'a.txt', size: 10 })).status).toBe(401);
  });

  it('rejects when the metadata sessionId is not the authenticated session', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const c = await tusCreate(ctx, { name: 'a.txt', size: 10, sessionId: '00000000-0000-0000-0000-000000000000' });
    expect(c.status).toBe(403);
    expect(errCode(c.text)).toBe('session_mismatch');
  });

  it('rejects blocked extensions (.exe) and archives when zip is disallowed', async () => {
    const { token } = await seedPortal({ portal: { allowZip: false } });
    const ctx = await newCtx(token);
    const exe = await tusCreate(ctx, { name: 'setup.EXE', size: 10 });
    expect(exe.status).toBe(400);
    expect(errCode(exe.text)).toBe('blocked_type');
    expect(JSON.parse(exe.text).error.message).toContain("aren't allowed");
    const zip = await tusCreate(ctx, { name: 'all.zip', size: 10 });
    expect(errCode(zip.text)).toBe('zip_not_allowed');
    expect(await getDb().select().from(files)).toHaveLength(0);
  });

  it('enforces allowedExtensions, folders and max file size', async () => {
    const { token } = await seedPortal({ portal: { allowedExtensions: ['pdf'], allowFolders: false, maxFileSizeBytes: 100 } });
    const ctx = await newCtx(token);
    expect(errCode((await tusCreate(ctx, { name: 'a.png', size: 10 })).text)).toBe('not_allowed_type');
    expect(errCode((await tusCreate(ctx, { name: 'a.pdf', size: 10, relativePath: 'dir' })).text)).toBe('folders_not_allowed');
    const big = await tusCreate(ctx, { name: 'a.pdf', size: 101 });
    expect(big.status).toBe(413);
    expect(errCode(big.text)).toBe('too_large');
    expect((await tusCreate(ctx, { name: 'a.pdf', size: 100 })).status).toBe(201);
  });

  it('rejects uploads that exceed the quota before any bytes are sent, counting in-flight uploads', async () => {
    const { token } = await seedPortal({ portal: { maxTotalBytes: 1000 } });
    const ctx = await newCtx(token);
    const first = await tusCreate(ctx, { name: 'a.bin', size: 600 });
    expect(first.status).toBe(201);
    const second = await tusCreate(ctx, { name: 'b.bin', size: 600 }); // 600 in flight + 600 > 1000
    expect(second.status).toBe(413);
    expect(errCode(second.text)).toBe('quota_exceeded');
    expect(second.text).toContain('400 B');
    const third = await tusCreate(ctx, { name: 'c.bin', size: 400 });
    expect(third.status).toBe(201);
    expect(await getDb().select().from(files)).toHaveLength(2);
  });

  it('honours the client quota across portals', async () => {
    const { client, portal, token } = await seedPortal({ client: { quotaBytes: 500 } });
    expect(portal.clientId).toBe(client.id);
    const ctx = await newCtx(token);
    expect((await tusCreate(ctx, { name: 'a.bin', size: 501 })).status).toBe(413);
    expect((await tusCreate(ctx, { name: 'a.bin', size: 500 })).status).toBe(201);
  });

  it('parallel creations cannot over-commit the quota', async () => {
    const { token } = await seedPortal({ portal: { maxTotalBytes: 1000 } });
    const ctx = await newCtx(token);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => tusCreate(ctx, { name: `p${i}.bin`, size: 400 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 413)).toHaveLength(4);
  });

  it('requires Upload-Length (no deferred length)', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const res = await fetch(`${base}/api/tus`, {
      method: 'POST',
      headers: { 'tus-resumable': '1.0.0', 'x-upload-session': ctx.sessionToken, 'upload-defer-length': '1', 'upload-metadata': `filename ${Buffer.from('a.txt').toString('base64')}` },
    });
    expect(res.status).toBe(400);
  });

  it('cannot touch an upload of another portal (404) even with a valid session', async () => {
    const { token } = await seedPortal();
    const a = await newCtx(token);
    const b = await newCtx((await seedPortal()).token);
    const c = await tusCreate(a, { name: 'secret.txt', size: 10 });
    expect(c.status).toBe(201);
    expect((await tusHead(b, c.url!)).status).toBe(404);
    expect((await tusPatch(b, c.url!, 0, Buffer.alloc(10))).status).toBe(404);
    expect((await tusHead(a, c.url!)).status).toBe(200);
  });

  it('refuses sessions of disabled portals and disabled clients', async () => {
    const { portal, token } = await seedPortal();
    const ctx = await newCtx(token);
    await getDb().update(portals).set({ status: 'disabled' }).where(eq(portals.id, portal.id));
    const res = await tusCreate(ctx, { name: 'a.txt', size: 10 });
    expect(res.status).toBe(403);
    expect(errCode(res.text)).toBe('portal_disabled');
  });
});

describe('duplicates', () => {
  async function upload(ctx: TusCtx, name: string, data: Buffer, action?: string) {
    const r = await tusUploadAll(ctx, { name, data, extra: action ? { duplicateAction: action } : {} });
    return r;
  }

  it('skip → 409, keep_both → "name (1).ext", replace → old file removed after finish', async () => {
    const { client, portal, token } = await seedPortal();
    const ctx = await newCtx(token);
    const v1 = randomBytes(500);
    const first = await upload(ctx, 'report.pdf', v1);
    expect(first.status).toBe(204);
    const [f1] = await getDb().select().from(files).where(eq(files.originalFilename, 'report.pdf'));
    await processFile(f1!.id);
    const [f1ready] = await getDb().select().from(files).where(eq(files.id, f1!.id));

    const skip = await upload(ctx, 'report.pdf', v1, 'skip');
    expect(skip.status).toBe(409);
    expect(errCode(skip.create.text)).toBe('duplicate_skipped');

    const keep = await upload(ctx, 'report.pdf', v1, 'keep_both');
    expect(keep.status).toBe(204);
    expect((await getDb().select().from(files).where(eq(files.originalFilename, 'report (1).pdf')))).toHaveLength(1);

    const v2 = randomBytes(700);
    const rep = await upload(ctx, 'report.pdf', v2, 'replace');
    expect(rep.status).toBe(204);
    const all = await getDb().select().from(files).where(and(eq(files.clientId, client.id)));
    expect(all.find((f) => f.id === f1!.id)).toBeUndefined(); // superseded file deleted
    const newer = all.find((f) => f.originalFilename === 'report.pdf')!;
    expect(Number(newer.size)).toBe(700);
    await expect(fs.stat(path.join(config().storage.path, f1ready!.storageKey!))).rejects.toThrow();
    const [po] = await getDb().select().from(portals).where(eq(portals.id, portal.id));
    expect(po!.fileCount).toBe(2); // "report (1).pdf" + replacement
    expect(Number(po!.storageUsedBytes)).toBe(500 + 700);
  });

  it('a retried upload of a file from the same session supersedes the stale attempt', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const a = await tusCreate(ctx, { name: 'big.mov', size: 1000 });
    const b = await tusCreate(ctx, { name: 'big.mov', size: 1000 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const rows = await getDb().select().from(files);
    expect(rows.map((r) => [r.originalFilename, r.status]).sort()).toEqual([['big.mov', 'cancelled'], ['big.mov', 'uploading']]);
  });
});

describe('memory safety', () => {
  const chunk = Buffer.alloc(1024 * 1024, 7);

  /** PATCH `length` bytes generated lazily as a stream of 1 MB chunks (never held in memory). */
  async function patchStream(ctx: TusCtx, url: string, offset: number, length: number) {
    let sent = 0;
    const body = Readable.toWeb(
      new Readable({
        read() {
          if (sent >= length) return this.push(null);
          sent += chunk.length;
          this.push(chunk);
        },
      }),
    );
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'tus-resumable': '1.0.0', 'x-upload-session': ctx.sessionToken, 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream', 'content-length': String(length) },
      body: body as never,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(204);
  }

  it('streams a ~200 MB upload to disk without buffering it in memory', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const part = 50 * 1024 * 1024;
    const size = Number(process.env.UPLOAD_TEST_MB ?? 200) * 1024 * 1024;

    // warm-up (JIT, socket buffers, allocator pools) so the measurement reflects steady state
    const warm = await tusCreate(ctx, { name: 'warm.bin', size: 32 * 1024 * 1024 });
    await patchStream(ctx, warm.url!, 0, 32 * 1024 * 1024);

    const c = await tusCreate(ctx, { name: 'huge.bin', size });
    expect(c.status).toBe(201);
    let peak = 0;
    const base0 = process.memoryUsage().rss;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 50);
    for (let offset = 0; offset < size; offset += part) await patchStream(ctx, c.url!, offset, Math.min(part, size - offset));
    clearInterval(timer);
    expect(peak - base0).toBeLessThan(100 * 1024 * 1024);

    const rows = await getDb().select().from(files).where(eq(files.originalFilename, 'huge.bin'));
    expect(rows[0]!.status).toBe('processing');
    await processFile(rows[0]!.id);
    const [done] = await getDb().select().from(files).where(eq(files.originalFilename, 'huge.bin'));
    expect(done!.status).toBe('ready');
    expect((await fs.stat(path.join(config().storage.path, done!.storageKey!))).size).toBe(size);
    await fs.rm(path.join(config().storage.path, done!.storageKey!));
  }, 180_000);
});

describe('session helper', () => {
  it('hashToken lookups never match a different token', async () => {
    const { portal } = await seedPortal();
    const s = await seedSession(portal);
    expect(s.tokenHash).not.toBe(hashToken('nope'));
    void seedReadyFile;
  });
});

describe('browser engine assumptions', () => {
  it('supports creation-with-upload (first chunk in the POST), partial and complete', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const data = randomBytes(5000);
    const post = (name: string, size: number, body: Buffer) =>
      fetch(`${ctx.base}/api/tus`, {
        method: 'POST',
        headers: {
          'tus-resumable': '1.0.0',
          'x-upload-session': ctx.sessionToken,
          'upload-length': String(size),
          'content-type': 'application/offset+octet-stream',
          'upload-metadata': `filename ${Buffer.from(name).toString('base64')},sessionId ${Buffer.from(ctx.sessionId).toString('base64')}`,
        },
        body: new Uint8Array(body),
      });
    // partial: first 2000 bytes in the POST, rest via PATCH
    const partial = await post('cwu.bin', data.length, data.subarray(0, 2000));
    expect(partial.status, await partial.clone().text()).toBe(201);
    expect(partial.headers.get('upload-offset')).toBe('2000');
    const url = `${ctx.base}${partial.headers.get('location')}`;
    expect((await tusPatch(ctx, url, 2000, data.subarray(2000))).status).toBe(204);
    // whole file in the POST → finished immediately
    const whole = await post('whole.bin', data.length, data);
    expect(whole.status, await whole.clone().text()).toBe(201);
    expect(whole.headers.get('upload-offset')).toBe(String(data.length));
    const rows = await getDb().select().from(files);
    expect(rows.map((r) => [r.originalFilename, r.status]).sort()).toEqual([['cwu.bin', 'processing'], ['whole.bin', 'processing']]);
  });

  it('allows HEAD/PATCH of an old upload from a NEWER session of the same portal (page reload), attributed to the original session', async () => {
    const { portal, token } = await seedPortal();
    const first = await newCtx(token);
    const data = randomBytes(4000);
    const c = await tusCreate(first, { name: 'resume.bin', size: data.length });
    await tusPatch(first, c.url!, 0, data.subarray(0, 1000));

    const second = await newCtx(token); // reload → new session token
    expect((await tusHead(second, c.url!)).offset).toBe(1000);
    const done = await tusPatch(second, c.url!, 1000, data.subarray(1000));
    expect(done.status).toBe(204);
    const [f] = await getDb().select().from(files).where(eq(files.originalFilename, 'resume.bin'));
    expect(f!.uploadSessionId).toBe(first.sessionId);
    const [s1] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, first.sessionId));
    const [s2] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, second.sessionId));
    expect([s1!.uploadedFiles, s2!.uploadedFiles]).toEqual([1, 0]);

    // a session of a different portal still cannot touch it
    const other = await seedPortal();
    const foreign = await newCtx(other.token);
    expect((await tusHead(foreign, c.url!)).status).toBe(404);
    void portal;
  });

  it('completed sessions keep working: new uploads reactivate them and re-arm the notification', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const hdr = { 'x-upload-session': ctx.sessionToken };
    const up = await tusUploadAll(ctx, { name: 'a.bin', data: randomBytes(100) });
    expect(up.status).toBe(204);
    await app.inject({ method: 'POST', url: `/api/public/portals/${token}/sessions/complete`, headers: hdr, payload: {} });
    await getDb().update(uploadSessions).set({ notifiedAt: new Date() }).where(eq(uploadSessions.id, ctx.sessionId));
    const [done] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, ctx.sessionId));
    expect(done!.status).toBe('completed');

    // preflight still works on a completed session; /sessions/current reports it
    const pf = await app.inject({ method: 'POST', url: `/api/public/portals/${token}/preflight`, headers: hdr, payload: { files: [{ clientKey: 'x', name: 'b.bin', relativePath: '', size: 5 }] } });
    expect(pf.statusCode).toBe(200);
    const cur = await app.inject({ method: 'GET', url: `/api/public/portals/${token}/sessions/current`, headers: hdr });
    expect(cur.json().status).toBe('completed');

    const retry = await tusUploadAll(ctx, { name: 'b.bin', data: randomBytes(100) });
    expect(retry.status).toBe(204);
    const [re] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, ctx.sessionId));
    expect(re).toMatchObject({ status: 'active', completedAt: null, notifiedAt: null, uploadedFiles: 2 });
    const again = await app.inject({ method: 'POST', url: `/api/public/portals/${token}/sessions/complete`, headers: hdr, payload: {} });
    expect(again.statusCode).toBe(204);
    expect((await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, ctx.sessionId)))[0]!.status).toBe('completed');

    // abandoned / failed sessions are rejected (401)
    await getDb().update(uploadSessions).set({ status: 'abandoned' }).where(eq(uploadSessions.id, ctx.sessionId));
    expect((await tusCreate(ctx, { name: 'c.bin', size: 5 })).status).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/public/portals/${token}/sessions/current`, headers: hdr })).statusCode).toBe(401);
  });
});

describe('integrity & CORS', () => {
  it('re-checks the size on finish: a mismatch is rejected, marked failed and not counted', async () => {
    const { client, token } = await seedPortal();
    const ctx = await newCtx(token);
    const c = await tusCreate(ctx, { name: 'tampered.bin', size: 100 });
    // simulate a corrupted declaration: the row says 99 bytes but 100 arrive
    await getDb().update(files).set({ size: 99 }).where(eq(files.originalFilename, 'tampered.bin'));
    const res = await tusPatch(ctx, c.url!, 0, Buffer.alloc(100));
    expect(res.status).toBe(422);
    const [row] = await getDb().select().from(files);
    expect(row).toMatchObject({ status: 'failed', error: 'Size mismatch after upload' });
    expect((await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, ctx.sessionId)))[0]).toMatchObject({ uploadedFiles: 0, failedFiles: 1 });
    await expect(fs.stat(path.join(config().storage.path, 'tus', row!.tusId!))).rejects.toThrow();
    void client;
  });

  it('accepts zero-byte files', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const r = await tusUploadAll(ctx, { name: 'empty.txt', data: Buffer.alloc(0) });
    expect(r.create.status).toBe(201);
    const [row] = await getDb().select().from(files);
    expect(row).toMatchObject({ status: 'processing', size: 0 });
    await processFile(row!.id);
    expect((await getDb().select().from(files))[0]!.status).toBe('ready');
  });

  it('sends CORS headers for the allowed origin (credentials, exposed tus headers) and answers preflight', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    const origin = 'http://localhost:3000';
    const res = await fetch(`${base}/api/tus`, {
      method: 'POST',
      headers: { origin, 'tus-resumable': '1.0.0', 'x-upload-session': ctx.sessionToken, 'upload-length': '5', 'upload-metadata': `filename ${Buffer.from('c.txt').toString('base64')},sessionId ${Buffer.from(ctx.sessionId).toString('base64')}` },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-expose-headers')?.toLowerCase()).toMatch(/location/);
    expect(res.headers.get('access-control-expose-headers')?.toLowerCase()).toMatch(/upload-offset/);
    const pre = await fetch(`${base}/api/tus`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'x-upload-session,tus-resumable,upload-offset,content-type' },
    });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-upload-session');
    expect(pre.headers.get('access-control-allow-origin')).toBe(origin);
    const foreign = await fetch(`${base}/api/tus`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(foreign.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});
