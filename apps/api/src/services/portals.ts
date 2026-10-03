import type { Paginated, PortalDTO } from '@scenox/shared';
import { and, asc, eq, gt, ilike, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db';
import { clients, files, portalAccessTokens, portals, type Portal } from '../db/schema';
import { audit } from '../lib/activity';
import { notFound, validationError } from '../lib/errors';
import { hashPassword } from '../lib/password';
import { parse } from '../lib/validate';
import { getStorage, KEYS } from '../storage';
import { deleteBrandingKey, readImageUpload, storeBrandingImage } from './branding';
import { deleteFileObjects } from './clients';
import { toPortalDTO } from './mappers';
import { generatePortalToken } from './portal-tokens';
import { getSettings } from './settings';
import { emitEvent } from './webhooks';
import { emailSchema, escapeLike, extensionList, nullableText, orderSchema, paginated, paginationSchema, positiveIntOrNull } from './validation';

const isoDate = z.iso.datetime({ offset: true, message: 'Use an ISO date/time.' }).transform((v) => new Date(v));

const portalPassword = z.string().min(8, 'Portal passwords must be at least 8 characters.').max(256, 'Password is too long.');

/** Empty allowed-extension list means "any type" (stored as null). */
const allowedExtensions = extensionList().transform((l) => (l.length === 0 ? null : l)).nullable();

const settingsFields = {
  title: nullableText(200),
  description: nullableText(2000),
  instructions: nullableText(5000),
  expiresAt: isoDate.nullable(),
  maxFileSizeBytes: positiveIntOrNull,
  maxTotalBytes: positiveIntOrNull,
  allowedExtensions,
  requireName: z.boolean(),
  requireEmail: z.boolean(),
  requireCompany: z.boolean(),
  requireMessage: z.boolean(),
  allowMultipleSessions: z.boolean(),
  allowFolders: z.boolean(),
  allowZip: z.boolean(),
  allowResume: z.boolean(),
  allowClientViewFiles: z.boolean(),
  allowClientDeleteFiles: z.boolean(),
  allowClientMessages: z.boolean(),
  notifyEmails: z
    .array(emailSchema)
    .max(20, 'At most 20 notification emails.')
    .transform((l) => [...new Set(l)]),
  notifyClient: z.boolean(),
};

const partialSettings = z.object(settingsFields).partial().shape;

export const createPortalSchema = z.strictObject({
  ...partialSettings,
  clientId: z.uuid('Choose a client.'),
  name: z.string().trim().min(1, 'Name is required.').max(200),
  password: portalPassword.nullable().optional(),
});

export const updatePortalSchema = z.strictObject({
  ...partialSettings,
  name: z.string().trim().min(1, 'Name is required.').max(200).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  password: portalPassword.nullable().optional(),
});

const SORTS = {
  name: portals.name,
  createdAt: portals.createdAt,
  expiresAt: portals.expiresAt,
  lastUploadAt: portals.lastUploadAt,
  storageUsedBytes: portals.storageUsedBytes,
  fileCount: portals.fileCount,
} as const;

export const listPortalsSchema = paginationSchema.extend({
  clientId: z.uuid().optional(),
  status: z.enum(['active', 'expired', 'disabled']).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['name', 'createdAt', 'expiresAt', 'lastUploadAt', 'storageUsedBytes', 'fileCount']).default('createdAt'),
  order: orderSchema,
});

