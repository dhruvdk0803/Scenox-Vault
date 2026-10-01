import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../db';
import { users, type User } from '../db/schema';
import { logActivity } from '../lib/activity';
import { AppError, conflict, tooManyRequests, validationError } from '../lib/errors';
import { dummyVerify, hashPassword, passwordProblems, verifyPassword } from '../lib/password';
import { parse } from '../lib/validate';
import { createSession, destroySession, revokeUserSessions, toMeDTO } from '../services/auth';
import { emailSchema, isUniqueViolation } from '../services/validation';

const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 15 * 60_000;
const SETUP_LOCK_KEY = 727_001; // arbitrary constant for pg_advisory_xact_lock

const loginSchema = z.object({ email: z.string().trim().max(254), password: z.string().min(1).max(256) });
const setupSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  email: emailSchema,
  password: z.string().max(256, 'Password is too long.').superRefine((v, ctx) => {
    const p = passwordProblems(v);
    if (p) ctx.addIssue({ code: 'custom', message: p });
  }),
});
const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1, 'Enter your current password.').max(256),
  newPassword: z.string().max(256, 'Password is too long.').superRefine((v, ctx) => {
    const p = passwordProblems(v);
    if (p) ctx.addIssue({ code: 'custom', message: p });
  }),
});

const INVALID_LOGIN = 'Invalid email or password.';

function rateLimit(max: number) {
  return config().rateLimitEnabled ? { config: { rateLimit: { max, timeWindow: '1 minute' } } } : {};
}

function userActor(u: Pick<User, 'id' | 'name' | 'email'>) {
  return { actorType: 'user' as const, actorId: u.id, actorLabel: `${u.name} <${u.email}>` };
}

function reqInfo(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, requestId: req.id };
}

export default async function authRoutes(app: FastifyInstance) {
  app.get('/setup-status', async () => {
    const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(users);
    return { needsSetup: r.n === 0 };
  });

  app.post('/setup', rateLimit(5), async (req, reply) => {
    const body = parse(setupSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    const created = await getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
      if (r.n > 0) throw conflict('Setup has already been completed.', 'already_setup');
      try {
        const [u] = await tx
          .insert(users)
          .values({ email: body.email, name: body.name, role: 'owner', passwordHash, passwordChangedAt: new Date(), lastLoginAt: new Date() })
          .returning();
        return u;
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('Setup has already been completed.', 'already_setup');
        throw err;
      }
    });
    const expiresAt = await createSession(req, reply, created.id);
    await logActivity({ ...userActor(created), ...reqInfo(req), action: 'auth.setup', resourceType: 'user', resourceId: created.id, metadata: { name: created.name } });
    return toMeDTO(created, expiresAt);
  });

  app.post('/login', rateLimit(10), async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(401, 'invalid_credentials', INVALID_LOGIN);
    const email = parsed.data.email.toLowerCase();
    const { password } = parsed.data;
    const db = getDb();

    const fail = async (user: User | null) => {
      await logActivity({
        ...(user ? userActor(user) : { actorType: 'system' as const, actorLabel: email.slice(0, 254) }),
        ...reqInfo(req),
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: user?.id ?? null,
        result: 'failure',
        metadata: { email: email.slice(0, 254) },
      });
    };

    const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (!user) {
      await dummyVerify(password);
      await fail(null);
      throw new AppError(401, 'invalid_credentials', INVALID_LOGIN);
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await dummyVerify(password);
      await fail(user);
      throw tooManyRequests('Too many failed attempts. Try again in 15 minutes.');
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok || user.status !== 'active') {
      if (!ok) {
        const [u] = await db
          .update(users)
          .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
          .where(eq(users.id, user.id))
          .returning({ n: users.failedLoginCount });
        if (u && u.n >= MAX_FAILED_LOGINS) {
          await db.update(users).set({ lockedUntil: new Date(Date.now() + LOCK_MS), failedLoginCount: 0 }).where(eq(users.id, user.id));
          await fail(user);
          throw tooManyRequests('Too many failed attempts. Try again in 15 minutes.');
        }
      }
      await fail(user);
      throw new AppError(401, 'invalid_credentials', INVALID_LOGIN);
    }

    // Start a fresh session (never reuse a pre-existing cookie).
    await destroySession(req, reply);
    const [fresh] = await db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    const expiresAt = await createSession(req, reply, user.id);
    await logActivity({ ...userActor(fresh), ...reqInfo(req), action: 'auth.login', resourceType: 'user', resourceId: fresh.id });
    return toMeDTO(fresh, expiresAt);
  });

  app.post('/logout', { preHandler: app.authenticate }, async (req, reply) => {
    await logActivity({ ...userActor(req.user!), ...reqInfo(req), action: 'auth.logout', resourceType: 'user', resourceId: req.user!.id });
    await destroySession(req, reply);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: app.authenticate }, async (req) => toMeDTO(req.user!, req.authSession!.expiresAt));

  app.post('/password', { preHandler: app.authenticate }, async (req, reply) => {
    const body = parse(changePasswordSchema, req.body);
    const [user] = await getDb().select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw validationError({ fields: { currentPassword: 'Current password is incorrect.' } }, 'Current password is incorrect.');
    }
    if (body.newPassword === body.currentPassword) {
      throw validationError({ fields: { newPassword: 'Choose a password you have not used before.' } }, 'Choose a different password.');
    }
    await getDb()
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await revokeUserSessions(user.id, req.authSession!.tokenHash);
    await logActivity({ ...userActor(user), ...reqInfo(req), action: 'auth.password_changed', resourceType: 'user', resourceId: user.id });
    return reply.status(204).send();
  });
}
