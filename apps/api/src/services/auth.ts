import { ADMIN_SESSION_COOKIE, ROLE_PERMISSIONS, type MeDTO } from '@scenox/shared';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { getDb } from '../db';
import { sessions, users, type User } from '../db/schema';
import { hashToken, randomToken } from '../lib/crypto';
import { getSettings } from './settings';

export type AuthUser = Pick<User, 'id' | 'email' | 'name' | 'role' | 'status' | 'lastLoginAt' | 'createdAt'>;

export function toUserDTO(u: AuthUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

export function toMeDTO(u: AuthUser, sessionExpiresAt: Date): MeDTO {
  return { user: toUserDTO(u), permissions: ROLE_PERMISSIONS[u.role], sessionExpiresAt: sessionExpiresAt.toISOString() };
}

/** Create a server-side session and set the HttpOnly cookie. Returns expiry. */
export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<Date> {
  const { security } = await getSettings();
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + security.adminSessionHours * 3600_000);
  await getDb()
    .insert(sessions)
    .values({ userId, tokenHash: hashToken(token), ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 512) ?? null, expiresAt });
  reply.setCookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config().cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return expiresAt;
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[ADMIN_SESSION_COOKIE];
  if (token) await getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  reply.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
}

/** Revoke every session for a user (password change, disable, delete). Optionally keep the current one. */
export async function revokeUserSessions(userId: string, exceptTokenHash?: string) {
  const db = getDb();
  const rows = await db.select({ id: sessions.id, tokenHash: sessions.tokenHash }).from(sessions).where(eq(sessions.userId, userId));
  for (const r of rows) if (r.tokenHash !== exceptTokenHash) await db.delete(sessions).where(eq(sessions.id, r.id));
}

const TOUCH_INTERVAL_MS = 5 * 60_000;

/** Resolve the admin user for a request from its session cookie. */
export async function resolveSession(req: FastifyRequest): Promise<{ user: AuthUser; sessionId: string; tokenHash: string; expiresAt: Date } | null> {
  const token = req.cookies[ADMIN_SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const tokenHash = hashToken(token);
  const db = getDb();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.user.status !== 'active') return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }
  return { user: row.user, sessionId: row.sessionId, tokenHash, expiresAt: row.expiresAt };
}

export async function purgeExpiredSessions() {
  await getDb().delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
