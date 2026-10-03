import {
  FILE_TYPE_CATEGORIES,
  getExtension,
  sanitizeFilename,
  sanitizeRelativePath,
  withCopySuffix,
  type BrowseResponse,
  type FileDTO,
  type FileListQuery,
  type FileStatus,
  type Paginated,
} from '@scenox/shared';
import { and, asc, desc, eq, gt, gte, ilike, inArray, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import { clients, files, portals, uploadSessions, type FileRow } from '../db/schema';
import { AppError, conflict, notFound, validationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { KEYS, getStorage } from '../storage';
import { toFileDTO } from './mappers';
import { bumpCounters, type Tx } from './uploads';
import { emitEvents } from './webhooks';

/** Statuses whose bytes are counted in session/portal/client counters. */
export const COUNTED_STATUSES: FileStatus[] = ['processing', 'ready', 'quarantined'];
/** Statuses that occupy a name inside a folder. */
export const NAME_TAKEN_STATUSES: FileStatus[] = ['uploading', 'processing', 'ready', 'quarantined'];
/** Statuses shown in the browser / default lists. */
export const VISIBLE_STATUSES: FileStatus[] = ['processing', 'ready', 'quarantined'];

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ───────────────────────── storage keys / deletion ─────────────────────────

/** Where the bytes of a file currently live (never exposed to clients). */
export function currentStorageKey(f: Pick<FileRow, 'storageKey' | 'status' | 'storedFilename'>): string | null {
  if (f.storageKey) return f.storageKey;
  if (f.status === 'processing') return KEYS.stagingKey(f.storedFilename);
  if (f.status === 'quarantined') return KEYS.quarantineKey(f.storedFilename);
  return null;
}

/**
 * Delete file rows inside a transaction and decrement the session/portal/client counters for
 * rows that were counted. Returns the rows that were actually deleted (concurrent deletes are safe).
 */
export async function deleteFileRowsTx(tx: Tx, ids: string[]): Promise<FileRow[]> {
  if (ids.length === 0) return [];
  const deleted = await tx.delete(files).where(inArray(files.id, ids)).returning();
  const groups = new Map<string, { uploadSessionId: string; portalId: string; clientId: string; files: number; bytes: number }>();
  for (const f of deleted) {
    if (!COUNTED_STATUSES.includes(f.status)) continue;
    const k = `${f.uploadSessionId}|${f.portalId}|${f.clientId}`;
    const g = groups.get(k) ?? { uploadSessionId: f.uploadSessionId, portalId: f.portalId, clientId: f.clientId, files: 0, bytes: 0 };
    g.files += 1;
    g.bytes += Number(f.size);
    groups.set(k, g);
  }
  for (const g of groups.values()) await bumpCounters(tx, g, -g.files, -g.bytes);
  return deleted;
}

/** Remove the on-disk objects of already-deleted rows. Best effort: failures are logged, never thrown. */
export async function removeStoredObjects(rows: FileRow[]): Promise<void> {
  const storage = getStorage();
  for (const f of rows) {
    const keys = new Set<string>();
    if (f.storageKey) keys.add(f.storageKey);
    keys.add(KEYS.stagingKey(f.storedFilename));
    keys.add(KEYS.quarantineKey(f.storedFilename));
    if (f.tusId) {
      keys.add(`${KEYS.tus}/${f.tusId}`);
      keys.add(`${KEYS.tus}/${f.tusId}.json`);
    }
    for (const k of keys) {
      try {
        await storage.delete(k);
      } catch (err) {
        logger.error({ err, fileId: f.id }, 'failed to remove stored object');
      }
    }
  }
}

/** Delete files (rows + bytes + counters). Returns the deleted rows. */
export async function deleteFiles(ids: string[]): Promise<FileRow[]> {
  const unique = [...new Set(ids)];
  const deleted: FileRow[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await getDb().transaction((tx) => deleteFileRowsTx(tx, chunk));
    await removeStoredObjects(rows);
    deleted.push(...rows);
  }
  // webhooks: only for files that had been visible (not abandoned/failed uploads). Never throws.
  await emitEvents(
    'file.deleted',
    deleted
      .filter((f) => COUNTED_STATUSES.includes(f.status))
      .map((f) => ({
        clientId: f.clientId,
        data: { id: f.id, name: f.originalFilename, relativePath: f.relativePath, clientId: f.clientId, portalId: f.portalId, size: Number(f.size) },
      })),
  );
  return deleted;
}

// ───────────────────────── names ─────────────────────────

/** First free name in a client folder ("a.pdf" → "a (1).pdf"). */
export async function uniqueName(
  tx: Pick<ReturnType<typeof getDb>, 'select'>,
  clientId: string,
  relativePath: string,
  name: string,
  excludeIds: string[] = [],
): Promise<string> {
  const taken = async (candidate: string) => {
    const [row] = await tx
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.clientId, clientId),
          eq(files.relativePath, relativePath),
          eq(files.originalFilename, candidate),
          inArray(files.status, NAME_TAKEN_STATUSES),
          ...(excludeIds.length ? [notInArray(files.id, excludeIds)] : []),
        ),
      )
      .limit(1);
    return !!row;
  };
  if (!(await taken(name))) return name;
  for (let n = 1; n < 1000; n++) {
    const candidate = withCopySuffix(name, n);
    if (!(await taken(candidate))) return candidate;
  }
  return withCopySuffix(name, Date.now());
}

