import {
  FILE_TYPE_CATEGORIES,
  fileCategory,
  sanitizeRelativePath,
  type ClientBrowseResponse,
  type ClientDashboardDTO,
  type ClientFileDTO,
  type ClientUploadDTO,
} from '@scenox/shared';
import { and, desc, eq, gt, inArray, notInArray, or, ilike, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db';
import { files, messages, uploadSessions, type Client, type Portal } from '../db/schema';
import { AppError } from '../lib/errors';
import { escapeLike } from './files';
import { clientMessageSummary } from './messages';
import { getQuota } from './quota';
import { assertPortalUsable, hasPortalAccess, loadPortalByToken } from './uploads';

/** Statuses a client can see (and that count towards stats). */
const VISIBLE = ['processing', 'ready', 'quarantined'] as const;
const DELETABLE = ['ready', 'processing'] as const;
const RECENT_UPLOADS = 5;
const RECENT_FILES = 6;
const MAX_UPLOADS = 100;

/**
 * Resolve the portal of a public token and make sure the visitor may use it: unknown token → 404,
 * disabled / expired → 403, password protected without a valid x-portal-access → 401.
 */
export async function loadUsablePortal(req: FastifyRequest, token: string, accessQuery?: string): Promise<{ portal: Portal; client: Client }> {
  const { portal, client } = await loadPortalByToken(token);
  assertPortalUsable(portal, client);
  if (!(await hasPortalAccess(portal, req, accessQuery))) {
    throw new AppError(401, 'password_required', 'This upload link is password protected. Please enter the password to continue.');
  }
  return { portal, client };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ───────────────────────── files ─────────────────────────

const uploadedAtCol = sql`coalesce(${files.completedAt}, ${files.createdAt})`;

const clientFileSelect = () => ({
  id: files.id,
  name: files.originalFilename,
  relativePath: files.relativePath,
  extension: files.extension,
  size: files.size,
  status: files.status,
  completedAt: files.completedAt,
  uploadedBy: uploadSessions.uploaderName,
  commentCount: sql<number>`(select count(*)::int from ${messages} where ${messages.fileId} = ${files.id})`,
});

function selectClientFiles() {
  return getDb()
    .select(clientFileSelect())
    .from(files)
    .innerJoin(uploadSessions, eq(uploadSessions.id, files.uploadSessionId));
}

type ClientFileRow = Awaited<ReturnType<typeof selectClientFiles>>[number];

const toClientFile = (r: ClientFileRow, portal: Pick<Portal, 'allowClientDeleteFiles'>): ClientFileDTO => ({
  id: r.id,
  name: r.name,
  relativePath: r.relativePath,
  extension: r.extension,
  type: fileCategory(r.extension),
  size: Number(r.size),
  status: r.status,
  uploadedAt: iso(r.completedAt),
  uploadedBy: r.uploadedBy ?? null,
  commentCount: Number(r.commentCount ?? 0),
  canDelete: portal.allowClientDeleteFiles && (DELETABLE as readonly string[]).includes(r.status),
});

const toUpload = (s: typeof uploadSessions.$inferSelect): ClientUploadDTO => ({
  id: s.id,
  uploaderName: s.uploaderName,
  message: s.message,
  files: s.uploadedFiles,
  bytes: Number(s.uploadedBytes),
  status: s.status,
  startedAt: s.startedAt.toISOString(),
  completedAt: iso(s.completedAt),
});

// ───────────────────────── dashboard ─────────────────────────

export async function buildClientDashboard(portal: Portal, client: Client): Promise<ClientDashboardDTO> {
  const db = getDb();
  const visible = and(eq(files.portalId, portal.id), inArray(files.status, [...VISIBLE]));

  const [stats] = await db
    .select({
      files: sql<number>`count(*)::int`,
      totalBytes: sql<string>`coalesce(sum(${files.size}), 0)`,
      folders: sql<number>`count(distinct split_part(${files.relativePath}, '/', 1)) filter (where ${files.relativePath} <> '')::int`,
      lastUploadAt: sql<Date | null>`max(${uploadedAtCol})`.mapWith(files.completedAt),
    })
    .from(files)
    .where(visible);

  const typeRows = await db
    .select({ extension: files.extension, files: sql<number>`count(*)::int`, bytes: sql<string>`coalesce(sum(${files.size}), 0)` })
    .from(files)
    .where(visible)
    .groupBy(files.extension);
  const buckets = new Map<string, { type: string; files: number; bytes: number }>();
  for (const r of typeRows) {
    const type = fileCategory(r.extension);
    const b = buckets.get(type) ?? { type, files: 0, bytes: 0 };
    b.files += Number(r.files);
    b.bytes += Number(r.bytes);
    buckets.set(type, b);
  }
  const byType = [...buckets.values()].sort((a, b) => b.bytes - a.bytes || a.type.localeCompare(b.type));

  const [uploadCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(uploadSessions)
    .where(and(eq(uploadSessions.portalId, portal.id), gt(uploadSessions.uploadedFiles, 0)));

  const recentUploads = await db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.portalId, portal.id), gt(uploadSessions.uploadedFiles, 0)))
    .orderBy(desc(uploadSessions.startedAt), desc(uploadSessions.id))
    .limit(RECENT_UPLOADS);

  const recentFiles = portal.allowClientViewFiles
    ? await selectClientFiles().where(visible).orderBy(desc(uploadedAtCol), desc(files.id)).limit(RECENT_FILES)
    : [];

  const quota = await getQuota(portal, client);
  const messagesSummary = portal.allowClientMessages ? await clientMessageSummary(portal.id) : { total: 0, unread: 0, latest: null };

  return {
    stats: {
      files: Number(stats?.files ?? 0),
      totalBytes: Number(stats?.totalBytes ?? 0),
      uploads: Number(uploadCount?.n ?? 0),
      folders: Number(stats?.folders ?? 0),
      lastUploadAt: iso(stats?.lastUploadAt),
    },
    quota: { usedBytes: quota.usedBytes, limitBytes: quota.limitBytes },
    expiresAt: iso(portal.expiresAt),
    byType,
    recentUploads: recentUploads.map(toUpload),
    recentFiles: recentFiles.map((r) => toClientFile(r, portal)),
    messages: messagesSummary,
  };
}

