import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config, resetConfig } from '../src/config';
import { getDb } from '../src/db';
import { activityLogs, exportJobs, files, notifications, portalAccessTokens, settings, uploadSessions } from '../src/db/schema';
import { markFileFailed, processFile, processSessionComplete, runCleanup, runStorageCheck, startWorkers } from '../src/jobs';
import { deliverNotification } from '../src/services/notifications';
import { closeQueues, getQueue, getRedis, QUEUES } from '../src/queue';
import { scanWithClamd } from '../src/services/scanner';
import { invalidateSettings } from '../src/services/settings';
import { KEYS, getStorage } from '../src/storage';
import { resetDatabase, setupTestApp } from './helpers';
import { adminHeaders, seedPortal, seedReadyFile, seedSession, sha256Hex, sleep } from './upload-utils';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupTestApp();
  for (const q of Object.values(QUEUES)) await getQueue(q).obliterate({ force: true });
});
beforeEach(async () => {
  await resetDatabase();
  invalidateSettings();
});
afterAll(async () => {
  await app.close();
  await closeQueues();
});

const setEnv = (vars: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
};

// ───────────────────────── fake servers ─────────────────────────

/** Minimal clamd: understands zINSTREAM, flags payloads containing "EICAR". */
function fakeClamd() {
  const received: number[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, Buffer.from(d)]);
      if (buf.length < 10) return;
      let p = 10; // "zINSTREAM\0"
      let chunks = 0;
      let total = 0;
      let hasEicar = false;
      for (;;) {
        if (buf.length < p + 4) return;
        const len = buf.readUInt32BE(p);
        if (len === 0) break;
        if (buf.length < p + 4 + len) return;
        if (buf.subarray(p + 4, p + 4 + len).includes('EICAR')) hasEicar = true;
        total += len;
        chunks++;
        p += 4 + len;
      }
      received.push(total, chunks);
      sock.end(hasEicar ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
    });
  });
  return new Promise<{ port: number; received: number[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => new Promise((r) => server.close(() => r())) })),
  );
}

