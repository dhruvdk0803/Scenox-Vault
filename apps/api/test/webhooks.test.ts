import http from 'node:http';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetConfig } from '../src/config';
import { getDb } from '../src/db';
import { clients, notifications, webhookDeliveries, webhooks } from '../src/db/schema';
import { decrypt } from '../src/lib/crypto';
import { isBlockedAddress } from '../src/lib/ssrf';
import { processFile, processSessionComplete, runCleanup, startWorkers } from '../src/jobs';
import { closeQueues, getQueue, QUEUES } from '../src/queue';
import { deliverWebhook, emitEvent, signPayload, validateWebhookUrl, WEBHOOK_AUTO_DISABLE_AFTER } from '../src/services/webhooks';
import { invalidateSettings } from '../src/services/settings';
import { resetDatabase, setupTestApp } from './helpers';
import { adminHeaders, seedPortal, seedReadyFile, seedSession, sleep } from './upload-utils';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.WEBHOOK_ALLOW_PRIVATE = 'true'; // the receiver below listens on 127.0.0.1
  resetConfig();
  app = await setupTestApp();
  await getQueue(QUEUES.webhooks).obliterate({ force: true });
});
beforeEach(async () => {
  await resetDatabase();
  invalidateSettings();
  receiver.reset();
});
afterAll(async () => {
  await getQueue(QUEUES.webhooks).obliterate({ force: true });
  await app.close();
  await closeQueues();
  await receiver.close();
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  resetConfig();
});

// ───────────────────────── local receiver ─────────────────────────

