import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetConfig } from '../src/config';
import { getDb } from '../src/db';
import { activityLogs, files, messages, notifications, portals, settings, users } from '../src/db/schema';
import { closeQueues, getQueue, QUEUES } from '../src/queue';
import { invalidateSettings } from '../src/services/settings';
import { resetDatabase, setupTestApp } from './helpers';
import { adminHeaders, seedPortal, seedReadyFile, seedSession } from './upload-utils';

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

const url = (token: string, suffix = '') => `/api/public/portals/${token}${suffix}`;
const pub = {
  get: (token: string, suffix: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: url(token, suffix), headers }),
  post: (token: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: url(token, '/messages'), payload: payload as object, headers }),
};
const admin = {
  get: (headers: Record<string, string>, path: string) => app.inject({ method: 'GET', url: `/api${path}`, headers }),
  post: (headers: Record<string, string>, path: string, payload?: unknown) => app.inject({ method: 'POST', url: `/api${path}`, headers, payload: (payload ?? undefined) as object | undefined }),
};
type Msg = { id: string; body: string; authorType: string; authorName: string; own?: boolean; readAt: string | null; fileId: string | null; fileName: string | null };

describe('public messages', () => {
  it('posts, lists oldest → newest with the own flag, and returns a MessageDTO', async () => {
    const { portal, token } = await seedPortal();
    const r1 = await pub.post(token, { body: '  Hello team  ', name: ' Jane ' });
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toMatchObject({ portalId: portal.id, fileId: null, fileName: null, authorType: 'client', authorName: 'Jane', body: 'Hello team', readAt: null, own: true });
    await getDb().insert(messages).values({ portalId: portal.id, clientId: portal.clientId, authorType: 'staff', authorName: 'ignored', body: 'Hi Jane', createdAt: new Date(Date.now() + 1000) });
    const list = (await pub.get(token, '/messages')).json() as { items: Msg[]; hasMore: boolean };
    expect(list.hasMore).toBe(false);
    expect(list.items.map((m) => m.body)).toEqual(['Hello team', 'Hi Jane']);
    expect(list.items.map((m) => m.own)).toEqual([true, false]);
    expect(list.items[1]!.authorName).toBe('Scenox Vault'); // no user → company name
    const stored = (await getDb().select().from(messages).where(eq(messages.authorType, 'client')))[0]!;
    expect(stored.authorEmail).toBeNull();
  });

  it('validates the body, name, email and fileId', async () => {
    const { token } = await seedPortal();
    const bad = async (payload: unknown) => expect((await pub.post(token, payload)).statusCode).toBe(400);
    await bad({});
    await bad({ body: '' });
    await bad({ body: '   \n ' });
    await bad({ body: 'x'.repeat(5001) });
    await bad({ body: 'ok', name: 'n'.repeat(101) });
    await bad({ body: 'ok', email: 'not-an-email' });
    await bad({ body: 'ok', email: `${'a'.repeat(200)}@example.com` });
    await bad({ body: 'ok', fileId: 'nope' });
    await bad({ body: 12 });
    expect((await pub.post(token, { body: 'x'.repeat(5000), name: 'n'.repeat(100), email: 'a@example.com', fileId: null })).statusCode).toBe(201);
    expect((await pub.post(token, { body: 'ok', name: '', email: '' })).statusCode).toBe(201);
    expect((await getDb().select().from(messages))).toHaveLength(2);
  });

  it('stores bodies as plain text (no HTML interpretation) and escapes nothing on the way in', async () => {
    const { token } = await seedPortal();
    const body = '<img src=x onerror=alert(1)> & "quotes"';
    expect((await pub.post(token, { body })).json().body).toBe(body);
    expect(((await pub.get(token, '/messages')).json() as { items: Msg[] }).items[0]!.body).toBe(body);
  });

  it('resolves the author name: given name → latest uploader name of this portal → "Client"', async () => {
    const { portal, token } = await seedPortal();
    expect((await pub.post(token, { body: 'a' })).json().authorName).toBe('Client');
    await seedSession(portal, { uploaderName: 'Old Uploader', startedAt: new Date(Date.now() - 100_000) });
    await seedSession(portal, { uploaderName: 'Newest Uploader', startedAt: new Date() });
    await seedSession(portal, { uploaderName: null, startedAt: new Date(Date.now() + 5000) });
    expect((await pub.post(token, { body: 'b' })).json().authorName).toBe('Newest Uploader');
    expect((await pub.post(token, { body: 'c', name: 'Given' })).json().authorName).toBe('Given');
    // other portals' uploader names never leak in
    const other = await seedPortal();
    await seedSession(other.portal, { uploaderName: 'Foreign' });
    expect((await pub.post(token, { body: 'd' })).json().authorName).toBe('Newest Uploader');
  });

  it('403 when the portal does not allow messages (GET and POST); dashboard unaffected', async () => {
    const { token } = await seedPortal({ portal: { allowClientMessages: false } });
    expect((await pub.get(token, '/messages')).statusCode).toBe(403);
    expect((await pub.post(token, { body: 'hi' })).statusCode).toBe(403);
    expect((await pub.get(token, '/dashboard')).statusCode).toBe(200);
  });

  it('paginates with before/limit (newest page first, oldest → newest inside the page)', async () => {
    const { portal, token } = await seedPortal();
    const base = Date.now() - 1_000_000;
    await getDb().insert(messages).values(
      Array.from({ length: 7 }, (_, i) => ({ portalId: portal.id, clientId: portal.clientId, authorType: 'client' as const, body: `m${i}`, createdAt: new Date(base + i * 1000) })),
    );
    const p1 = (await pub.get(token, '/messages?limit=3')).json() as { items: Msg[]; hasMore: boolean };
    expect(p1.items.map((m) => m.body)).toEqual(['m4', 'm5', 'm6']);
    expect(p1.hasMore).toBe(true);
    const before = new Date(base + 4000).toISOString();
    const p2 = (await pub.get(token, `/messages?limit=3&before=${encodeURIComponent(before)}`)).json() as { items: Msg[]; hasMore: boolean };
    expect(p2.items.map((m) => m.body)).toEqual(['m1', 'm2', 'm3']);
    expect(p2.hasMore).toBe(true);
    const p3 = (await pub.get(token, `/messages?limit=3&before=${encodeURIComponent(new Date(base + 1000).toISOString())}`)).json() as { items: Msg[]; hasMore: boolean };
    expect(p3.items.map((m) => m.body)).toEqual(['m0']);
    expect(p3.hasMore).toBe(false);
    expect((await pub.get(token, '/messages?limit=101')).statusCode).toBe(400);
    expect((await pub.get(token, '/messages?limit=0')).statusCode).toBe(400);
    expect((await pub.get(token, '/messages?before=yesterday')).statusCode).toBe(400);
    expect((await pub.get(token, '/messages?limit=100')).statusCode).toBe(200);
    expect(((await pub.get(token, '/messages')).json() as { items: Msg[] }).items).toHaveLength(7); // default 50
  });

  it('file comments: fileId must belong to this portal; threads are separate', async () => {
    const a = await seedPortal();
    const b = await seedPortal();
    const fa = await seedReadyFile(a.portal, await seedSession(a.portal), { name: 'logo.png' });
    const fb = await seedReadyFile(b.portal, await seedSession(b.portal), { name: 'other.png' });
    expect((await pub.post(a.token, { body: 'portal level' })).statusCode).toBe(201);
    const c = await pub.post(a.token, { body: 'nice logo', fileId: fa.file.id, name: 'Jane' });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ fileId: fa.file.id, fileName: 'logo.png' });
    expect((await pub.post(a.token, { body: 'sneaky', fileId: fb.file.id })).statusCode).toBe(404);
    expect((await pub.get(a.token, `/messages?fileId=${fb.file.id}`)).statusCode).toBe(404);
    expect((await pub.get(a.token, `/messages?fileId=${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect(((await pub.get(a.token, `/messages?fileId=${fa.file.id}`)).json() as { items: Msg[] }).items.map((m) => m.body)).toEqual(['nice logo']);
    expect(((await pub.get(a.token, '/messages')).json() as { items: Msg[] }).items.map((m) => m.body)).toEqual(['portal level', 'nice logo']); // whole conversation incl. file comments
    expect((await getDb().select().from(messages).where(eq(messages.portalId, b.portal.id)))).toHaveLength(0);
    // deleting the file cascades its comments
    await getDb().delete(files).where(eq(files.id, fa.file.id));
    expect((await getDb().select().from(messages).where(eq(messages.fileId, fa.file.id)))).toHaveLength(0);
  });

  it('logs message.posted with metadata (no body) as a client actor', async () => {
    const { portal, token } = await seedPortal();
    const f = await seedReadyFile(portal, await seedSession(portal));
    await pub.post(token, { body: 'hello', name: 'Jane' });
    await pub.post(token, { body: 'on file', fileId: f.file.id });
    const logs = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'message.posted'));
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ actorType: 'client', actorLabel: 'Jane', portalId: portal.id, clientId: portal.clientId, resourceType: 'message' });
    expect(logs[0]!.metadata).toEqual({ length: 5 });
    expect(logs[1]!.metadata).toEqual({ fileId: f.file.id, length: 7 });
    const owner = await adminHeaders();
    const act = (await admin.get(owner.headers, '/activity?pageSize=50')).json().items as { action: string; summary: string }[];
    expect(act.find((a) => a.action === 'message.posted')!.summary).toBe('ABC Company sent a message');
  });

  it('works with rate limiting disabled (many posts) and the route carries a 20/min limit when enabled', async () => {
    const { token } = await seedPortal();
    for (let i = 0; i < 25; i++) expect((await pub.post(token, { body: `m${i}` })).statusCode).toBe(201);
    // with rate limiting enabled, the 21st request in a minute from one IP is refused
    process.env.RATE_LIMIT_ENABLED = 'true';
    resetConfig();
    const limited = await setupLimitedApp();
    try {
      const l = await seedPortal();
      const codes: number[] = [];
      for (let i = 0; i < 22; i++) codes.push((await limited.inject({ method: 'POST', url: url(l.token, '/messages'), payload: { body: 'x' } })).statusCode);
      expect(codes.slice(0, 20).every((c) => c === 201)).toBe(true);
      expect(codes.slice(20)).toEqual([429, 429]);
    } finally {
      await limited.close();
      process.env.RATE_LIMIT_ENABLED = 'false';
      resetConfig();
    }
  });
});

async function setupLimitedApp() {
  const { buildApp } = await import('../src/app');
  const a = await buildApp();
  await a.ready();
  return a;
}

describe('read flags (both directions)', () => {
  it('client GET marks the staff messages of that thread as read; dashboard unread follows', async () => {
    const { portal, token } = await seedPortal();
    const f = await seedReadyFile(portal, await seedSession(portal));
    const staff = (body: string, fileId: string | null = null) =>
      getDb().insert(messages).values({ portalId: portal.id, clientId: portal.clientId, fileId, authorType: 'staff', body });
    await staff('portal reply 1');
    await staff('portal reply 2');
    await staff('file reply', f.file.id);

    let d = (await pub.get(token, '/dashboard')).json();
    expect(d.messages).toMatchObject({ total: 3, unread: 3 });
    expect(d.messages.latest.own).toBe(false);

    const list = (await pub.get(token, '/messages')).json() as { items: Msg[] };
    expect(list.items).toHaveLength(3); // whole conversation incl. the file comment
    expect(list.items.every((m) => m.readAt === null)).toBe(true); // snapshot before this view marks them
    d = (await pub.get(token, '/dashboard')).json();
    expect(d.messages.unread).toBe(0); // viewing the conversation marks everything in it read
    expect(((await pub.get(token, '/messages')).json() as { items: Msg[] }).items.every((m) => m.readAt !== null)).toBe(true);

    // a file thread on its own only marks that file's comments
    await staff('another file reply', f.file.id);
    await pub.get(token, `/messages?fileId=${f.file.id}`);
    expect((await pub.get(token, '/dashboard')).json().messages.unread).toBe(0);
  });

  it('client messages stay unread for staff until POST /portals/:id/messages/read; scoped to the portal', async () => {
    const owner = await adminHeaders();
    const a = await seedPortal();
    const b = await seedPortal();
    await pub.post(a.token, { body: 'from a 1' });
    await pub.post(a.token, { body: 'from a 2' });
    await pub.post(b.token, { body: 'from b' });
    const inbox = (await admin.get(owner.headers, '/messages/inbox')).json();
    expect(inbox.unreadTotal).toBe(3);

    // admin listing does not mark anything
    await admin.get(owner.headers, `/portals/${a.portal.id}/messages`);
    expect((await admin.get(owner.headers, '/messages/inbox')).json().unreadTotal).toBe(3);

    const r = await admin.post(owner.headers, `/portals/${a.portal.id}/messages/read`);
    expect(r.statusCode).toBe(204);
    const after = (await admin.get(owner.headers, '/messages/inbox')).json();
    expect(after.unreadTotal).toBe(1);
    expect(after.items.find((i: { portalId: string }) => i.portalId === b.portal.id).unread).toBe(1);
    expect(after.items.find((i: { portalId: string }) => i.portalId === a.portal.id).unread).toBe(0);
    // the client never sees their own message as read by virtue of staff reading (own messages have readAt for staff view)
    const list = (await admin.get(owner.headers, `/portals/${a.portal.id}/messages`)).json() as { items: Msg[] };
    expect(list.items.every((m) => m.readAt !== null)).toBe(true);
  });
});

describe('admin: portal thread, replies, comments', () => {
  it('lists the thread with permission checks and 404s for unknown/malformed portals', async () => {
    const { portal, token } = await seedPortal();
    await pub.post(token, { body: 'hi', name: 'Jane' });
    expect((await app.inject({ method: 'GET', url: `/api/portals/${portal.id}/messages` })).statusCode).toBe(401);
    const viewer = await adminHeaders('viewer');
    const r = await admin.get(viewer.headers, `/portals/${portal.id}/messages`);
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0]).toMatchObject({ body: 'hi', authorType: 'client', authorName: 'Jane' });
    expect(r.json().items[0].own).toBeUndefined();
    expect((await admin.get(viewer.headers, `/portals/${crypto.randomUUID()}/messages`)).statusCode).toBe(404);
    expect((await admin.get(viewer.headers, '/portals/nope/messages')).statusCode).toBe(404);
    expect((await admin.get(viewer.headers, `/portals/${portal.id}/messages?limit=500`)).statusCode).toBe(400);
    // viewers may not reply; mark-read is a view permission
    expect((await admin.post(viewer.headers, `/portals/${portal.id}/messages`, { body: 'x' })).statusCode).toBe(403);
    expect((await admin.post(viewer.headers, `/portals/${portal.id}/messages/read`)).statusCode).toBe(204);
  });

  it('staff replies: authorName = user name, audit log, client sees it as staff and not own', async () => {
    const { portal, token } = await seedPortal();
    const member = await adminHeaders('member');
    const f = await seedReadyFile(portal, await seedSession(portal), { name: 'doc.pdf' });
    expect((await admin.post(member.headers, `/portals/${portal.id}/messages`, { body: '' })).statusCode).toBe(400);
    expect((await admin.post(member.headers, `/portals/${portal.id}/messages`, { body: 'x'.repeat(5001) })).statusCode).toBe(400);
    expect((await admin.post(member.headers, `/portals/${portal.id}/messages`, { body: 'x', fileId: 'nope' })).statusCode).toBe(400);
    const other = await seedPortal();
    const foreign = await seedReadyFile(other.portal, await seedSession(other.portal));
    expect((await admin.post(member.headers, `/portals/${portal.id}/messages`, { body: 'x', fileId: foreign.file.id })).statusCode).toBe(404);

    const res = await admin.post(member.headers, `/portals/${portal.id}/messages`, { body: ' Thanks, received. ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ authorType: 'staff', authorName: member.user.name, body: 'Thanks, received.', readAt: null, fileId: null });
    const onFile = await admin.post(member.headers, `/portals/${portal.id}/messages`, { body: 'looks good', fileId: f.file.id });
    expect(onFile.json()).toMatchObject({ fileId: f.file.id, fileName: 'doc.pdf' });

    const logs = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'message.replied'));
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ actorType: 'user', actorId: member.user.id, portalId: portal.id, clientId: portal.clientId });
    expect(logs[0]!.metadata).toEqual({ length: 17 });
    const owner = await adminHeaders();
    const act = (await admin.get(owner.headers, '/activity?pageSize=50')).json().items as { action: string; summary: string }[];
    expect(act.find((a) => a.action === 'message.replied')!.summary).toBe('Replied to a client message');

    const clientView = (await pub.get(token, '/messages')).json() as { items: Msg[] };
    expect(clientView.items).toHaveLength(2); // portal reply + file comment
    expect(clientView.items[0]).toMatchObject({ authorType: 'staff', authorName: member.user.name, own: false });

    // deleted user → company name
    await getDb().delete(users).where(eq(users.id, member.user.id));
    const afterDelete = (await pub.get(token, '/messages')).json() as { items: Msg[] };
    expect(afterDelete.items[0]!.authorName).toBe('Scenox Vault');
  });

  it('GET /files/:id/comments returns the file thread for staff', async () => {
    const { portal, token } = await seedPortal();
    const f = await seedReadyFile(portal, await seedSession(portal), { name: 'a.png' });
    const g = await seedReadyFile(portal, await seedSession(portal), { name: 'b.png' });
    await pub.post(token, { body: 'on a', fileId: f.file.id, name: 'Jane' });
    await pub.post(token, { body: 'on b', fileId: g.file.id });
    await pub.post(token, { body: 'portal level' });
    const viewer = await adminHeaders('viewer');
    const r = await admin.get(viewer.headers, `/files/${f.file.id}/comments`);
    expect(r.statusCode).toBe(200);
    expect(r.json().hasMore).toBe(false);
    expect(r.json().items).toHaveLength(1);
    expect(r.json().items[0]).toMatchObject({ body: 'on a', fileId: f.file.id, fileName: 'a.png', authorName: 'Jane' });
    expect((await admin.get(viewer.headers, `/files/${crypto.randomUUID()}/comments`)).statusCode).toBe(404);
    expect((await admin.get(viewer.headers, '/files/nope/comments')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/files/${f.file.id}/comments` })).statusCode).toBe(401);
  });

  it('portal create/update accept allowClientMessages', async () => {
    const owner = await adminHeaders();
    const { client } = await seedPortal();
    const created = await admin.post(owner.headers, '/portals', { clientId: client.id, name: 'P2', allowClientMessages: false });
    expect(created.statusCode).toBe(201);
    expect(created.json().allowClientMessages).toBe(false);
    const upd = await app.inject({ method: 'PATCH', url: `/api/portals/${created.json().id}`, headers: owner.headers, payload: { allowClientMessages: true } });
    expect(upd.json().allowClientMessages).toBe(true);
    const [row] = await getDb().select().from(portals).where(eq(portals.id, created.json().id));
    expect(row!.allowClientMessages).toBe(true);
  });
});

