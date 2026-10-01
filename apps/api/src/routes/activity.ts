import type { ActivityDTO, NotificationDTO, Paginated } from '@scenox/shared';
import { and, desc, eq, gte, inArray, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db';
import { activityLogs, clients, notifications } from '../db/schema';
import { parse } from '../lib/validate';
import { toActivityDTO, toNotificationDTO } from '../services/mappers';
import { escapeLike, paginated, paginationSchema } from '../services/validation';

const date = z.coerce.date({ error: 'Use an ISO date.' });

const activityQuerySchema = paginationSchema.extend({
  clientId: z.uuid().optional(),
  portalId: z.uuid().optional(),
  action: z.string().trim().max(100).optional(),
  actorType: z.enum(['user', 'client', 'system']).optional(),
  from: date.optional(),
  to: date.optional(),
});

async function queryActivity(query: unknown, extra?: SQL): Promise<Paginated<ActivityDTO>> {
  const q = parse(activityQuerySchema, query);
  const where: SQL[] = [];
  if (extra) where.push(extra);
  if (q.clientId) where.push(eq(activityLogs.clientId, q.clientId));
  if (q.portalId) where.push(eq(activityLogs.portalId, q.portalId));
  if (q.action) where.push(like(activityLogs.action, `${escapeLike(q.action)}%`));
  if (q.actorType) where.push(eq(activityLogs.actorType, q.actorType));
  if (q.from) where.push(gte(activityLogs.createdAt, q.from));
  if (q.to) where.push(lte(activityLogs.createdAt, q.to));
  const cond = where.length ? and(...where) : undefined;
  const db = getDb();
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ log: activityLogs, clientName: clients.name })
      .from(activityLogs)
      .leftJoin(clients, eq(clients.id, activityLogs.clientId))
      .where(cond)
      .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(activityLogs).where(cond),
  ]);
  return paginated(
    rows.map((r) => toActivityDTO(r.log, r.clientName)),
    n,
    q.page,
    q.pageSize,
  );
}

const readSchema = z.strictObject({ ids: z.array(z.uuid()).max(500).optional() }).optional();

export default async function activityRoutes(app: FastifyInstance) {
  app.get('/activity', { preHandler: app.requirePermission('activity.view') }, async (req) => queryActivity(req.query));

  app.get('/audit', { preHandler: app.requirePermission('audit.view') }, async (req) =>
    queryActivity(req.query, or(eq(activityLogs.actorType, 'user'), like(activityLogs.action, 'auth.%'))),
  );

  app.get('/notifications', { preHandler: app.authenticate }, async (req): Promise<Paginated<NotificationDTO> & { unread: number }> => {
    const q = parse(paginationSchema, req.query);
    const inApp = eq(notifications.channel, 'in_app');
    const db = getDb();
    const [rows, [{ n }], [{ unread }]] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(inApp)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(inApp),
      db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(and(inApp, isNull(notifications.readAt))),
    ]);
    return { ...paginated(rows.map(toNotificationDTO), n, q.page, q.pageSize), unread };
  });

  app.post('/notifications/read', { preHandler: app.authenticate }, async (req, reply) => {
    const body = parse(readSchema, req.body) ?? {};
    const cond = [eq(notifications.channel, 'in_app'), isNull(notifications.readAt)];
    if (body.ids) {
      if (body.ids.length === 0) return reply.status(204).send();
      cond.push(inArray(notifications.id, body.ids));
    }
    await getDb()
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(...cond));
    return reply.status(204).send();
  });
}
