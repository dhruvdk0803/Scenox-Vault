import { FileStore } from '@tus/file-store';
import { EVENTS, Server, Upload, type ServerOptions } from '@tus/server';
import { UPLOAD_SESSION_HEADER, getExtension, type DuplicateAction } from '@scenox/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../config';
import { getDb } from '../db';
import { clients, files, portals, uploadSessions, type FileRow } from '../db/schema';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { enqueue } from '../queue';
import { KEYS, getStorage } from '../storage';
import { deleteFileRowsTx, removeStoredObjects, uniqueName } from './files';
import { getQuota, quotaMessage } from './quota';
import { getSettings } from './settings';
import { authenticateUploadToken, bumpCounters, checkFileRules, getUploadRules, type Tx, type UploadContext } from './uploads';
import { cleanName, cleanPath } from './uploads';

type TusRequest = Parameters<NonNullable<ServerOptions['onIncomingRequest']>>[0];

/** Error object understood by @tus/server: `{ status_code, body }`. The body is an ApiError JSON document. */
export function tusError(status: number, code: string, message: string) {
  return { status_code: status, body: JSON.stringify({ error: { code, message } }) };
}

const fromAppError = (e: AppError) => tusError(e.statusCode, e.code, e.message);

const authCache = new WeakMap<object, UploadContext>();

async function authenticate(req: TusRequest): Promise<UploadContext> {
  const cached = authCache.get(req);
  if (cached) return cached;
  try {
    const ctx = await authenticateUploadToken(req.headers.get(UPLOAD_SESSION_HEADER));
    authCache.set(req, ctx);
    return ctx;
  } catch (err) {
    if (err instanceof AppError) throw fromAppError(err);
    throw err;
  }
}

/**
 * New bytes arriving on a session that was already marked completed (e.g. "Retry failed" after the
 * client called /sessions/complete) put it back to active, so the next completion notifies again.
 */
async function reactivateSession(tx: Tx, sessionId: string) {
  await tx
    .update(uploadSessions)
    .set({ status: 'active', completedAt: null, notifiedAt: null, lastActivityAt: new Date() })
    .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.status, 'completed')));
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const DUP_ACTIONS: readonly string[] = ['replace', 'keep_both', 'skip'];
/** An 'uploading' row with no progress for this long is treated as abandoned. */
const STALE_UPLOAD_MS = 15 * 60_000;

function parseLastModified(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = /^\d{9,15}$/.test(v) ? new Date(Number(v)) : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) || t < 0 || t > Date.now() + 86_400_000 ? null : d;
}

/** Look up a finished upload of this session, for HEAD resume of an upload whose final response was lost. */
export async function findFinishedUpload(token: string | undefined, tusId: string): Promise<Pick<FileRow, 'size' | 'status'> | null> {
  const ctx = await authenticateUploadToken(token, { touch: false });
  const [f] = await getDb()
    .select({ size: files.size, status: files.status })
    .from(files)
    .where(and(eq(files.tusId, tusId), eq(files.portalId, ctx.portal.id)))
    .limit(1);
  return f && ['processing', 'ready', 'quarantined'].includes(f.status) ? f : null;
}

/**
 * FileStore that can still describe an upload for a few seconds after it was finished and moved
 * out of the tus directory. @tus/server calls getUpload() once more after onUploadFinish when the
 * whole file arrived inside the creation POST (creation-with-upload).
 */
class VaultFileStore extends FileStore {
  private finished = new Map<string, { size: number; at: number }>();

  markFinished(id: string, size: number) {
    const now = Date.now();
    for (const [k, v] of this.finished) if (now - v.at > 60_000) this.finished.delete(k);
    this.finished.set(id, { size, at: now });
  }

  override async getUpload(id: string) {
    try {
      return await super.getUpload(id);
    } catch (err) {
      const done = this.finished.get(id);
      if (!done) throw err;
      this.finished.delete(id);
      return new Upload({ id, size: done.size, offset: done.size });
    }
  }
}

