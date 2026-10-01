import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { activityLogs, clients, files, messages, portals } from '../src/db/schema';
import { closeQueues } from '../src/queue';
import { getStorage } from '../src/storage';
import { resetDatabase, setupTestApp } from './helpers';
import { seedPortal, seedReadyFile, seedSession, startSession, tusUploadAll, type TusCtx } from './upload-utils';

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

const url = (token: string, suffix = '') => `/api/public/portals/${token}${suffix}`;
const get = (token: string, suffix: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: url(token, suffix), headers });

async function ctxFor(token: string, name?: string): Promise<TusCtx> {
  const { body } = await startSession(app, token, name ? { name } : {});
  return { base, sessionToken: body.sessionToken, sessionId: body.sessionId };
}

describe('GET /dashboard', () => {
  it('computes stats from real uploads, quota, type buckets, recent uploads/files', async () => {
    const { portal, token } = await seedPortal({ portal: { maxTotalBytes: 1_000_000 } });
    const s1 = await ctxFor(token, 'Jane');
    expect((await tusUploadAll(s1, { name: 'a.jpg', data: randomBytes(1000), relativePath: 'shoot/day1' })).status).toBe(204);
    expect((await tusUploadAll(s1, { name: 'b.jpg', data: randomBytes(500), relativePath: 'shoot' })).status).toBe(204);
    expect((await tusUploadAll(s1, { name: 'c.pdf', data: randomBytes(300), relativePath: 'docs' })).status).toBe(204);
    const s2 = await ctxFor(token, 'Bob');
    expect((await tusUploadAll(s2, { name: 'weird.xyz', data: randomBytes(200) })).status).toBe(204);
    await ctxFor(token, 'Empty'); // session without files: not counted as an upload

    // files that must NOT count: failed + still uploading
    const sess = await seedSession(portal);
    await getDb().insert(files).values([
      { clientId: portal.clientId, portalId: portal.id, uploadSessionId: sess.id, originalFilename: 'bad.png', storedFilename: 'x1', extension: 'png', size: 99999, status: 'failed' },
      { clientId: portal.clientId, portalId: portal.id, uploadSessionId: sess.id, originalFilename: 'wip.png', storedFilename: 'x2', extension: 'png', size: 88888, status: 'uploading' },
    ]);
    // quarantined counts
    await seedReadyFile(portal, s1.sessionId ? { id: s1.sessionId } : sess, { name: 'virus.zip', status: 'quarantined', data: Buffer.alloc(100) });

    const res = await get(token, '/dashboard');
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.stats).toMatchObject({ files: 5, totalBytes: 1000 + 500 + 300 + 200 + 100, uploads: 2, folders: 2 });
    expect(typeof d.stats.lastUploadAt).toBe('string');
    expect(d.quota.usedBytes).toBe(2100);
    expect(d.quota.limitBytes).toBe(1_000_000);
    expect(d.expiresAt).toBeNull();
    const byType = Object.fromEntries(d.byType.map((t: { type: string; files: number; bytes: number }) => [t.type, t]));
    expect(byType.image).toMatchObject({ files: 2, bytes: 1500 });
    expect(byType.document).toMatchObject({ files: 1, bytes: 300 });
    expect(byType.archive).toMatchObject({ files: 1, bytes: 100 });
    expect(byType.other).toMatchObject({ files: 1, bytes: 200 });
    expect(d.recentUploads.map((u: { uploaderName: string }) => u.uploaderName)).toEqual(['Bob', 'Jane']);
    expect(d.recentUploads[1]).toMatchObject({ files: 4, bytes: 1900, status: 'active' });
    expect(d.recentFiles).toHaveLength(5);
    expect(Object.keys(d.recentFiles[0]).sort()).toEqual(['canDelete', 'commentCount', 'extension', 'id', 'name', 'relativePath', 'size', 'status', 'type', 'uploadedAt', 'uploadedBy']);
    expect(d.recentFiles.every((f: { canDelete: boolean }) => f.canDelete === false)).toBe(true);
    expect(d.recentFiles.map((f: { name: string }) => f.name)).not.toContain('bad.png');
    expect(d.messages).toEqual({ total: 0, unread: 0, latest: null });
    expect(JSON.stringify(d)).not.toContain(token);
  });

  it('limits recent uploads to 5 and recent files to 6', async () => {
    const { portal, token } = await seedPortal();
    for (let i = 0; i < 8; i++) {
      const s = await seedSession(portal, { uploaderName: `U${i}`, startedAt: new Date(Date.now() - (10 - i) * 60_000) });
      await seedReadyFile(portal, s, { name: `f${i}.txt`, extra: { completedAt: new Date(Date.now() - (10 - i) * 60_000) } });
    }
    const d = (await get(token, '/dashboard')).json();
    expect(d.stats.uploads).toBe(8);
    expect(d.recentUploads).toHaveLength(5);
    expect(d.recentUploads[0].uploaderName).toBe('U7');
    expect(d.recentFiles).toHaveLength(6);
    expect(d.recentFiles[0].name).toBe('f7.txt');
  });

  it('hides recent files and messages when the portal does not allow them; canDelete follows the portal flag', async () => {
    const a = await seedPortal({ portal: { allowClientViewFiles: false, allowClientMessages: false } });
    await seedReadyFile(a.portal, await seedSession(a.portal));
    await getDb().insert(messages).values({ portalId: a.portal.id, clientId: a.portal.clientId, authorType: 'staff', body: 'hi' });
    const d = (await get(a.token, '/dashboard')).json();
    expect(d.stats.files).toBe(1);
    expect(d.recentFiles).toEqual([]);
    expect(d.messages).toEqual({ total: 0, unread: 0, latest: null });

    const b = await seedPortal({ portal: { allowClientDeleteFiles: true } });
    await seedReadyFile(b.portal, await seedSession(b.portal));
    await seedReadyFile(b.portal, await seedSession(b.portal), { status: 'quarantined' });
    const items = (await get(b.token, '/dashboard')).json().recentFiles as { status: string; canDelete: boolean }[];
    expect(items.find((f) => f.status === 'ready')!.canDelete).toBe(true);
    expect(items.find((f) => f.status === 'quarantined')!.canDelete).toBe(false);
  });

  it('reports the effective (client-limited) quota like the public portal endpoint', async () => {
    const { token } = await seedPortal({ client: { quotaBytes: 5000, storageUsedBytes: 1000 }, portal: { maxTotalBytes: 10_000, storageUsedBytes: 100 } });
    const d = (await get(token, '/dashboard')).json();
    const p = (await get(token, '')).json();
    expect(d.quota).toEqual(p.portal.quota);
    expect(d.quota).toEqual({ usedBytes: 100, limitBytes: 4100 });
  });

  it('is scoped to the portal: other portals of the same client do not leak', async () => {
    const a = await seedPortal();
    const [p2] = await getDb().insert(portals).values({ clientId: a.client.id, name: 'Other', tokenHash: 'h'.repeat(64), tokenEncrypted: 'x', tokenPreview: 'abcdef' }).returning();
    await seedReadyFile(p2!, await seedSession(p2!), { name: 'other.txt' });
    await getDb().insert(messages).values({ portalId: p2!.id, clientId: a.client.id, authorType: 'staff', body: 'secret' });
    const d = (await get(a.token, '/dashboard')).json();
    expect(d.stats.files).toBe(0);
    expect(d.messages.total).toBe(0);
  });
});

