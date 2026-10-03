import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { activityLogs, clients, files, notifications, portals, uploadSessions } from '../src/db/schema';
import { generatePortalToken } from '../src/services/portal-tokens';
import { getStorage } from '../src/storage';
import { loginAs, setupTestApp } from './helpers';

let app: FastifyInstance;
let owner: Awaited<ReturnType<typeof loginAs>>;
beforeEach(async () => {
  await app?.close();
  app = await setupTestApp();
  owner = await loginAs(app, 'owner');
});
afterAll(async () => {
  await app?.close();
});

const get = (url: string, headers = owner.headers) => app.inject({ url, headers });

async function seed() {
  const db = getDb();
  const [a, b] = await db
    .insert(clients)
    .values([
      { name: 'ABC Company', storageUsedBytes: 3000, fileCount: 2, quotaBytes: 10_000 },
      { name: 'XYZ Retail', storageUsedBytes: 500, fileCount: 1 },
    ])
    .returning();
  const mk = (clientId: string, name: string, extra: Partial<typeof portals.$inferInsert> = {}) => {
    const t = generatePortalToken();
    return { clientId, name, tokenHash: t.tokenHash, tokenEncrypted: t.tokenEncrypted, tokenPreview: t.tokenPreview, ...extra };
  };
  const [pa, pb, pc] = await db
    .insert(portals)
    .values([
      mk(a.id, 'Active'),
      mk(b.id, 'Expired', { expiresAt: new Date(Date.now() - 1000) }),
      mk(b.id, 'Disabled', { status: 'disabled' }),
    ])
    .returning();
  const exp = new Date(Date.now() + 1e7);
  const [live, done] = await db
    .insert(uploadSessions)
    .values([
      { clientId: a.id, portalId: pa.id, tokenHash: 's1', status: 'active', uploaderName: 'Jane', totalFiles: 2, totalBytes: 5000, expiresAt: exp },
      { clientId: b.id, portalId: pb.id, tokenHash: 's2', status: 'completed', completedAt: new Date(), avgSpeedBps: 2_000_000, expiresAt: exp },
    ])
    .returning();
  const base = { storedFilename: 'x' };
  await db.insert(files).values([
    { ...base, clientId: a.id, portalId: pa.id, uploadSessionId: live.id, originalFilename: 'a.jpg', extension: 'jpg', size: 2000, bytesReceived: 2000, status: 'ready', completedAt: new Date() },
    { ...base, clientId: a.id, portalId: pa.id, uploadSessionId: live.id, originalFilename: 'big.mov', extension: 'mov', size: 1000, bytesReceived: 400, status: 'uploading' },
    { ...base, clientId: b.id, portalId: pb.id, uploadSessionId: done.id, originalFilename: 'doc.pdf', extension: 'pdf', size: 500, bytesReceived: 500, status: 'processing', completedAt: new Date() },
    { ...base, clientId: b.id, portalId: pb.id, uploadSessionId: done.id, originalFilename: 'old.zip', extension: 'zip', size: 7777, bytesReceived: 7777, status: 'failed' },
  ]);
  return { a, b, pa, pb, pc, live, done };
}

describe('GET /api/dashboard', () => {
  it('requires auth', async () => {
    expect((await app.inject({ url: '/api/dashboard' })).statusCode).toBe(401);
  });

  it('returns real totals, live session progress and recent lists', async () => {
    const { live } = await seed();
    await getDb().insert(activityLogs).values({ actorType: 'system', action: 'client.created', metadata: { name: 'ABC Company' } });
    const res = await get('/api/dashboard');
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.totals).toEqual({ clients: 2, activePortals: 1, files: 2, storageUsedBytes: 3500, uploadsToday: 2, bytesToday: 2500, activeSessions: 1 });
    expect(d.storage.capacityBytes).toBeGreaterThan(0);
    expect(['ok', 'warning', 'critical']).toContain(d.storage.warningLevel);
    expect(d.recentSessions).toHaveLength(2);
    const liveDto = d.recentSessions.find((s: { id: string }) => s.id === live.id);
    expect(liveDto).toMatchObject({ clientName: 'ABC Company', portalName: 'Active', status: 'active', uploadedBytes: 2400 });
    expect(d.recentClients).toHaveLength(2);
    expect(d.recentClients.find((c: { name: string }) => c.name === 'XYZ Retail').portalCount).toBe(2);
    expect(d.recentActivity[0]).toMatchObject({ action: 'client.created', summary: 'Client ABC Company created' });
  });

  it('works on an empty database', async () => {
    const d = (await get('/api/dashboard')).json();
    expect(d.totals).toMatchObject({ clients: 0, files: 0, storageUsedBytes: 0 });
    expect(d.recentSessions).toEqual([]);
  });
});