export interface TusService {
  server: Server;
  store: VaultFileStore;
}

/** Build the tus server (one per Fastify app). Bytes are streamed to disk by FileStore — never buffered. */
export function createTusServer(): TusService {
  const cfg = config();
  const storage = getStorage();
  if (!storage.localPath) throw new Error('The tus upload engine requires a storage driver with local disk access.');
  const store = new VaultFileStore({ directory: storage.localPath(KEYS.tus), expirationPeriodInMilliseconds: 72 * 3600_000 });
  const lastProgress = new Map<string, number>();

  const server = new Server({
    path: cfg.upload.tusPath,
    datastore: store,
    relativeLocation: true,
    respectForwardedHeaders: true,
    allowedOrigins: cfg.allowedOrigins,
    allowedCredentials: true,
    allowedHeaders: [UPLOAD_SESSION_HEADER, 'x-portal-access', 'x-request-id'],
    postReceiveInterval: 3000,
    // size limits are enforced per portal in onUploadCreate (before any bytes are accepted)
    namingFunction: () => randomUUID().replace(/-/g, ''),

    async onIncomingRequest(req, id) {
      const ctx = await authenticate(req);
      // keep abandoned-upload expiry in sync with Settings → Retention
      const { retention } = await getSettings();
      store.expirationPeriodInMilliseconds = Math.max(1, retention.incompleteUploadHours) * 3600_000;
      if (req.method === 'POST' || req.method === 'OPTIONS') return;
      const [f] = await getDb()
        .select({ status: files.status })
        .from(files)
        // resume may happen from a newer session of the same portal (page reload); the file stays
        // attributed to the session that created it
        .where(and(eq(files.tusId, id), eq(files.portalId, ctx.portal.id)))
        .limit(1);
      if (!f) throw tusError(404, 'upload_not_found', 'This upload could not be found. Please start it again.');
      if (req.method !== 'HEAD' && f.status !== 'uploading') {
        throw tusError(409, 'upload_finished', 'This file has already been uploaded.');
      }
    },

    async onUploadCreate(req, upload) {
      const ctx = await authenticate(req);
      const { session, portal, client } = ctx;
      const meta = upload.metadata ?? {};

      if (upload.sizeIsDeferred || upload.size === undefined || !Number.isSafeInteger(upload.size) || upload.size < 0) {
        throw tusError(400, 'size_required', 'The file size must be provided when starting an upload.');
      }
      if (meta.sessionId && meta.sessionId !== session.id) {
        throw tusError(403, 'session_mismatch', 'This upload does not belong to your current session. Please refresh the page and try again.');
      }
      if (!meta.filename) throw tusError(400, 'filename_required', 'A file name is required.');

      // never trust names: strip directories, control chars, traversal; disk names are generated UUIDs
      const originalName = cleanName(meta.filename);
      const relativePath = cleanPath(meta.relativePath);
      const size = upload.size;
      const rules = await getUploadRules(portal);
      const violation = checkFileRules(rules, { name: originalName, relativePath, size });
      if (violation) throw tusError(violation.reason === 'too_large' ? 413 : 400, violation.reason, violation.message);

      const requested: DuplicateAction | undefined = DUP_ACTIONS.includes(meta.duplicateAction ?? '') ? (meta.duplicateAction as DuplicateAction) : undefined;
      const mimeType = meta.filetype && MIME_RE.test(meta.filetype) ? meta.filetype.toLowerCase() : null;
      const clientKey = meta.clientKey ? meta.clientKey.slice(0, 128) : null;
      const lastModified = parseLastModified(meta.lastModified);

      let fileName = originalName;
      let replaceFileId: string | null = null;
      const superseded: FileRow[] = [];
      const db = getDb();

      const row = await db.transaction(async (tx) => {
        // serialise quota decisions per client so parallel creates cannot over-commit
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'quota:' + client.id}, 0))`);
        const [p] = await tx.select().from(portals).where(eq(portals.id, portal.id)).limit(1);
        const [c] = await tx.select().from(clients).where(eq(clients.id, client.id)).limit(1);
        if (!p || !c) throw tusError(404, 'not_found', 'This upload link is no longer available.');

        const quota = await getQuota(p, c, { includeInflight: true, db: tx });
        if (quota.remainingBytes !== null && size > quota.remainingBytes) {
          throw tusError(413, 'quota_exceeded', quotaMessage(quota.remainingBytes));
        }

        // A re-created upload of a file that is still 'uploading' supersedes the earlier attempt
        // (instead of producing "name (1).ext" copies) when it is clearly the same file:
        //  - started by this session, or
        //  - started through this portal with the same size + lastModified (page reload / new session), or
        //  - abandoned (no bytes received for STALE_UPLOAD_MS).
        const staleBefore = Date.now() - STALE_UPLOAD_MS;
        const isRetryOf = (f: FileRow) =>
          f.status === 'uploading' &&
          (f.uploadSessionId === session.id ||
            (f.portalId === portal.id && Number(f.size) === size && !!lastModified && f.lastModified?.getTime() === lastModified.getTime()) ||
            f.updatedAt.getTime() < staleBefore);
        const existing = await tx
          .select()
          .from(files)
          .where(
            and(
              eq(files.clientId, client.id),
              eq(files.relativePath, relativePath),
              eq(files.originalFilename, originalName),
              inArray(files.status, ['uploading', 'processing', 'ready', 'quarantined']),
            ),
          );
        const live = existing.filter((f) => {
          if (isRetryOf(f)) {
            superseded.push(f);
            return false;
          }
          return true;
        });
        for (const s of superseded) await tx.update(files).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(files.id, s.id));

        if (live.length > 0) {
          const action = requested ?? 'keep_both';
          if (action === 'skip') throw tusError(409, 'duplicate_skipped', `"${originalName}" already exists and was skipped.`);
          const target = action === 'replace' ? live.find((f) => f.status === 'ready' || f.status === 'processing') : undefined;
          if (target) replaceFileId = target.id;
          else fileName = await uniqueName(tx, client.id, relativePath, originalName);
        }

        await reactivateSession(tx, session.id);
        const [inserted] = await tx
          .insert(files)
          .values({
            clientId: client.id,
            portalId: portal.id,
            uploadSessionId: session.id,
            tusId: upload.id,
            originalFilename: fileName,
            storedFilename: randomUUID(),
            relativePath,
            extension: getExtension(fileName),
            mimeType,
            size,
            clientKey,
            lastModified,
            status: 'uploading',
          })
          .returning();
        return inserted!;
      });
      for (const s of superseded) await removeStoredObjects([s]);

      // metadata persisted by tus (and echoed on HEAD): only sanitised values + server-side markers
      const metadata: Record<string, string | null> = {
        filename: fileName,
        relativePath,
        sessionId: session.id,
        fileId: row.id,
      };
      if (mimeType) metadata.filetype = mimeType;
      if (clientKey) metadata.clientKey = clientKey;
      if (requested) metadata.duplicateAction = requested;
      if (meta.lastModified && lastModified) metadata.lastModified = meta.lastModified.slice(0, 40);
      if (replaceFileId) metadata.replaceFileId = replaceFileId;
      return { metadata };
    },

    async onUploadFinish(req, upload) {
      const ctx = await authenticate(req);
      const db = getDb();
      const [f] = await db
        .select()
        .from(files)
        .where(and(eq(files.tusId, upload.id), eq(files.portalId, ctx.portal.id)))
        .limit(1);
      if (!f || f.status !== 'uploading') throw tusError(409, 'upload_finished', 'This file has already been uploaded.');

      // re-check on-disk size against what was declared (and validated) at creation
      const tusKey = `${KEYS.tus}/${upload.id}`;
      let onDisk = -1;
      try {
        onDisk = (await fs.stat(storage.localPath!(tusKey))).size;
      } catch {
        /* handled below */
      }
      if (onDisk !== Number(f.size) || (upload.size !== undefined && onDisk !== upload.size)) {
        logger.error({ fileId: f.id, onDisk, declared: Number(f.size) }, 'tus finish: size mismatch');
        await db.update(files).set({ status: 'failed', error: 'Size mismatch after upload', updatedAt: new Date() }).where(eq(files.id, f.id));
        await db.execute(sql`update upload_sessions set failed_files = failed_files + 1 where id = ${f.uploadSessionId}`);
        await storage.delete(tusKey).catch(() => {});
        await storage.delete(`${tusKey}.json`).catch(() => {});
        throw tusError(422, 'size_mismatch', 'The uploaded file was incomplete or corrupted. Please try uploading it again.');
      }

      await storage.move(tusKey, KEYS.stagingKey(f.storedFilename));
      await storage.delete(`${tusKey}.json`).catch(() => {});
      store.markFinished(upload.id, Number(f.size));

      const completedAt = new Date();
      const seconds = Math.max(0.001, (completedAt.getTime() - f.createdAt.getTime()) / 1000);
      const replaceId = upload.metadata?.replaceFileId ?? null;
      let replaced: FileRow[] = [];

      await db.transaction(async (tx) => {
        const [done] = await tx
          .update(files)
          .set({
            status: 'processing',
            bytesReceived: f.size,
            completedAt,
            avgSpeedBps: Math.round(Number(f.size) / seconds),
            updatedAt: completedAt,
          })
          .where(and(eq(files.id, f.id), eq(files.status, 'uploading')))
          .returning({ id: files.id });
        if (!done) throw tusError(409, 'upload_finished', 'This file has already been uploaded.');
        await bumpCounters(tx, f, 1, Number(f.size), true);
        await reactivateSession(tx, f.uploadSessionId);
        if (replaceId) {
          const [old] = await tx.select({ id: files.id, clientId: files.clientId }).from(files).where(eq(files.id, replaceId)).limit(1);
          if (old && old.clientId === f.clientId && old.id !== f.id) replaced = await deleteFileRowsTx(tx, [old.id]);
        }
      });
      await removeStoredObjects(replaced);

      try {
        await enqueue('process-file', { fileId: f.id }, { jobId: `process-file-${f.id}` });
      } catch (err) {
        // the cleanup job re-queues files stuck in "processing"
        logger.error({ err, fileId: f.id }, 'failed to enqueue process-file');
      }
      return {};
    },

    async onResponseError(_req, err) {
      if (typeof (err as { status_code?: unknown }).status_code === 'number') return undefined;
      logger.error({ err }, 'tus request failed');
      return tusError(500, 'internal_error', 'Something went wrong on our side. Please try again.');
    },
  });

  // live progress for admins (throttled by tus' postReceiveInterval and again per upload)
  server.on(EVENTS.POST_RECEIVE, (_req: unknown, upload: { id: string; offset: number }) => {
    const now = Date.now();
    if (now - (lastProgress.get(upload.id) ?? 0) < 2500) return;
    lastProgress.set(upload.id, now);
    if (lastProgress.size > 10_000) lastProgress.clear();
    const db = getDb();
    void db
      .update(files)
      .set({ bytesReceived: upload.offset, updatedAt: new Date() })
      .where(and(eq(files.tusId, upload.id), eq(files.status, 'uploading')))
      .then(() =>
        db.execute(sql`update upload_sessions s set last_activity_at = now() from files f where f.tus_id = ${upload.id} and s.id = f.upload_session_id`),
      )
      .catch((err) => logger.warn({ err }, 'failed to record upload progress'));
  });

  // termination: the client cancelled the upload
  server.on(EVENTS.POST_TERMINATE, (_req: unknown, _res: unknown, id: string) => {
    lastProgress.delete(id);
    void getDb()
      .update(files)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(files.tusId, id), eq(files.status, 'uploading')))
      .catch((err) => logger.warn({ err }, 'failed to mark upload cancelled'));
  });

  return { server, store };
}
