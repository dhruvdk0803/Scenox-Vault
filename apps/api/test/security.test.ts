import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { config, resetConfig } from '../src/config';
import { getDb } from '../src/db';
import { files } from '../src/db/schema';
import { processFile } from '../src/jobs';
import { redactUrl } from '../src/lib/logger';
import { closeQueues } from '../src/queue';
import { resetDatabase, setupTestApp } from './helpers';
import { adminHeaders, seedPortal, startSession, tusCreate, tusHead, tusUploadAll, type TusCtx } from './upload-utils';

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

async function newCtx(token: string): Promise<TusCtx> {
  const { body } = await startSession(app, token);
  return { base, sessionToken: body.sessionToken, sessionId: body.sessionId };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

describe('path traversal & hostile names', () => {
  const cases: { name: string; relativePath: string; expectName: string; expectPath: string }[] = [
    { name: '../../etc/passwd', relativePath: '../../..', expectName: 'passwd', expectPath: '' },
    { name: '/etc/shadow', relativePath: '/abs/path', expectName: 'shadow', expectPath: 'abs/path' },
    { name: 'C:\\Windows\\system32\\evil.dll', relativePath: 'C:\\Users\\x', expectName: 'evil.dll', expectPath: 'Users/x' },
    { name: '..\\..\\x.txt', relativePath: '..\\..\\up', expectName: 'x.txt', expectPath: 'up' },
    { name: 'CON.txt', relativePath: 'a/./b/../c', expectName: '_CON.txt', expectPath: 'a/b/c' },
    { name: 'nul\u0000byte\u0007.txt', relativePath: 'dir\u0000/sub', expectName: 'nulbyte.txt', expectPath: 'dir/sub' },
    { name: '....//....//weird', relativePath: '%2e%2e/%2e%2e', expectName: 'weird', expectPath: '%2e%2e/%2e%2e' }, // percent-escapes are inert literal text
  ];

  it('neutralises traversal in filename/relativePath; disk names stay generated UUIDs inside the storage root', async () => {
    const { client, portal, token } = await seedPortal();
    const ctx = await newCtx(token);
    const root = config().storage.path;
    for (const c of cases) {
      const r = await tusUploadAll(ctx, { name: c.name, relativePath: c.relativePath, data: Buffer.from('payload') });
      expect(r.status, JSON.stringify(c)).toBe(204);
    }
    const rows = await getDb().select().from(files);
    expect(rows).toHaveLength(cases.length);
    for (const c of cases) {
      const row = rows.find((r) => r.originalFilename === c.expectName && r.relativePath === c.expectPath);
      expect(row, JSON.stringify(c)).toBeTruthy();
    }
    for (const r of rows) await processFile(r.id);
    const ready = await getDb().select().from(files);
    for (const r of ready) {
      expect(r.storageKey).toMatch(new RegExp(`^uploads/${client.id}/${portal.id}/[0-9a-f-]{36}/[0-9a-f-]{36}$`));
      const abs = path.resolve(root, r.storageKey!);
      expect(abs.startsWith(root + path.sep)).toBe(true);
      expect(r.storedFilename).toMatch(/^[0-9a-f-]{36}$/);
    }
    // nothing was written anywhere unexpected inside the root, and nothing outside it
    for (const f of await walk(root)) expect(f.startsWith(root + path.sep)).toBe(true);
    await expect(fs.stat(path.join(root, '..', 'etc'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'etc'))).rejects.toThrow();
  });

  it('tus ids cannot escape the tus directory', async () => {
    const { token } = await seedPortal();
    const ctx = await newCtx(token);
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e', '..', '%2e%2e%5c%2e%2e%5cwindows', 'a%00b']) {
      const res = await fetch(`${base}/api/tus/${id}`, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0', 'x-upload-session': ctx.sessionToken } });
      expect([400, 404], id).toContain(res.status);
    }
    const created = await tusCreate(ctx, { name: 'ok.txt', size: 3 });
    expect((await tusHead(ctx, created.url!)).status).toBe(200);
  });

  it('LocalStorage refuses keys that escape the root', async () => {
    const { getStorage } = await import('../src/storage');
    expect(() => getStorage().localPath!('../outside')).toThrow();
    expect(() => getStorage().localPath!('uploads/../../outside')).toThrow();
    expect(() => getStorage().localPath!('/etc/passwd')).toThrow();
  });

  it('admin-supplied paths are sanitised on rename/move too', async () => {
    const { portal } = await seedPortal();
    const { seedSession, seedReadyFile } = await import('./upload-utils');
    const session = await seedSession(portal);
    const f = await seedReadyFile(portal, session, { name: 'a.txt' });
    const admin = await adminHeaders('owner');
    await app.inject({ method: 'PATCH', url: `/api/files/${f.file.id}`, headers: admin.headers, payload: { name: '../../../root/.ssh/authorized_keys' } });
    await app.inject({ method: 'POST', url: '/api/files/move', headers: admin.headers, payload: { fileIds: [f.file.id], relativePath: '/../../../etc' } });
    const [row] = await getDb().select().from(files).where(eq(files.id, f.file.id));
    expect(row).toMatchObject({ originalFilename: 'authorized_keys', relativePath: 'etc' });
  });
});

describe('error handling & secrets', () => {
  it('returns friendly ApiError shapes and never leaks internals', async () => {
    const admin = await adminHeaders('owner');
    const cases = [
      await app.inject({ method: 'GET', url: '/api/files/not-a-uuid', headers: admin.headers }),
      await app.inject({ method: 'GET', url: '/api/files' }),
      await app.inject({ method: 'POST', url: '/api/public/portals/zzzzzzzzzzzzzzzzzzzzzzzz/sessions', payload: {} }),
      await app.inject({ method: 'POST', url: '/api/exports', headers: { ...admin.headers, 'content-type': 'application/json' }, payload: 'not json' }),
    ];
    for (const res of cases) {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      const body = res.json();
      expect(body.error.code).toBeTruthy();
      expect(body.error.message.length).toBeGreaterThan(5);
      expect(JSON.stringify(body)).not.toMatch(/stack|node_modules|SELECT|postgres|drizzle/i);
    }
  });

  it('tus error bodies are ApiError JSON with friendly messages', async () => {
    const { token } = await seedPortal({ portal: { maxTotalBytes: 10 } });
    const ctx = await newCtx(token);
    const res = await tusCreate(ctx, { name: 'big.bin', size: 1000 });
    expect(res.status).toBe(413);
    const body = JSON.parse(res.text);
    expect(body.error.code).toBe('quota_exceeded');
    expect(body.error.message).toMatch(/storage|remaining/i);
  });

  it('redacts portal tokens from logged URLs', () => {
    expect(redactUrl('/api/public/portals/SECRETTOKEN123/files?x=1')).toBe('/api/public/portals/[token]/files?x=1');
    expect(redactUrl('/api/public/portals/SECRETTOKEN123')).toBe('/api/public/portals/[token]');
    expect(redactUrl('/api/tus/abc')).toBe('/api/tus/abc');
  });

  it('a session token for one portal is rejected on another portal\'s endpoints', async () => {
    const a = await seedPortal();
    const b = await seedPortal();
    const { body } = await startSession(app, a.token);
    const res = await app.inject({
      method: 'POST',
      url: `/api/public/portals/${b.token}/preflight`,
      headers: { 'x-upload-session': body.sessionToken },
      payload: { files: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  let limited: FastifyInstance;
  let limitedBase: string;
  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    resetConfig();
    limited = await buildApp();
    limited.server.requestTimeout = 0;
    await limited.listen({ port: 0, host: '127.0.0.1' });
    limitedBase = `http://127.0.0.1:${(limited.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await limited.close();
    process.env.RATE_LIMIT_ENABLED = 'false';
    resetConfig();
  });

  it('limits unlock to 5/min/IP with a friendly 429', async () => {
    const { token } = await seedPortal({ portal: { password: 'right-password-1' } });
    const url = `/api/public/portals/${token}/unlock`;
    for (let i = 0; i < 5; i++) expect((await limited.inject({ method: 'POST', url, payload: { password: 'wrong' } })).statusCode).toBe(401);
    const res = await limited.inject({ method: 'POST', url, payload: { password: 'right-password-1' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(res.json().error.message).toMatch(/Too many requests/);
  });

  it('limits sessions (30/min) and portal lookups (120/min), but never the tus byte path', async () => {
    const { token } = await seedPortal();
    const sess = `/api/public/portals/${token}/sessions`;
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await limited.inject({ method: 'POST', url: sess, payload: {} })).statusCode;
    expect(last).toBe(429);

    const get = `/api/public/portals/${token}`;
    const codes: number[] = [];
    for (let i = 0; i < 121; i++) codes.push((await limited.inject({ method: 'GET', url: get })).statusCode);
    expect(codes.slice(0, 120).every((c) => c === 200)).toBe(true);
    expect(codes[120]).toBe(429);

    // tus: 200 requests from the same IP, none rate limited
    const statuses = new Set<number>();
    for (let i = 0; i < 200; i += 20) {
      const batch = await Promise.all(
        Array.from({ length: 20 }, () => fetch(`${limitedBase}/api/tus/abc`, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0', 'x-upload-session': 'x'.repeat(43) } })),
      );
      for (const r of batch) statuses.add(r.status);
    }
    expect([...statuses]).toEqual([401]);
  });
});