function fakeSmtp() {
  const messages: string[] = [];
  const server = net.createServer((sock) => {
    let data = '';
    let inData = false;
    sock.write('220 localhost ESMTP\r\n');
    sock.on('data', (d) => {
      const text = d.toString('utf8');
      if (inData) {
        data += text;
        if (data.endsWith('\r\n.\r\n')) {
          inData = false;
          messages.push(data);
          data = '';
          sock.write('250 queued\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 localhost\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise<{ port: number; messages: string[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, messages, close: () => new Promise((r) => server.close(() => r())) })),
  );
}

// ───────────────────────── process-file ─────────────────────────

describe('process-file', () => {
  async function processing(data: Buffer, name = 'a.bin') {
    const { client, portal } = await seedPortal();
    const session = await seedSession(portal);
    const seeded = await seedReadyFile(portal, session, { name, data, status: 'processing' });
    return { client, portal, session, ...seeded };
  }

  it('hashes, sniffs the real MIME, moves to the permanent key; scan skipped when ClamAV is off', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64, 1)]);
    const { file, portal, session } = await processing(png, 'looks-like.txt');
    await getDb().update(files).set({ checksumSha256: null }).where(eq(files.id, file.id));
    await processFile(file.id);
    const [f] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(f).toMatchObject({ status: 'ready', scanStatus: 'skipped', detectedMime: 'image/png', checksumSha256: sha256Hex(png) });
    expect(f!.storageKey).toBe(KEYS.fileKey(portal.clientId, portal.id, session.id, f!.storedFilename));
    expect(await getStorage().exists(f!.storageKey!)).toBe(true);
    expect(await getStorage().exists(KEYS.stagingKey(f!.storedFilename))).toBe(false);
  });

  it('is idempotent and retry-safe (bytes already moved by a previous attempt)', async () => {
    const data = Buffer.from('retry me');
    const { file, portal, session } = await processing(data);
    // simulate: previous attempt moved the bytes but crashed before updating the row
    const finalKey = KEYS.fileKey(portal.clientId, portal.id, session.id, file.storedFilename);
    await getStorage().move(KEYS.stagingKey(file.storedFilename), finalKey);
    await processFile(file.id);
    await processFile(file.id);
    const [f] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(f).toMatchObject({ status: 'ready', checksumSha256: sha256Hex(data), storageKey: finalKey });
  });

  it('throws (for a retry) when the bytes are missing; markFileFailed releases counters', async () => {
    const { file, abs, client } = await processing(Buffer.from('x'.repeat(50)));
    await fs.rm(abs);
    await expect(processFile(file.id)).rejects.toThrow(/not found/);
    await markFileFailed(file.id, 'File processing failed.');
    const [f] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(f).toMatchObject({ status: 'failed', error: 'File processing failed.' });
    const [cl] = await getDb().execute<{ file_count: number; storage_used_bytes: string }>(
      (await import('drizzle-orm')).sql`select file_count, storage_used_bytes from clients where id = ${client.id}`,
    );
    expect([cl!.file_count, Number(cl!.storage_used_bytes)]).toEqual([0, 0]);
    const [s] = await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, f!.uploadSessionId));
    expect([s!.failedFiles, s!.uploadedFiles]).toEqual([1, 0]);
    await markFileFailed(file.id, 'again'); // no double decrement
    expect((await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, f!.uploadSessionId)))[0]!.failedFiles).toBe(1);
  });

  it('flags duplicates by checksum within the same client', async () => {
    const data = Buffer.from('same bytes');
    const first = await processing(data, 'one.bin');
    await processFile(first.file.id);
    const session2 = await seedSession(first.portal);
    const second = await seedReadyFile(first.portal, session2, { name: 'two.bin', data, status: 'processing' });
    await processFile(second.file.id);
    const [f2] = await getDb().select().from(files).where(eq(files.id, second.file.id));
    expect(f2!.status).toBe('ready');
    expect(f2!.duplicateOfId).toBe(first.file.id);
    // a different client never matches
    const other = await seedPortal();
    const s3 = await seedSession(other.portal);
    const third = await seedReadyFile(other.portal, s3, { name: 'three.bin', data, status: 'processing' });
    await processFile(third.file.id);
    expect((await getDb().select().from(files).where(eq(files.id, third.file.id)))[0]!.duplicateOfId).toBeNull();
  });

  describe('with ClamAV enabled', () => {
    let clam: Awaited<ReturnType<typeof fakeClamd>>;
    beforeAll(async () => {
      clam = await fakeClamd();
    });
    afterAll(async () => {
      await clam.close();
    });
    afterEach(() => setEnv({ CLAMAV_ENABLED: undefined, CLAMAV_HOST: undefined, CLAMAV_PORT: undefined }));
    const enable = (port = clam.port) => setEnv({ CLAMAV_ENABLED: 'true', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(port) });

    it('speaks INSTREAM in 1 MB chunks and parses OK / FOUND replies', async () => {
      const big = Buffer.alloc(2.5 * 1024 * 1024, 5);
      const p = path.join(config().storage.path, 'scan-probe.bin');
      await fs.writeFile(p, big);
      clam.received.length = 0;
      expect(await scanWithClamd(p, { host: '127.0.0.1', port: clam.port })).toEqual({ status: 'clean' });
      expect(clam.received).toEqual([big.length, 3]); // 1 MB + 1 MB + 0.5 MB
      await fs.writeFile(p, 'xxEICARxx');
      expect(await scanWithClamd(p, { host: '127.0.0.1', port: clam.port })).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
      await fs.rm(p);
    });

    it('marks clean files clean', async () => {
      enable();
      const { file } = await processing(Buffer.from('harmless'));
      await processFile(file.id);
      expect((await getDb().select().from(files).where(eq(files.id, file.id)))[0]).toMatchObject({ status: 'ready', scanStatus: 'clean' });
    });

    it('quarantines infected files: moved, status, signature, activity, notification; downloads refused', async () => {
      enable();
      const { file, portal, abs } = await processing(Buffer.from('X5O!P%@AP EICAR-STANDARD'), 'invoice.pdf');
      await processFile(file.id);
      const [f] = await getDb().select().from(files).where(eq(files.id, file.id));
      expect(f).toMatchObject({ status: 'quarantined', scanStatus: 'infected', scanResult: 'Eicar-Test-Signature', storageKey: KEYS.quarantineKey(file.storedFilename), duplicateOfId: null });
      await expect(fs.stat(abs)).rejects.toThrow();
      expect(await getStorage().exists(f!.storageKey!)).toBe(true);
      const logs = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'file.quarantined'));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ actorType: 'system', clientId: portal.clientId });
      const notes = await getDb().select().from(notifications).where(eq(notifications.type, 'file_quarantined'));
      expect(notes.filter((n) => n.channel === 'in_app')).toHaveLength(1);
      const admin = await adminHeaders('owner');
      expect((await app.inject({ method: 'GET', url: `/api/files/${file.id}/download`, headers: admin.headers })).statusCode).toBe(403);
    });

    it('keeps the file (scanStatus "failed") when the scanner is unreachable', async () => {
      const dead = net.createServer();
      await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
      const port = (dead.address() as net.AddressInfo).port;
      await new Promise<void>((r) => dead.close(() => r()));
      enable(port);
      const { file } = await processing(Buffer.from('still stored'));
      await processFile(file.id);
      expect((await getDb().select().from(files).where(eq(files.id, file.id)))[0]).toMatchObject({ status: 'ready', scanStatus: 'failed' });
    });
  });
});

