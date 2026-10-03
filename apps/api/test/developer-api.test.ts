import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetConfig } from '../src/config';
import { getDb } from '../src/db';
import { activityLogs, apiKeys, files, users } from '../src/db/schema';
import { closeQueues } from '../src/queue';
import { buildSignedUrl, signFileUrl } from '../src/services/signed-urls';
import { resetDatabase, setupTestApp } from './helpers';
import { adminHeaders, seedPortal, seedReadyFile, seedSession, sleep } from './upload-utils';

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

type Headers = Record<string, string>;
const call = (method: string, url: string, headers: Headers = {}, payload?: unknown) =>
  app.inject({ method: method as 'GET', url, headers, payload: payload as object | undefined });
const bearer = (key: string): Headers => ({ authorization: `Bearer ${key}` });

interface Created {
  key: string;
  apiKey: { id: string; name: string; prefix: string; scopes: string[]; expiresAt: string | null; revokedAt: string | null };
}
async function makeKey(admin: { headers: Headers }, scopes: string[] = ['read'], extra: Record<string, unknown> = {}): Promise<Created> {
  const res = await call('POST', '/api/developer/api-keys', admin.headers, { name: 'Test key', scopes, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function fixture() {
  const { client, portal } = await seedPortal();
  const session = await seedSession(portal, { uploaderName: 'Jane' });
  const owner = await adminHeaders('owner');
  return { client, portal, session, owner };
}

describe('API keys: management', () => {
  it('returns the secret once; the list only has the prefix; only a hash is stored', async () => {
    const { owner } = await fixture();
    const { key, apiKey } = await makeKey(owner, ['read', 'write'], { name: 'Claude agent', expiresInDays: 30 });
    expect(key).toMatch(/^svk_[A-Za-z0-9_-]{43}$/);
    expect(apiKey.prefix).toBe(key.slice(0, 12));
    expect(apiKey).toMatchObject({ name: 'Claude agent', scopes: ['read', 'write'], revokedAt: null });
    expect(new Date(apiKey.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const list = await call('GET', '/api/developer/api-keys', owner.headers);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(key);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ id: apiKey.id, prefix: apiKey.prefix, createdBy: { id: owner.user.id } });
    expect(list.json()[0].key).toBeUndefined();

    const [row] = await getDb().select().from(apiKeys);
    expect(row!.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key);

    // never logged
    const logs = JSON.stringify(await getDb().select().from(activityLogs));
    expect(logs).not.toContain(key);
    expect(logs).toContain('apikey.created');
  });

  it('validates input', async () => {
    const { owner } = await fixture();
    const bad = async (p: unknown) => expect((await call('POST', '/api/developer/api-keys', owner.headers, p)).statusCode).toBe(400);
    await bad({});
    await bad({ name: '', scopes: ['read'] });
    await bad({ name: 'x', scopes: [] });
    await bad({ name: 'x', scopes: ['admin'] });
    await bad({ name: 'x', scopes: ['read'], expiresInDays: 0 });
    await bad({ name: 'x', scopes: ['read'], extra: true });
  });

  it('limits scopes to the creator role; viewers cannot create write keys', async () => {
    const member = await adminHeaders('member');
    const viewer = await adminHeaders('viewer');
    expect((await makeKey(member, ['read', 'write'])).apiKey.scopes).toEqual(['read', 'write']);
    const res = await call('POST', '/api/developer/api-keys', viewer.headers, { name: 'v', scopes: ['write'] });
    expect(res.statusCode).toBe(403);
    expect((await call('GET', '/api/developer/api-keys', viewer.headers)).statusCode).toBe(403);
    expect((await call('GET', '/api/developer/api-keys')).statusCode).toBe(401);
  });

  it('members see and revoke only their own keys; owners/admins can revoke any', async () => {
    const owner = await adminHeaders('owner');
    const m1 = await adminHeaders('member');
    const m2 = await adminHeaders('member');
    const k1 = await makeKey(m1);
    const k2 = await makeKey(m2);
    expect((await call('GET', '/api/developer/api-keys', m1.headers)).json().map((k: { id: string }) => k.id)).toEqual([k1.apiKey.id]);
    expect((await call('GET', '/api/developer/api-keys', owner.headers)).json()).toHaveLength(2);
    expect((await call('DELETE', `/api/developer/api-keys/${k2.apiKey.id}`, m1.headers)).statusCode).toBe(404);
    expect((await call('GET', '/api/clients', bearer(k2.key))).statusCode).toBe(200); // still works
    expect((await call('DELETE', `/api/developer/api-keys/${k2.apiKey.id}`, owner.headers)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/developer/api-keys/${k1.apiKey.id}`, m1.headers)).statusCode).toBe(204);
    const list = (await call('GET', '/api/developer/api-keys', owner.headers)).json();
    expect(list.every((k: { revokedAt: string | null }) => k.revokedAt)).toBe(true);
    const logs = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'apikey.revoked'));
    expect(logs).toHaveLength(2);
  });
});

describe('API keys: authentication', () => {
  it('authenticates with Authorization: Bearer or x-api-key, never from the query string', async () => {
    const { owner, client } = await fixture();
    const { key } = await makeKey(owner);
    const a = await call('GET', '/api/files', bearer(key));
    expect(a.statusCode).toBe(200);
    expect(a.json()).toHaveProperty('items');
    expect((await call('GET', '/api/clients', { 'x-api-key': key })).json().items[0].id).toBe(client.id);
    expect((await call('GET', `/api/files?api_key=${key}`)).statusCode).toBe(401);
    expect((await call('GET', `/api/files?apiKey=${key}&key=${key}`)).statusCode).toBe(401);
  });

  it('answers 401 with a friendly message for unknown, malformed, revoked, expired keys and disabled creators', async () => {
    const { owner } = await fixture();
    const msg = 'Invalid or expired API key.';
    const unknown = await call('GET', '/api/files', bearer('svk_' + 'A'.repeat(43)));
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(msg);
    expect((await call('GET', '/api/files', bearer('svk_short'))).json().error.message).toBe(msg);

    const revoked = await makeKey(owner);
    await call('DELETE', `/api/developer/api-keys/${revoked.apiKey.id}`, owner.headers);
    const r = await call('GET', '/api/files', bearer(revoked.key));
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe(msg);

    const expired = await makeKey(owner, ['read'], { expiresInDays: 1 });
    expect((await call('GET', '/api/files', bearer(expired.key))).statusCode).toBe(200);
    await getDb().update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, expired.apiKey.id));
    expect((await call('GET', '/api/files', bearer(expired.key))).statusCode).toBe(401);

    const member = await adminHeaders('member');
    const mk = await makeKey(member);
    expect((await call('GET', '/api/files', bearer(mk.key))).statusCode).toBe(200);
    await getDb().update(users).set({ status: 'disabled' }).where(eq(users.id, member.user.id));
    expect((await call('GET', '/api/files', bearer(mk.key))).statusCode).toBe(401);
  });

  it('does not apply the Origin/CSRF check to bearer requests (but still does for cookies)', async () => {
    const { owner, session, portal } = await fixture();
    const f = await seedReadyFile(portal, session, { name: 'a.txt' });
    const { key } = await makeKey(owner, ['write']);
    const evil = { origin: 'https://evil.example', referer: 'https://evil.example/x' };
    const ok = await call('PATCH', `/api/files/${f.file.id}`, { ...bearer(key), ...evil }, { addTags: ['x'] });
    expect(ok.statusCode, ok.body).toBe(200);
    const cookie = await call('PATCH', `/api/files/${f.file.id}`, { cookie: owner.headers.cookie!, ...evil }, { addTags: ['y'] });
    expect(cookie.statusCode).toBe(403);
  });

  it('records last use (throttled) and labels audit entries with the key', async () => {
    const { owner, session, portal } = await fixture();
    const f = await seedReadyFile(portal, session, { name: 'a.txt' });
    const { key, apiKey } = await makeKey(owner, ['write'], { name: 'CI bot' });
    await call('PATCH', `/api/files/${f.file.id}`, bearer(key), { addTags: ['audited'] });
    await sleep(100);
    const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(row!.lastUsedAt).toBeTruthy();
    const first = row!.lastUsedAt!.getTime();
    await call('GET', '/api/files', bearer(key));
    await sleep(100);
    expect((await getDb().select().from(apiKeys).where(eq(apiKeys.id, apiKey.id)))[0]!.lastUsedAt!.getTime()).toBe(first); // within a minute: not rewritten

    const [log] = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.tagged'));
    expect(log!.actorLabel).toBe(`API key "CI bot" (${owner.user.name})`);
    expect(log!.actorId).toBe(owner.user.id);
    expect(log!.metadata).toMatchObject({ apiKeyId: apiKey.id });
  });
});

describe('API keys: scopes and role limits', () => {
  it('read keys can read but not write; write keys can', async () => {
    const { owner, session, portal, client } = await fixture();
    const f = await seedReadyFile(portal, session, { name: 'a.txt' });
    const ro = await makeKey(owner, ['read']);
    const rw = await makeKey(owner, ['write']);
    for (const url of ['/api/clients', `/api/clients/${client.id}`, '/api/portals', '/api/files', `/api/files/${f.file.id}`, '/api/files/browse?clientId=' + client.id, '/api/uploads', '/api/activity', '/api/messages/inbox']) {
      expect((await call('GET', url, bearer(ro.key))).statusCode, url).toBe(200);
    }
    expect((await call('GET', `/api/files/${f.file.id}/download`, bearer(ro.key))).statusCode).toBe(200);
    expect((await call('PATCH', `/api/files/${f.file.id}`, bearer(ro.key), { addTags: ['x'] })).statusCode).toBe(403);
    expect((await call('POST', '/api/files/tags', bearer(ro.key), { fileIds: [f.file.id], addTags: ['x'] })).statusCode).toBe(403);
    expect((await call('POST', '/api/clients', bearer(ro.key), { name: 'New' })).statusCode).toBe(403);
    expect((await call('DELETE', `/api/files/${f.file.id}`, bearer(ro.key))).statusCode).toBe(403);
    expect((await call('GET', `/api/files/${f.file.id}`, bearer(ro.key))).statusCode).toBe(200); // still there

    expect((await call('PATCH', `/api/files/${f.file.id}`, bearer(rw.key), { addTags: ['x'] })).statusCode).toBe(200);
    expect((await call('POST', '/api/clients', bearer(rw.key), { name: 'New' })).statusCode).toBe(201);
    expect((await call('DELETE', `/api/files/${f.file.id}`, bearer(rw.key))).statusCode).toBe(204);
  });

  it('effective permission = role AND scope (a member with a write key still cannot delete)', async () => {
    const { session, portal } = await fixture();
    const f = await seedReadyFile(portal, session, { name: 'a.txt' });
    const member = await adminHeaders('member');
    const { key } = await makeKey(member, ['read', 'write']);
    expect((await call('PATCH', `/api/files/${f.file.id}`, bearer(key), { addTags: ['x'] })).statusCode).toBe(200);
    expect((await call('DELETE', `/api/files/${f.file.id}`, bearer(key))).statusCode).toBe(403);
  });

  it('can never manage keys, webhooks, team or settings (even a write key of an owner)', async () => {
    const { owner } = await fixture();
    const { key } = await makeKey(owner, ['read', 'write']);
    const h = bearer(key);
    const forbidden = async (method: string, url: string, payload?: unknown) => expect((await call(method, url, h, payload)).statusCode, `${method} ${url}`).toBe(403);
    await forbidden('GET', '/api/developer/api-keys');
    await forbidden('POST', '/api/developer/api-keys', { name: 'escalate', scopes: ['write'] });
    await forbidden('DELETE', `/api/developer/api-keys/${'0'.repeat(8)}-0000-4000-8000-000000000000`);
    await forbidden('GET', '/api/developer/webhooks');
    await forbidden('POST', '/api/developer/webhooks', { name: 'x', url: 'https://example.com', events: ['*'] });
    await forbidden('GET', '/api/users');
    await forbidden('POST', '/api/users', { email: 'x@example.com', name: 'X', role: 'admin', password: 'correct-horse-battery-staple' });
    await forbidden('GET', '/api/settings');
    await forbidden('PATCH', '/api/settings', { branding: { companyName: 'Hacked' } });
    await forbidden('GET', '/api/audit');
    await forbidden('GET', '/api/system');
    // session-only routes
    await forbidden('GET', '/api/auth/me');
    await forbidden('POST', '/api/auth/password', { currentPassword: 'x', newPassword: 'y'.repeat(14) });
    await forbidden('POST', '/api/auth/logout');
  });
});

describe('API key rate limit', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_ENABLED;
    resetConfig();
  });

  it('allows 600 requests per minute per key, then answers 429 (other keys unaffected)', async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    resetConfig();
    const limited = await setupTestApp();
    try {
      const owner = await adminHeaders('owner');
      const mk = async () => (await limited.inject({ method: 'POST', url: '/api/developer/api-keys', headers: owner.headers, payload: { name: 'k', scopes: ['read'] } })).json() as Created;
      const a = await mk();
      const b = await mk();
      const get = (key: string) => limited.inject({ method: 'GET', url: '/api/clients?pageSize=1', headers: bearer(key) });
      for (let i = 0; i < 600; i++) {
        const r = await get(a.key);
        if (r.statusCode !== 200) throw new Error(`request ${i + 1} → ${r.statusCode}`);
      }
      const over = await get(a.key);
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('rate_limited');
      expect(over.headers['retry-after']).toBeDefined();
      expect((await get(b.key)).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
    // app for the remaining tests in this file is rebuilt in the next beforeAll-less test via setupTestApp
    app = await setupTestApp();
  }, 120_000);
});

describe('files: tags, meta, filters', () => {
  async function seedMany() {
    const { owner, portal, session, client } = await fixture();
    const mk = (name: string, extra: Record<string, unknown> = {}) => seedReadyFile(portal, session, { name, relativePath: 'sku-1', extra: extra as never });
    const a = await mk('a.jpg', { tags: ['shopify', 'hero'], completedAt: new Date('2026-01-01T00:00:00Z') });
    const b = await mk('b.jpg', { tags: ['hero'], completedAt: new Date('2026-02-01T00:00:00Z') });
    const c = await mk('c.jpg', { tags: [], completedAt: new Date('2026-03-01T00:00:00Z') });
    const { key } = await makeKey(owner, ['read', 'write']);
    return { owner, portal, session, client, a, b, c, h: bearer(key) };
  }
  const names = (res: { json: () => { items: { name: string }[] } }) => res.json().items.map((f) => f.name).sort();

  it('returns tags and meta on FileDTO and filters by tag / notTag / since / sort=completedAt', async () => {
    const { a, h, client } = await seedMany();
    const all = await call('GET', `/api/files?clientId=${client.id}`, h);
    expect(all.json().items.find((f: { id: string }) => f.id === a.file.id)).toMatchObject({ tags: ['shopify', 'hero'], meta: {} });
    expect(names(await call('GET', '/api/files?tag=hero', h))).toEqual(['a.jpg', 'b.jpg']);
    expect(names(await call('GET', '/api/files?tag=HERO', h))).toEqual(['a.jpg', 'b.jpg']); // normalised
    expect(names(await call('GET', '/api/files?notTag=shopify', h))).toEqual(['b.jpg', 'c.jpg']);
    expect(names(await call('GET', '/api/files?tag=hero&notTag=shopify', h))).toEqual(['b.jpg']);
    expect(names(await call('GET', '/api/files?tag=nope', h))).toEqual([]);
    expect(names(await call('GET', '/api/files?since=2026-01-15T00:00:00Z', h))).toEqual(['b.jpg', 'c.jpg']);
    expect(names(await call('GET', '/api/files?since=2026-02-01T00:00:00.000Z', h))).toEqual(['c.jpg']); // strictly after
    expect((await call('GET', '/api/files?since=garbage', h)).statusCode).toBe(400);
    expect((await call('GET', '/api/files?tag=bad%2Ftag', h)).statusCode).toBe(400);
    expect(names(await call('GET', '/api/files?tag=Hero%20Shot', h))).toEqual([]); // spaces become "-"; valid
    const sorted = await call('GET', '/api/files?sort=completedAt&order=asc', h);
    expect(sorted.json().items.map((f: { name: string }) => f.name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    const desc = await call('GET', '/api/files?sort=completedAt&order=desc', h);
    expect(desc.json().items.map((f: { name: string }) => f.name)).toEqual(['c.jpg', 'b.jpg', 'a.jpg']);
  });

  it('PATCH: tags (replace), addTags, removeTags are normalised and de-duplicated', async () => {
    const { b, h } = await seedMany();
    const patch = (payload: unknown) => call('PATCH', `/api/files/${b.file.id}`, h, payload);
    let r = await patch({ addTags: ['  Shopify ', 'SKU:123', 'shopify'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().tags).toEqual(['hero', 'shopify', 'sku:123']);
    r = await patch({ removeTags: ['hero', 'missing'] });
    expect(r.json().tags).toEqual(['shopify', 'sku:123']);
    r = await patch({ tags: ['a.b_c-d:e'] });
    expect(r.json().tags).toEqual(['a.b_c-d:e']);
    r = await patch({ tags: ['x', 'y'], addTags: ['z'], removeTags: ['x'] }); // replace → add → remove
    expect(r.json().tags).toEqual(['y', 'z']);
    expect((await patch({ tags: [] })).json().tags).toEqual([]);
    expect((await patch({ addTags: ['bad!tag'] })).statusCode).toBe(400);
    expect((await patch({ addTags: ['has/slash'] })).statusCode).toBe(400);
    expect((await patch({ addTags: [''] })).statusCode).toBe(400);
    expect((await patch({ addTags: ['x'.repeat(51)] })).statusCode).toBe(400);
    expect((await patch({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    // 20 is fine; one more through addTags is not
    expect((await patch({ tags: Array.from({ length: 20 }, (_, i) => `t${i}`) })).statusCode).toBe(200);
    expect((await patch({ addTags: ['one-more'] })).statusCode).toBe(400);
  });

  it('PATCH: meta is shallow-merged, null deletes keys, ≤ 16 KB; rename still works alongside', async () => {
    const { c, h } = await seedMany();
    const patch = (payload: unknown) => call('PATCH', `/api/files/${c.file.id}`, h, payload);
    let r = await patch({ meta: { shopifyProductId: 'gid://shopify/Product/1', sku: 'ABC', nested: { a: 1 } } });
    expect(r.json().meta).toEqual({ shopifyProductId: 'gid://shopify/Product/1', sku: 'ABC', nested: { a: 1 } });
    r = await patch({ meta: { sku: null, extra: 2, nested: { b: 2 } } });
    expect(r.json().meta).toEqual({ shopifyProductId: 'gid://shopify/Product/1', extra: 2, nested: { b: 2 } }); // shallow: nested replaced
    expect((await patch({ meta: { big: 'x'.repeat(17 * 1024) } })).statusCode).toBe(400);
    // merged result over the limit is refused too
    expect((await patch({ meta: { a: 'x'.repeat(9 * 1024) } })).statusCode).toBe(200);
    expect((await patch({ meta: { b: 'x'.repeat(9 * 1024) } })).statusCode).toBe(400);
    expect((await patch({ meta: 'not-an-object' })).statusCode).toBe(400);
    r = await patch({ name: 'renamed.jpg', addTags: ['done'], meta: { a: null } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ name: 'renamed.jpg', tags: ['done'] });
    expect(r.json().meta.a).toBeUndefined();
    // the old rename-only call still works for the web app (cookie + origin)
    const { owner } = await fixture();
    void owner;
  });

  it('keeps the legacy rename-only PATCH working with a session cookie', async () => {
    const { owner, portal, session } = await fixture();
    const f = await seedReadyFile(portal, session, { name: 'old.txt' });
    const r = await call('PATCH', `/api/files/${f.file.id}`, owner.headers, { name: 'new.txt' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ name: 'new.txt', tags: [], meta: {} });
    expect((await call('PATCH', `/api/files/${f.file.id}`, owner.headers, { name: '' })).statusCode).toBe(400);
  });

  it('POST /files/tags bulk-tags up to 1000 files and returns { updated }', async () => {
    const { a, b, c, h } = await seedMany();
    const ids = [a.file.id, b.file.id, c.file.id];
    let r = await call('POST', '/api/files/tags', h, { fileIds: ids, addTags: ['Batch-1', 'shopify'], removeTags: ['hero'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ updated: 3 });
    const rows = await getDb().select({ id: files.id, tags: files.tags }).from(files);
    const byId = new Map(rows.map((x) => [x.id, x.tags]));
    expect(byId.get(a.file.id)).toEqual(['shopify', 'batch-1']);
    expect(byId.get(b.file.id)).toEqual(['batch-1', 'shopify']);
    expect(byId.get(c.file.id)).toEqual(['batch-1', 'shopify']);
    // unknown ids are ignored, not an error
    r = await call('POST', '/api/files/tags', h, { fileIds: [a.file.id, '00000000-0000-4000-8000-000000000000'], removeTags: ['batch-1'] });
    expect(r.json()).toEqual({ updated: 1 });
    expect((await call('POST', '/api/files/tags', h, { fileIds: [], addTags: ['x'] })).statusCode).toBe(400);
    expect((await call('POST', '/api/files/tags', h, { fileIds: ids })).statusCode).toBe(400);
    expect((await call('POST', '/api/files/tags', h, { fileIds: ids, addTags: ['bad!tag'] })).statusCode).toBe(400);
    const tooMany = Array.from({ length: 1001 }, () => '00000000-0000-4000-8000-000000000000');
    expect((await call('POST', '/api/files/tags', h, { fileIds: tooMany, addTags: ['x'] })).statusCode).toBe(400);
  });
});

describe('signed URLs', () => {
  async function signedFixture(opts: { name?: string; data?: Buffer; extra?: Record<string, unknown> } = {}) {
    const { owner, portal, session } = await fixture();
    const f = await seedReadyFile(portal, session, { name: opts.name ?? 'photo.png', data: opts.data ?? Buffer.from('0123456789'.repeat(100)), extra: { detectedMime: 'image/png', ...opts.extra } as never });
    const { key } = await makeKey(owner, ['read']);
    const create = async (body: unknown = {}) => call('POST', `/api/files/${f.file.id}/signed-url`, bearer(key), body);
    return { owner, f, key, create };
  }
  const pathOf = (url: string) => url.replace('http://localhost:3000', '');

  it('creates a public URL that downloads without any credentials, with caching and CORP headers', async () => {
    const { f, create } = await signedFixture();
    const r = await create({ expiresIn: 86400 });
    expect(r.statusCode, r.body).toBe(200);
    const { url, expiresAt } = r.json();
    expect(url).toMatch(new RegExp(`^http://localhost:3000/api/public/files/${f.file.id}/\\d+/[A-Za-z0-9_-]{43}/photo\\.png$`));
    const msLeft = new Date(expiresAt).getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(86_300_000);
    expect(msLeft).toBeLessThanOrEqual(86_400_000);

    const dl = await call('GET', pathOf(url)); // no cookies, no headers
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(f.data)).toBe(true);
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.headers['content-disposition']).toContain('inline');
    expect(dl.headers['accept-ranges']).toBe('bytes');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(dl.headers['cache-control']).toMatch(/^private, max-age=(86[0-4]\d\d|863\d\d)$/);

    const head = await call('HEAD', pathOf(url));
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(f.data.length));
    expect(head.rawPayload.length).toBe(0);

    // the file name segment is cosmetic
    expect((await call('GET', pathOf(url).replace('photo.png', 'whatever.jpg'))).statusCode).toBe(200);
  });

  it('defaults: 1 hour, inline; attachment disposition is bound to the signature', async () => {
    const { create } = await signedFixture();
    const d = (await create({})).json();
    const left = new Date(d.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(3_500_000);
    expect(left).toBeLessThanOrEqual(3_600_000);

    const att = (await create({ disposition: 'attachment', expiresIn: 600 })).json();
    expect(att.url).toMatch(/\?d=a$/);
    const dl = await call('GET', pathOf(att.url));
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    // flipping the disposition invalidates the signature in both directions
    expect((await call('GET', pathOf(att.url).replace('?d=a', ''))).statusCode).toBe(403);
    expect((await call('GET', pathOf(d.url) + '?d=a')).statusCode).toBe(403);
  });

  it('supports Range requests (206) and rejects unsatisfiable ranges (416)', async () => {
    const { f, create } = await signedFixture();
    const { url } = (await create({})).json();
    const r = await call('GET', pathOf(url), { range: 'bytes=10-19' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 10-19/${f.data.length}`);
    expect(r.rawPayload.equals(f.data.subarray(10, 20))).toBe(true);
    const tail = await call('GET', pathOf(url), { range: 'bytes=-5' });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(f.data.subarray(f.data.length - 5))).toBe(true);
    expect((await call('GET', pathOf(url), { range: `bytes=${f.data.length + 10}-` })).statusCode).toBe(416);
  });

  it('refuses expired (410), tampered (403) and malformed links', async () => {
    const { f } = await signedFixture();
    const { url: expiredUrl } = buildSignedUrl(f.file, 60, 'inline', Date.now() - 3_600_000);
    const expired = await call('GET', pathOf(expiredUrl));
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe('link_expired');

    const { url } = buildSignedUrl(f.file, 600, 'inline');
    const parts = pathOf(url).split('/'); // '', api, public, files, id, exp, sig, name
    const tamper = (i: number, v: string) => [...parts.slice(0, i), v, ...parts.slice(i + 1)].join('/');
    const sig = parts[6]!;
    expect((await call('GET', tamper(6, (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)))).statusCode).toBe(403);
    expect((await call('GET', tamper(6, sig.slice(0, -1)))).statusCode).toBe(403);
    expect((await call('GET', tamper(5, String(Number(parts[5]) + 3600)))).statusCode).toBe(403); // extending the expiry
    expect((await call('GET', tamper(5, 'abc'))).statusCode).toBe(403);
    expect((await call('GET', tamper(4, '00000000-0000-4000-8000-000000000000'))).statusCode).toBe(403);
    expect((await call('GET', tamper(4, 'not-a-uuid'))).statusCode).toBe(403);
    // a validly signed link for another file id does not leak anything about this one
    const otherSig = signFileUrl('00000000-0000-4000-8000-000000000000', Number(parts[5]), 'inline');
    expect((await call('GET', tamper(6, otherSig))).statusCode).toBe(403);
    expect((await call('GET', pathOf(url))).statusCode).toBe(200); // the untouched link still works
  });

  it('refuses quarantined, not-ready and deleted files', async () => {
    const { f, create, owner } = await signedFixture();
    const { url } = (await create({})).json();
    await getDb().update(files).set({ status: 'quarantined' }).where(eq(files.id, f.file.id));
    const q = await call('GET', pathOf(url));
    expect(q.statusCode).toBe(403);
    expect(q.rawPayload.toString()).not.toContain('0123456789');
    expect((await create({})).statusCode).toBe(403); // can't mint new links for it either

    await getDb().update(files).set({ status: 'processing' }).where(eq(files.id, f.file.id));
    expect((await call('GET', pathOf(url))).statusCode).toBe(409);
    expect((await create({})).statusCode).toBe(409);

    await getDb().update(files).set({ status: 'ready' }).where(eq(files.id, f.file.id));
    expect((await call('GET', pathOf(url))).statusCode).toBe(200);
    await call('DELETE', `/api/files/${f.file.id}`, owner.headers);
    expect((await call('GET', pathOf(url))).statusCode).toBe(404);
  });

  it('validates the request and needs files.download', async () => {
    const { f, create } = await signedFixture();
    expect((await create({ expiresIn: 59 })).statusCode).toBe(400);
    expect((await create({ expiresIn: 604_801 })).statusCode).toBe(400);
    expect((await create({ expiresIn: 1.5 })).statusCode).toBe(400);
    expect((await create({ disposition: 'sideways' })).statusCode).toBe(400);
    expect((await create({ expiresIn: 604_800 })).statusCode).toBe(200);
    expect((await call('POST', `/api/files/${f.file.id}/signed-url`, {}, {})).statusCode).toBe(401);
    expect((await call('POST', '/api/files/00000000-0000-4000-8000-000000000000/signed-url', await keyHeaders(), {})).statusCode).toBe(404);
    async function keyHeaders() {
      const o = await adminHeaders('owner');
      return bearer((await makeKey(o)).key);
    }
  });

  it('only serves script-capable types as attachment / octet-stream, using the detected MIME', async () => {
    const svg = await signedFixture({ name: 'logo.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), extra: { detectedMime: 'image/svg+xml', mimeType: 'image/png' } });
    const r = await call('GET', pathOf((await svg.create({})).json().url));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
    // the declared (client-supplied) type is ignored when the detected one disagrees
    const lie = await signedFixture({ name: 'x.png', data: Buffer.from('<html>'), extra: { detectedMime: 'text/html', mimeType: 'image/png' } });
    const l = await call('GET', pathOf((await lie.create({})).json().url));
    expect(l.headers['content-type']).toBe('application/octet-stream');
    expect(l.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('audits link creation once (with expiresIn) and not each download; the key is attributed', async () => {
    const { f, create } = await signedFixture();
    const { url } = (await create({ expiresIn: 7200 })).json();
    for (let i = 0; i < 3; i++) await call('GET', pathOf(url));
    const created = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.signed_url_created'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ resourceId: f.file.id, metadata: expect.objectContaining({ expiresIn: 7200 }) });
    expect(created[0]!.actorLabel).toContain('API key "Test key"');
    expect(JSON.stringify(created[0])).not.toContain(url.split('/').slice(-2)[0]!); // signature is not logged
    expect(await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.downloaded'))).toHaveLength(0);
  });
});

describe('developer docs', () => {
  it('GET /api/docs is public Markdown with the base URL filled in and caching', async () => {
    const r = await call('GET', '/api/docs');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.body).toContain('# Scenox Vault Developer API');
    expect(r.body).toContain('http://localhost:3000/api');
    expect(r.body).not.toContain('https://<your-domain>');
  });
});