describe('portal state / access', () => {
  it('404 for unknown token, 403 for disabled and expired portals', async () => {
    expect((await get('x'.repeat(32), '/dashboard')).statusCode).toBe(404);
    expect((await get('x'.repeat(32), '/browse')).statusCode).toBe(404);
    const dis = await seedPortal({ portal: { status: 'disabled' } });
    const r = await get(dis.token, '/dashboard');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('portal_disabled');
    const exp = await seedPortal({ portal: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get(exp.token, '/dashboard')).json().error.code).toBe('portal_expired');
    expect((await get(exp.token, '/browse')).statusCode).toBe(403);
    expect((await get(exp.token, '/messages')).statusCode).toBe(403);
    const cd = await seedPortal({ client: { status: 'disabled' } });
    expect((await get(cd.token, '/uploads')).statusCode).toBe(403);
  });

  it('password-protected portals need x-portal-access for dashboard, browse, uploads and messages', async () => {
    const { token } = await seedPortal({ portal: { password: 'correct horse battery' } });
    for (const p of ['/dashboard', '/browse', '/uploads', '/messages']) {
      const r = await get(token, p);
      expect(r.statusCode, p).toBe(401);
      expect(r.json().error.code).toBe('password_required');
      expect((await get(token, p, { 'x-portal-access': 'a'.repeat(40) })).statusCode, p).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: url(token, '/messages'), payload: { body: 'hi' } })).statusCode).toBe(401);
    const unlock = await app.inject({ method: 'POST', url: url(token, '/unlock'), payload: { password: 'correct horse battery' } });
    const hdr = { 'x-portal-access': unlock.json().accessToken };
    for (const p of ['/dashboard', '/browse', '/uploads', '/messages']) expect((await get(token, p, hdr)).statusCode, p).toBe(200);
    expect((await app.inject({ method: 'POST', url: url(token, '/messages'), payload: { body: 'hi' }, headers: hdr })).statusCode).toBe(201);
  });

  it('a token for one portal does not unlock another', async () => {
    const a = await seedPortal({ portal: { password: 'password-one-1' } });
    const b = await seedPortal({ portal: { password: 'password-two-2' } });
    const unlock = await app.inject({ method: 'POST', url: url(a.token, '/unlock'), payload: { password: 'password-one-1' } });
    expect((await get(b.token, '/dashboard', { 'x-portal-access': unlock.json().accessToken })).statusCode).toBe(401);
  });
});