// ───────────────────────── listing ─────────────────────────

// ───────────────────────── tags & meta ─────────────────────────

export const MAX_TAGS_PER_FILE = 20;
export const MAX_META_BYTES = 16 * 1024;

/** Normalised server-side: trimmed, lowercased, whitespace → "-"; then 1..50 chars of [a-z0-9:_-.] */
export const tagSchema = z
  .string('Tags must be text.')
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\s+/g, '-'))
  .pipe(
    z
      .string()
      .min(1, 'Tags cannot be empty.')
      .max(50, 'Tags can be at most 50 characters.')
      .regex(/^[a-z0-9:_\-.]+$/, 'Tags may only contain letters, numbers and : _ - .'),
  );
const tagList = z.array(tagSchema).max(MAX_TAGS_PER_FILE, `A file can have at most ${MAX_TAGS_PER_FILE} tags.`);

const metaSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((m) => !Object.keys(m).some((k) => k === '__proto__'), 'Invalid key.')
  .refine((m) => Buffer.byteLength(JSON.stringify(m)) <= MAX_META_BYTES, `Metadata can be at most ${MAX_META_BYTES / 1024} KB.`);

export const updateFileSchema = z
  .object({
    name: z.string().trim().min(1, 'Please enter a file name.').max(1024).optional(),
    tags: tagList.optional(),
    addTags: tagList.optional(),
    removeTags: tagList.optional(),
    meta: metaSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });
export type UpdateFileInput = z.infer<typeof updateFileSchema>;

export const bulkTagSchema = z
  .strictObject({
    fileIds: z.array(z.uuid()).min(1, 'Select at least one file.').max(1000, 'Please send at most 1000 files at a time.'),
    addTags: tagList.optional(),
    removeTags: tagList.optional(),
  })
  .refine((v) => (v.addTags?.length ?? 0) + (v.removeTags?.length ?? 0) > 0, { message: 'Provide addTags and/or removeTags.' });

/** tags (replace) → addTags → removeTags, de-duplicated, order preserved. */
export function applyTagOps(current: string[], ops: { tags?: string[]; addTags?: string[]; removeTags?: string[] }): string[] {
  let next = ops.tags ? [...new Set(ops.tags)] : [...current];
  if (ops.addTags) next = [...new Set([...next, ...ops.addTags])];
  if (ops.removeTags) {
    const drop = new Set(ops.removeTags);
    next = next.filter((t) => !drop.has(t));
  }
  if (next.length > MAX_TAGS_PER_FILE) {
    throw validationError({ fields: { tags: `A file can have at most ${MAX_TAGS_PER_FILE} tags.` } }, `A file can have at most ${MAX_TAGS_PER_FILE} tags.`);
  }
  return next;
}