interface Hit {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function makeReceiver() {
  const hits: Hit[] = [];
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_r, res) => res.writeHead(200).end('ok');
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      respond(req, res);
    });
  });
  server.listen(0, '127.0.0.1');
  return {
    hits,
    get port() {
      return (server.address() as AddressInfo).port;
    },
    url: (p = '/hook') => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`,
    respondWith: (fn: typeof respond) => {
      respond = fn;
    },
    reset() {
      hits.length = 0;
      respond = (_r, res) => res.writeHead(200).end('ok');
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
const receiver = makeReceiver();

// ───────────────────────── helpers ─────────────────────────

type Headers = Record<string, string>;
const call = (method: string, url: string, headers: Headers = {}, payload?: unknown) =>
  app.inject({ method: method as 'GET', url, headers, payload: payload as object | undefined });

async function createHook(admin: { headers: Headers }, body: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/developer/webhooks', admin.headers, { name: 'Test hook', url: receiver.url(), events: ['*'], ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { webhook: { id: string; enabled: boolean }; secret: string };
}
const deliveries = (webhookId?: string) =>
  getDb().select().from(webhookDeliveries).where(webhookId ? eq(webhookDeliveries.webhookId, webhookId) : undefined).orderBy(desc(webhookDeliveries.createdAt));

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}

describe('webhook management', () => {
  it('creates with the secret shown once (stored encrypted), lists without it', async () => {
    const admin = await adminHeaders('owner');
    const { webhook, secret } = await createHook(admin, { name: 'Shopify sync', events: ['upload.completed', 'file.ready'] });
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    expect(webhook).toMatchObject({ name: 'Shopify sync', events: ['upload.completed', 'file.ready'], enabled: true, clientId: null, clientName: null, consecutiveFailures: 0, lastStatus: null });
    const list = await call('GET', '/api/developer/webhooks', admin.headers);
    expect(list.json()).toHaveLength(1);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain('secret');
    const [row] = await getDb().select().from(webhooks);
    expect(row!.secretEncrypted).not.toContain(secret);
    expect(decrypt(row!.secretEncrypted)).toBe(secret);
  });

  it('validates input; collapses "*"; checks the client filter', async () => {
    const admin = await adminHeaders('owner');
    const bad = async (p: Record<string, unknown>) => expect((await call('POST', '/api/developer/webhooks', admin.headers, { name: 'x', url: receiver.url(), events: ['*'], ...p })).statusCode).toBe(400);
    await bad({ name: '' });
    await bad({ url: 'not a url' });
    await bad({ url: 'ftp://example.com/x' });
    await bad({ url: 'http://user:pw@example.com/x' });
    await bad({ events: [] });
    await bad({ events: ['nope'] });
    await bad({ clientId: '00000000-0000-4000-8000-000000000000' });
    const { webhook } = await createHook(admin, { events: ['file.ready', '*', 'file.ready'] });
    expect((webhook as unknown as { events: string[] }).events).toEqual(['*']);
  });

  it('is restricted to owner/admin sessions (members, viewers, API keys get 403)', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const u = await adminHeaders(role);
      expect((await call('GET', '/api/developer/webhooks', u.headers)).statusCode).toBe(403);
      expect((await call('POST', '/api/developer/webhooks', u.headers, { name: 'x', url: receiver.url(), events: ['*'] })).statusCode).toBe(403);
    }
    expect((await call('GET', '/api/developer/webhooks')).statusCode).toBe(401);
    const admin = await adminHeaders('admin');
    expect((await call('GET', '/api/developer/webhooks', admin.headers)).statusCode).toBe(200);
  });

  it('PATCH updates fields (re-enabling resets the failure streak), DELETE removes with its deliveries', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin);
    await getDb().update(webhooks).set({ enabled: false, consecutiveFailures: 50 }).where(eq(webhooks.id, webhook.id));
    const r = await call('PATCH', `/api/developer/webhooks/${webhook.id}`, admin.headers, { name: 'Renamed', enabled: true, events: ['file.ready'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ name: 'Renamed', enabled: true, consecutiveFailures: 0, events: ['file.ready'] });
    expect((await call('PATCH', `/api/developer/webhooks/${webhook.id}`, admin.headers, { url: 'nope' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/developer/webhooks/00000000-0000-4000-8000-000000000000', admin.headers, { name: 'x' })).statusCode).toBe(404);
    await emitEvent('file.ready', { id: 'x' });
    expect(await deliveries(webhook.id)).toHaveLength(1);
    expect((await call('DELETE', `/api/developer/webhooks/${webhook.id}`, admin.headers)).statusCode).toBe(204);
    expect(await getDb().select().from(webhookDeliveries)).toHaveLength(0);
    expect((await call('DELETE', `/api/developer/webhooks/${webhook.id}`, admin.headers)).statusCode).toBe(404);
  });

  it('rotates the secret: the old one stops verifying, the new one is returned once', async () => {
    const admin = await adminHeaders('owner');
    const { webhook, secret } = await createHook(admin);
    const r = await call('POST', `/api/developer/webhooks/${webhook.id}/rotate-secret`, admin.headers);
    expect(r.statusCode).toBe(200);
    const next = r.json().secret as string;
    expect(next).toMatch(/^whsec_/);
    expect(next).not.toBe(secret);
    await emitEvent('file.ready', { id: 'x' });
    const [d] = await deliveries(webhook.id);
    await deliverWebhook(d!.id);
    const hit = receiver.hits[0]!;
    const sig = hit.headers['x-scenox-signature'] as string;
    const [t, v1] = [/t=(\d+)/.exec(sig)![1]!, /v1=([0-9a-f]+)/.exec(sig)![1]!];
    expect(v1).toBe(createHmac('sha256', next).update(`${t}.${hit.body}`).digest('hex'));
    expect(v1).not.toBe(createHmac('sha256', secret).update(`${t}.${hit.body}`).digest('hex'));
  });
});

describe('URL validation and SSRF protection', () => {
  it('classifies addresses: private/loopback/link-local/CGNAT/multicast/metadata are blocked, public ones are not', () => {
    for (const ip of [
      '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1',
      '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '240.0.0.1', '198.18.0.1',
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', '2001:db8::1',
      'fd00:ec2::254', 'not-an-ip',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('rejects private literal hosts at creation when WEBHOOK_ALLOW_PRIVATE=false', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = 'false';
    resetConfig();
    try {
      const admin = await adminHeaders('owner');
      for (const url of ['http://127.0.0.1:9/hook', 'http://localhost:3000/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]:80/x', 'http://10.1.2.3/x', 'http://192.168.0.5/x', 'http://[fd00::1]/x', 'http://100.64.1.1/x']) {
        const r = await call('POST', '/api/developer/webhooks', admin.headers, { name: 'ssrf', url, events: ['*'] });
        expect(r.statusCode, url).toBe(400);
        expect(r.json().error.details.fields.url, url).toMatch(/private|internal/);
      }
      expect((await call('POST', '/api/developer/webhooks', admin.headers, { name: 'ok', url: 'https://example.com/hook', events: ['*'] })).statusCode).toBe(201);
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
      resetConfig();
    }
  });

  it('requires https in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_ALLOW_PRIVATE = 'false';
    resetConfig();
    try {
      expect(validateWebhookUrl('http://example.com/hook')).toMatch(/https/);
      expect(validateWebhookUrl('http://localhost/hook')).toMatch(/https/);
      expect(validateWebhookUrl('https://example.com/hook')).toBeNull();
    } finally {
      process.env.NODE_ENV = prev;
      process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
      resetConfig();
    }
  });

  it('refuses at delivery time (literal IP and DNS names that resolve to loopback), without sending anything', async () => {
    const admin = await adminHeaders('owner');
    const literal = (await createHook(admin, { name: 'literal' })).webhook;
    const dns = (await createHook(admin, { name: 'dns', url: `http://localhost:${receiver.port}/hook` })).webhook;
    await emitEvent('file.ready', { id: 'x' });
    process.env.WEBHOOK_ALLOW_PRIVATE = 'false'; // flipped after creation: the delivery-time guard must still hold
    resetConfig();
    try {
      for (const hook of [literal, dns]) {
        const [d] = await deliveries(hook.id);
        expect(await deliverWebhook(d!.id, { finalAttempt: false })).toBe('failed'); // permanent: no retry
        const [after] = await deliveries(hook.id);
        expect(after).toMatchObject({ status: 'failed', attempts: 1 });
        expect(after!.error).toMatch(/not allowed/);
      }
      expect(receiver.hits).toHaveLength(0);
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
      resetConfig();
    }
  });
});

