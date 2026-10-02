import type { UploadSessionDTO } from '@scenox/shared';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db';
import { clients, files, portals, uploadSessions } from '../db/schema';
import { notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { audit } from '../lib/activity';
import { deleteFiles, escapeLike } from '../services/files';
import { toUploadSessionDTO } from '../services/mappers';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  clientId: z.uuid().optional(),
  portalId: z.uuid().optional(),
  status: z.enum(['active', 'completed', 'abandoned', 'failed']).optional(),
  q: z.string().trim().max(200).optional(),
});

const select = {
  session: uploadSessions,
  clientName: clients.name,
  portalName: portals.name,
};

/** For active sessions, uploadedBytes is the live sum of bytes received across the session's files. */
async function withLiveBytes(rows: { session: typeof uploadSessions.$inferSelect; clientName: string; portalName: string }[]): Promise<UploadSessionDTO[]> {
  const dtos = rows.map((r) => toUploadSessionDTO(r.session, r));
  const active = dtos.filter((d) => d.status === 'active').map((d) => d.id);
  if (active.length) {
    const sums = await getDb()
      .select({ id: files.uploadSessionId, bytes: sql<string>`coalesce(sum(${files.bytesReceived}), 0)` })
      .from(files)
      .where(and(inArray(files.uploadSessionId, active), inArray(files.status, ['uploading', 'processing', 'ready', 'quarantined'])))
      .groupBy(files.uploadSessionId);
    const byId = new Map(sums.map((s) => [s.id, Number(s.bytes)]));
    for (const d of dtos) if (byId.has(d.id)) d.uploadedBytes = Math.max(d.uploadedBytes, byId.get(d.id)!);
  }
  return dtos;
}

export default async function uploadRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.requirePermission('files.view') }, async (req) => {
    const q = parse(listSchema, req.query);
    const conds: (SQL | undefined)[] = [];
    if (q.clientId) conds.push(eq(uploadSessions.clientId, q.clientId));
    if (q.portalId) conds.push(eq(uploadSessions.portalId, q.portalId));
    if (q.status) conds.push(eq(uploadSessions.status, q.status));
    if (q.q) {
      const pat = `%${escapeLike(q.q)}%`;
      conds.push(
        or(
          ilike(uploadSessions.uploaderName, pat),
          ilike(uploadSessions.uploaderEmail, pat),
          ilike(uploadSessions.uploaderCompany, pat),
          ilike(uploadSessions.message, pat),
          ilike(clients.name, pat),
          ilike(portals.name, pat),
        ),
      );
    }
    const where = and(...conds);
    const db = getDb();
    const base = () => db.select(select).from(uploadSessions).innerJoin(clients, eq(clients.id, uploadSessions.clientId)).innerJoin(portals, eq(portals.id, uploadSessions.portalId));
    const rows = await base()
      .where(where)
      .orderBy(desc(uploadSessions.startedAt), desc(uploadSessions.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(uploadSessions)
      .innerJoin(clients, eq(clients.id, uploadSessions.clientId))
      .innerJoin(portals, eq(portals.id, uploadSessions.portalId))
      .where(where);
    return { items: await withLiveBytes(rows), total: Number(n), page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', { preHandler: app.requirePermission('files.view') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const [row] = await getDb()
      .select(select)
      .from(uploadSessions)
      .innerJoin(clients, eq(clients.id, uploadSessions.clientId))
      .innerJoin(portals, eq(portals.id, uploadSessions.portalId))
      .where(eq(uploadSessions.id, id))
      .limit(1);
    if (!row) throw notFound('Upload session not found.');
    return (await withLiveBytes([row]))[0];
  });

  /**
   * Delete an upload (batch) entirely: cancels in-progress transfers, removes every file of the
   * session (any status, incl. partial tus data) and the session itself. Used for stuck/abandoned
   * uploads (e.g. the client's laptop shut down mid-transfer) — the client can simply upload again.
   */
  app.delete('/:id', { preHandler: app.requirePermission('files.delete') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const db = getDb();
    const [s] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).limit(1);
    if (!s) throw notFound('Upload session not found.');
    const ids = (await db.select({ id: files.id }).from(files).where(eq(files.uploadSessionId, id))).map((r) => r.id);
    const deleted = await deleteFiles(ids);
    await db.transaction(async (tx) => {
      await tx.delete(uploadSessions).where(eq(uploadSessions.id, id));
      await tx.execute(sql`update portals set session_count = greatest(session_count - 1, 0), updated_at = now() where id = ${s.portalId}`);
      await tx.execute(sql`update clients set upload_count = greatest(upload_count - 1, 0), updated_at = now() where id = ${s.clientId}`);
    });
    await audit(req, {
      action: 'upload.deleted',
      resourceType: 'upload_session',
      resourceId: id,
      clientId: s.clientId,
      portalId: s.portalId,
      metadata: { count: deleted.length, bytes: deleted.reduce((n, f) => n + Number(f.size), 0), status: s.status },
    });
    return reply.code(204).send();
  });
}