/** Shallow merge; a null value deletes the key. */
export function mergeMeta(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else Object.defineProperty(next, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_META_BYTES) {
    throw validationError({ fields: { meta: `Metadata can be at most ${MAX_META_BYTES / 1024} KB.` } }, `Metadata can be at most ${MAX_META_BYTES / 1024} KB.`);
  }
  return next;
}

/** Apply tag and/or meta changes to one file atomically (row lock, so concurrent updates don't lose writes). */
export async function updateFileTagsAndMeta(
  id: string,
  input: Pick<UpdateFileInput, 'tags' | 'addTags' | 'removeTags' | 'meta'>,
): Promise<{ before: FileRow; after: FileRow }> {
  return getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(files).where(eq(files.id, id)).for('update').limit(1);
    if (!before) throw notFound('File not found.');
    const hasTags = input.tags !== undefined || input.addTags !== undefined || input.removeTags !== undefined;
    const tags = hasTags ? applyTagOps(before.tags ?? [], input) : (before.tags ?? []);
    const meta = input.meta ? mergeMeta(before.meta ?? {}, input.meta) : (before.meta ?? {});
    if (!hasTags && !input.meta) return { before, after: before };
    const [after] = await tx.update(files).set({ tags, meta, updatedAt: new Date() }).where(eq(files.id, id)).returning();
    return { before, after: after! };
  });
}

/** Add/remove tags on many files in one transaction. Returns how many of the given files exist (and were processed). */
export async function bulkTagFiles(ids: string[], ops: { addTags?: string[]; removeTags?: string[] }): Promise<{ updated: number }> {
  const unique = [...new Set(ids)];
  return getDb().transaction(async (tx) => {
    let updated = 0;
    const rows = await tx.select({ id: files.id, tags: files.tags }).from(files).where(inArray(files.id, unique)).orderBy(asc(files.id)).for('update');
    for (const r of rows) {
      const next = applyTagOps(r.tags ?? [], ops);
      updated++;
      const cur = r.tags ?? [];
      if (next.length === cur.length && next.every((t, i) => t === cur[i])) continue;
      await tx.update(files).set({ tags: next, updatedAt: new Date() }).where(eq(files.id, r.id));
    }
    return { updated };
  });
}

export const fileListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['name', 'size', 'createdAt', 'completedAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  clientId: z.uuid().optional(),
  portalId: z.uuid().optional(),
  uploadSessionId: z.uuid().optional(),
  status: z.enum(['uploading', 'processing', 'ready', 'quarantined', 'failed', 'cancelled']).optional(),
  scanStatus: z.enum(['pending', 'scanning', 'clean', 'infected', 'skipped', 'failed']).optional(),
  type: z.enum(['image', 'video', 'audio', 'document', 'spreadsheet', 'archive', 'other']).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  minSize: z.coerce.number().int().min(0).optional(),
  maxSize: z.coerce.number().int().min(0).optional(),
  path: z.string().max(4096).optional(),
  tag: tagSchema.optional(),
  notTag: tagSchema.optional(),
  /** ISO date/time: only files completed (uploaded) after this instant — for incremental sync */
  since: z
    .string()
    .max(40)
    .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Use an ISO date/time.')
    .optional(),
});

const parseDate = (s: string | undefined, endOfDay = false): Date | undefined => {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

const fileSelect = {
  file: files,
  clientName: clients.name,
  portalName: portals.name,
  uploaderName: uploadSessions.uploaderName,
  uploaderEmail: uploadSessions.uploaderEmail,
};

function joined() {
  return getDb()
    .select(fileSelect)
    .from(files)
    .innerJoin(clients, eq(clients.id, files.clientId))
    .innerJoin(portals, eq(portals.id, files.portalId))
    .innerJoin(uploadSessions, eq(uploadSessions.id, files.uploadSessionId));
}

type JoinedRow = Awaited<ReturnType<typeof joined>>[number];
const rowToDTO = (r: JoinedRow): FileDTO =>
  toFileDTO(r.file, { clientName: r.clientName, portalName: r.portalName, uploaderName: r.uploaderName, uploaderEmail: r.uploaderEmail });

async function countWhere(where: SQL | undefined): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(files).where(where);
  return Number(row?.n ?? 0);
}