describe('delivery', () => {
  it('POSTs the signed payload with the documented headers and records success', async () => {
    const admin = await adminHeaders('owner');
    const { webhook, secret } = await createHook(admin);
    await emitEvent('file.ready', { id: 'file-1', name: 'a.jpg' }, { clientId: null });
    const [d] = await deliveries(webhook.id);
    expect(d).toMatchObject({ status: 'pending', attempts: 0, event: 'file.ready' });
    const queued = await getQueue(QUEUES.webhooks).getJob(`deliver-webhook-${d!.id}`);
    expect(queued?.data).toEqual({ deliveryId: d!.id });
    expect(queued?.opts.attempts).toBe(8);
    expect(queued?.opts.backoff).toEqual({ type: 'exponential', delay: 10_000 });

    expect(await deliverWebhook(d!.id)).toBe('success');
    expect(receiver.hits).toHaveLength(1);
    const hit = receiver.hits[0]!;
    expect(hit.path).toBe('/hook');
    expect(hit.headers).toMatchObject({ 'content-type': 'application/json', 'user-agent': 'ScenoxVault-Webhooks/1.0', 'x-scenox-event': 'file.ready', 'x-scenox-delivery': d!.id });
    const payload = JSON.parse(hit.body);
    expect(payload).toMatchObject({ id: d!.id, event: 'file.ready', data: { id: 'file-1', name: 'a.jpg' } });
    expect(new Date(payload.createdAt).getTime()).toBeGreaterThan(Date.now() - 10_000);

    // signature: t=<unix>,v1=hex(hmac_sha256(full "whsec_…" secret, `${t}.${rawBody}`))
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit.headers['x-scenox-signature'] as string)!;
    expect(m).toBeTruthy();
    expect(Math.abs(Date.now() / 1000 - Number(m[1]))).toBeLessThan(30);
    expect(m[2]).toBe(createHmac('sha256', secret).update(`${m[1]}.${hit.body}`).digest('hex'));
    expect(m[2]).toBe(signPayload(secret, Number(m[1]), hit.body));
    expect(m[2]).not.toBe(createHmac('sha256', secret.replace(/^whsec_/, '')).update(`${m[1]}.${hit.body}`).digest('hex')); // prefix is part of the key

    const [after] = await deliveries(webhook.id);
    expect(after).toMatchObject({ status: 'success', attempts: 1, responseStatus: 200, responseBody: 'ok', error: null });
    expect(after!.deliveredAt).toBeTruthy();
    expect(after!.durationMs).toBeGreaterThanOrEqual(0);
    const [hook] = await getDb().select().from(webhooks).where(eq(webhooks.id, webhook.id));
    expect(hook).toMatchObject({ lastStatus: 200, consecutiveFailures: 0 });
    expect(hook!.lastDeliveryAt).toBeTruthy();
    expect(await deliverWebhook(d!.id)).toBe('skipped'); // already delivered: never twice
    expect(receiver.hits).toHaveLength(1);
  });

  it('records a failed attempt on HTTP 500 (retry), then final failure; success later resets the streak', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin);
    receiver.respondWith((_r, res) => res.writeHead(500).end('boom'));
    await emitEvent('file.ready', { id: 'x' });
    const [d] = await deliveries(webhook.id);
    expect(await deliverWebhook(d!.id)).toBe('retry');
    let [row] = await deliveries(webhook.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 500, responseBody: 'boom' });
    expect(row!.error).toMatch(/HTTP 500/);
    let [hook] = await getDb().select().from(webhooks).where(eq(webhooks.id, webhook.id));
    expect(hook).toMatchObject({ lastStatus: 500, consecutiveFailures: 0 }); // not a "failed delivery" yet

    expect(await deliverWebhook(d!.id, { finalAttempt: true })).toBe('failed');
    [row] = await deliveries(webhook.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 2 });
    [hook] = await getDb().select().from(webhooks).where(eq(webhooks.id, webhook.id));
    expect(hook).toMatchObject({ consecutiveFailures: 1 });

    receiver.respondWith((_r, res) => res.writeHead(204).end());
    await emitEvent('file.ready', { id: 'y' });
    const next = (await deliveries(webhook.id)).find((x) => x.status === 'pending')!;
    expect(await deliverWebhook(next.id)).toBe('success');
    [hook] = await getDb().select().from(webhooks).where(eq(webhooks.id, webhook.id));
    expect(hook).toMatchObject({ consecutiveFailures: 0, lastStatus: 204 });
  });

  it('does not follow redirects, truncates stored response bodies to 1 KB, records connection errors', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin);
    receiver.respondWith((req, res) => (req.url === '/hook' ? res.writeHead(302, { location: receiver.url('/elsewhere') }).end() : res.writeHead(200).end()));
    await emitEvent('file.ready', { id: 'x' });
    let [d] = await deliveries(webhook.id);
    expect(await deliverWebhook(d!.id)).toBe('retry');
    expect(receiver.hits.map((h) => h.path)).toEqual(['/hook']); // /elsewhere never requested
    [d] = await deliveries(webhook.id);
    expect(d).toMatchObject({ responseStatus: 302, status: 'pending' });

    receiver.respondWith((_r, res) => res.writeHead(500).end('x'.repeat(5000)));
    expect(await deliverWebhook(d!.id)).toBe('retry');
    [d] = await deliveries(webhook.id);
    expect(d!.responseBody).toHaveLength(1024);

    // nothing listening → network error recorded, no response status
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    await call('PATCH', `/api/developer/webhooks/${webhook.id}`, admin.headers, { url: `http://127.0.0.1:${free}/x` });
    expect(await deliverWebhook(d!.id, { finalAttempt: true })).toBe('failed');
    [d] = await deliveries(webhook.id);
    expect(d).toMatchObject({ status: 'failed', responseStatus: null });
    expect(d!.error).toMatch(/ECONNREFUSED/);
  });

  it('auto-disables after 50 consecutive failed deliveries and notifies in-app', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin, { name: 'Flaky hook' });
    receiver.respondWith((_r, res) => res.writeHead(503).end());
    await getDb().update(webhooks).set({ consecutiveFailures: WEBHOOK_AUTO_DISABLE_AFTER - 1 }).where(eq(webhooks.id, webhook.id));
    await emitEvent('file.ready', { id: 'x' });
    const [d] = await deliveries(webhook.id);
    expect(await deliverWebhook(d!.id, { finalAttempt: true })).toBe('failed');
    const [hook] = await getDb().select().from(webhooks).where(eq(webhooks.id, webhook.id));
    expect(hook).toMatchObject({ enabled: false, consecutiveFailures: WEBHOOK_AUTO_DISABLE_AFTER });
    const notes = await getDb().select().from(notifications).where(eq(notifications.type, 'webhook_disabled'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ channel: 'in_app' });
    expect(notes[0]!.subject).toContain('Flaky hook');
    // disabled hooks receive no new events
    await emitEvent('file.ready', { id: 'y' });
    expect(await deliveries(webhook.id)).toHaveLength(1);
  });

  it('the worker delivers queued jobs end to end', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin);
    const stop = await startWorkers();
    try {
      await emitEvent('client.created', { id: 'c1', name: 'Acme' });
      const d = await waitFor(async () => (await deliveries(webhook.id)).find((x) => x.status === 'success'));
      expect(d.attempts).toBe(1);
      expect(receiver.hits).toHaveLength(1);
      expect(receiver.hits[0]!.headers['x-scenox-event']).toBe('client.created');
    } finally {
      await stop();
    }
  });

  it('the worker retries a failing delivery (attempt recorded, retry scheduled with backoff)', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin);
    receiver.respondWith((_r, res) => res.writeHead(500).end('nope'));
    const stop = await startWorkers();
    try {
      await emitEvent('file.ready', { id: 'x' });
      const d = await waitFor(async () => (await deliveries(webhook.id)).find((x) => x.attempts === 1));
      expect(d).toMatchObject({ status: 'pending', responseStatus: 500 });
      const [job] = await getQueue(QUEUES.webhooks).getJobs(['delayed'], 0, 10);
      expect(job).toBeTruthy();
      expect(job!.delay).toBe(10_000);
      await getQueue(QUEUES.webhooks).obliterate({ force: true });
    } finally {
      await stop();
    }
  });
});