export async function listPortals(query: unknown): Promise<Paginated<PortalDTO>> {
  const q = parse(listPortalsSchema, query);
  const now = new Date();
  const where: SQL[] = [];
  if (q.clientId) where.push(eq(portals.clientId, q.clientId));
  if (q.status === 'disabled') where.push(eq(portals.status, 'disabled'));
  if (q.status === 'active') where.push(eq(portals.status, 'active'), or(isNull(portals.expiresAt), gt(portals.expiresAt, now))!);
  if (q.status === 'expired') where.push(eq(portals.status, 'active'), isNotNull(portals.expiresAt), lte(portals.expiresAt, now));
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    where.push(or(ilike(portals.name, like), ilike(portals.title, like), ilike(clients.name, like))!);
  }
  const cond = where.length ? and(...where) : undefined;
  const col = SORTS[q.sort];
  const orderBy = q.order === 'asc' ? sql`${col} asc nulls last` : sql`${col} desc nulls last`;
  const db = getDb();
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ portal: portals, clientName: clients.name })
      .from(portals)
      .innerJoin(clients, eq(clients.id, portals.clientId))
      .where(cond)
      .orderBy(orderBy, asc(portals.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(portals).innerJoin(clients, eq(clients.id, portals.clientId)).where(cond),
  ]);
  return paginated(
    rows.map((r) => toPortalDTO(r.portal, r.clientName)),
    n,
    q.page,
    q.pageSize,
  );
}

async function loadPortal(id: string): Promise<{ portal: Portal; clientName: string }> {
  const [row] = await getDb()
    .select({ portal: portals, clientName: clients.name })
    .from(portals)
    .innerJoin(clients, eq(clients.id, portals.clientId))
    .where(eq(portals.id, id))
    .limit(1);
  if (!row) throw notFound('Portal not found.');
  return row;
}

export async function getPortalDTO(id: string): Promise<PortalDTO> {
  const { portal, clientName } = await loadPortal(id);
  return toPortalDTO(portal, clientName);
}

export async function createPortal(req: FastifyRequest, body: unknown): Promise<PortalDTO> {
  const data = parse(createPortalSchema, body);
  const db = getDb();
  const [client] = await db.select().from(clients).where(eq(clients.id, data.clientId)).limit(1);
  if (!client) throw validationError({ fields: { clientId: 'That client does not exist.' } }, 'That client does not exist.');
  if (client.status !== 'active') throw validationError({ fields: { clientId: 'That client is disabled.' } }, 'That client is disabled.');

  const { uploads } = await getSettings();
  const { password, clientId, ...rest } = data;
  const tok = generatePortalToken();
  const [row] = await db
    .insert(portals)
    .values({
      ...rest,
      clientId,
      maxFileSizeBytes: data.maxFileSizeBytes === undefined ? uploads.defaultMaxFileSizeBytes : data.maxFileSizeBytes,
      maxTotalBytes: data.maxTotalBytes === undefined ? uploads.defaultPortalQuotaBytes : data.maxTotalBytes,
      allowedExtensions: data.allowedExtensions ?? null,
      passwordHash: password ? await hashPassword(password) : null,
      tokenHash: tok.tokenHash,
      tokenEncrypted: tok.tokenEncrypted,
      tokenPreview: tok.tokenPreview,
      createdBy: req.user?.id ?? null,
    })
    .returning();
  await audit(req, {
    action: 'portal.created',
    resourceType: 'portal',
    resourceId: row.id,
    clientId,
    portalId: row.id,
    metadata: { name: row.name, clientName: client.name, passwordProtected: !!row.passwordHash },
  });
  const dto = toPortalDTO(row, client.name);
  // the secret upload link must never leave the system through a webhook
  const { url: _url, tokenPreview: _preview, ...safe } = dto;
  await emitEvent('portal.created', safe, { clientId });
  return dto;
}