describe('admin inbox', () => {
  it('one row per portal, newest activity first, with unread (client only) and totals', async () => {
    const owner = await adminHeaders();
    const a = await seedPortal({ client: { name: 'Alpha' }, portal: { name: 'A portal' } });
    const b = await seedPortal({ client: { name: 'Beta' }, portal: { name: 'B portal' } });
    const c = await seedPortal({ client: { name: 'Gamma' }, portal: { name: 'C portal' } }); // no messages → absent
    const t = Date.now() - 100_000;
    const add = (p: typeof a, authorType: 'client' | 'staff', body: string, at: number, readAt: Date | null = null) =>
      getDb().insert(messages).values({ portalId: p.portal.id, clientId: p.portal.clientId, authorType, body, createdAt: new Date(t + at), readAt, authorName: authorType === 'client' ? 'Pat' : null });
    await add(a, 'client', 'a1', 0);
    await add(a, 'staff', 'a2 staff', 1000);
    await add(a, 'client', 'a3 read', 2000, new Date());
    await add(a, 'client', 'a4', 3000);
    await add(b, 'client', 'b1', 5000);
    await add(b, 'staff', 'b2 staff newest', 9000);

    const r = await admin.get(owner.headers, '/messages/inbox');
    expect(r.statusCode).toBe(200);
    const { items, unreadTotal } = r.json() as { items: { portalId: string; portalName: string; clientId: string; clientName: string; unread: number; total: number; lastMessage: Msg }[]; unreadTotal: number };
    expect(items.map((i) => i.portalName)).toEqual(['B portal', 'A portal']);
    expect(items.map((i) => i.portalId)).not.toContain(c.portal.id);
    expect(items[0]).toMatchObject({ clientName: 'Beta', clientId: b.client.id, unread: 1, total: 2 });
    expect(items[0]!.lastMessage).toMatchObject({ body: 'b2 staff newest', authorType: 'staff' });
    expect(items[1]).toMatchObject({ clientName: 'Alpha', unread: 2, total: 4 });
    expect(items[1]!.lastMessage.body).toBe('a4');
    expect(unreadTotal).toBe(3);

    // a new message in A moves it to the top
    await pub.post(a.token, { body: 'fresh' });
    const r2 = (await admin.get(owner.headers, '/messages/inbox')).json() as { items: { portalName: string; unread: number }[] };
    expect(r2.items.map((i) => i.portalName)).toEqual(['A portal', 'B portal']);
    expect(r2.items[0]!.unread).toBe(3);
  });

  it('is empty without messages and requires portals.view', async () => {
    const owner = await adminHeaders();
    expect((await admin.get(owner.headers, '/messages/inbox')).json()).toEqual({ items: [], unreadTotal: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/messages/inbox' })).statusCode).toBe(401);
    const viewer = await adminHeaders('viewer');
    expect((await admin.get(viewer.headers, '/messages/inbox')).statusCode).toBe(200);
  });
});

describe('team notifications for client messages', () => {
  const rows = (type = 'client_message') => getDb().select().from(notifications).where(eq(notifications.type, type));

  it('creates one in-app notification, throttled to 1 per portal per 10 minutes', async () => {
    const a = await seedPortal({ client: { name: 'Acme' } });
    const b = await seedPortal({ client: { name: 'Bravo' } });
    expect((await pub.post(a.token, { body: 'first', name: 'Jane' })).statusCode).toBe(201);
    let list = await rows();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ channel: 'in_app', status: 'sent', subject: 'New message from Acme', link: `/portals/${a.portal.id}?tab=messages`, clientId: a.client.id, recipient: null });
    expect(list[0]!.body).toContain('first');
    expect(list[0]!.body).toContain('Jane');

    await pub.post(a.token, { body: 'second' });
    await pub.post(a.token, { body: 'third' });
    expect(await rows()).toHaveLength(1);

    // another portal is independent
    await pub.post(b.token, { body: 'hello' });
    expect(await rows()).toHaveLength(2);

    // after the window passes a new notification is created
    await getDb().update(notifications).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(notifications.link, `/portals/${a.portal.id}?tab=messages`));
    await pub.post(a.token, { body: 'later' });
    list = await rows();
    expect(list).toHaveLength(3);
  });

  it('concurrent messages produce a single notification', async () => {
    const a = await seedPortal();
    await Promise.all(Array.from({ length: 6 }, (_, i) => pub.post(a.token, { body: `burst ${i}` })));
    expect(await rows()).toHaveLength(1);
    expect(await getDb().select().from(messages)).toHaveLength(6);
  });

  it('records skipped email rows (SMTP not configured) for the admin recipients, same throttle', async () => {
    await getDb().insert(settings).values({ key: 'notifications', value: { adminEmails: ['Admin@Example.com'] } });
    invalidateSettings();
    const a = await seedPortal({ portal: { notifyEmails: ['extra@example.com', 'admin@example.com'] } });
    await pub.post(a.token, { body: 'ping' });
    await pub.post(a.token, { body: 'ping 2' });
    const emails = (await rows()).filter((n) => n.channel === 'email');
    expect(emails.map((e) => e.recipient).sort()).toEqual(['Admin@Example.com', 'extra@example.com']);
    expect(emails.every((e) => e.status === 'skipped' && e.error === 'SMTP not configured')).toBe(true);
    expect(emails[0]!.link).toBe(`http://localhost:3000/portals/${a.portal.id}?tab=messages`);
  });

  it('a failing notification never fails the message', async () => {
    const a = await seedPortal();
    // simulate a broken settings row type that makes admin email resolution throw
    await getDb().insert(settings).values({ key: 'notifications', value: { adminEmails: 123 } });
    invalidateSettings();
    const r = await pub.post(a.token, { body: 'still stored' });
    expect(r.statusCode).toBe(201);
    expect(await getDb().select().from(messages)).toHaveLength(1);
  });
});