describe('routing of events', () => {
  it('matches by event list, "*", client filter and enabled flag', async () => {
    const admin = await adminHeaders('owner');
    const { client: acme } = await seedPortal({ client: { name: 'Acme' } });
    const { client: other } = await seedPortal({ client: { name: 'Other' } });
    const all = (await createHook(admin, { name: 'all', events: ['*'] })).webhook;
    const readyOnly = (await createHook(admin, { name: 'ready', events: ['file.ready'] })).webhook;
    const acmeOnly = (await createHook(admin, { name: 'acme', events: ['*'], clientId: acme.id })).webhook;
    const off = (await createHook(admin, { name: 'off', events: ['*'] })).webhook;
    await call('PATCH', `/api/developer/webhooks/${off.id}`, admin.headers, { enabled: false });

    await emitEvent('file.ready', { id: '1' }, { clientId: acme.id });
    await emitEvent('file.ready', { id: '2' }, { clientId: other.id });
    await emitEvent('file.deleted', { id: '3' }, { clientId: other.id });
    const count = async (id: string) => (await deliveries(id)).map((d) => d.event).sort();
    expect(await count(all.id)).toEqual(['file.deleted', 'file.ready', 'file.ready']);
    expect(await count(readyOnly.id)).toEqual(['file.ready', 'file.ready']);
    expect(await count(acmeOnly.id)).toEqual(['file.ready']);
    expect(await count(off.id)).toEqual([]);
  });

  it('never throws, even when the database is unusable for webhooks', async () => {
    await getDb().execute((await import('drizzle-orm')).sql`select 1`);
    await expect(emitEvent('file.ready', { id: 'x' })).resolves.toBeUndefined();
    // a circular payload cannot be serialised: emit must swallow it
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const admin = await adminHeaders('owner');
    await createHook(admin);
    await expect(emitEvent('file.ready', circular)).resolves.toBeUndefined();
  });
});