describe('GET /browse', () => {
  async function seedTree() {
    const s = await seedPortal({ portal: { allowClientDeleteFiles: true } });
    const sess = await seedSession(s.portal, { uploaderName: 'Jane' });
    const mk = (name: string, relativePath = '', data = randomBytes(100), extra = {}) => seedReadyFile(s.portal, sess, { name, relativePath, data, extra });
    await mk('root.pdf');
    await mk('Photo.JPG', '', randomBytes(300));
    await mk('100%_done.txt', '', randomBytes(150));
    await mk('x.mp4', '', randomBytes(50));
    await mk('a.jpg', 'shoot/day1');
    await mk('b.jpg', 'shoot/day2', randomBytes(10));
    await mk('c.png', 'shoot');
    await mk('notes.txt', 'docs');
    await seedReadyFile(s.portal, sess, { name: 'q.txt', status: 'quarantined', relativePath: 'docs' });
    await getDb().insert(files).values({ clientId: s.portal.clientId, portalId: s.portal.id, uploadSessionId: sess.id, originalFilename: 'hidden.txt', storedFilename: 'h1', extension: 'txt', size: 5, status: 'failed' });
    return { ...s, sess };
  }

  it('lists top-level folders with counts/bytes and root files', async () => {
    const { token } = await seedTree();
    const r = (await get(token, '/browse')).json();
    expect(r.path).toBe('');
    expect(r.breadcrumbs).toEqual([]);
    expect(r.folders.map((f: { name: string }) => f.name)).toEqual(['docs', 'shoot']);
    expect(r.folders[1]).toMatchObject({ name: 'shoot', path: 'shoot', fileCount: 3, totalBytes: 100 + 10 + 100 });
    expect(r.folders[0]).toMatchObject({ fileCount: 2 }); // notes.txt + quarantined
    expect(r.files.total).toBe(4);
    expect(r.files.items.map((f: { name: string }) => f.name)).toEqual(['100%_done.txt', 'Photo.JPG', 'root.pdf', 'x.mp4']);
    expect(r.files.items[1]).toMatchObject({ type: 'image', extension: 'jpg', uploadedBy: 'Jane', canDelete: true, commentCount: 0 });
  });

  it('descends into folders with breadcrumbs', async () => {
    const { token } = await seedTree();
    const r = (await get(token, '/browse?path=shoot')).json();
    expect(r.breadcrumbs).toEqual([{ name: 'shoot', path: 'shoot' }]);
    expect(r.folders).toEqual([
      { name: 'day1', path: 'shoot/day1', fileCount: 1, totalBytes: 100 },
      { name: 'day2', path: 'shoot/day2', fileCount: 1, totalBytes: 10 },
    ]);
    expect(r.files.items.map((f: { name: string }) => f.name)).toEqual(['c.png']);
    const deep = (await get(token, '/browse?path=shoot/day1')).json();
    expect(deep.breadcrumbs.map((b: { name: string }) => b.name)).toEqual(['shoot', 'day1']);
    expect(deep.files.items[0].relativePath).toBe('shoot/day1');
    // traversal attempts are sanitised, never leaving the portal
    const odd = await get(token, '/browse?path=../../etc');
    expect(odd.statusCode).toBe(200);
  });

  it('searches by name (wildcards are literal) and filters folders too', async () => {
    const { token } = await seedTree();
    expect((await get(token, '/browse?q=photo')).json().files.items.map((f: { name: string }) => f.name)).toEqual(['Photo.JPG']);
    expect((await get(token, '/browse?q=' + encodeURIComponent('%'))).json().files.items.map((f: { name: string }) => f.name)).toEqual(['100%_done.txt']);
    expect((await get(token, '/browse?q=' + encodeURIComponent('_'))).json().files.items.map((f: { name: string }) => f.name)).toEqual(['100%_done.txt']);
    const folderSearch = (await get(token, '/browse?q=shoo')).json();
    expect(folderSearch.folders.map((f: { name: string }) => f.name)).toEqual(['shoot']);
    expect(folderSearch.files.total).toBe(0);
    expect((await get(token, '/browse?q=' + 'z'.repeat(201))).statusCode).toBe(400);
  });

  it('filters by type category (including other) and rejects unknown types', async () => {
    const { token } = await seedTree();
    const names = async (q: string) => (await get(token, `/browse?${q}`)).json().files.items.map((f: { name: string }) => f.name);
    expect(await names('type=image')).toEqual(['Photo.JPG']);
    expect(await names('type=video')).toEqual(['x.mp4']);
    expect(await names('type=document')).toEqual(['100%_done.txt', 'root.pdf']);
    expect(await names('type=other')).toEqual([]);
    const folders = (await get(token, '/browse?type=image')).json().folders;
    expect(folders.map((f: { name: string }) => f.name)).toEqual(['shoot']);
    expect(folders[0].fileCount).toBe(3);
    expect((await get(token, '/browse?type=nope')).statusCode).toBe(400);
  });

  it('sorts (whitelist) and paginates (<= 200)', async () => {
    const { token } = await seedTree();
    const names = async (q: string) => (await get(token, `/browse?${q}`)).json().files.items.map((f: { name: string }) => f.name);
    expect(await names('sort=size&order=desc')).toEqual(['Photo.JPG', '100%_done.txt', 'root.pdf', 'x.mp4']);
    expect(await names('sort=name&order=desc')).toEqual(['x.mp4', 'root.pdf', 'Photo.JPG', '100%_done.txt']);
    const p2 = (await get(token, '/browse?pageSize=3&page=2')).json();
    expect(p2.files).toMatchObject({ total: 4, page: 2, pageSize: 3 });
    expect(p2.files.items).toHaveLength(1);
    expect((await get(token, '/browse?sort=originalFilename;drop')).statusCode).toBe(400);
    expect((await get(token, '/browse?pageSize=201')).statusCode).toBe(400);
    expect((await get(token, '/browse?pageSize=200')).statusCode).toBe(200);
    expect((await get(token, '/browse?uploadedAt=1&sort=uploadedAt&order=desc')).statusCode).toBe(200);
  });

  it('includes comment counts and is forbidden (files_hidden) when the portal hides files', async () => {
    const { portal, token, sess } = await seedTree();
    const [f] = await getDb().select().from(files).where(eq(files.originalFilename, 'root.pdf'));
    await getDb().insert(messages).values([
      { portalId: portal.id, clientId: portal.clientId, fileId: f!.id, authorType: 'client', body: 'a' },
      { portalId: portal.id, clientId: portal.clientId, fileId: f!.id, authorType: 'staff', body: 'b' },
    ]);
    const item = (await get(token, '/browse')).json().files.items.find((x: { name: string }) => x.name === 'root.pdf');
    expect(item.commentCount).toBe(2);
    expect(sess.id).toBeTruthy();

    await getDb().update(portals).set({ allowClientViewFiles: false }).where(eq(portals.id, portal.id));
    const r = await get(token, '/browse');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('files_hidden');
    expect((await get(token, '/uploads')).statusCode).toBe(403);
    expect((await get(token, '/dashboard')).statusCode).toBe(200);
  });

  it('never returns files of other portals', async () => {
    const a = await seedTree();
    const b = await seedPortal();
    await seedReadyFile(b.portal, await seedSession(b.portal), { name: 'other-portal.txt', relativePath: 'shoot' });
    const r = (await get(a.token, '/browse?path=shoot')).json();
    expect(JSON.stringify(r)).not.toContain('other-portal');
    expect((await get(b.token, '/browse')).json().folders[0]).toMatchObject({ name: 'shoot', fileCount: 1 });
  });
});

