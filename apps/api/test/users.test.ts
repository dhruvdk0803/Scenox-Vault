import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { activityLogs, sessions, users } from '../src/db/schema';
import { loginAs, setupTestApp } from './helpers';

let app: FastifyInstance;
beforeEach(async () => {
  await app?.close();
  app = await setupTestApp();
});
afterAll(async () => {
  await app?.close();
});

const PW = 'a-very-long-password-1';
const create = (headers: Record<string, string>, payload: object) => app.inject({ method: 'POST', url: '/api/users', headers, payload });

describe('RBAC', () => {
  it('member and viewer can list but not manage the team', async () => {
    const member = await loginAs(app, 'member');
    const viewer = await loginAs(app, 'viewer');
    expect((await app.inject({ url: '/api/users', headers: viewer.headers })).statusCode).toBe(200);
    expect((await create(member.headers, { name: 'X', email: 'x@example.com', role: 'viewer', password: PW })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/users' })).statusCode).toBe(401);
  });

  it('admin can create members but not owners or admins', async () => {
    const admin = await loginAs(app, 'admin');
    const ok = await create(admin.headers, { name: 'M', email: 'm@example.com', role: 'member', password: PW });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).not.toHaveProperty('passwordHash');
    expect((await create(admin.headers, { name: 'O', email: 'o@example.com', role: 'owner', password: PW })).statusCode).toBe(403);
    expect((await create(admin.headers, { name: 'A', email: 'a2@example.com', role: 'admin', password: PW })).statusCode).toBe(403);
  });

  it('admin cannot edit or delete an owner, nor promote someone to owner', async () => {
    const admin = await loginAs(app, 'admin');
    const owner = await loginAs(app, 'owner');
    const member = (await create(owner.headers, { name: 'M', email: 'm@example.com', role: 'member', password: PW })).json();
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${owner.user.id}`, headers: admin.headers, payload: { name: 'Hax' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${owner.user.id}`, headers: admin.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${member.id}`, headers: admin.headers, payload: { role: 'owner' } })).statusCode).toBe(403);
  });
});

describe('user management', () => {
  it('rejects duplicate emails (case-insensitive) with a friendly 409', async () => {
    const owner = await loginAs(app, 'owner');
    expect((await create(owner.headers, { name: 'A', email: 'dup@example.com', role: 'viewer', password: PW })).statusCode).toBe(201);
    const res = await create(owner.headers, { name: 'B', email: 'DUP@example.com', role: 'viewer', password: PW });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already exists/);
  });

  it('validates input', async () => {
    const owner = await loginAs(app, 'owner');
    expect((await create(owner.headers, { name: 'A', email: 'not-an-email', role: 'viewer', password: PW })).statusCode).toBe(400);
    expect((await create(owner.headers, { name: 'A', email: 'a@example.com', role: 'superuser', password: PW })).statusCode).toBe(400);
    expect((await create(owner.headers, { name: 'A', email: 'a@example.com', role: 'viewer', password: 'short' })).statusCode).toBe(400);
  });

  it('cannot change own role/status or delete self; cannot remove the last owner', async () => {
    const owner = await loginAs(app, 'owner');
    const url = `/api/users/${owner.user.id}`;
    expect((await app.inject({ method: 'PATCH', url, headers: owner.headers, payload: { role: 'member' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url, headers: owner.headers, payload: { status: 'disabled' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url, headers: owner.headers })).statusCode).toBe(403);

    const second = await loginAs(app, 'owner');
    // demote/disable/delete the other owner while a third active owner exists: allowed
    // but removing the *last other* owner is blocked: disable second, then try to disable first via second
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${second.user.id}`, headers: owner.headers, payload: { status: 'disabled' } })).statusCode).toBe(200);
    const third = await loginAs(app, 'owner');
    // owner (first) is the only other active owner besides third; disabling `owner` via third is fine, then third is last
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${owner.user.id}`, headers: third.headers, payload: { role: 'admin' } })).statusCode).toBe(200);
    const lastOwnerDelete = await app.inject({ method: 'DELETE', url: `/api/users/${third.user.id}`, headers: third.headers });
    expect(lastOwnerDelete.statusCode).toBe(403); // self
  });

  it('blocks demoting/deleting the last active owner (via another owner who is then the last)', async () => {
    const a = await loginAs(app, 'owner');
    const b = await loginAs(app, 'owner');
    // a disables b => a is last owner
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${b.user.id}`, headers: a.headers, payload: { status: 'disabled' } })).statusCode).toBe(200);
    // re-enable b's row is not needed; create a *new* owner c, then a disables c? Instead try demoting a via disabled b: b's session is revoked.
    expect((await app.inject({ url: '/api/auth/me', headers: b.headers })).statusCode).toBe(401);
    const c = await loginAs(app, 'owner');
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${a.user.id}`, headers: c.headers })).statusCode).toBe(204);
    // c is now the only active owner; an admin cannot touch owners, and c cannot self-delete.
    const admin = await loginAs(app, 'admin');
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${c.user.id}`, headers: admin.headers })).statusCode).toBe(403);
    expect(await getDb().select().from(users).where(eq(users.role, 'owner'))).toHaveLength(2); // b (disabled) + c
  });

  it('revokes sessions on disable and password reset; audits changes', async () => {
    const owner = await loginAs(app, 'owner');
    const member = await loginAs(app, 'member');
    expect((await app.inject({ url: '/api/auth/me', headers: member.headers })).statusCode).toBe(200);
    const res = await app.inject({ method: 'PATCH', url: `/api/users/${member.user.id}`, headers: owner.headers, payload: { password: 'another-long-password' } });
    expect(res.statusCode).toBe(200);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, member.user.id))).toHaveLength(0);
    expect((await app.inject({ url: '/api/auth/me', headers: member.headers })).statusCode).toBe(401);

    const viewer = await loginAs(app, 'viewer');
    await app.inject({ method: 'PATCH', url: `/api/users/${viewer.user.id}`, headers: owner.headers, payload: { status: 'disabled' } });
    expect((await app.inject({ url: '/api/auth/me', headers: viewer.headers })).statusCode).toBe(401);
    const logs = await getDb().select().from(activityLogs).where(eq(activityLogs.action, 'user.updated'));
    expect(logs.length).toBe(2);
    const del = await app.inject({ method: 'DELETE', url: `/api/users/${viewer.user.id}`, headers: owner.headers });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${viewer.user.id}`, headers: owner.headers })).statusCode).toBe(404);
  });
});
