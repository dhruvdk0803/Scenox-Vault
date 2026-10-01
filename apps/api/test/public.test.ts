import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { activityLogs, clients, portalAccessTokens, portals, settings, uploadSessions } from '../src/db/schema';
import { hashToken } from '../src/lib/crypto';
import { closeQueues } from '../src/queue';
import { getStorage } from '../src/storage';
import { invalidateSettings } from '../src/services/settings';
import { Readable } from 'node:stream';
import { resetDatabase, setupTestApp } from './helpers';
import { seedPortal, seedReadyFile, seedSession, startSession } from './upload-utils';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  invalidateSettings();
});
afterAll(async () => {
  await app.close();
  await closeQueues();
});

const get = (token: string, headers: Record<string, string> = {}, suffix = '') => app.inject({ method: 'GET', url: `/api/public/portals/${token}${suffix}`, headers });
const post = (token: string, suffix: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/api/public/portals/${token}${suffix}`, payload: payload as object, headers });

describe('GET /api/public/portals/:token', () => {
  it('returns the ok state with branding, engine config, quota and blocked extensions', async () => {
    const { token } = await seedPortal({
      client: { quotaBytes: 5000, storageUsedBytes: 1000 },
      portal: { title: 'Send us your files', maxTotalBytes: 10_000, maxFileSizeBytes: 2000, allowedExtensions: ['pdf', 'png'], storageUsedBytes: 100 },
    });
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('ok');
    expect(body.branding.companyName).toBe('Scenox Vault');
    expect(body.portal).toMatchObject({
      title: 'Send us your files',
      clientName: 'ABC Company',
      maxFileSizeBytes: 2000,
      allowedExtensions: ['pdf', 'png'],
      quota: { usedBytes: 100, limitBytes: 100 + 4000 }, // client has 4000 left < portal's remaining
    });
    expect(body.portal.blockedExtensions).toContain('exe');
    expect(body.upload.endpoint).toBe('/api/tus');
    expect(body.upload.retryDelays).toHaveLength(6);
    expect(body.upload.retryDelays[0]).toBe(500);
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('404s on unknown or malformed tokens and after the link is regenerated', async () => {
    expect((await get('x'.repeat(32))).statusCode).toBe(404);
    expect((await get('short')).statusCode).toBe(404);
    const { portal, token } = await seedPortal();
    expect((await get(token)).statusCode).toBe(200);
    const { generatePortalToken } = await import('../src/services/portal-tokens');
    const next = generatePortalToken();
    await getDb().update(portals).set({ tokenHash: next.tokenHash }).where(eq(portals.id, portal.id));
    const res = await get(token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('reports disabled (portal or client) and expired portals', async () => {
    const a = await seedPortal({ portal: { status: 'disabled' } });
    expect((await get(a.token)).json()).toMatchObject({ state: 'disabled' });
    expect((await get(a.token)).json().portal).toBeUndefined();
    const b = await seedPortal({ client: { status: 'disabled' } });
    expect((await get(b.token)).json().state).toBe('disabled');
    const c = await seedPortal({ portal: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get(c.token)).json().state).toBe('expired');
  });

  it('logs portal.accessed and updates lastAccessedAt at most once per 5 minutes', async () => {
    const { portal, token } = await seedPortal();
    await get(token);
    await get(token);
    await get(token);
    const logs = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'portal.accessed'));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.clientId).toBe(portal.clientId);
    const [p] = await getDb().select().from(portals).where(eq(portals.id, portal.id));
    expect(p!.lastAccessedAt).toBeTruthy();
  });
});

describe('password protected portals', () => {
  it('requires unlock; wrong password → 401 + failure activity; correct → access token', async () => {
    const { portal, token } = await seedPortal({ portal: { password: 'open-sesame-123' } });
    expect((await get(token)).json()).toMatchObject({ state: 'password_required' });
    expect((await get(token)).json().portal).toBeUndefined();

    const bad = await post(token, '/unlock', { password: 'nope' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.message).toBe('Incorrect password.');
    const failures = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'portal.unlock_failed'));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.result).toBe('failure');
    expect(JSON.stringify(failures[0])).not.toContain('nope');

    // session creation is refused without access
    expect((await post(token, '/sessions', {})).statusCode).toBe(401);

    const ok = await post(token, '/unlock', { password: 'open-sesame-123' });
    expect(ok.statusCode).toBe(200);
    const { accessToken, expiresAt } = ok.json();
    expect(accessToken.length).toBeGreaterThan(30);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 60 * 3600_000); // default 72 h
    const [row] = await getDb().select().from(portalAccessTokens).where(eq(portalAccessTokens.portalId, portal.id));
    expect(row!.tokenHash).toBe(hashToken(accessToken)); // stored hashed
    expect(row!.tokenHash).not.toBe(accessToken);

    expect((await get(token, { 'x-portal-access': accessToken })).json().state).toBe('ok');
    expect((await get(token, { 'x-portal-access': 'z'.repeat(43) })).json().state).toBe('password_required');
    expect((await post(token, '/sessions', {}, { 'x-portal-access': accessToken })).statusCode).toBe(201);

    // expired grants stop working
    await getDb().update(portalAccessTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await get(token, { 'x-portal-access': accessToken })).json().state).toBe('password_required');
  });

  it('an access token is only valid for its own portal', async () => {
    const a = await seedPortal({ portal: { password: 'password-aaaa-1' } });
    const b = await seedPortal({ portal: { password: 'password-bbbb-2' } });
    const { accessToken } = (await post(a.token, '/unlock', { password: 'password-aaaa-1' })).json();
    expect((await get(b.token, { 'x-portal-access': accessToken })).json().state).toBe('password_required');
  });
});

describe('POST /sessions', () => {
  it('creates a session (hashed token), bumps counters, logs upload.started', async () => {
    const { client, portal, token } = await seedPortal();
    const res = await post(token, '/sessions', { name: 'Jane', email: 'jane@example.com', company: 'Acme', message: 'hello', totalFiles: 3, totalBytes: 999 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sessionToken.length).toBeGreaterThanOrEqual(40);
    const [s] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, body.sessionId));
    expect(s).toMatchObject({ uploaderName: 'Jane', uploaderEmail: 'jane@example.com', uploaderCompany: 'Acme', status: 'active', totalFiles: 3 });
    expect(s!.tokenHash).toBe(hashToken(body.sessionToken));
    const [p] = await getDb().select().from(portals).where(eq(portals.id, portal.id));
    const [c] = await getDb().select().from(clients).where(eq(clients.id, client.id));
    expect([p!.sessionCount, c!.uploadCount]).toEqual([1, 1]);
    expect(await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'upload.started'))).toHaveLength(1);
  });

  it('enforces required intake fields and validates input', async () => {
    const { token } = await seedPortal({ portal: { requireName: true, requireEmail: true, requireCompany: true, requireMessage: true } });
    const missing = await post(token, '/sessions', {});
    expect(missing.statusCode).toBe(400);
    expect(Object.keys(missing.json().error.details.fields).sort()).toEqual(['company', 'email', 'message', 'name']);
    const badEmail = await post(token, '/sessions', { name: 'a', email: 'not-an-email', company: 'c', message: 'm' });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.json().error.details.fields.email).toMatch(/valid email/);
    const tooLong = await post(token, '/sessions', { name: 'a'.repeat(201), email: 'a@b.co', company: 'c', message: 'm' });
    expect(tooLong.statusCode).toBe(400);
    expect((await post(token, '/sessions', { name: 'a', email: 'a@b.co', company: 'c', message: 'm' })).statusCode).toBe(201);
  });

  it('refuses expired / disabled portals with friendly errors', async () => {
    const e = await seedPortal({ portal: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await post(e.token, '/sessions', {});
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('portal_expired');
    const d = await seedPortal({ portal: { status: 'disabled' } });
    expect((await post(d.token, '/sessions', {})).json().error.code).toBe('portal_disabled');
  });

  it('allowMultipleSessions=false: second session after an upload → 409', async () => {
    const { portal, token } = await seedPortal({ portal: { allowMultipleSessions: false } });
    const first = await post(token, '/sessions', {});
    expect(first.statusCode).toBe(201);
    expect((await post(token, '/sessions', {})).statusCode).toBe(201); // nothing uploaded yet
    await getDb().update(uploadSessions).set({ uploadedFiles: 2 }).where(eq(uploadSessions.id, first.json().sessionId));
    const res = await post(token, '/sessions', {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_uploaded');
    void portal;
  });

  it('GET /sessions/current validates the session token', async () => {
    const { token } = await seedPortal();
    const other = await seedPortal();
    const { body } = await startSession(app, token);
    const ok = await get(token, { 'x-upload-session': body.sessionToken }, '/sessions/current');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ sessionId: body.sessionId, status: 'active' });
    expect((await get(token, {}, '/sessions/current')).statusCode).toBe(401);
    expect((await get(token, { 'x-upload-session': 'a'.repeat(43) }, '/sessions/current')).statusCode).toBe(401);
    // a session of another portal is not valid here
    expect((await get(other.token, { 'x-upload-session': body.sessionToken }, '/sessions/current')).statusCode).toBe(401);
    await getDb().update(uploadSessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(uploadSessions.id, body.sessionId));
    expect((await get(token, { 'x-upload-session': body.sessionToken }, '/sessions/current')).statusCode).toBe(401);
  });
});

describe('POST /preflight', () => {
  it('checks types, sizes, folders, cumulative quota and detects duplicates', async () => {
    const { portal, token } = await seedPortal({ portal: { maxTotalBytes: 3000, maxFileSizeBytes: 2000, allowFolders: false, allowZip: false } });
    const session = await seedSession(portal, { tokenHash: hashToken('s'.repeat(40)) });
    const existing = await seedReadyFile(portal, session, { name: 'dup.pdf', data: Buffer.alloc(500, 1) });
    const hdr = { 'x-upload-session': 's'.repeat(40) };
    const res = await post(
      token,
      '/preflight',
      {
        files: [
          { clientKey: 'a', name: 'ok.pdf', relativePath: '', size: 1000 },
          { clientKey: 'b', name: 'virus.exe', relativePath: '', size: 10 },
          { clientKey: 'c', name: 'huge.pdf', relativePath: '', size: 2001 },
          { clientKey: 'd', name: 'in-folder.pdf', relativePath: 'dir', size: 10 },
          { clientKey: 'e', name: 'bundle.zip', relativePath: '', size: 10 },
          { clientKey: 'f', name: 'dup.pdf', relativePath: '', size: 500 },
          { clientKey: 'g', name: 'dup.pdf', relativePath: '', size: 501 }, // different size → not a duplicate
          { clientKey: 'h', name: 'second.pdf', relativePath: '', size: 1500 }, // 500 used + 1000 + 500 + 1501 > 3000
          { clientKey: 'i', name: '../../etc/passwd.pdf', relativePath: '../..', size: 5 },
        ],
      },
      hdr,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const byKey = Object.fromEntries(body.results.map((r: { clientKey: string }) => [r.clientKey, r]));
    expect(byKey.a.ok).toBe(true);
    expect(byKey.b).toMatchObject({ ok: false, reason: 'blocked_type' });
    expect(byKey.c).toMatchObject({ ok: false, reason: 'too_large' });
    expect(byKey.d).toMatchObject({ ok: false, reason: 'folders_not_allowed' });
    expect(byKey.e).toMatchObject({ ok: false, reason: 'zip_not_allowed' });
    expect(byKey.f).toMatchObject({ ok: true, duplicate: { fileId: existing.file.id, size: 500 } });
    expect(byKey.g.duplicate).toBeNull();
    expect(byKey.h).toMatchObject({ ok: false, reason: 'quota_exceeded' });
    expect(byKey.i.ok).toBe(true); // sanitised to a plain root file
    expect(body.quota).toMatchObject({ usedBytes: 500, limitBytes: 3000, requestedBytes: 1000 + 500 + 501 + 5 });
  });

  it('requires a valid session and caps the request at 5000 files', async () => {
    const { token } = await seedPortal();
    expect((await post(token, '/preflight', { files: [] })).statusCode).toBe(401);
    const { body } = await startSession(app, token);
    const hdr = { 'x-upload-session': body.sessionToken };
    const many = Array.from({ length: 5001 }, (_, i) => ({ clientKey: String(i), name: `f${i}.txt`, relativePath: '', size: 1 }));
    expect((await post(token, '/preflight', { files: many }, hdr)).statusCode).toBe(400);
    expect((await post(token, '/preflight', { files: many.slice(0, 5000) }, hdr)).statusCode).toBe(200);
    expect((await post(token, '/preflight', { nope: 1 }, hdr)).statusCode).toBe(400);
  });
});

describe('client file view / delete', () => {
  it('lists only this session\'s files when allowed, and deletes them with counters + activity', async () => {
    const { client, portal, token } = await seedPortal({ portal: { allowClientViewFiles: true, allowClientDeleteFiles: true } });
    const { body } = await startSession(app, token, { name: 'Jane' });
    const mine = await seedReadyFile(portal, { id: body.sessionId }, { name: 'mine.txt' });
    const otherSession = await seedSession(portal);
    const theirs = await seedReadyFile(portal, otherSession, { name: 'theirs.txt' });
    const hdr = { 'x-upload-session': body.sessionToken };

    const list = await get(token, hdr, '/files');
    expect(list.statusCode).toBe(200);
    expect(list.json().map((f: { name: string }) => f.name)).toEqual(['mine.txt']);
    expect(Object.keys(list.json()[0]).sort()).toEqual(['id', 'name', 'relativePath', 'size', 'status', 'uploadedAt']);

    expect((await app.inject({ method: 'DELETE', url: `/api/public/portals/${token}/files/${theirs.file.id}`, headers: hdr })).statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/public/portals/${token}/files/${mine.file.id}`, headers: hdr });
    expect(del.statusCode).toBe(204);
    const [c] = await getDb().select().from(clients).where(eq(clients.id, client.id));
    expect(c!.fileCount).toBe(1); // only "theirs" remains
    expect((await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.deleted_by_client')))).toHaveLength(1);
    await expect(getStorage().exists(mine.key)).resolves.toBe(false);
  });

  it('is forbidden when the portal does not allow it', async () => {
    const { token } = await seedPortal();
    const { body } = await startSession(app, token);
    const hdr = { 'x-upload-session': body.sessionToken };
    expect((await get(token, hdr, '/files')).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/public/portals/${token}/files/00000000-0000-0000-0000-000000000000`, headers: hdr })).statusCode).toBe(403);
  });
});

describe('branding endpoints', () => {
  it('serves branding JSON and streams logo/favicon with caching headers; 404 when unset', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json().companyName).toBe('Scenox Vault');
    expect((await app.inject({ method: 'GET', url: '/api/public/branding/logo' })).statusCode).toBe(404);

    await getStorage().put('branding/logo-abc.png', Readable.from(Buffer.from('PNGDATA')));
    await getDb().insert(settings).values({ key: 'branding', value: { logoKey: 'branding/logo-abc.png' } });
    invalidateSettings();
    const logo = await app.inject({ method: 'GET', url: '/api/public/branding/logo' });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['cache-control']).toBe('public, max-age=300');
    expect(logo.body).toBe('PNGDATA');
    expect((await app.inject({ method: 'GET', url: '/api/public/branding' })).json().logoUrl).toContain('/api/public/branding/logo');
  });

  it('streams the portal logo', async () => {
    const { token, portal } = await seedPortal();
    expect((await get(token, {}, '/logo')).statusCode).toBe(404);
    await getStorage().put('branding/portal-x.svg', Readable.from(Buffer.from('<svg/>')));
    await getDb().update(portals).set({ logoKey: 'branding/portal-x.svg' }).where(eq(portals.id, portal.id));
    const res = await get(token, {}, '/logo');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await get(token)).json().portal.logoUrl).toBe(`/api/public/portals/${token}/logo`);
  });
});