describe('GET /api/analytics', () => {
  it('requires activity.view and validates days', async () => {
    expect((await get('/api/analytics?days=3')).statusCode).toBe(400);
    expect((await get('/api/analytics?days=400')).statusCode).toBe(400);
    const viewer = await loginAs(app, 'viewer');
    expect((await get('/api/analytics', viewer.headers)).statusCode).toBe(200);
  });

  it('returns a zero-filled daily series, top clients and file-type buckets', async () => {
    await seed();
    const res = await get('/api/analytics?days=7');
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.daily).toHaveLength(7);
    expect(a.daily.at(-1).date).toBe(new Date().toISOString().slice(0, 10));
    expect(a.daily.slice(0, 6).every((d: { files: number; bytes: number }) => d.files === 0 && d.bytes === 0)).toBe(true);
    expect(a.daily.at(-1)).toMatchObject({ files: 2, bytes: 2500, sessions: 2 });
    expect(a.totals).toMatchObject({ sessions: 2, completedSessions: 1, failedSessions: 0, activeSessions: 1, filesUploaded: 2, bytesUploaded: 2500, avgSpeedBps: 2_000_000, storageUsedBytes: 3500 });
    expect(a.topClients.map((c: { clientName: string; bytes: number }) => [c.clientName, c.bytes])).toEqual([['ABC Company', 2000], ['XYZ Retail', 500]]);
    expect(a.fileTypes).toEqual([
      { type: 'image', files: 1, bytes: 2000 },
      { type: 'document', files: 1, bytes: 500 },
    ]);
    expect(new Date(a.range.to).getTime()).toBeGreaterThan(new Date(a.range.from).getTime());
    expect((await get('/api/analytics?days=365')).json().daily).toHaveLength(365);
  });
});

describe('GET /api/storage', () => {
  it('requires system.view', async () => {
    const viewer = await loginAs(app, 'viewer');
    expect((await get('/api/storage', viewer.headers)).statusCode).toBe(403);
    const member = await loginAs(app, 'member');
    expect((await get('/api/storage', member.headers)).statusCode).toBe(200);
  });

  it('reports vault usage by status/client and temp usage', async () => {
    await seed();
    await getStorage().put('exports/e1.zip', Buffer.alloc(1234));
    const res = await get('/api/storage');
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.driver).toBe('local');
    expect(s.disk.totalBytes).toBeGreaterThan(0);
    expect(s.vaultUsedBytes).toBe(2500);
    expect(s.byStatus).toEqual(expect.arrayContaining([
      { status: 'ready', files: 1, bytes: 2000 },
      { status: 'uploading', files: 1, bytes: 1000 },
      { status: 'processing', files: 1, bytes: 500 },
      { status: 'failed', files: 1, bytes: 7777 },
    ]));
    expect(s.byClient[0]).toMatchObject({ clientName: 'ABC Company', files: 1, bytes: 2000, quotaBytes: 10_000 });
    expect(s.temp).toEqual({ incompleteUploads: 1, incompleteBytes: 400, exportsBytes: 1234 });
    expect(['ok', 'warning', 'critical']).toContain(s.warningLevel);
  });
});