// ───────────────────────── session-complete / notifications ─────────────────────────

describe('session-complete', () => {
  async function completedSession() {
    const { client, portal } = await seedPortal({ client: { name: 'ABC Company' }, portal: { notifyEmails: ['ops@example.com'], notifyClient: true, name: 'Brand shoot' } });
    const session = await seedSession(portal, {
      status: 'completed', completedAt: new Date(), uploaderName: 'Jane Doe', uploaderEmail: 'jane@example.com', uploaderCompany: 'Acme', message: 'All the raw files',
    });
    await seedReadyFile(portal, session, { name: 'a.bin', data: Buffer.alloc(1500) });
    await seedReadyFile(portal, session, { name: 'b.bin', data: Buffer.alloc(500) });
    await getDb().insert(settings).values({ key: 'notifications', value: { adminEmails: ['admin@example.com', 'OPS@example.com'], notifyClientReceipt: true } });
    invalidateSettings();
    return { client, portal, session };
  }

  it('waits while files are still processing', async () => {
    const { portal, session } = await completedSession();
    const pending = await seedReadyFile(portal, session, { name: 'slow.bin', status: 'processing' });
    expect(await processSessionComplete(session.id)).toBe('wait');
    expect((await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, session.id)))[0]!.notifiedAt).toBeNull();
    expect(await getDb().select().from(notifications)).toHaveLength(0);
    // …but gives up waiting after 30 minutes
    expect(await processSessionComplete(session.id, new Date(Date.now() + 31 * 60_000))).toBe('done');
    void pending;
  });

  it('creates in-app + email rows (SMTP not configured → skipped, honestly), is idempotent', async () => {
    const { client, session } = await completedSession();
    expect(await processSessionComplete(session.id)).toBe('done');
    const rows = await getDb().select().from(notifications);
    const inApp = rows.filter((r) => r.channel === 'in_app');
    expect(inApp).toHaveLength(1);
    expect(inApp[0]).toMatchObject({ type: 'upload_completed', status: 'sent', clientId: client.id, uploadSessionId: session.id });
    expect(inApp[0]!.subject).toBe('New client upload completed — ABC Company');
    expect(inApp[0]!.link).toBe(`http://localhost:3000/uploads?session=${session.id}`);
    expect(inApp[0]!.body).toContain('Files: 2 (2.0 KB)');
    expect(inApp[0]!.body).toContain('Brand shoot');
    expect(inApp[0]!.body).toContain('Jane Doe <jane@example.com> (Acme)');

    const emails = rows.filter((r) => r.channel === 'email');
    expect(emails.map((e) => e.recipient).sort()).toEqual(['OPS@example.com', 'admin@example.com', 'jane@example.com']); // ops@ de-duplicated case-insensitively
    expect(emails.every((e) => e.status === 'skipped' && e.error === 'SMTP not configured')).toBe(true);
    expect(emails.find((e) => e.recipient === 'jane@example.com')!.type).toBe('upload_receipt');
    expect((await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, session.id)))[0]!.notifiedAt).toBeTruthy();

    expect(await processSessionComplete(session.id)).toBe('skipped');
    expect(await getDb().select().from(notifications)).toHaveLength(4);
  });

  it('respects notify flags (no admin emails when disabled; no client receipt unless enabled)', async () => {
    const { session } = await completedSession();
    await getDb().update(settings).set({ value: { adminEmails: ['admin@example.com'], notifyOnUploadComplete: false, notifyClientReceipt: false } }).where(eq(settings.key, 'notifications'));
    invalidateSettings();
    await processSessionComplete(session.id);
    const rows = await getDb().select().from(notifications);
    expect(rows.map((r) => r.channel)).toEqual(['in_app']);
  });

  describe('with SMTP configured', () => {
    let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
    beforeAll(async () => {
      smtp = await fakeSmtp();
      setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false' });
    });
    afterAll(async () => {
      setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_SECURE: undefined });
      await smtp.close();
    });

    it('queues pending emails and send-notification delivers them (HTML + text, escaped)', async () => {
      const { session } = await completedSession();
      await getDb().update(uploadSessions).set({ message: '<script>alert(1)</script>' }).where(eq(uploadSessions.id, session.id));
      await getQueue(QUEUES.notifications).obliterate({ force: true });
      await processSessionComplete(session.id);
      const emails = await getDb().select().from(notifications).where(eq(notifications.channel, 'email'));
      expect(emails).toHaveLength(3);
      expect(emails.every((e) => e.status === 'pending')).toBe(true);
      expect((await getQueue(QUEUES.notifications).getJobs(['waiting', 'delayed'])).filter((j) => j.name === 'send-notification')).toHaveLength(3);

      expect(await deliverNotification(emails[0]!.id)).toBe('sent');
      expect(await deliverNotification(emails[0]!.id)).toBe('noop'); // not sent twice
      const [row] = await getDb().select().from(notifications).where(eq(notifications.id, emails[0]!.id));
      expect(row).toMatchObject({ status: 'sent' });
      expect(row!.sentAt).toBeTruthy();
      expect(smtp.messages).toHaveLength(1);
      const raw = smtp.messages[0]!.replace(/=\r\n/g, '').replace(/=3D/g, '=');
      expect(raw).toContain('Subject:');
      expect(raw).toContain('Content-Type: text/html');
      expect(raw).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); // HTML part is escaped
      expect(raw.slice(raw.indexOf('Content-Type: text/html'))).not.toContain('<script>');
    });

    it('records delivery failures', async () => {
      const { session } = await completedSession();
      await processSessionComplete(session.id);
      const [email] = await getDb().select().from(notifications).where(eq(notifications.channel, 'email'));
      setEnv({ SMTP_PORT: '1' }); // nothing listens there; transport already cached → point the cached transport nowhere by closing the server
      await smtp.close();
      await expect(deliverNotification(email!.id)).rejects.toThrow();
      expect((await getDb().select().from(notifications).where(eq(notifications.id, email!.id)))[0]!.status).toBe('failed');
    });
  });
});

