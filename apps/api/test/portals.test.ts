import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { activityLogs, clients, files, portals, uploadSessions } from '../src/db/schema';
import { verifyPassword } from '../src/lib/password';
import { findPortalByToken } from '../src/services/portal-tokens';
import { updateSettings } from '../src/services/settings';
import { getStorage } from '../src/storage';
import { loginAs, setupTestApp } from './helpers';

let app: FastifyInstance;
let owner: Awaited<ReturnType<typeof loginAs>>;
let clientId: string;

beforeEach(async () => {
  await app?.close();
  app = await setupTestApp();
  owner = await loginAs(app, 'owner');
  clientId = (await app.inject({ method: 'POST', url: '/api/clients', headers: owner.headers, payload: { name: 'ABC Company' } })).json().id;
});
afterAll(async () => {
  await app?.close();
});

const createPortal = (payload: object, headers = owner.headers) => app.inject({ method: 'POST', url: '/api/portals', headers, payload });
const tokenOf = (url: string) => url.split('/u/')[1];

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function multipart(filename: string, contentType: string, data: Buffer) {
  const boundary = '----scenoxtest' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('create', () => {
  it('returns a PortalDTO with a working url and no secrets', async () => {
    const res = await createPortal({ clientId, name: 'Main', password: 'client-pass-123', allowedExtensions: ['.JPG', 'png', 'jpg', ' .Mov '], notifyEmails: ['A@Example.com', 'a@example.com'] });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.url).toMatch(/^http:\/\/localhost:3000\/u\/[A-Za-z0-9_-]{32}$/);
    expect(p).toMatchObject({ hasPassword: true, status: 'active', clientName: 'ABC Company', allowedExtensions: ['jpg', 'png', 'mov'], notifyEmails: ['a@example.com'], maxFileSizeBytes: null });
    expect(JSON.stringify(p)).not.toMatch(/\$argon2|passwordHash|tokenHash|tokenEncrypted/);
    expect(p.tokenPreview).toBe(tokenOf(p.url).slice(0, 6));
    const found = await findPortalByToken(tokenOf(p.url));
    expect(found?.id).toBe(p.id);
    // password stored as an argon2 hash
    const [row] = await getDb().select().from(portals).where(eq(portals.id, p.id));
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(row.passwordHash!, 'client-pass-123')).toBe(true);
    expect((await app.inject({ url: `/api/portals/${p.id}`, headers: owner.headers })).json().url).toBe(p.url);
    expect((await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'portal.created')))[0].portalId).toBe(p.id);
  });

  it('applies defaults from settings and null for "any" extensions', async () => {
    await updateSettings({ uploads: { defaultMaxFileSizeBytes: 1_000_000, defaultPortalQuotaBytes: 9_000_000 } });
    const a = (await createPortal({ clientId, name: 'A', allowedExtensions: [] })).json();
    expect(a).toMatchObject({ maxFileSizeBytes: 1_000_000, maxTotalBytes: 9_000_000, allowedExtensions: null });
    const b = (await createPortal({ clientId, name: 'B', maxFileSizeBytes: null, maxTotalBytes: 5 })).json();
    expect(b).toMatchObject({ maxFileSizeBytes: null, maxTotalBytes: 5 });
  });

  it('validates input and the client', async () => {
    expect((await createPortal({ clientId, name: '' })).statusCode).toBe(400);
    expect((await createPortal({ clientId, name: 'x', password: 'short' })).statusCode).toBe(400);
    expect((await createPortal({ clientId, name: 'x', maxFileSizeBytes: -1 })).statusCode).toBe(400);
    expect((await createPortal({ clientId, name: 'x', maxTotalBytes: 0 })).statusCode).toBe(400);
    expect((await createPortal({ clientId, name: 'x', notifyEmails: ['nope'] })).statusCode).toBe(400);
    expect((await createPortal({ clientId, name: 'x', allowedExtensions: ['../etc'] })).statusCode).toBe(400);
    expect((await createPortal({ clientId, name: 'x', expiresAt: 'tomorrow' })).statusCode).toBe(400);
    expect((await createPortal({ clientId: '00000000-0000-4000-8000-000000000000', name: 'x' })).statusCode).toBe(400);
    expect((await createPortal({ clientId: 'nope', name: 'x' })).statusCode).toBe(400);
    await app.inject({ method: 'PATCH', url: `/api/clients/${clientId}`, headers: owner.headers, payload: { status: 'disabled' } });
    expect((await createPortal({ clientId, name: 'x' })).statusCode).toBe(400);
  });

  it('viewer cannot create', async () => {
    const viewer = await loginAs(app, 'viewer');
    expect((await createPortal({ clientId, name: 'x' }, viewer.headers)).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/portals', headers: viewer.headers })).statusCode).toBe(200);
  });
});