describe('GET /uploads', () => {
  it('lists sessions with files or active, newest first, with the client-visible fields only', async () => {
    const { portal, token } = await seedPortal();
    const old = await seedSession(portal, { uploaderName: 'Old', message: 'first batch', status: 'completed', completedAt: new Date(Date.now() - 3600_000), startedAt: new Date(Date.now() - 7200_000) });
    await seedReadyFile(portal, old, { name: 'one.txt', data: Buffer.alloc(40) });
    await seedSession(portal, { uploaderName: 'Ghost', status: 'completed', startedAt: new Date(Date.now() - 5000_000) }); // no files, completed → hidden
    await seedSession(portal, { uploaderName: 'Live', status: 'active', startedAt: new Date() }); // no files but active → shown
    const mid = await seedSession(portal, { uploaderName: 'Mid', status: 'completed', startedAt: new Date(Date.now() - 3600_000) });
    await seedReadyFile(portal, mid, { name: 'two.txt', data: Buffer.alloc(60) });
    const other = await seedPortal();
    await seedReadyFile(other.portal, await seedSession(other.portal, { uploaderName: 'Other' }));

    const r = await get(token, '/uploads');
    expect(r.statusCode).toBe(200);
    const list = r.json();
    expect(list.map((u: { uploaderName: string }) => u.uploaderName)).toEqual(['Live', 'Mid', 'Old']);
    expect(list[2]).toMatchObject({ message: 'first batch', files: 1, bytes: 40, status: 'completed' });
    expect(list[2].completedAt).toBeTruthy();
    expect(Object.keys(list[0]).sort()).toEqual(['bytes', 'completedAt', 'files', 'id', 'message', 'startedAt', 'status', 'uploaderName']);
  });

  it('caps the history at 100 sessions', async () => {
    const { portal, token } = await seedPortal();
    const { uploadSessions } = await import('../src/db/schema');
    const { hashToken } = await import('../src/lib/crypto');
    await getDb().insert(uploadSessions).values(
      Array.from({ length: 105 }, (_, i) => ({ portalId: portal.id, clientId: portal.clientId, tokenHash: hashToken(`t${i}`), expiresAt: new Date(Date.now() + 3600_000), status: 'active' as const })),
    );
    expect((await get(token, '/uploads')).json()).toHaveLength(100);
  });
});