// ───────────────────────── cleanup ─────────────────────────

describe('cleanup', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  it('completes stale sessions with files (and queues the notification), abandons empty ones, leaves fresh ones', async () => {
    const { portal } = await seedPortal();
    await getQueue(QUEUES.notifications).obliterate({ force: true });
    const withFiles = await seedSession(portal, { lastActivityAt: hoursAgo(7), uploadedFiles: 3, uploadedBytes: 3000 });
    const empty = await seedSession(portal, { lastActivityAt: hoursAgo(7) });
    const fresh = await seedSession(portal, { lastActivityAt: hoursAgo(1), uploadedFiles: 1 });
    const summary = await runCleanup();
    expect(summary).toMatchObject({ sessionsCompleted: 1, sessionsAbandoned: 1 });
    const get = async (id: string) => (await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, id)))[0]!;
    expect(await get(withFiles.id)).toMatchObject({ status: 'completed' });
    expect((await get(withFiles.id)).completedAt).toBeTruthy();
    expect(Number((await get(withFiles.id)).avgSpeedBps)).toBeGreaterThanOrEqual(0);
    expect((await get(empty.id)).status).toBe('abandoned');
    expect((await get(fresh.id)).status).toBe('active');
    const jobs = await getQueue(QUEUES.notifications).getJobs(['waiting', 'delayed']);
    expect(jobs.filter((j) => j.name === 'session-complete').map((j) => j.data.sessionId)).toEqual([withFiles.id]);
    expect(await getDb().select().from(activityLogs).where(and(eq(activityLogs.action, 'upload.completed'), eq(activityLogs.actorType, 'system')))).toHaveLength(1);
    // already-notified sessions are not queued again
    const notified = await seedSession(portal, { lastActivityAt: hoursAgo(8), uploadedFiles: 1, notifiedAt: new Date() });
    await getQueue(QUEUES.notifications).obliterate({ force: true });
    await runCleanup();
    expect((await get(notified.id)).status).toBe('completed');
    expect(await getQueue(QUEUES.notifications).getJobs(['waiting', 'delayed'])).toHaveLength(0);
  });

  it('fails stale "uploading" files and removes their tus data; deletes expired tus uploads', async () => {
    const { portal } = await seedPortal();
    const session = await seedSession(portal);
    const root = config().storage.path;
    const storage = getStorage();
    const mkTus = async (id: string, created: Date) => {
      await fs.writeFile(path.join(root, 'tus', id), Buffer.alloc(10));
      await fs.writeFile(path.join(root, 'tus', `${id}.json`), JSON.stringify({ id, size: 100, offset: 0, creation_date: created.toISOString(), metadata: {} }));
    };
    await mkTus('stale1', hoursAgo(100));
    await mkTus('orphan1', hoursAgo(100)); // no files row at all
    await mkTus('fresh1', hoursAgo(1));
    const base = { clientId: portal.clientId, portalId: portal.id, uploadSessionId: session.id, storedFilename: 'x', size: 100, status: 'uploading' as const };
    await getDb().insert(files).values({ ...base, originalFilename: 'stale.bin', tusId: 'stale1', updatedAt: hoursAgo(100) });
    await getDb().insert(files).values({ ...base, originalFilename: 'fresh.bin', tusId: 'fresh1', updatedAt: hoursAgo(1) });
    const summary = await runCleanup();
    expect(summary.tusExpired).toBeGreaterThanOrEqual(1);
    expect(summary.uploadsFailed).toBe(1);
    const rows = Object.fromEntries((await getDb().select().from(files)).map((f) => [f.originalFilename, f.status]));
    expect(rows).toEqual({ 'stale.bin': 'failed', 'fresh.bin': 'uploading' });
    expect(await storage.exists('tus/stale1')).toBe(false);
    expect(await storage.exists('tus/stale1.json')).toBe(false);
    expect(await storage.exists('tus/orphan1')).toBe(false);
    expect(await storage.exists('tus/fresh1')).toBe(true);
    expect((await getDb().select().from(uploadSessions).where(eq(uploadSessions.id, session.id)))[0]!.failedFiles).toBe(1);
    await storage.delete('tus/fresh1');
    await storage.delete('tus/fresh1.json');
  });

  it('expires exports, purges access tokens and old activity, re-queues stuck processing files', async () => {
    const { portal } = await seedPortal();
    const session = await seedSession(portal);
    const storage = getStorage();
    await storage.put('exports/old.zip', (await import('node:stream')).Readable.from(Buffer.from('zip')));
    const [exp] = await getDb().insert(exportJobs).values({ fileIds: [], status: 'ready', outputKey: 'exports/old.zip', expiresAt: hoursAgo(1) }).returning();
    const [keep] = await getDb().insert(exportJobs).values({ fileIds: [], status: 'ready', outputKey: 'exports/keep.zip', expiresAt: new Date(Date.now() + 3600_000) }).returning();
    await getDb().insert(portalAccessTokens).values([
      { portalId: portal.id, tokenHash: 'old', expiresAt: hoursAgo(1) },
      { portalId: portal.id, tokenHash: 'new', expiresAt: new Date(Date.now() + 3600_000) },
    ]);
    await getDb().insert(activityLogs).values([
      { actorType: 'system', action: 'old.thing', createdAt: new Date(Date.now() - 400 * 86_400_000) },
      { actorType: 'system', action: 'new.thing' },
    ]);
    const stuck = await seedReadyFile(portal, session, { name: 'stuck.bin', status: 'processing', extra: { completedAt: hoursAgo(1) } });
    await getQueue(QUEUES.fileProcessing).obliterate({ force: true });

    const summary = await runCleanup();
    expect(summary).toMatchObject({ exportsExpired: 1, accessTokensPurged: 1, activityPurged: 1, processingRequeued: 1 });
    expect((await getDb().select().from(exportJobs).where(eq(exportJobs.id, exp!.id)))[0]).toMatchObject({ status: 'expired', outputKey: null });
    expect((await getDb().select().from(exportJobs).where(eq(exportJobs.id, keep!.id)))[0]!.status).toBe('ready');
    expect(await storage.exists('exports/old.zip')).toBe(false);
    expect((await getDb().select().from(portalAccessTokens)).map((t) => t.tokenHash)).toEqual(['new']);
    expect((await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'old.thing')))).toHaveLength(0);
    expect(await getQueue(QUEUES.fileProcessing).getJob(`process-file-${stuck.file.id}`)).toBeTruthy();
    // running again does not queue a second job while the first is waiting
    expect((await runCleanup()).processingRequeued).toBe(0);
  });

  it('keeps activity forever when retention is 0', async () => {
    await getDb().insert(settings).values({ key: 'retention', value: { activityLogDays: 0 } });
    invalidateSettings();
    await getDb().insert(activityLogs).values({ actorType: 'system', action: 'ancient', createdAt: new Date(Date.now() - 3000 * 86_400_000) });
    expect((await runCleanup()).activityPurged).toBe(0);
    expect(await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'ancient'))).toHaveLength(1);
  });
});

