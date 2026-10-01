import { canManageRole, ROLES, type Role, type UserDTO } from '@scenox/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db';
import { users, type User } from '../db/schema';
import { audit } from '../lib/activity';
import { conflict, forbidden, notFound, validationError } from '../lib/errors';
import { hashPassword, passwordProblems } from '../lib/password';
import { parse } from '../lib/validate';
import { revokeUserSessions, toUserDTO } from './auth';
import { emailSchema, isUniqueViolation } from './validation';

const roleSchema = z.enum(ROLES);

const passwordSchema = z.string().max(256, 'Password is too long.').superRefine((v, ctx) => {
  const problem = passwordProblems(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

export const createUserSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  email: emailSchema,
  role: roleSchema,
  password: passwordSchema,
});

export const updateUserSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name is required.').max(120).optional(),
  role: roleSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  password: passwordSchema.optional(),
});

const EMAIL_TAKEN = 'A team member with that email already exists.';

export async function listUsers(): Promise<UserDTO[]> {
  const rows = await getDb().select().from(users).orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(toUserDTO);
}

function assertCanManage(actorRole: Role, targetRole: Role) {
  if (!canManageRole(actorRole, targetRole)) throw forbidden("You don't have permission to manage a user with that role.");
}

export async function createUser(req: FastifyRequest, body: unknown): Promise<UserDTO> {
  const actor = req.user!;
  const data = parse(createUserSchema, body);
  assertCanManage(actor.role, data.role);
  const passwordHash = await hashPassword(data.password);
  let row: User;
  try {
    [row] = await getDb()
      .insert(users)
      .values({ email: data.email, name: data.name, role: data.role, passwordHash, passwordChangedAt: new Date() })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(EMAIL_TAKEN, 'email_taken');
    throw err;
  }
  await audit(req, { action: 'user.created', resourceType: 'user', resourceId: row.id, metadata: { name: row.name, email: row.email, role: row.role } });
  return toUserDTO(row);
}

/** Active owners other than `excludeId`; locks the rows so concurrent demotions cannot both succeed. */
async function otherActiveOwners(tx: Pick<ReturnType<typeof getDb>, 'select'>, excludeId: string) {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'owner'), eq(users.status, 'active')))
    .for('update');
  return rows.filter((r) => r.id !== excludeId).length;
}

export async function updateUser(req: FastifyRequest, id: string, body: unknown): Promise<UserDTO> {
  const actor = req.user!;
  const data = parse(updateUserSchema, body);
  const isSelf = actor.id === id;
  if (isSelf && ((data.role !== undefined) || (data.status !== undefined))) {
    throw forbidden("You can't change your own role or status.");
  }
  if (isSelf && data.password !== undefined) {
    throw validationError({ fields: { password: 'Use "Change password" in your profile to update your own password.' } });
  }

  const result = await getDb().transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1);
    if (!target) throw notFound('Team member not found.');
    assertCanManage(actor.role, target.role);
    if (data.role) assertCanManage(actor.role, data.role);

    const losesOwner =
      target.role === 'owner' && target.status === 'active' && ((data.role && data.role !== 'owner') || data.status === 'disabled');
    if (losesOwner && (await otherActiveOwners(tx, id)) === 0) {
      throw conflict('There must always be at least one active owner.', 'last_owner');
    }

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.role !== undefined) patch.role = data.role;
    if (data.status !== undefined) patch.status = data.status;
    if (data.password !== undefined) {
      patch.passwordHash = await hashPassword(data.password);
      patch.passwordChangedAt = new Date();
      patch.failedLoginCount = 0;
      patch.lockedUntil = null;
    }
    const [updated] = await tx.update(users).set(patch).where(eq(users.id, id)).returning();
    return { target, updated };
  });

  const { target, updated } = result;
  const revoke = data.status === 'disabled' || data.password !== undefined;
  if (revoke) await revokeUserSessions(id);

  await audit(req, {
    action: 'user.updated',
    resourceType: 'user',
    resourceId: id,
    metadata: {
      name: updated.name,
      changes: {
        ...(data.name !== undefined && data.name !== target.name ? { name: true } : {}),
        ...(data.role !== undefined && data.role !== target.role ? { role: { from: target.role, to: data.role } } : {}),
        ...(data.status !== undefined && data.status !== target.status ? { status: { from: target.status, to: data.status } } : {}),
        ...(data.password !== undefined ? { passwordReset: true } : {}),
      },
    },
  });
  return toUserDTO(updated);
}

export async function deleteUser(req: FastifyRequest, id: string): Promise<void> {
  const actor = req.user!;
  if (actor.id === id) throw forbidden("You can't delete your own account.");
  const target = await getDb().transaction(async (tx) => {
    const [t] = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1);
    if (!t) throw notFound('Team member not found.');
    assertCanManage(actor.role, t.role);
    if (t.role === 'owner' && t.status === 'active' && (await otherActiveOwners(tx, id)) === 0) {
      throw conflict('There must always be at least one active owner.', 'last_owner');
    }
    await tx.delete(users).where(eq(users.id, id)); // sessions cascade
    return t;
  });
  await audit(req, { action: 'user.deleted', resourceType: 'user', resourceId: id, metadata: { name: target.name, email: target.email, role: target.role } });
}

/** Used by the CLI. */
export async function countUsers(): Promise<number> {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(users);
  return r.n;
}
