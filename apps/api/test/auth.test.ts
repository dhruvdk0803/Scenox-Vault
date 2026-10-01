import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { activityLogs, sessions, users } from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { loginAs, ORIGIN, setupTestApp } from './helpers';

let app: FastifyInstance;
beforeEach(async () => {
  await app?.close();
  app = await setupTestApp();
});
afterAll(async () => {
  await app?.close();
});

const PASSWORD = 'correct-horse-battery-staple';

async function createUser(email: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await getDb()
    .insert(users)
    .values({ email, name: 'Test', role: 'member', passwordHash: await hashPassword(PASSWORD), ...extra })
    .returning();
  return u;
}
const login = (email: string, password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/api/auth/login', headers: ORIGIN, payload: { email, password } });

describe('setup', () => {
  it('reports needsSetup and creates the first owner exactly once', async () => {
    expect((await app.inject({ url: '/api/auth/setup-status' })).json()).toEqual({ needsSetup: true });
    const body = { name: 'Owner', email: 'Owner@Example.com', password: PASSWORD };
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: ORIGIN, payload: body });
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.user.role).toBe('owner');
    expect(me.user.email).toBe('owner@example.com');
    expect(me.permissions).toContain('team.manage');
    expect(res.headers['set-cookie']).toContain('sv_session=');
    expect(JSON.stringify(me)).not.toMatch(/hash/i);
    expect((await app.inject({ url: '/api/auth/setup-status' })).json()).toEqual({ needsSetup: false });
    const again = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: ORIGIN, payload: { ...body, email: 'x@example.com' } });
    expect(again.statusCode).toBe(409);
  });

  it('is race-safe: concurrent setups create one owner', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        app.inject({ method: 'POST', url: '/api/auth/setup', headers: ORIGIN, payload: { name: 'O', email: `o${i}@example.com`, password: PASSWORD } }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await getDb().select().from(users)).toHaveLength(1);
  });

  it('enforces the password policy', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: ORIGIN, payload: { name: 'O', email: 'o@example.com', password: 'short' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});

describe('login', () => {
  it('succeeds, sets lastLoginAt and an audit entry', async () => {
    const u = await createUser('a@example.com');
    const res = await login('A@Example.com');
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(u.id);
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(row.lastLoginAt).not.toBeNull();
    const logs = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'auth.login'));
    expect(logs).toHaveLength(1);
  });

  it('returns the same generic error for unknown email and wrong password', async () => {
    await createUser('a@example.com');
    const bad = await login('a@example.com', 'wrong-password-123');
    const unknown = await login('nobody@example.com');
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json().error.message).toBe('Invalid email or password.');
    expect(unknown.json().error.message).toBe('Invalid email or password.');
    const failures = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'auth.login_failed'));
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.result === 'failure')).toBe(true);
  });

  it('locks the account after 10 failures and recovers after the lock expires', async () => {
    const u = await createUser('lock@example.com');
    for (let i = 0; i < 9; i++) expect((await login('lock@example.com', 'wrong-password-123')).statusCode).toBe(401);
    const tenth = await login('lock@example.com', 'wrong-password-123');
    expect(tenth.statusCode).toBe(429);
    expect(tenth.json().error.message).toBe('Too many failed attempts. Try again in 15 minutes.');
    // correct password is refused while locked
    expect((await login('lock@example.com')).statusCode).toBe(429);
    await getDb().update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, u.id));
    expect((await login('lock@example.com')).statusCode).toBe(200);
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(row.failedLoginCount).toBe(0);
  });

  it('refuses disabled users with the generic message', async () => {
    await createUser('off@example.com', { status: 'disabled' });
    const res = await login('off@example.com');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid email or password.');
  });
});

describe('session', () => {
  it('GET /me requires a session; logout invalidates it', async () => {
    expect((await app.inject({ url: '/api/auth/me' })).statusCode).toBe(401);
    const { headers, user } = await loginAs(app, 'admin');
    const me = await app.inject({ url: '/api/auth/me', headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user.id);
    expect(new Date(me.json().sessionExpiresAt).getTime()).toBeGreaterThan(Date.now());
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/auth/me', headers })).statusCode).toBe(401);
  });

  it('rejects state-changing requests from a foreign origin (CSRF)', async () => {
    const { cookie } = await loginAs(app, 'owner');
    const res = await app.inject({ method: 'POST', url: '/api/clients', headers: { cookie, origin: 'https://evil.example' }, payload: { name: 'X' } });
    expect(res.statusCode).toBe(403);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: 'https://evil.example' } });
    expect(logout.statusCode).toBe(403);
  });
});

describe('change password', () => {
  it('verifies the current password, applies policy and revokes other sessions', async () => {
    const { headers, user } = await loginAs(app, 'member');
    // second session for the same user
    const other = await login((await getDb().select().from(users).where(eq(users.id, user.id)))[0].email);
    const otherCookie = (other.headers['set-cookie'] as string).split(';')[0];
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: otherCookie } })).statusCode).toBe(200);

    const wrong = await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: 'nope-nope-nope', newPassword: 'a-brand-new-password' } });
    expect(wrong.statusCode).toBe(400);
    const weak = await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: PASSWORD, newPassword: 'short' } });
    expect(weak.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' } });
    expect(ok.statusCode).toBe(204);

    expect((await app.inject({ url: '/api/auth/me', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: otherCookie } })).statusCode).toBe(401);
    const email = (await getDb().select().from(users).where(eq(users.id, user.id)))[0].email;
    expect((await login(email, PASSWORD)).statusCode).toBe(401);
    expect((await login(email, 'a-brand-new-password')).statusCode).toBe(200);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(2);
  });
});
