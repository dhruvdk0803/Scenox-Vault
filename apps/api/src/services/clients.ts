import { CLIENT_STATUSES, type ClientDTO, type Paginated } from '@scenox/shared';
import { and, asc, eq, ilike, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db';
import { clients, files, portals } from '../db/schema';
import { audit } from '../lib/activity';
import { notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { parse } from '../lib/validate';
import { getStorage, KEYS } from '../storage';
import { toClientDTO } from './mappers';
import { emitEvent } from './webhooks';
import { emailSchema, escapeLike, nullableText, orderSchema, paginated, paginationSchema, positiveIntOrNull } from './validation';

const optionalEmail = z
  .union([z.literal(''), z.null(), emailSchema])
  .transform((v) => (v === '' ? null : v));

const clientFields = {
  name: z.string().trim().min(1, 'Name is required.').max(200),
  company: nullableText(200),
  email: optionalEmail,
  phone: nullableText(50),
  notes: nullableText(5000),
  quotaBytes: positiveIntOrNull,
};

export const createClientSchema = z.strictObject({
  ...clientFields,
  company: clientFields.company.optional(),
  email: clientFields.email.optional(),
  phone: clientFields.phone.optional(),
  notes: clientFields.notes.optional(),
  quotaBytes: clientFields.quotaBytes.optional(),
});

export const updateClientSchema = z.strictObject({
  name: clientFields.name.optional(),
  company: clientFields.company.optional(),
  email: clientFields.email.optional(),
  phone: clientFields.phone.optional(),
  notes: clientFields.notes.optional(),
  quotaBytes: clientFields.quotaBytes.optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
});

const SORTS = {
  name: clients.name,
  createdAt: clients.createdAt,
  storageUsedBytes: clients.storageUsedBytes,
  lastUploadAt: clients.lastUploadAt,
  fileCount: clients.fileCount,
} as const;

export const listClientsSchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
  sort: z.enum(['name', 'createdAt', 'storageUsedBytes', 'lastUploadAt', 'fileCount']).default('createdAt'),
  order: orderSchema,
});

const portalCountSql = sql<number>`(select count(*)::int from portals where portals.client_id = clients.id)`;

export async function listClients(query: unknown): Promise<Paginated<ClientDTO>> {
  const q = parse(listClientsSchema, query);
  const where: SQL[] = [];
  if (q.status) where.push(eq(clients.status, q.status));
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    where.push(or(ilike(clients.name, like), ilike(clients.company, like), ilike(clients.email, like))!);
  }
  const cond = where.length ? and(...where) : undefined;
  const col = SORTS[q.sort];
  const orderBy = q.order === 'asc' ? sql`${col} asc nulls last` : sql`${col} desc nulls last`;
  const db = getDb();
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ client: clients, portalCount: portalCountSql })
      .from(clients)
      .where(cond)
      .orderBy(orderBy, asc(clients.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(clients).where(cond),
  ]);
  return paginated(
    rows.map((r) => toClientDTO(r.client, { portalCount: r.portalCount })),
    n,
    q.page,
    q.pageSize,
  );
}

export async function getClientDTO(id: string): Promise<ClientDTO> {
  const [row] = await getDb().select({ client: clients, portalCount: portalCountSql }).from(clients).where(eq(clients.id, id)).limit(1);
  if (!row) throw notFound('Client not found.');
  return toClientDTO(row.client, { portalCount: row.portalCount });
}

export async function createClient(req: FastifyRequest, body: unknown): Promise<ClientDTO> {
  const data = parse(createClientSchema, body);
  const [row] = await getDb()
    .insert(clients)
    .values({
      name: data.name,
      company: data.company ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      notes: data.notes ?? null,
      quotaBytes: data.quotaBytes ?? null,
      createdBy: req.user?.id ?? null,
    })
    .returning();
  await audit(req, { action: 'client.created', resourceType: 'client', resourceId: row.id, clientId: row.id, metadata: { name: row.name } });
  const dto = toClientDTO(row, { portalCount: 0 });
  await emitEvent('client.created', dto, { clientId: row.id });
  return dto;
}

export async function updateClient(req: FastifyRequest, id: string, body: unknown): Promise<ClientDTO> {
  const data = parse(updateClientSchema, body);
  const patch: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
  const db = getDb();
  const [before] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!before) throw notFound('Client not found.');
  const [row] = await db.update(clients).set(patch).where(eq(clients.id, id)).returning();
  const disabled = data.status === 'disabled' && before.status !== 'disabled';
  await audit(req, {
    action: disabled ? 'client.disabled' : 'client.updated',
    resourceType: 'client',
    resourceId: id,
    clientId: id,
    metadata: { name: row.name, fields: Object.keys(data), ...(data.status && data.status !== before.status ? { status: data.status } : {}) },
  });
  return getClientDTO(row.id);
}

/**
 * Delete every stored object for the given file rows: staging / quarantine objects referenced by
 * `storage_key`, plus the tus temp files of unfinished uploads. Best-effort per object, but throws if
 * a delete fails for a reason other than the object being absent (so the DB row is kept for a retry).
 */
export async function deleteFileObjects(rows: { storageKey: string | null; tusId: string | null }[]) {
  const storage = getStorage();
  for (const r of rows) {
    const keys: string[] = [];
    if (r.storageKey) keys.push(r.storageKey);
    if (r.tusId && /^[A-Za-z0-9_-]{1,128}$/.test(r.tusId)) keys.push(`${KEYS.tus}/${r.tusId}`, `${KEYS.tus}/${r.tusId}.json`);
    for (const key of keys) {
      try {
        await storage.delete(key);
      } catch (err) {
        logger.warn({ err, key }, 'failed to delete stored object');
        throw err;
      }
    }
  }
}

export async function deleteClient(req: FastifyRequest, id: string): Promise<void> {
  const db = getDb();
  const [client] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!client) throw notFound('Client not found.');
  const rows = await db
    .select({ storageKey: files.storageKey, tusId: files.tusId })
    .from(files)
    .where(and(eq(files.clientId, id), or(isNotNull(files.storageKey), isNotNull(files.tusId))));
  const storage = getStorage();
  await storage.deletePrefix(`${KEYS.uploads}/${id}`);
  await deleteFileObjects(rows);
  const logoRows = await db.select({ logoKey: portals.logoKey }).from(portals).where(and(eq(portals.clientId, id), isNotNull(portals.logoKey)));
  for (const r of logoRows) await storage.delete(r.logoKey!).catch(() => {});
  await db.delete(clients).where(eq(clients.id, id)); // cascades portals, sessions, files
  await audit(req, { action: 'client.deleted', resourceType: 'client', resourceId: id, clientId: id, metadata: { name: client.name, files: client.fileCount } });
}