// ───────────────────────── storage-check ─────────────────────────

describe('storage-check', () => {
  it('alerts at most once per level per 24 h', async () => {
    const redis = getRedis();
    await redis.del('scenox:disk-alert:warning', 'scenox:disk-alert:critical');
    await getDb().insert(settings).values({ key: 'notifications', value: { diskWarningPercent: 0, diskCriticalPercent: 101, adminEmails: ['admin@example.com'] } });
    invalidateSettings();
    const first = await runStorageCheck();
    expect(first).toMatchObject({ level: 'warning', alerted: true });
    const again = await runStorageCheck();
    expect(again).toMatchObject({ level: 'warning', alerted: false });
    const rows = await getDb().select().from(notifications).where(eq(notifications.type, 'disk_warning'));
    expect(rows.filter((r) => r.channel === 'in_app')).toHaveLength(1);
    expect(rows.filter((r) => r.channel === 'email').map((r) => [r.recipient, r.status])).toEqual([['admin@example.com', 'skipped']]);
    expect(await redis.ttl('scenox:disk-alert:warning')).toBeGreaterThan(23 * 3600);

    // critical is a separate level with its own once-per-24h budget
    await getDb().update(settings).set({ value: { diskWarningPercent: 0, diskCriticalPercent: 0, adminEmails: [] } }).where(eq(settings.key, 'notifications'));
    invalidateSettings();
    expect(await runStorageCheck()).toMatchObject({ level: 'critical', alerted: true });
    await redis.del('scenox:disk-alert:warning', 'scenox:disk-alert:critical');
  });

  it('does nothing when usage is below the warning threshold', async () => {
    await getDb().insert(settings).values({ key: 'notifications', value: { diskWarningPercent: 101, diskCriticalPercent: 102 } });
    invalidateSettings();
    expect(await runStorageCheck()).toMatchObject({ level: 'ok', alerted: false });
    expect(await getDb().select().from(notifications)).toHaveLength(0);
  });
});