describe('update / regenerate', () => {
  it('sets, keeps and removes the password; toggles status with audit actions', async () => {
    const p = (await createPortal({ clientId, name: 'P' })).json();
    const url = `/api/portals/${p.id}`;
    expect((await app.inject({ method: 'PATCH', url, headers: owner.headers, payload: { password: 'new-secret-pass' } })).json().hasPassword).toBe(true);
    expect((await app.inject({ method: 'PATCH', url, headers: owner.headers, payload: { title: 'Hi' } })).json()).toMatchObject({ hasPassword: true, title: 'Hi' });
    expect((await app.inject({ method: 'PATCH', url, headers: owner.headers, payload: { password: null } })).json().hasPassword).toBe(false);
    expect((await app.inject({ method: 'PATCH', url, headers: owner.headers, payload: { password: 'short' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url, headers: owner.headers, payload: { status: 'disabled' } })).json()).toMatchObject({ status: 'disabled', storedStatus: 'disabled' });
    await app.inject({ method: 'PATCH', url, headers: owner.headers, payload: { status: 'active' } });
    const actions = (await getDb().select().from(activityLogs)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['portal.updated', 'portal.disabled', 'portal.enabled']));
  });

  it('derives expired status from expiresAt', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const expired = (await createPortal({ clientId, name: 'Old', expiresAt: past })).json();
    const live = (await createPortal({ clientId, name: 'New', expiresAt: future })).json();
    const off = (await createPortal({ clientId, name: 'Off', expiresAt: past })).json();
    await app.inject({ method: 'PATCH', url: `/api/portals/${off.id}`, headers: owner.headers, payload: { status: 'disabled' } });
    expect(expired).toMatchObject({ status: 'expired', storedStatus: 'active' });
    expect(live.status).toBe('active');
    expect(off.status).toBe('expired');
    const get = async (qs: string) => (await app.inject({ url: `/api/portals?${qs}`, headers: owner.headers })).json();
    expect((await get('status=expired')).items.map((p: { id: string }) => p.id)).toEqual([expired.id]);
    expect((await get('status=active')).items.map((p: { id: string }) => p.id)).toEqual([live.id]);
    expect((await get('status=disabled')).items.map((p: { id: string }) => p.id)).toEqual([off.id]);
    expect((await get(`clientId=${clientId}`)).total).toBe(3);
    expect((await get('q=ol')).items.map((p: { name: string }) => p.name)).toEqual(['Old']);
    expect((await get('status=bogus')).error.code).toBe('validation_error');
  });

  it('regenerate invalidates the old link immediately', async () => {
    const p = (await createPortal({ clientId, name: 'P' })).json();
    const oldToken = tokenOf(p.url);
    expect((await findPortalByToken(oldToken))?.id).toBe(p.id);
    const res = await app.inject({ method: 'POST', url: `/api/portals/${p.id}/regenerate`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const next = res.json();
    expect(next.url).not.toBe(p.url);
    expect(await findPortalByToken(oldToken)).toBeNull();
    expect((await findPortalByToken(tokenOf(next.url)))?.id).toBe(p.id);
    expect((await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'portal.link_regenerated'))).length).toBe(1);
  });
});