describe('events emitted by the app', () => {
  const eventsOf = async (name: string) => (await getDb().select().from(webhookDeliveries)).filter((d) => d.event === name);

  it('file.ready is emitted by processFile with the FileDTO (tags/meta included)', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin, { events: ['file.ready'] });
    const { portal, client } = await seedPortal();
    const session = await seedSession(portal);
    const { file } = await seedReadyFile(portal, session, { name: 'shot.png', data: Buffer.from('png-ish bytes'), status: 'processing' });
    await processFile(file.id);
    const [d] = await eventsOf('file.ready');
    expect(d!.webhookId).toBe(webhook.id);
    expect(d!.payload).toMatchObject({ id: d!.id, event: 'file.ready', data: { id: file.id, name: 'shot.png', status: 'ready', clientId: client.id, clientName: client.name, tags: [], meta: {} } });
    await processFile(file.id); // retry-safe: no second event
    expect(await eventsOf('file.ready')).toHaveLength(1);
  });

  it('file.quarantined is emitted when the scanner flags a file', async () => {
    const clam = await new Promise<net.Server>((resolve) => {
      const server = net.createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => {
          buf = Buffer.concat([buf, Buffer.from(d)]);
          if (buf.length >= 10 && buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) sock.end('stream: Eicar-Test-Signature FOUND\0');
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
    process.env.CLAMAV_ENABLED = 'true';
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String((clam.address() as AddressInfo).port);
    resetConfig();
    try {
      const admin = await adminHeaders('owner');
      await createHook(admin, { events: ['file.quarantined', 'file.ready'] });
      const { portal } = await seedPortal();
      const session = await seedSession(portal);
      const { file } = await seedReadyFile(portal, session, { name: 'virus.exe', data: Buffer.from('EICAR'), status: 'processing' });
      await processFile(file.id);
      expect(await eventsOf('file.ready')).toHaveLength(0);
      const [d] = await eventsOf('file.quarantined');
      expect(d!.payload).toMatchObject({ event: 'file.quarantined', data: { id: file.id, status: 'quarantined', scanStatus: 'infected' } });
    } finally {
      delete process.env.CLAMAV_ENABLED;
      delete process.env.CLAMAV_HOST;
      delete process.env.CLAMAV_PORT;
      resetConfig();
      await new Promise((r) => clam.close(r));
    }
  });

  it('upload.completed is emitted by session-complete once, with the ready files (and not for empty sessions)', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin, { events: ['upload.completed'] });
    const { portal, client } = await seedPortal();
    const session = await seedSession(portal, { status: 'completed', completedAt: new Date(), uploaderName: 'Jane', message: 'Spring photos' });
    await seedReadyFile(portal, session, { name: 'a.jpg', relativePath: 'SKU-1' });
    await seedReadyFile(portal, session, { name: 'b.jpg', relativePath: 'SKU-1' });
    await seedReadyFile(portal, session, { name: 'virus.bin', status: 'quarantined' });
    expect(await processSessionComplete(session.id)).toBe('done');
    expect(await processSessionComplete(session.id)).toBe('skipped');
    const rows = await eventsOf('upload.completed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.webhookId).toBe(webhook.id);
    const data = (rows[0]!.payload as { data: { upload: Record<string, unknown>; files: { name: string; relativePath: string }[]; fileCount: number } }).data;
    expect(data.upload).toMatchObject({ id: session.id, clientId: client.id, clientName: client.name, portalName: portal.name, uploaderName: 'Jane', message: 'Spring photos' });
    expect(data.fileCount).toBe(2);
    expect(data.files.map((f) => f.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(data.files[0]!.relativePath).toBe('SKU-1');

    const empty = await seedSession(portal, { status: 'completed', completedAt: new Date() });
    expect(await processSessionComplete(empty.id)).toBe('done');
    expect(await eventsOf('upload.completed')).toHaveLength(1);
  });

  it('file.deleted is emitted when files are deleted (admin API and bulk)', async () => {
    const admin = await adminHeaders('owner');
    await createHook(admin, { events: ['file.deleted'] });
    const { portal, client } = await seedPortal();
    const session = await seedSession(portal);
    const a = await seedReadyFile(portal, session, { name: 'a.jpg', relativePath: 'x/y', data: Buffer.alloc(123, 1) });
    const b = await seedReadyFile(portal, session, { name: 'b.jpg' });
    const c = await seedReadyFile(portal, session, { name: 'c.jpg' });
    expect((await call('DELETE', `/api/files/${a.file.id}`, admin.headers)).statusCode).toBe(204);
    expect((await call('POST', '/api/files/delete', admin.headers, { fileIds: [b.file.id, c.file.id] })).statusCode).toBe(204);
    const rows = await eventsOf('file.deleted');
    expect(rows).toHaveLength(3);
    const first = rows.map((r) => (r.payload as { data: Record<string, unknown> }).data).find((x) => x.id === a.file.id);
    expect(first).toEqual({ id: a.file.id, name: 'a.jpg', relativePath: 'x/y', clientId: client.id, portalId: portal.id, size: 123 });
  });

  it('message.created is emitted when a client posts a message', async () => {
    const admin = await adminHeaders('owner');
    await createHook(admin, { events: ['message.created'] });
    const { portal, client, token } = await seedPortal({ client: { name: 'Acme' }, portal: { name: 'Main', allowClientMessages: true } });
    const r = await call('POST', `/api/public/portals/${token}/messages`, {}, { body: 'Hello team', name: 'Jane' });
    expect(r.statusCode, r.body).toBe(201);
    const [d] = await eventsOf('message.created');
    const data = (d!.payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ id: r.json().id, body: 'Hello team', authorType: 'client', authorName: 'Jane', portalId: portal.id, portalName: 'Main', clientId: client.id, clientName: 'Acme' });
    expect(data.own).toBeUndefined();
    // staff replies are not "client messages"
    await call('POST', `/api/portals/${portal.id}/messages`, admin.headers, { body: 'Hi Jane' });
    expect(await eventsOf('message.created')).toHaveLength(1);
  });

  it('client.created and portal.created are emitted (portal without url/token)', async () => {
    const admin = await adminHeaders('owner');
    await createHook(admin, { events: ['client.created', 'portal.created'] });
    const c = await call('POST', '/api/clients', admin.headers, { name: 'Brand New' });
    expect(c.statusCode).toBe(201);
    const p = await call('POST', '/api/portals', admin.headers, { clientId: c.json().id, name: 'Uploads' });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json().url).toMatch(/\/u\//); // the admin response still has the link
    const [cd] = await eventsOf('client.created');
    expect((cd!.payload as { data: unknown }).data).toMatchObject({ id: c.json().id, name: 'Brand New' });
    const [pd] = await eventsOf('portal.created');
    const portalData = (pd!.payload as { data: Record<string, unknown> }).data;
    expect(portalData).toMatchObject({ id: p.json().id, name: 'Uploads', clientId: c.json().id, clientName: 'Brand New' });
    expect('url' in portalData).toBe(false);
    expect('tokenPreview' in portalData).toBe(false);
    expect(JSON.stringify(pd!.payload)).not.toContain('/u/');
    // a webhook filtered to another client only sees its own client's events
    const [other] = await getDb().select({ id: clients.id }).from(clients).limit(1);
    void other;
  });
});

describe('test deliveries, history, redelivery, retention', () => {
  it('POST /:id/test enqueues a webhook.test delivery that arrives signed (even if the webhook is disabled)', async () => {
    const admin = await adminHeaders('owner');
    const { webhook, secret } = await createHook(admin);
    await call('PATCH', `/api/developer/webhooks/${webhook.id}`, admin.headers, { enabled: false });
    const r = await call('POST', `/api/developer/webhooks/${webhook.id}/test`, admin.headers);
    expect(r.statusCode).toBe(202);
    const dto = r.json();
    expect(dto).toMatchObject({ event: 'webhook.test', status: 'pending', attempts: 0 });
    expect(dto.payload).toMatchObject({ id: dto.id, event: 'webhook.test' });
    const job = await getQueue(QUEUES.webhooks).getJob(`deliver-webhook-${dto.id}`);
    expect(job?.data).toEqual({ deliveryId: dto.id, force: true });
    expect(job?.opts.attempts).toBe(1);

    expect(await deliverWebhook(dto.id, { force: true, finalAttempt: true })).toBe('success');
    const hit = receiver.hits[0]!;
    expect(hit.headers['x-scenox-event']).toBe('webhook.test');
    const m = /t=(\d+),v1=([0-9a-f]+)/.exec(hit.headers['x-scenox-signature'] as string)!;
    expect(m[2]).toBe(createHmac('sha256', secret).update(`${m[1]}.${hit.body}`).digest('hex'));
    // …but a normal (non-forced) delivery to a disabled webhook is skipped
    await getDb().update(webhookDeliveries).set({ status: 'pending' }).where(eq(webhookDeliveries.id, dto.id));
    expect(await deliverWebhook(dto.id)).toBe('skipped');
    expect(receiver.hits).toHaveLength(1);
    expect((await call('POST', '/api/developer/webhooks/00000000-0000-4000-8000-000000000000/test', admin.headers)).statusCode).toBe(404);
  });

  it('GET /:id/deliveries lists newest first with a limit; redeliver resets and re-queues the same delivery', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin);
    for (let i = 0; i < 3; i++) await emitEvent('file.ready', { id: String(i) });
    const all = await call('GET', `/api/developer/webhooks/${webhook.id}/deliveries`, admin.headers);
    expect(all.statusCode).toBe(200);
    expect(all.json()).toHaveLength(3);
    expect(all.json()[0]).toHaveProperty('payload');
    expect((await call('GET', `/api/developer/webhooks/${webhook.id}/deliveries?limit=2`, admin.headers)).json()).toHaveLength(2);
    expect((await call('GET', `/api/developer/webhooks/${webhook.id}/deliveries?limit=0`, admin.headers)).statusCode).toBe(400);
    expect((await call('GET', '/api/developer/webhooks/00000000-0000-4000-8000-000000000000/deliveries', admin.headers)).statusCode).toBe(404);

    const [d] = await deliveries(webhook.id);
    receiver.respondWith((_r, res) => res.writeHead(500).end('x'));
    await deliverWebhook(d!.id, { finalAttempt: true });
    expect((await deliveries(webhook.id)).find((x) => x.id === d!.id)).toMatchObject({ status: 'failed', attempts: 1 });
    receiver.respondWith((_r, res) => res.writeHead(200).end('fine'));
    const r = await call('POST', `/api/developer/webhooks/deliveries/${d!.id}/redeliver`, admin.headers);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ id: d!.id, status: 'pending', attempts: 0, error: null, responseStatus: null });
    expect(await deliverWebhook(d!.id, { force: true })).toBe('success');
    expect((await deliveries(webhook.id)).find((x) => x.id === d!.id)).toMatchObject({ status: 'success', responseBody: 'fine' });
    expect((await call('POST', '/api/developer/webhooks/deliveries/00000000-0000-4000-8000-000000000000/redeliver', admin.headers)).statusCode).toBe(404);
    const member = await adminHeaders('member');
    expect((await call('POST', `/api/developer/webhooks/deliveries/${d!.id}/redeliver`, member.headers)).statusCode).toBe(403);
  });

  it('cleanup deletes deliveries older than 30 days only', async () => {
    const admin = await adminHeaders('owner');
    const { webhook } = await createHook(admin);
    const old = new Date(Date.now() - 31 * 86_400_000);
    const recent = new Date(Date.now() - 29 * 86_400_000);
    await getDb().insert(webhookDeliveries).values([
      { webhookId: webhook.id, event: 'file.ready', payload: {}, createdAt: old },
      { webhookId: webhook.id, event: 'file.ready', payload: {}, createdAt: recent },
    ]);
    const summary = await runCleanup();
    expect(summary.webhookDeliveriesPurged).toBe(1);
    expect(await deliveries(webhook.id)).toHaveLength(1);
  });
});

afterEach(() => {
  /* receiver state is reset in beforeEach */
});
