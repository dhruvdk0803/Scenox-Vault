import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { activityLogs } from '../src/db/schema';
import { serveBrandingAsset } from '../src/services/branding';
import { getSettings } from '../src/services/settings';
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// minimal ICO header + one 1x1 image entry (BMP payload not needed for magic-byte detection)
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 40, 0, 0, 0, 22, 0, 0, 0]), Buffer.alloc(40)]);

function multipart(filename: string, contentType: string, data: Buffer) {
  const boundary = '----scenoxtest' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const patch = (payload: unknown, headers = owner.headers) => app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: payload as object });

describe('settings', () => {
  it('GET returns the DTO without internal keys; permissions enforced', async () => {
    const res = await app.inject({ url: '/api/settings', headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.branding).toMatchObject({ companyName: 'Scenox Vault', logoUrl: null });
    expect(s.smtpConfigured).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/logoKey|faviconKey/);
    const viewer = await loginAs(app, 'viewer');
    expect((await app.inject({ url: '/api/settings', headers: viewer.headers })).statusCode).toBe(403);
    const member = await loginAs(app, 'member');
    expect((await app.inject({ url: '/api/settings', headers: member.headers })).statusCode).toBe(200);
    expect((await patch({ branding: { companyName: 'X' } }, member.headers)).statusCode).toBe(403);
  });

  it('PATCH updates sections, normalises values and audits', async () => {
    const res = await patch({
      branding: { companyName: ' Acme ', primaryColor: '#abcdef', supportEmail: 'Help@Acme.com' },
      notifications: { adminEmails: ['A@x.com', 'a@x.com'], diskWarningPercent: 70, diskCriticalPercent: 90 },
      security: { blockedExtensions: ['.EXE', 'bat', 'exe'], adminSessionHours: 24 },
      retention: { activityLogDays: 0 },
      uploads: { defaultMaxFileSizeBytes: 5_000_000 },
    });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.branding).toMatchObject({ companyName: 'Acme', primaryColor: '#ABCDEF', supportEmail: 'help@acme.com' });
    expect(s.notifications).toMatchObject({ adminEmails: ['a@x.com'], diskWarningPercent: 70, diskCriticalPercent: 90 });
    expect(s.security).toMatchObject({ blockedExtensions: ['exe', 'bat'], adminSessionHours: 24, portalSessionHours: 72 });
    expect(s.retention.activityLogDays).toBe(0);
    expect(s.uploads).toEqual({ defaultMaxFileSizeBytes: 5_000_000, defaultPortalQuotaBytes: null });
    expect((await app.inject({ url: '/api/settings', headers: owner.headers })).json().branding.companyName).toBe('Acme');
    expect((await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'settings.updated'))).length).toBe(1);
    expect((await patch({ branding: { supportEmail: null } })).json().branding.supportEmail).toBeNull();
  });

  it.each([
    ['bad color', { branding: { primaryColor: 'red' } }],
    ['short color', { branding: { primaryColor: '#fff' } }],
    ['empty company', { branding: { companyName: '' } }],
    ['bad support email', { branding: { supportEmail: 'nope' } }],
    ['bad admin email', { notifications: { adminEmails: ['nope'] } }],
    ['warning too low', { notifications: { diskWarningPercent: 49 } }],
    ['critical too high', { notifications: { diskCriticalPercent: 100 } }],
    ['warning >= critical', { notifications: { diskWarningPercent: 90, diskCriticalPercent: 80 } }],
    ['hours too small', { security: { adminSessionHours: 0 } }],
    ['hours too large', { security: { portalSessionHours: 721 } }],
    ['bad extension', { security: { blockedExtensions: ['a/b'] } }],
    ['negative retention', { retention: { exportHours: -1 } }],
    ['unknown key', { security: { evil: true } }],
    ['unknown section', { logoKey: 'x' }],
    ['non-positive quota', { uploads: { defaultPortalQuotaBytes: 0 } }],
  ])('rejects %s', async (_n, body) => {
    const res = await patch(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('warning is validated against the stored critical level', async () => {
    expect((await patch({ notifications: { diskWarningPercent: 96 } })).statusCode).toBe(400);
  });
});

describe('branding images', () => {
  it('stores logo/favicon (png/jpeg/webp, ico for favicon), serves them, and deletes', async () => {
    const logo = multipart('l.png', 'image/png', PNG);
    const res = await app.inject({ method: 'POST', url: '/api/settings/logo', headers: { ...owner.headers, ...logo.headers }, payload: logo.payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().branding.logoUrl).toMatch(/^\/api\/public\/branding\/logo\?v=logo-[0-9a-f]+\.png$/);
    const key = (await getSettings()).branding.logoKey!;
    expect(key).toMatch(/^branding\/logo-[0-9a-f]+\.png$/);
    expect(await getStorage().exists(key)).toBe(true);

    // served via serveBrandingAsset with safe headers
    const mini = Fastify();
    mini.get('/logo', (_r, reply) => serveBrandingAsset('logo', reply));
    mini.get('/favicon', (_r, reply) => serveBrandingAsset('favicon', reply));
    const served = await mini.inject({ url: '/logo' });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(served.rawPayload, PNG)).toBe(0);
    expect((await mini.inject({ url: '/favicon' })).statusCode).toBe(404);

    // ICO: favicon only
    const ico = multipart('f.ico', 'image/x-icon', ICO);
    expect((await app.inject({ method: 'POST', url: '/api/settings/logo', headers: { ...owner.headers, ...ico.headers }, payload: ico.payload })).statusCode).toBe(400);
    const fav = await app.inject({ method: 'POST', url: '/api/settings/favicon', headers: { ...owner.headers, ...ico.headers }, payload: ico.payload });
    expect(fav.statusCode).toBe(200);
    expect(fav.json().branding.faviconUrl).toMatch(/favicon\?v=favicon-[0-9a-f]+\.ico$/);
    expect((await mini.inject({ url: '/favicon' })).headers['content-type']).toBe('image/x-icon');
    await mini.close();

    // SVG refused even when declared as png
    const svg = multipart('x.png', 'image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect((await app.inject({ method: 'POST', url: '/api/settings/logo', headers: { ...owner.headers, ...svg.headers }, payload: svg.payload })).statusCode).toBe(400);

    const del = await app.inject({ method: 'DELETE', url: '/api/settings/logo', headers: owner.headers });
    expect(del.json().branding.logoUrl).toBeNull();
    expect(await getStorage().exists(key)).toBe(false);
  });
});

describe('test email', () => {
  it('returns a friendly failure when SMTP is not configured', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/test-email', headers: owner.headers, payload: { to: 'me@example.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.json().message).toMatch(/not configured/i);
    expect((await app.inject({ method: 'POST', url: '/api/settings/test-email', headers: owner.headers, payload: { to: 'nope' } })).statusCode).toBe(400);
  });
});