export async function listFiles(raw: FileListQuery | z.input<typeof fileListQuerySchema>): Promise<Paginated<FileDTO>> {
  const q = fileListQuerySchema.parse(raw);
  const conds: (SQL | undefined)[] = [];
  if (q.clientId) conds.push(eq(files.clientId, q.clientId));
  if (q.portalId) conds.push(eq(files.portalId, q.portalId));
  if (q.uploadSessionId) conds.push(eq(files.uploadSessionId, q.uploadSessionId));
  if (q.status) conds.push(eq(files.status, q.status));
  else conds.push(inArray(files.status, VISIBLE_STATUSES));
  if (q.scanStatus) conds.push(eq(files.scanStatus, q.scanStatus));
  if (q.type) {
    if (q.type === 'other') conds.push(notInArray(files.extension, Object.values(FILE_TYPE_CATEGORIES).flat() as string[]));
    else conds.push(inArray(files.extension, [...FILE_TYPE_CATEGORIES[q.type]]));
  }
  const from = parseDate(q.from);
  const to = parseDate(q.to, true);
  if (from) conds.push(gte(files.createdAt, from));
  if (to) conds.push(lte(files.createdAt, to));
  if (q.minSize !== undefined) conds.push(gte(files.size, q.minSize));
  if (q.maxSize !== undefined) conds.push(lte(files.size, q.maxSize));
  if (q.path !== undefined) conds.push(eq(files.relativePath, sanitizeRelativePath(q.path)));
  if (q.tag) conds.push(sql`${files.tags} @> ARRAY[${q.tag}]::text[]`);
  if (q.notTag) conds.push(sql`NOT (${files.tags} @> ARRAY[${q.notTag}]::text[])`);
  if (q.since) conds.push(gt(files.completedAt, new Date(q.since)));
  if (q.q) {
    const pat = `%${escapeLike(q.q)}%`;
    conds.push(or(ilike(files.originalFilename, pat), ilike(files.relativePath, pat)));
  }
  const where = and(...conds);
  const col = { name: files.originalFilename, size: files.size, createdAt: files.createdAt, completedAt: files.completedAt }[q.sort];
  const dir = q.order === 'asc' ? asc : desc;
  const rows = await joined()
    .where(where)
    .orderBy(dir(col), desc(files.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { items: rows.map(rowToDTO), total: await countWhere(where), page: q.page, pageSize: q.pageSize };
}

/** Ready files of one upload session (oldest first) for the upload.completed webhook. */
export async function listSessionReadyFiles(sessionId: string, limit: number): Promise<{ files: FileDTO[]; total: number }> {
  const where = and(eq(files.uploadSessionId, sessionId), eq(files.status, 'ready'));
  const rows = await joined().where(where).orderBy(asc(files.createdAt), asc(files.id)).limit(limit);
  return { files: rows.map(rowToDTO), total: await countWhere(where) };
}

export async function getFileDTO(id: string): Promise<FileDTO> {
  const [row] = await joined().where(eq(files.id, id)).limit(1);
  if (!row) throw notFound('File not found.');
  return rowToDTO(row);
}

export async function getFileRow(id: string): Promise<FileRow> {
  const [row] = await getDb().select().from(files).where(eq(files.id, id)).limit(1);
  if (!row) throw notFound('File not found.');
  return row;
}

// ───────────────────────── browse ─────────────────────────

export const browseQuerySchema = z.object({
  clientId: z.uuid(),
  portalId: z.uuid().optional(),
  path: z.string().max(4096).default(''),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function browseFiles(raw: z.input<typeof browseQuerySchema>): Promise<BrowseResponse> {
  const q = browseQuerySchema.parse(raw);
  const path = sanitizeRelativePath(q.path);
  const db = getDb();

  const visible = sql`${files.status} in ('processing','ready','quarantined')`;
  const scope = and(eq(files.clientId, q.clientId), q.portalId ? eq(files.portalId, q.portalId) : undefined);

  // folders = distinct immediate child segment of relative_path below `path`
  const offset = path === '' ? 1 : path.length + 2; // 1-based substr start after "path/"
  const prefixCond = path === '' ? sql`${files.relativePath} <> ''` : sql`starts_with(${files.relativePath}, ${path + '/'})`;
  const segment = sql<string>`split_part(substr(${files.relativePath}, ${sql.raw(String(offset))}), '/', 1)`; // offset is an integer we computed
  const folderRows = await db
    .select({
      name: segment,
      fileCount: sql<number>`count(*)::int`,
      totalBytes: sql<string>`coalesce(sum(${files.size}), 0)`,
    })
    .from(files)
    .where(and(scope, visible, prefixCond, q.q ? sql`${segment} ilike ${'%' + escapeLike(q.q) + '%'}` : undefined))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const fileWhere = and(
    scope,
    visible,
    eq(files.relativePath, path),
    q.q ? ilike(files.originalFilename, `%${escapeLike(q.q)}%`) : undefined,
  );
  const rows = await joined()
    .where(fileWhere)
    .orderBy(asc(files.originalFilename), desc(files.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const parts = path ? path.split('/') : [];
  return {
    path,
    breadcrumbs: parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') })),
    folders: folderRows
      .filter((f) => f.name !== '')
      .map((f) => ({ name: f.name, path: path ? `${path}/${f.name}` : f.name, fileCount: Number(f.fileCount), totalBytes: Number(f.totalBytes) })),
    files: { items: rows.map(rowToDTO), total: await countWhere(fileWhere), page: q.page, pageSize: q.pageSize },
  };
}

// ───────────────────────── rename / move ─────────────────────────

export async function renameFile(id: string, rawName: string): Promise<{ before: FileRow; after: FileRow }> {
  const name = sanitizeFilename(rawName);
  const before = await getFileRow(id);
  if (!COUNTED_STATUSES.includes(before.status)) throw conflict('This file can’t be renamed right now.');
  if (name === before.originalFilename) return { before, after: before };
  const [clash] = await getDb()
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.clientId, before.clientId),
        eq(files.relativePath, before.relativePath),
        eq(files.originalFilename, name),
        inArray(files.status, NAME_TAKEN_STATUSES),
      ),
    )
    .limit(1);
  if (clash) throw new AppError(409, 'name_taken', 'A file with that name already exists in this folder.');
  const [after] = await getDb()
    .update(files)
    .set({ originalFilename: name, extension: getExtension(name), updatedAt: new Date() })
    .where(eq(files.id, id))
    .returning();
  return { before, after: after! };
}

/** Move files to another (sanitised) folder. Name collisions get a " (n)" suffix. Returns moved count. */
export async function moveFiles(ids: string[], rawPath: string): Promise<{ moved: number; relativePath: string }> {
  const relativePath = sanitizeRelativePath(rawPath);
  const unique = [...new Set(ids)];
  let moved = 0;
  await getDb().transaction(async (tx) => {
    const rows = await tx.select().from(files).where(and(inArray(files.id, unique), inArray(files.status, COUNTED_STATUSES)));
    for (const f of rows) {
      if (f.relativePath === relativePath) continue;
      const name = await uniqueName(tx, f.clientId, relativePath, f.originalFilename, [f.id]);
      await tx.update(files).set({ relativePath, originalFilename: name, extension: getExtension(name), updatedAt: new Date() }).where(eq(files.id, f.id));
      moved++;
    }
  });
  return { moved, relativePath };
}
