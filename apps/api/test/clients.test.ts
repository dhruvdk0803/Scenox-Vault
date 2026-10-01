import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { getDb } from '../src/db';
import { activityLogs, clients, files, portals, uploadSessions } from '../src/db/schema';
import { generatePortalToken } from '../src/services/portal-tokens';
import { getStorage } from '../src/storage';
import { loginAs, setupTestApp } from './helpers';

let app: FastifyInstance;
beforeEach(async () => {
  await app?.close();
  app = await setupTestApp();
});
afterAll(async () => {
  await app?.close();
});

type H = Record<string, string>;
const post = (headers: H, payload: object) => app.inject({ method: 'POST', url: '/api/clients', headers, payload });

describe('clients CRUD', () => {
  it('viewer can read but not create; member can manage', async () => {
    const viewer = await loginAs(app, 'viewer');
    const member = await loginAs(app, 'member');
    expect((await post(viewer.headers, { name: 'Nope' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/clients', headers: viewer.headers })).statusCode).toBe(200);
    const res = await post(member.headers, { name: '  ABC Company  ', email: '', quotaBytes: 5_000_000_000 });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({ name: 'ABC Company', email: null, quotaBytes: 5_000_000_000, portalCount: 0, status: 'active', storageUsedBytes: 0 });
    const got = await app.inject({ url: `/api/clients/${c.id}`, headers: viewer.headers });
    expect(got.json().id).toBe(c.id);
    expect((await app.inject({ url: '/api/clients/not-a-uuid', headers: viewer.headers })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/clients/${'0'.repeat(8)}-0000-4000-8000-000000000000`, headers: viewer.headers })).statusCode).toBe(404);
  });

  it('validates input', async () => {
    const { headers } = await loginAs(app, 'owner');
    expect((await post(headers, { name: '' })).statusCode).toBe(400);
    expect((await post(headers, { name: 'X', email: 'bad' })).statusCode).toBe(400);
    expect((await post(headers, { name: 'X', quotaBytes: -5 })).statusCode).toBe(400);
    expect((await post(headers, { name: 'X', quotaBytes: 0 })).statusCode).toBe(400);
    expect((await post(headers, { name: 'X', quotaBytes: 1.5 })).statusCode).toBe(400);
    expect((await post(headers, { name: 'X', status: 'disabled', evil: 1 })).statusCode).toBe(400);
    expect((await post(headers, { name: 'X', quotaBytes: null })).statusCode).toBe(201);
  });

  it('patches fields and audits client.disabled', async () => {
    const { headers } = await loginAs(app, 'owner');
    const c = (await post(headers, { name: 'Acme', notes: 'hello' })).json();
    const upd = await app.inject({ method: 'PATCH', url: `/api/clients/${c.id}`, headers, payload: { notes: null, company: 'Acme Inc', quotaBytes: 123 } });
    expect(upd.json()).toMatchObject({ notes: null, company: 'Acme Inc', quotaBytes: 123, name: 'Acme' });
    const dis = await app.inject({ method: 'PATCH', url: `/api/clients/${c.id}`, headers, payload: { status: 'disabled' } });
    expect(dis.json().status).toBe('disabled');
    const actions = (await getDb().select().from(activityLogs)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['client.created', 'client.updated', 'client.disabled']));
    expect((await app.inject({ method: 'PATCH', url: `/api/clients/${c.id}`, headers, payload: { status: 'nope' } })).statusCode).toBe(400);
  });
});

describe('client list', () => {
  it('searches (escaping wildcards), filters, sorts and paginates', async () => {
    const { headers } = await loginAs(app, 'owner');
    for (const n of ['Alpha Co', 'Beta 100%', 'Gamma_Studio', 'Delta']) await post(headers, { name: n, company: n === 'Delta' ? 'Alpha Holdings' : null });
    const list = async (qs: string) => (await app.inject({ url: `/api/clients?${qs}`, headers })).json();
    expect((await list('q=alpha')).items.map((c: { name: string }) => c.name).sort()).toEqual(['Alpha Co', 'Delta']);
    expect((await list('q=%25')).items.map((c: { name: string }) => c.name)).toEqual(['Beta 100%']);
    expect((await list('q=_')).items.map((c: { name: string }) => c.name)).toEqual(['Gamma_Studio']);
    expect((await list('q=a_a')).total).toBe(0);
    const sorted = await list('sort=name&order=asc');
    expect(sorted.items.map((c: { name: string }) => c.name)).toEqual(['Alpha Co', 'Beta 100%', 'Delta', 'Gamma_Studio']);
    const page = await list('sort=name&order=asc&pageSize=2&page=2');
    expect(page).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(page.items.map((c: { name: string }) => c.name)).toEqual(['Delta', 'Gamma_Studio']);
    expect((await list('pageSize=9999')).pageSize).toBe(200);
    expect((await app.inject({ url: '/api/clients?sort=passwordHash', headers })).statusCode).toBe(400);
    await app.inject({ method: 'PATCH', url: `/api/clients/${sorted.items[0].id}`, headers, payload: { status: 'disabled' } });
    expect((await list('status=disabled')).total).toBe(1);
    expect((await list('status=active')).total).toBe(3);
  });

  it('includes portalCount', async () => {
    const { headers } = await loginAs(app, 'owner');
    const c = (await post(headers, { name: 'With portals' })).json();
    for (const name of ['One', 'Two']) await app.inject({ method: 'POST', url: '/api/portals', headers, payload: { clientId: c.id, name } });
    expect((await app.inject({ url: `/api/clients/${c.id}`, headers })).json().portalCount).toBe(2);
    expect((await app.inject({ url: '/api/clients', headers })).json().items[0].portalCount).toBe(2);
  });
});

describe('client delete', () => {
  async function seedFiles() {
    const db = getDb();
    const [client] = await db.insert(clients).values({ name: 'Doomed', storageUsedBytes: 10, fileCount: 2 }).returning();
    const tok = generatePortalToken();
    const [portal] = await db
      .insert(portals)
      .values({ clientId: client.id, name: 'P', tokenHash: tok.tokenHash, tokenEncrypted: tok.tokenEncrypted, tokenPreview: tok.tokenPreview })
      .returning();
    const [session] = await db
      .insert(uploadSessions)
      .values({ clientId: client.id, portalId: portal.id, tokenHash: 'h-' + Math.random(), expiresAt: new Date(Date.now() + 1e6) })
      .returning();
    const storage = getStorage();
    const permanent = `uploads/${client.id}/${portal.id}/${session.id}/a.bin`;
    const staged = 'staging/staged-file.bin';
    await storage.put(permanent, Buffer.from('permanent'));
    await storage.put(staged, Buffer.from('staged'));
    await db.insert(files).values([
      { clientId: client.id, portalId: portal.id, uploadSessionId: session.id, originalFilename: 'a.bin', storedFilename: 'a.bin', size: 9, status: 'ready', storageKey: permanent },
      { clientId: client.id, portalId: portal.id, uploadSessionId: session.id, originalFilename: 'b.bin', storedFilename: 'staged-file.bin', size: 6, status: 'processing', storageKey: staged },
    ]);
    return { client, portal, permanent, staged };
  }

  it('requires clients.manage + files.delete and removes db rows and storage objects', async () => {
    const { client, permanent, staged } = await seedFiles();
    const member = await loginAs(app, 'member'); // clients.manage but no files.delete
    const owner = await loginAs(app, 'owner');
    expect((await app.inject({ method: 'DELETE', url: `/api/clients/${client.id}`, headers: member.headers })).statusCode).toBe(403);
    expect(await getStorage().exists(permanent)).toBe(true);

    const res = await app.inject({ method: 'DELETE', url: `/api/clients/${client.id}`, headers: owner.headers });
    expect(res.statusCode).toBe(204);
    expect(await getStorage().exists(permanent)).toBe(false);
    expect(await getStorage().exists(staged)).toBe(false);
    await expect(fs.access(path.join(config().storage.path, 'uploads', client.id))).rejects.toThrow();
    expect(await getDb().select().from(clients).where(eq(clients.id, client.id))).toHaveLength(0);
    expect(await getDb().select().from(files)).toHaveLength(0);
    expect(await getDb().select().from(portals)).toHaveLength(0);
    const log = (await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'client.deleted')))[0];
    expect(log.clientId).toBe(client.id);
    expect((await app.inject({ method: 'DELETE', url: `/api/clients/${client.id}`, headers: owner.headers })).statusCode).toBe(404);
  });
});
