import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { getDb } from '../src/db';
import { clients, files, portals, uploadSessions } from '../src/db/schema';
import { closeQueues } from '../src/queue';
import { resetDatabase, setupTestApp } from './helpers';
import { adminHeaders, seedPortal, seedReadyFile, seedSession, startSession, tusCreate, tusPatch, type TusCtx } from './upload-utils';

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

const pub = (token: string, suffix: string) => `/api/public/portals/${token}${suffix}`;
// minimal valid PNG / MP4 headers so file-type style mime values make sense
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(500)]);

describe('DELETE /api/uploads/:id (stuck upload cleanup)', () => {
  it('cancels in-progress transfers, deletes every file of the upload and the upload itself', async () => {
    const { portal, client, token } = await seedPortal();
    const owner = await adminHeaders();
    const { body } = await startSession(app, token, { name: 'Jynor' });
    const ctx: TusCtx = { base, sessionToken: body.sessionToken, sessionId: body.sessionId };

    // one finished file + one half-uploaded file (laptop shut down mid-transfer)
    const done = await seedReadyFile(portal, { id: body.sessionId }, { name: 'done.jpg', data: PNG });
    const created = await tusCreate(ctx, { name: 'big.mov', size: 10_000 });
    expect(created.status).toBe(201);
    const loc = created.url!;
    expect((await tusPatch(ctx, loc, 0, randomBytes(4000))).status).toBe(204);
    const tusId = loc.split('/').pop()!;
    const tusPath = nodePath.join(config().storage.path, 'tus', tusId);
    await expect(fs.stat(tusPath)).resolves.toBeTruthy();

    const before = (await getDb().select().from(clients).where(eq(clients.id, client.id)))[0]!;
    const res = await app.inject({ method: 'DELETE', url: `/api/uploads/${body.sessionId}`, headers: owner.headers });
    expect(res.statusCode).toBe(204);

    expect(await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, body.sessionId))).toHaveLength(0);
    expect(await getDb().select().from(files).where(eq(files.portalId, portal.id))).toHaveLength(0);
    await expect(fs.stat(tusPath)).rejects.toThrow();
    await expect(fs.stat(nodePath.join(config().storage.path, done.file.storageKey!))).rejects.toThrow();
    const after = (await getDb().select().from(clients).where(eq(clients.id, client.id)))[0]!;
    expect(after.fileCount).toBe(before.fileCount - 1);
    expect(after.uploadCount).toBe(Math.max(before.uploadCount - 1, 0));
    const p = (await getDb().select().from(portals).where(eq(portals.id, portal.id)))[0]!;
    expect(p.storageUsedBytes).toBe(0);

    // the client can keep uploading in the same portal afterwards; the dead transfer is gone
    expect((await tusPatch(ctx, loc, 4000, randomBytes(10))).status).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: 'GET', url: '/api/uploads', headers: owner.headers })).json().total).toBe(0);
  });

  it('requires files.delete and 404s unknown uploads', async () => {
    const { portal } = await seedPortal();
    const s = await seedSession(portal);
    const viewer = await adminHeaders('viewer');
    expect((await app.inject({ method: 'DELETE', url: `/api/uploads/${s.id}`, headers: viewer.headers })).statusCode).toBe(403);
    const owner = await adminHeaders();
    expect((await app.inject({ method: 'DELETE', url: `/api/uploads/${crypto.randomUUID()}`, headers: owner.headers })).statusCode).toBe(404);
  });
});