describe('GET /api/system', () => {
  it('returns health with checks and queues', async () => {
    const res = await get('/api/system');
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(['ok', 'degraded', 'down']).toContain(s.status);
    expect(s.cpu.cores).toBeGreaterThan(0);
    expect(s.cpu.loadAvg).toHaveLength(3);
    expect(s.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(s.cpu.usagePercent).toBeLessThanOrEqual(100);
    expect(s.memory.totalBytes).toBeGreaterThan(s.memory.freeBytes);
    expect(s.memory.processRssBytes).toBeGreaterThan(0);
    expect(s.disk.totalBytes).toBeGreaterThan(0);
    expect(s.network).toHaveProperty('rxBytesPerSec');
    const checks = Object.fromEntries(s.checks.map((c: { name: string }) => [c.name, c]));
    expect(Object.keys(checks).sort()).toEqual(['clamav', 'database', 'redis', 'smtp', 'storage', 'worker']);
    expect(checks.database.status).toBe('ok');
    expect(checks.redis.status).toBe('ok');
    expect(checks.storage.status).toBe('ok');
    expect(checks.clamav.status).toBe('disabled');
    expect(checks.smtp.status).toBe('disabled');
    // a BullMQ worker may or may not be connected to this Redis (e.g. another test file's worker)
    if (checks.worker.status === 'down') {
      expect(checks.worker.message).toBe('No worker process connected');
      expect(s.status).toBe('degraded');
    } else {
      expect(checks.worker.status).toBe('ok');
      expect(s.status).toBe('ok');
    }
    expect(s.queues.map((q: { name: string }) => q.name).sort()).toEqual(['exports', 'file-processing', 'maintenance', 'notifications', 'webhooks']);
    const viewer = await loginAs(app, 'viewer');
    expect((await get('/api/system', viewer.headers)).statusCode).toBe(403);
  });
});

describe('activity, audit, notifications', () => {
  it('filters activity, restricts audit, paginates and joins client names', async () => {
    const { a } = await seed();
    await getDb().insert(activityLogs).values([
      { actorType: 'client', action: 'upload.completed', clientId: a.id, metadata: { files: 3 } },
      { actorType: 'client', action: 'upload.started', clientId: a.id },
      { actorType: 'user', actorLabel: 'Bob <b@x.com>', action: 'client.created', clientId: a.id },
      { actorType: 'system', action: 'auth.login_failed', result: 'failure' },
      { actorType: 'system', action: 'cleanup.run' },
    ]);
    const act = (await get('/api/activity?action=upload.')).json();
    expect(act.total).toBe(2);
    expect(act.items[0]).toMatchObject({ action: 'upload.started', clientName: 'ABC Company' });
    expect((await get('/api/activity?action=%25')).json().total).toBe(0);
    expect((await get(`/api/activity?clientId=${a.id}&actorType=client&pageSize=1&page=2`)).json()).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect((await get('/api/activity?from=2999-01-01')).json().total).toBe(0);
    expect((await get('/api/activity?actorType=robot')).statusCode).toBe(400);
    expect((await get('/api/activity?clientId=nope')).statusCode).toBe(400);
    const audit = (await get('/api/audit')).json();
    expect(audit.items.map((i: { action: string }) => i.action).sort()).toEqual(['auth.login', 'auth.login_failed', 'client.created'].sort());
    const member = await loginAs(app, 'member');
    expect((await get('/api/audit', member.headers)).statusCode).toBe(403);
    expect((await get('/api/activity', member.headers)).statusCode).toBe(200);
  });

  it('lists in-app notifications with unread count and marks them read', async () => {
    const db = getDb();
    const rows = await db
      .insert(notifications)
      .values([
        { type: 'upload.completed', channel: 'in_app', subject: 'One', body: 'b', status: 'sent', createdAt: new Date(Date.now() - 5000) },
        { type: 'upload.completed', channel: 'in_app', subject: 'Two', body: 'b', status: 'sent' },
        { type: 'upload.completed', channel: 'email', subject: 'Mail', body: 'b', recipient: 'x@y.z' },
      ])
      .returning();
    const list = (await get('/api/notifications')).json();
    expect(list).toMatchObject({ total: 2, unread: 2, page: 1 });
    expect(list.items.map((n: { subject: string }) => n.subject)).toEqual(['Two', 'One']);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/read', headers: owner.headers, payload: { ids: [rows[0].id] } })).statusCode).toBe(204);
    expect((await get('/api/notifications')).json().unread).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/read', headers: owner.headers, payload: { ids: ['nope'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/read', headers: owner.headers, payload: {} })).statusCode).toBe(204);
    expect((await get('/api/notifications')).json().unread).toBe(0);
    expect((await app.inject({ url: '/api/notifications' })).statusCode).toBe(401);
  });
});
