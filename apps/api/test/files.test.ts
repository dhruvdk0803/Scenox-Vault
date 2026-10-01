import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { activityLogs, clients, files, portals, uploadSessions } from '../src/db/schema';
import { closeQueues } from '../src/queue';
import { contentDisposition, parseRange } from '../src/routes/files';
import { resetDatabase, setupTestApp } from './helpers';
import { adminHeaders, seedPortal, seedReadyFile, seedSession } from './upload-utils';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await app.close();
  await closeQueues();
});

const req = (method: string, url: string, headers: Record<string, string>, payload?: unknown) => app.inject({ method: method as 'GET', url, headers, payload: payload as object });

async function fixture() {
  const { client, portal, token } = await seedPortal();
  const session = await seedSession(portal, { uploaderName: 'Jane', uploaderEmail: 'jane@example.com' });
  const admin = await adminHeaders('owner');
  return { client, portal, token, session, admin };
}

describe('permissions', () => {
  it('requires a signed-in user with the right permission', async () => {
    const { session, portal } = await fixture();
    const f = await seedReadyFile(portal, session, { name: 'a.txt' });
    expect((await app.inject({ method: 'GET', url: '/api/files' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/files/${f.file.id}/download` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/uploads' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/exports' })).statusCode).toBe(401);

    const viewer = await adminHeaders('viewer');
    expect((await req('GET', '/api/files', viewer.headers)).statusCode).toBe(200);
    expect((await req('GET', `/api/files/${f.file.id}/download`, viewer.headers)).statusCode).toBe(200);
    expect((await req('PATCH', `/api/files/${f.file.id}`, viewer.headers, { name: 'b.txt' })).statusCode).toBe(403);
    expect((await req('POST', '/api/files/move', viewer.headers, { fileIds: [f.file.id], relativePath: 'x' })).statusCode).toBe(403);
    expect((await req('DELETE', `/api/files/${f.file.id}`, viewer.headers)).statusCode).toBe(403);

    const member = await adminHeaders('member');
    expect((await req('PATCH', `/api/files/${f.file.id}`, member.headers, { name: 'b.txt' })).statusCode).toBe(200);
    expect((await req('DELETE', `/api/files/${f.file.id}`, member.headers)).statusCode).toBe(403); // members lack files.delete
    // CSRF: state-changing requests from a foreign origin are refused
    expect((await req('DELETE', `/api/files/${f.file.id}`, { ...member.headers, origin: 'https://evil.example' })).statusCode).toBe(403);
  });
});

describe('GET /api/files', () => {
  it('filters, searches (escaping LIKE wildcards), sorts and paginates', async () => {
    const { portal, session, admin, client } = await fixture();
    const mk = (name: string, size: number, relativePath = '', extra = {}) => seedReadyFile(portal, session, { name, relativePath, data: Buffer.alloc(size, 1), extra });
    await mk('photo.jpg', 300, 'shoot');
    await mk('video.mp4', 100, 'shoot/raw');
    await mk('100%_done.txt', 200);
    await mk('report.pdf', 400, '', { status: 'ready' });
    await mk('mystery.xyz', 50);
    await seedReadyFile(portal, session, { name: 'virus.txt', status: 'quarantined' });
    await seedReadyFile(portal, session, { name: 'cancelled.txt', extra: { status: 'cancelled' } });

    const list = async (q: string) => (await req('GET', `/api/files?${q}`, admin.headers)).json();
    expect((await list('')).total).toBe(6); // cancelled hidden by default
    expect((await list('q=%25')).items.map((f: { name: string }) => f.name)).toEqual(['100%_done.txt']); // % is literal
    expect((await list('q=_')).items.map((f: { name: string }) => f.name)).toEqual(['100%_done.txt']);
    expect((await list('q=SHOOT')).total).toBe(2); // matches relative path, case-insensitive
    expect((await list('type=image')).items.map((f: { name: string }) => f.name)).toEqual(['photo.jpg']);
    expect((await list('type=other')).total).toBe(1);
    expect((await list('type=document')).total).toBe(3); // pdf, txt x2 (incl. quarantined)
    expect((await list('sort=size&order=asc')).items.map((f: { size: number }) => f.size)).toEqual([50, 100, 200, 300, 400, 2048]);
    expect((await list('sort=name&order=asc')).items[0].name).toBe('100%_done.txt');
    const page = await list('pageSize=2&page=2&sort=size&order=desc');
    expect(page).toMatchObject({ total: 6, page: 2, pageSize: 2 });
    expect(page.items.map((f: { size: number }) => f.size)).toEqual([300, 200]);
    expect((await list('status=quarantined')).total).toBe(1);
    expect((await list('status=cancelled')).total).toBe(1);
    expect((await list(`uploadSessionId=${session.id}`)).total).toBe(6);
    expect((await list(`clientId=${client.id}&path=shoot`)).items).toHaveLength(1);
    expect((await list('minSize=300&maxSize=400')).total).toBe(2);
    expect((await req('GET', '/api/files?pageSize=500', admin.headers)).statusCode).toBe(400);
    expect((await req('GET', '/api/files?sort=password', admin.headers)).statusCode).toBe(400);
    expect((await req('GET', '/api/files?clientId=not-a-uuid', admin.headers)).statusCode).toBe(400);
    expect((await list('')).items[0]).toMatchObject({ clientName: 'ABC Company', portalName: 'Main portal', uploaderName: 'Jane', uploaderEmail: 'jane@example.com' });
  });
});

describe('GET /api/files/browse', () => {
  it('derives folders from relative paths with subtree aggregates, breadcrumbs and paging', async () => {
    const { portal, session, admin, client } = await fixture();
    const mk = (name: string, relativePath: string, size = 100, extra = {}) => seedReadyFile(portal, session, { name, relativePath, data: Buffer.alloc(size, 1), extra });
    await mk('root.txt', '');
    await mk('a1.txt', 'a', 10);
    await mk('a2.txt', 'a', 20);
    await mk('deep.txt', 'a/b/c', 30);
    await mk('b1.txt', 'b', 40);
    await mk('ab.txt', 'ab', 5); // must not be mistaken for the "a" subtree
    await mk('hidden.txt', 'a', 999, { status: 'failed' });
    await mk('up.txt', 'a', 999, { status: 'uploading' });

    const browse = async (q: string) => (await req('GET', `/api/files/browse?clientId=${client.id}&${q}`, admin.headers)).json();
    const root = await browse('');
    expect(root.path).toBe('');
    expect(root.breadcrumbs).toEqual([]);
    expect(root.folders).toEqual([
      { name: 'a', path: 'a', fileCount: 3, totalBytes: 60 },
      { name: 'ab', path: 'ab', fileCount: 1, totalBytes: 5 },
      { name: 'b', path: 'b', fileCount: 1, totalBytes: 40 },
    ]);
    expect(root.files.items.map((f: { name: string }) => f.name)).toEqual(['root.txt']);

    const a = await browse('path=a');
    expect(a.breadcrumbs).toEqual([{ name: 'a', path: 'a' }]);
    expect(a.folders).toEqual([{ name: 'b', path: 'a/b', fileCount: 1, totalBytes: 30 }]);
    expect(a.files.items.map((f: { name: string }) => f.name).sort()).toEqual(['a1.txt', 'a2.txt']);

    const deep = await browse('path=a/b/c');
    expect(deep.breadcrumbs).toEqual([{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }, { name: 'c', path: 'a/b/c' }]);
    expect(deep.folders).toEqual([]);
    expect(deep.files.total).toBe(1);

    expect((await browse('path=..%2F..%2Fa')).path).toBe('a'); // traversal is sanitised
    expect((await browse('path=a&pageSize=1')).files).toMatchObject({ total: 2, pageSize: 1 });
    expect((await browse('q=a1')).files.total).toBe(0);
    expect((await browse('path=a&q=a1')).files.items).toHaveLength(1);
    expect((await req('GET', '/api/files/browse', admin.headers)).statusCode).toBe(400); // clientId required
    const other = await seedPortal();
    expect((await req('GET', `/api/files/browse?clientId=${other.client.id}`, admin.headers)).json().folders).toEqual([]);
    expect((await browse(`portalId=${portal.id}`)).folders).toHaveLength(3);
  });
});

describe('rename / move / delete', () => {
  it('renames with sanitisation, keeps the extension field in sync, refuses collisions', async () => {
    const { portal, session, admin } = await fixture();
    const a = await seedReadyFile(portal, session, { name: 'a.txt' });
    await seedReadyFile(portal, session, { name: 'taken.txt' });
    const ok = await req('PATCH', `/api/files/${a.file.id}`, admin.headers, { name: '../../Evil: name?.PDF' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'Evil_ name_.PDF', extension: 'pdf' });
    expect((await req('PATCH', `/api/files/${a.file.id}`, admin.headers, { name: 'taken.txt' })).statusCode).toBe(409);
    expect((await req('PATCH', `/api/files/${a.file.id}`, admin.headers, { name: '' })).statusCode).toBe(400);
    const [row] = await getDb().select().from(files).where(eq(files.id, a.file.id));
    expect(row!.storedFilename).toBe(a.file.storedFilename); // disk key untouched
    expect(await fs.readFile(a.abs)).toEqual(a.data);
    expect(await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.renamed'))).toHaveLength(1);
  });

  it('moves files to a sanitised folder, suffixing name collisions', async () => {
    const { portal, session, admin } = await fixture();
    const a = await seedReadyFile(portal, session, { name: 'a.txt', relativePath: 'x' });
    const b = await seedReadyFile(portal, session, { name: 'a.txt', relativePath: 'y' });
    const mv = await req('POST', '/api/files/move', admin.headers, { fileIds: [a.file.id, b.file.id], relativePath: '../../etc\\passwd/' });
    expect(mv.statusCode).toBe(204);
    const rows = await getDb().select().from(files);
    expect(rows.map((r) => [r.relativePath, r.originalFilename]).sort()).toEqual([['etc/passwd', 'a (1).txt'], ['etc/passwd', 'a.txt']]);
    expect((await req('POST', '/api/files/move', admin.headers, { fileIds: [], relativePath: 'x' })).statusCode).toBe(400);
  });

  it('bulk delete removes bytes and decrements counters once per file', async () => {
    const { portal, session, admin, client } = await fixture();
    const a = await seedReadyFile(portal, session, { name: 'a.txt', data: Buffer.alloc(100) });
    const b = await seedReadyFile(portal, session, { name: 'b.txt', data: Buffer.alloc(200) });
    const c = await seedReadyFile(portal, session, { name: 'c.txt', data: Buffer.alloc(400) });
    const res = await req('POST', '/api/files/delete', admin.headers, { fileIds: [a.file.id, b.file.id, b.file.id, '00000000-0000-0000-0000-000000000000'] });
    expect(res.statusCode).toBe(204);
    await expect(fs.stat(a.abs)).rejects.toThrow();
    await expect(fs.stat(b.abs)).rejects.toThrow();
    await expect(fs.stat(c.abs)).resolves.toBeTruthy();
    const [cl] = await getDb().select().from(clients).where(eq(clients.id, client.id));
    const [po] = await getDb().select().from(portals).where(eq(portals.id, portal.id));
    const [se] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, session.id));
    expect([cl!.fileCount, Number(cl!.storageUsedBytes), po!.fileCount, Number(po!.storageUsedBytes), se!.uploadedFiles, Number(se!.uploadedBytes)]).toEqual([1, 400, 1, 400, 1, 400]);
    expect((await req('DELETE', `/api/files/${a.file.id}`, admin.headers)).statusCode).toBe(404);
    expect(await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.deleted'))).toHaveLength(1);
  });
});

describe('download', () => {
  it('refuses quarantined (403) and unprocessed (409) files', async () => {
    const { portal, session, admin } = await fixture();
    const q = await seedReadyFile(portal, session, { name: 'virus.exe.txt', status: 'quarantined' });
    const p = await seedReadyFile(portal, session, { name: 'new.txt', status: 'processing' });
    const r = await req('GET', `/api/files/${q.file.id}/download`, admin.headers);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toMatch(/quarantined/i);
    expect((await req('GET', `/api/files/${p.file.id}/download`, admin.headers)).statusCode).toBe(409);
  });

  it('serves attachment by default; inline only for safe types', async () => {
    const { portal, session, admin } = await fixture();
    const png = await seedReadyFile(portal, session, { name: 'pic.png', extra: { detectedMime: 'image/png' } });
    const svg = await seedReadyFile(portal, session, { name: 'pic.svg', extra: { detectedMime: 'image/svg+xml', mimeType: 'image/svg+xml' } });
    const html = await seedReadyFile(portal, session, { name: 'page.html', extra: { mimeType: 'text/html' } });
    const txt = await seedReadyFile(portal, session, { name: 'note.txt', extra: { mimeType: 'text/plain' } });

    const inline = (id: string) => req('GET', `/api/files/${id}/download?inline=1`, admin.headers);
    const a = await inline(png.file.id);
    expect(a.headers['content-type']).toBe('image/png');
    expect(a.headers['content-disposition']).toMatch(/^inline;/);
    expect(a.headers['x-content-type-options']).toBe('nosniff');
    for (const f of [svg, html]) {
      const r = await inline(f.file.id);
      expect(r.headers['content-type']).toBe('application/octet-stream');
      expect(r.headers['content-disposition']).toMatch(/^attachment;/);
    }
    expect((await inline(txt.file.id)).headers['content-type']).toBe('text/plain');
    // no ?inline → always attachment
    const plain = await req('GET', `/api/files/${png.file.id}/download`, admin.headers);
    expect(plain.headers['content-type']).toBe('application/octet-stream');
    expect(plain.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('does not log file.downloaded for ranges that do not start at 0', async () => {
    const { portal, session, admin } = await fixture();
    const f = await seedReadyFile(portal, session, { name: 'a.bin', data: Buffer.alloc(5000, 3) });
    const res = await req('GET', `/api/files/${f.file.id}/download`, { ...admin.headers, range: 'bytes=1000-' });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(4000);
    expect(await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.downloaded'))).toHaveLength(0);
    await req('GET', `/api/files/${f.file.id}/download`, { ...admin.headers, range: 'bytes=0-9' });
    expect(await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.downloaded'))).toHaveLength(1);
  });

  it('returns a friendly 410 when the bytes are gone from disk', async () => {
    const { portal, session, admin } = await fixture();
    const f = await seedReadyFile(portal, session, { name: 'gone.bin' });
    await fs.rm(f.abs);
    const r = await req('GET', `/api/files/${f.file.id}/download`, admin.headers);
    expect(r.statusCode).toBe(410);
    expect(r.json().error.message).toMatch(/no longer available/);
  });
});

describe('helpers', () => {
  it('parseRange handles open, suffix, invalid and unsupported ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=9-2', 100)).toBe('invalid');
    expect(parseRange('bytes=-0', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
  });

  it('contentDisposition emits an ASCII fallback plus RFC 5987 filename*, with no header injection', () => {
    const v = contentDisposition('attachment', 'Résumé "final"\r\nSet-Cookie: x=1.pdf');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22%0D%0ASet-Cookie%3A%20x%3D1.pdf");
    expect(v.split(';')[1]).not.toMatch(/"[^"]*"[^;]*"/); // quotes in the fallback were replaced
    expect(contentDisposition('inline', 'a.png')).toBe(`inline; filename="a.png"; filename*=UTF-8''a.png`);
  });
});

describe('GET /api/uploads', () => {
  it('lists sessions with filters, search and live bytes for active sessions', async () => {
    const { portal, session, admin, client } = await fixture();
    await seedReadyFile(portal, session, { name: 'done.bin', data: Buffer.alloc(1000) });
    await getDb().insert(files).values({
      clientId: client.id, portalId: portal.id, uploadSessionId: session.id, originalFilename: 'live.bin', storedFilename: 'x', size: 5000, bytesReceived: 1234, status: 'uploading',
    });
    const done = await seedSession(portal, { status: 'completed', uploaderName: 'Bob', uploadedBytes: 77, uploadedFiles: 1 });
    const q = async (s: string) => (await req('GET', `/api/uploads${s}`, admin.headers)).json();
    const all = await q('');
    expect(all.total).toBe(2);
    const active = all.items.find((s: { id: string }) => s.id === session.id);
    expect(active.uploadedBytes).toBe(1000 + 1234); // live sum of bytes received
    expect(active).toMatchObject({ clientName: 'ABC Company', portalName: 'Main portal', status: 'active' });
    expect((await q('?status=completed')).items.map((s: { id: string }) => s.id)).toEqual([done.id]);
    expect((await q('?q=jane@example')).total).toBe(1);
    expect((await q('?q=abc')).total).toBe(2); // client name
    expect((await q('?q=bob')).total).toBe(1);
    expect((await q(`?clientId=${client.id}&portalId=${portal.id}`)).total).toBe(2);
    const one = await req('GET', `/api/uploads/${session.id}`, admin.headers);
    expect(one.statusCode).toBe(200);
    expect(one.json().uploadedBytes).toBe(2234);
    expect((await req('GET', '/api/uploads/00000000-0000-0000-0000-000000000000', admin.headers)).statusCode).toBe(404);
    expect((await req('GET', '/api/uploads/not-a-uuid', admin.headers)).statusCode).toBe(400);
  });
});