describe('staff reply emails to the client', () => {
  it('does not email when SMTP is not configured', async () => {
    const { portal, token } = await seedPortal();
    await pub.post(token, { body: 'q', email: 'client@example.com' });
    const m = await adminHeaders('member');
    expect((await admin.post(m.headers, `/portals/${portal.id}/messages`, { body: 'a' })).statusCode).toBe(201);
    expect(await getDb().select().from(notifications).where(eq(notifications.type, 'staff_reply'))).toHaveLength(0);
  });

  describe('with SMTP configured', () => {
    beforeAll(() => {
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1';
      resetConfig();
    });
    afterAll(async () => {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_PORT;
      resetConfig();
      await getQueue(QUEUES.notifications).obliterate({ force: true });
    });

    it('queues an escaped email to the latest client email of the thread, never blocking the request', async () => {
      const { portal, token, client } = await seedPortal();
      const m = await adminHeaders('member');
      await pub.post(token, { body: 'old', email: 'old@example.com', name: 'Jane' });
      await pub.post(token, { body: 'new', email: 'Client@Example.com', name: 'Jane' });
      await pub.post(token, { body: 'no email follow-up' });
      const res = await admin.post(m.headers, `/portals/${portal.id}/messages`, { body: 'Thanks <b>so</b> much & more' });
      expect(res.statusCode).toBe(201);
      const mails = await getDb().select().from(notifications).where(and(eq(notifications.type, 'staff_reply')));
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ channel: 'email', status: 'pending', recipient: 'Client@Example.com', subject: 'New reply from Scenox Vault', clientId: client.id });
      expect(mails[0]!.body).toContain('Thanks <b>so</b> much & more'); // plain text row; HTML is escaped when rendered
      expect(mails[0]!.link).toMatch(/^http:\/\/localhost:3000\/u\/.+/);
      const { renderEmailHtml } = await import('../src/services/notifications');
      const html = renderEmailHtml(mails[0]!, { companyName: 'Scenox Vault', primaryColor: '#4F46E5' });
      expect(html).toContain('Thanks &lt;b&gt;so&lt;/b&gt; much &amp; more');
      expect(html).not.toContain('<b>so</b>');
    });

    it('skips the email when nobody in the thread left an address (file threads are separate)', async () => {
      const { portal, token } = await seedPortal();
      const f = await seedReadyFile(portal, await seedSession(portal));
      const m = await adminHeaders('member');
      await pub.post(token, { body: 'portal msg', email: 'client@example.com' });
      await pub.post(token, { body: 'file msg', fileId: f.file.id });
      await admin.post(m.headers, `/portals/${portal.id}/messages`, { body: 'reply on file', fileId: f.file.id });
      expect(await getDb().select().from(notifications).where(eq(notifications.type, 'staff_reply'))).toHaveLength(0);
      await admin.post(m.headers, `/portals/${portal.id}/messages`, { body: 'reply on portal' });
      expect(await getDb().select().from(notifications).where(eq(notifications.type, 'staff_reply'))).toHaveLength(1);
    });
  });
});