describe('POST /public/portals/:token/files/delete (bulk)', () => {
  it('deletes selected files of this portal only, when allowed', async () => {
    const a = await seedPortal({ portal: { allowClientDeleteFiles: true } });
    const b = await seedPortal({ portal: { allowClientDeleteFiles: true } });
    const sa = await seedSession(a.portal);
    const sb = await seedSession(b.portal);
    const fa1 = await seedReadyFile(a.portal, sa);
    const fa2 = await seedReadyFile(a.portal, sa);
    const fa3 = await seedReadyFile(a.portal, sa);
    const fb = await seedReadyFile(b.portal, sb);

    const res = await app.inject({ method: 'POST', url: pub(a.token, '/files/delete'), payload: { fileIds: [fa1.file.id, fa2.file.id, fb.file.id] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    const left = await getDb().select({ id: files.id }).from(files);
    expect(left.map((r) => r.id).sort()).toEqual([fa3.file.id, fb.file.id].sort());
  });

  it('is refused when deleting is disabled, and validates input', async () => {
    const { portal, token } = await seedPortal({ portal: { allowClientDeleteFiles: false } });
    const f = await seedReadyFile(portal, await seedSession(portal));
    expect((await app.inject({ method: 'POST', url: pub(token, '/files/delete'), payload: { fileIds: [f.file.id] } })).statusCode).toBe(403);
    const ok = await seedPortal({ portal: { allowClientDeleteFiles: true } });
    expect((await app.inject({ method: 'POST', url: pub(ok.token, '/files/delete'), payload: { fileIds: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: pub(ok.token, '/files/delete'), payload: { fileIds: ['../x'] } })).statusCode).toBe(400);
  });
});

describe('GET /public/portals/:token/files/:id/preview', () => {
  it('streams previewable files inline with Range support and safe headers', async () => {
    const { portal, token } = await seedPortal();
    const f = await seedReadyFile(portal, await seedSession(portal), { name: 'photo.png', data: PNG, extra: { detectedMime: 'image/png' } });
    const res = await app.inject({ method: 'GET', url: pub(token, `/files/${f.file.id}/preview`) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.rawPayload.equals(PNG)).toBe(true);
    const ranged = await app.inject({ method: 'GET', url: pub(token, `/files/${f.file.id}/preview`), headers: { range: 'bytes=0-7' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.length).toBe(8);
  });

  it('refuses unsafe types (svg/html/zip), hidden files and other portals', async () => {
    const { portal, token } = await seedPortal();
    const s = await seedSession(portal);
    const svg = await seedReadyFile(portal, s, { name: 'x.svg', extra: { detectedMime: 'image/svg+xml' } });
    const html = await seedReadyFile(portal, s, { name: 'x.html', extra: { mimeType: 'text/html' } });
    expect((await app.inject({ method: 'GET', url: pub(token, `/files/${svg.file.id}/preview`) })).statusCode).toBe(415);
    expect((await app.inject({ method: 'GET', url: pub(token, `/files/${html.file.id}/preview`) })).statusCode).toBe(415);

    const other = await seedPortal();
    expect((await app.inject({ method: 'GET', url: pub(other.token, `/files/${svg.file.id}/preview`) })).statusCode).toBe(404);

    const hidden = await seedPortal({ portal: { allowClientViewFiles: false } });
    const hf = await seedReadyFile(hidden.portal, await seedSession(hidden.portal), { name: 'a.png', data: PNG, extra: { detectedMime: 'image/png' } });
    expect((await app.inject({ method: 'GET', url: pub(hidden.token, `/files/${hf.file.id}/preview`) })).statusCode).toBe(403);
  });

  it('password-protected portals accept the access token as ?access= (media tags cannot send headers)', async () => {
    const { portal, token } = await seedPortal({ portal: { password: 'client-pass-123' } });
    const f = await seedReadyFile(portal, await seedSession(portal), { name: 'a.png', data: PNG, extra: { detectedMime: 'image/png' } });
    expect((await app.inject({ method: 'GET', url: pub(token, `/files/${f.file.id}/preview`) })).statusCode).toBe(401);
    const unlock = await app.inject({ method: 'POST', url: pub(token, '/unlock'), payload: { password: 'client-pass-123' } });
    const access = unlock.json().accessToken as string;
    expect((await app.inject({ method: 'GET', url: pub(token, `/files/${f.file.id}/preview?access=${encodeURIComponent(access)}`) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: pub(token, `/files/${f.file.id}/preview?access=wrong-token-0123456789`) })).statusCode).toBe(401);
  });
});