export async function updatePortal(req: FastifyRequest, id: string, body: unknown): Promise<PortalDTO> {
  const data = parse(updatePortalSchema, body);
  const { before, clientName } = await loadPortal(id).then((r) => ({ before: r.portal, clientName: r.clientName }));
  const { password, ...rest } = data;
  const patch: Partial<typeof portals.$inferInsert> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
  if (password !== undefined) patch.passwordHash = password === null ? null : await hashPassword(password);
  const [row] = await getDb().update(portals).set(patch).where(eq(portals.id, id)).returning();
  // A changed/removed password invalidates access grants issued under the old one.
  if (password !== undefined) await getDb().delete(portalAccessTokens).where(eq(portalAccessTokens.portalId, id));

  const action = data.status && data.status !== before.status ? (data.status === 'disabled' ? 'portal.disabled' : 'portal.enabled') : 'portal.updated';
  await audit(req, {
    action,
    resourceType: 'portal',
    resourceId: id,
    clientId: row.clientId,
    portalId: id,
    metadata: { name: row.name, clientName, fields: Object.keys(rest), ...(password !== undefined ? { password: password === null ? 'removed' : 'changed' } : {}) },
  });
  return toPortalDTO(row, clientName);
}

export async function regeneratePortalLink(req: FastifyRequest, id: string): Promise<PortalDTO> {
  const { clientName } = await loadPortal(id);
  const tok = generatePortalToken();
  const db = getDb();
  const [row] = await db
    .update(portals)
    .set({ tokenHash: tok.tokenHash, tokenEncrypted: tok.tokenEncrypted, tokenPreview: tok.tokenPreview, updatedAt: new Date() })
    .where(eq(portals.id, id))
    .returning();
  await db.delete(portalAccessTokens).where(eq(portalAccessTokens.portalId, id));
  await audit(req, { action: 'portal.link_regenerated', resourceType: 'portal', resourceId: id, clientId: row.clientId, portalId: id, metadata: { name: row.name, clientName } });
  return toPortalDTO(row, clientName);
}

export async function setPortalLogo(req: FastifyRequest, id: string): Promise<PortalDTO> {
  const { portal, clientName } = await loadPortal(id);
  const img = await readImageUpload(req);
  const key = await storeBrandingImage(`portal-${id}`, img);
  const [row] = await getDb().update(portals).set({ logoKey: key, updatedAt: new Date() }).where(eq(portals.id, id)).returning();
  await deleteBrandingKey(portal.logoKey);
  await audit(req, { action: 'portal.updated', resourceType: 'portal', resourceId: id, clientId: row.clientId, portalId: id, metadata: { name: row.name, clientName, fields: ['logo'] } });
  return toPortalDTO(row, clientName);
}

export async function removePortalLogo(req: FastifyRequest, id: string): Promise<PortalDTO> {
  const { portal, clientName } = await loadPortal(id);
  const [row] = await getDb().update(portals).set({ logoKey: null, updatedAt: new Date() }).where(eq(portals.id, id)).returning();
  await deleteBrandingKey(portal.logoKey);
  await audit(req, { action: 'portal.updated', resourceType: 'portal', resourceId: id, clientId: row.clientId, portalId: id, metadata: { name: row.name, clientName, fields: ['logo'] } });
  return toPortalDTO(row, clientName);
}

export async function deletePortal(req: FastifyRequest, id: string): Promise<void> {
  const { portal, clientName } = await loadPortal(id);
  const db = getDb();
  const fileRows = await db
    .select({ storageKey: files.storageKey, tusId: files.tusId })
    .from(files)
    .where(and(eq(files.portalId, id), or(isNotNull(files.storageKey), isNotNull(files.tusId))));
  await getStorage().deletePrefix(`${KEYS.uploads}/${portal.clientId}/${id}`);
  await deleteFileObjects(fileRows);
  await deleteBrandingKey(portal.logoKey);
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(portals).where(eq(portals.id, id)).for('update').limit(1);
    if (!p) return;
    await tx
      .update(clients)
      .set({
        storageUsedBytes: sql`greatest(0, ${clients.storageUsedBytes} - ${p.storageUsedBytes})`,
        fileCount: sql`greatest(0, ${clients.fileCount} - ${p.fileCount})`,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, p.clientId));
    await tx.delete(portals).where(eq(portals.id, id));
  });
  await audit(req, { action: 'portal.deleted', resourceType: 'portal', resourceId: id, clientId: portal.clientId, portalId: id, metadata: { name: portal.name, clientName } });
}