describe('logo', () => {
  it('accepts a PNG by magic bytes, replaces and deletes it; rejects SVG and spoofed types', async () => {
    const p = (await createPortal({ clientId, name: 'P' })).json();
    const url = `/api/portals/${p.id}/logo`;
    const up = multipart('logo.png', 'image/png', PNG);
    const res = await app.inject({ method: 'POST', url, headers: { ...owner.headers, ...up.headers }, payload: up.body });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasLogo).toBe(true);
    const [row] = await getDb().select().from(portals).where(eq(portals.id, p.id));
    expect(row.logoKey).toMatch(new RegExp(`^branding/portal-${p.id}-[0-9a-f]+\\.png$`));
    expect(await getStorage().exists(row.logoKey!)).toBe(true);

    const second = multipart('x.png', 'image/png', PNG);
    await app.inject({ method: 'POST', url, headers: { ...owner.headers, ...second.headers }, payload: second.body });
    const [row2] = await getDb().select().from(portals).where(eq(portals.id, p.id));
    expect(row2.logoKey).not.toBe(row.logoKey);
    expect(await getStorage().exists(row.logoKey!)).toBe(false);

    const svg = multipart('x.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    expect((await app.inject({ method: 'POST', url, headers: { ...owner.headers, ...svg.headers }, payload: svg.body })).statusCode).toBe(400);
    const fake = multipart('x.png', 'image/png', Buffer.from('definitely not an image'));
    expect((await app.inject({ method: 'POST', url, headers: { ...owner.headers, ...fake.headers }, payload: fake.body })).statusCode).toBe(400);
    const big = multipart('big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 10)]));
    expect((await app.inject({ method: 'POST', url, headers: { ...owner.headers, ...big.headers }, payload: big.body })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url, headers: owner.headers, payload: { a: 1 } })).statusCode).toBe(400);

    const del = await app.inject({ method: 'DELETE', url, headers: owner.headers });
    expect(del.json().hasLogo).toBe(false);
    expect(await getStorage().exists(row2.logoKey!)).toBe(false);
  });
});

describe('delete', () => {
  it('requires files.delete, removes storage and decrements client counters', async () => {
    const db = getDb();
    const p = (await createPortal({ clientId, name: 'P' })).json();
    const other = (await createPortal({ clientId, name: 'Other' })).json();
    await db.update(portals).set({ storageUsedBytes: 700, fileCount: 2 }).where(eq(portals.id, p.id));
    await db.update(portals).set({ storageUsedBytes: 300, fileCount: 1 }).where(eq(portals.id, other.id));
    await db.update(clients).set({ storageUsedBytes: 1000, fileCount: 3 }).where(eq(clients.id, clientId));
    const [session] = await db.insert(uploadSessions).values({ clientId, portalId: p.id, tokenHash: 'h' + Math.random(), expiresAt: new Date(Date.now() + 1e6) }).returning();
    const key = `uploads/${clientId}/${p.id}/${session.id}/f.bin`;
    const otherKey = `uploads/${clientId}/${other.id}/s/f.bin`;
    await getStorage().put(key, Buffer.from('x'));
    await getStorage().put(otherKey, Buffer.from('y'));
    await db.insert(files).values({ clientId, portalId: p.id, uploadSessionId: session.id, originalFilename: 'f', storedFilename: 'f.bin', size: 1, storageKey: key, status: 'ready' });

    const member = await loginAs(app, 'member');
    expect((await app.inject({ method: 'DELETE', url: `/api/portals/${p.id}`, headers: member.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/portals/${p.id}`, headers: owner.headers })).statusCode).toBe(204);
    expect(await getStorage().exists(key)).toBe(false);
    expect(await getStorage().exists(otherKey)).toBe(true);
    const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(c).toMatchObject({ storageUsedBytes: 300, fileCount: 1 });
    expect(await db.select().from(portals).where(eq(portals.id, p.id))).toHaveLength(0);
    expect(await db.select().from(files)).toHaveLength(0);
    expect((await app.inject({ url: `/api/portals/${p.id}`, headers: owner.headers })).statusCode).toBe(404);
  });
});