describe('DELETE /files/:fileId (client)', () => {
  it('deletes any file of this portal without an upload session; counters + activity; never another portal', async () => {
    const a = await seedPortal({ portal: { allowClientDeleteFiles: true } });
    const b = await seedPortal({ portal: { allowClientDeleteFiles: true } });
    const mine = await seedReadyFile(a.portal, await seedSession(a.portal, { uploaderName: 'Someone' }), { name: 'mine.txt' });
    const foreign = await seedReadyFile(b.portal, await seedSession(b.portal), { name: 'foreign.txt' });
    const del = (token: string, id: string, headers: Record<string, string> = {}) => app.inject({ method: 'DELETE', url: url(token, `/files/${id}`), headers });

    expect((await del(a.token, foreign.file.id)).statusCode).toBe(404);
    expect((await del(a.token, 'not-a-uuid')).statusCode).toBe(404);
    expect((await del(a.token, mine.file.id)).statusCode).toBe(204);
    await expect(getStorage().exists(mine.key)).resolves.toBe(false);
    expect((await del(a.token, mine.file.id)).statusCode).toBe(404);
    const [pa] = await getDb().select().from(portals).where(eq(portals.id, a.portal.id));
    expect(pa).toMatchObject({ fileCount: 0, storageUsedBytes: 0 });
    const [cb] = await getDb().select().from(clients).where(eq(clients.id, b.client.id));
    expect(cb!.fileCount).toBe(1);
    const log = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.deleted_by_client'));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ portalId: a.portal.id, clientId: a.client.id, resourceId: mine.file.id });
  });

  it('is forbidden when deletes are off; still accepts the optional upload-session header', async () => {
    const off = await seedPortal();
    const f = await seedReadyFile(off.portal, await seedSession(off.portal));
    expect((await app.inject({ method: 'DELETE', url: url(off.token, `/files/${f.file.id}`) })).statusCode).toBe(403);

    const on = await seedPortal({ portal: { allowClientDeleteFiles: true } });
    const { body } = await startSession(app, on.token, { name: 'Jane' });
    const mine = await seedReadyFile(on.portal, { id: body.sessionId });
    const del = await app.inject({ method: 'DELETE', url: url(on.token, `/files/${mine.file.id}`), headers: { 'x-upload-session': body.sessionToken } });
    expect(del.statusCode).toBe(204);
    const [log] = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.deleted_by_client'));
    expect(log!.actorLabel).toBe('Jane');
    // an invalid session header is ignored rather than rejected
    const again = await seedReadyFile(on.portal, await seedSession(on.portal));
    expect((await app.inject({ method: 'DELETE', url: url(on.token, `/files/${again.file.id}`), headers: { 'x-upload-session': 'z'.repeat(40) } })).statusCode).toBe(204);
  });

  it('requires the portal password and a usable portal', async () => {
    const pw = await seedPortal({ portal: { allowClientDeleteFiles: true, password: 'long enough pw' } });
    const f = await seedReadyFile(pw.portal, await seedSession(pw.portal));
    expect((await app.inject({ method: 'DELETE', url: url(pw.token, `/files/${f.file.id}`) })).statusCode).toBe(401);
    const off = await seedPortal({ portal: { allowClientDeleteFiles: true, status: 'disabled' } });
    const g = await seedReadyFile(off.portal, await seedSession(off.portal));
    expect((await app.inject({ method: 'DELETE', url: url(off.token, `/files/${g.file.id}`) })).statusCode).toBe(403);
  });

  it('keeps the legacy session file list working', async () => {
    const { portal, token } = await seedPortal({ portal: { allowClientViewFiles: true } });
    const { body } = await startSession(app, token);
    await seedReadyFile(portal, { id: body.sessionId }, { name: 'mine.txt' });
    const r = await get(token, '/files', { 'x-upload-session': body.sessionToken });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((f: { name: string }) => f.name)).toEqual(['mine.txt']);
  });
});