// ───────────────────────── browse ─────────────────────────

export const clientBrowseQuerySchema = z.object({
  path: z.string().max(4096).default(''),
  q: z.string().trim().max(200).optional(),
  type: z.enum(['image', 'video', 'audio', 'document', 'spreadsheet', 'archive', 'other']).optional(),
  sort: z.enum(['name', 'size', 'uploadedAt']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function browseClientFiles(portal: Portal, raw: z.infer<typeof clientBrowseQuerySchema>): Promise<ClientBrowseResponse> {
  const q = raw;
  const path = sanitizeRelativePath(q.path);
  const db = getDb();

  const typeCond: SQL | undefined = q.type
    ? q.type === 'other'
      ? notInArray(files.extension, Object.values(FILE_TYPE_CATEGORIES).flat() as string[])
      : inArray(files.extension, [...FILE_TYPE_CATEGORIES[q.type]])
    : undefined;
  const scope = and(eq(files.portalId, portal.id), inArray(files.status, [...VISIBLE]), typeCond);

  // folders = distinct immediate child segment of relative_path below `path`
  const offset = path === '' ? 1 : path.length + 2; // 1-based substr start after "path/"
  const prefixCond = path === '' ? sql`${files.relativePath} <> ''` : sql`starts_with(${files.relativePath}, ${path + '/'})`;
  const segment = sql<string>`split_part(substr(${files.relativePath}, ${sql.raw(String(offset))}), '/', 1)`; // offset is an integer we computed
  const folderRows = await db
    .select({ name: segment, fileCount: sql<number>`count(*)::int`, totalBytes: sql<string>`coalesce(sum(${files.size}), 0)` })
    .from(files)
    .where(and(scope, prefixCond, q.q ? sql`${segment} ilike ${'%' + escapeLike(q.q) + '%'}` : undefined))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const fileWhere = and(scope, eq(files.relativePath, path), q.q ? ilike(files.originalFilename, `%${escapeLike(q.q)}%`) : undefined);
  const col = { name: files.originalFilename, size: files.size, uploadedAt: uploadedAtCol }[q.sort];
  const dir = q.order === 'asc' ? sql`asc` : sql`desc`;
  const rows = await selectClientFiles()
    .where(fileWhere)
    .orderBy(sql`${col} ${dir}`, desc(files.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(files).where(fileWhere);

  const parts = path ? path.split('/') : [];
  return {
    path,
    breadcrumbs: parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') })),
    folders: folderRows
      .filter((f) => f.name !== '')
      .map((f) => ({ name: f.name, path: path ? `${path}/${f.name}` : f.name, fileCount: Number(f.fileCount), totalBytes: Number(f.totalBytes) })),
    files: { items: rows.map((r) => toClientFile(r, portal)), total: Number(total?.n ?? 0), page: q.page, pageSize: q.pageSize },
  };
}

// ───────────────────────── upload history ─────────────────────────

export async function listClientUploads(portal: Portal): Promise<ClientUploadDTO[]> {
  const rows = await getDb()
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.portalId, portal.id), or(gt(uploadSessions.uploadedFiles, 0), eq(uploadSessions.status, 'active'))))
    .orderBy(desc(uploadSessions.startedAt), desc(uploadSessions.id))
    .limit(MAX_UPLOADS);
  return rows.map(toUpload);
}