// ───────────────────────── real workers ─────────────────────────

describe('startWorkers', () => {
  it('processes a queued file end-to-end through BullMQ and registers the schedulers', async () => {
    const { portal } = await seedPortal();
    const session = await seedSession(portal);
    const data = Buffer.from('through the queue');
    const { file } = await seedReadyFile(portal, session, { name: 'q.bin', data, status: 'processing' });
    const { enqueue } = await import('../src/queue');
    const stop = await startWorkers();
    try {
      await enqueue('process-file', { fileId: file.id }, { jobId: `process-file-${file.id}` });
      let status = 'processing';
      for (let i = 0; i < 100 && status !== 'ready'; i++) {
        await sleep(100);
        status = (await getDb().select().from(files).where(eq(files.id, file.id)))[0]!.status;
      }
      expect(status).toBe('ready');
      const schedulers = await getQueue(QUEUES.maintenance).getJobSchedulers();
      expect(schedulers.map((s) => s.name ?? s.key).sort()).toEqual(['cleanup', 'storage-check']);

      // session-complete re-schedules itself (delayed, not failed) while files are still processing
      const busy = await seedSession(portal, { status: 'completed', completedAt: new Date() });
      await seedReadyFile(portal, busy, { name: 'busy.bin', status: 'processing' });
      const job = await enqueue('session-complete', { sessionId: busy.id }, { jobId: `session-complete-${busy.id}-1` });
      await sleep(800);
      expect(await job.getState()).toBe('delayed');
      expect(job.attemptsMade).toBe(0);
    } finally {
      await stop();
    }
    // pools are re-created lazily after stop()
    expect((await getDb().select().from(files).where(eq(files.id, file.id)))[0]!.checksumSha256).toBe(sha256Hex(data));
  });
});
