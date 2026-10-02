import {
  UPLOAD_SESSION_HEADER,
  sanitizeFilename,
  sanitizeRelativePath,
  type CompleteSessionRequest,
  type PreflightResponse,
  type PreflightResult,
  type PublicFileDTO,
  type StartSessionRequest,
} from '@scenox/shared';
import { and, eq, inArray, asc, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../db';
import { files, uploadSessions } from '../db/schema';
import { clientActivity } from '../lib/activity';
import { AppError, forbidden, notFound, validationError } from '../lib/errors';
import { parse } from '../lib/validate';
import { enqueue } from '../queue';
import { browseClientFiles, buildClientDashboard, clientBrowseQuerySchema, listClientUploads, loadUsablePortal } from '../services/client-portal';
import { currentStorageKey, deleteFiles } from '../services/files';
import { INLINE_SAFE, streamStoredFile } from './files';
import {
  createClientMessage,
  getMessageDTO,
  listThread,
  markStaffMessagesRead,
  messageListQuerySchema,
  notifyTeamOfClientMessage,
  postClientMessageSchema,
} from '../services/messages';
import {
  buildPublicPortalDTO,
  openStoredImage,
  startSession,
  startSessionSchema,
  unlockPortal,
  unlockSchema,
  validateIntake,
} from '../services/public-portal';
import { getQuota, quotaMessage } from '../services/quota';
import { getBranding, getSettings } from '../services/settings';
import { assertPortalUsable, authenticateUploadToken, checkFileRules, getUploadRules, hasPortalAccess, loadPortalByToken, requireUploadSession } from '../services/uploads';

const MAX_PREFLIGHT_FILES = 5000;

const preflightSchema = z.object({
  files: z
    .array(
      z.object({
        clientKey: z.string().max(256),
        name: z.string().max(2048),
        relativePath: z.string().max(8192).optional().default(''),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        type: z.string().max(255).optional(),
      }),
    )
    .max(MAX_PREFLIGHT_FILES, `Please send at most ${MAX_PREFLIGHT_FILES} files per request.`),
});

const completeSchema = z
  .object({
    filesUploaded: z.number().int().min(0).max(10_000_000).optional(),
    bytesUploaded: z.number().int().min(0).optional(),
    filesFailed: z.number().int().min(0).max(10_000_000).optional(),
  })
  .partial();

const tokenParam = z.object({ token: z.string().max(200) });

export default async function publicRoutes(app: FastifyInstance) {
  const limit = (max: number) => (config().rateLimitEnabled ? { config: { rateLimit: { max, timeWindow: '1 minute' } } } : {});

  const sendImage = async (reply: FastifyReply, key: string | null | undefined) => {
    const img = await openStoredImage(key);
    if (!img) throw notFound('Image not found.');
    return reply
      .header('content-type', img.contentType)
      .header('content-length', img.size)
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(img.stream);
  };

  // ───────────── branding ─────────────
  app.get('/branding', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return getBranding();
  });
  app.get('/branding/logo', async (_req, reply) => sendImage(reply, (await getSettings()).branding.logoKey));
  app.get('/branding/favicon', async (_req, reply) => sendImage(reply, (await getSettings()).branding.faviconKey));

  // ───────────── portal ─────────────
  app.get('/portals/:token', limit(120), async (req) => {
    const { token } = parse(tokenParam, req.params);
    const { portal, client } = await loadPortalByToken(token);
    return buildPublicPortalDTO(req, token, portal, client);
  });

  app.get('/portals/:token/logo', limit(120), async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const { portal } = await loadPortalByToken(token);
    return sendImage(reply, portal.logoKey);
  });

  app.post('/portals/:token/unlock', limit(5), async (req) => {
    const { token } = parse(tokenParam, req.params);
    const body = parse(unlockSchema, req.body ?? {});
    const { portal, client } = await loadPortalByToken(token);
    return unlockPortal(req, portal, client, body.password);
  });

  // ───────────── upload sessions ─────────────
  app.post('/portals/:token/sessions', limit(30), async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const body: StartSessionRequest = parse(startSessionSchema, req.body ?? {});
    const { portal, client } = await loadPortalByToken(token);
    assertPortalUsable(portal, client);
    if (!(await hasPortalAccess(portal, req))) {
      throw new AppError(401, 'password_required', 'This upload link is password protected. Please enter the password to continue.');
    }
    const missing = validateIntake(portal, body);
    if (Object.keys(missing).length) throw validationError({ fields: missing }, 'Please fill in the required details.');
    const quota = await getQuota(portal, client);
    if (quota.remainingBytes === 0) throw new AppError(413, 'quota_exceeded', quotaMessage(0));
    const res = await startSession(req, portal, client, body);
    return reply.code(201).send(res);
  });

  app.get('/portals/:token/sessions/current', async (req) => {
    const { token } = parse(tokenParam, req.params);
    const { portal } = await loadPortalByToken(token);
    const { session } = await requireUploadSession(req, portal, { statuses: ['active', 'completed'], skipPortalState: true, touch: false });
    return { sessionId: session.id, status: session.status, expiresAt: session.expiresAt.toISOString() };
  });

  app.post('/portals/:token/preflight', limit(60), async (req) => {
    const { token } = parse(tokenParam, req.params);
    const body = parse(preflightSchema, req.body ?? {});
    const { portal } = await loadPortalByToken(token);
    const { client, portal: freshPortal } = await requireUploadSession(req, portal);
    const rules = await getUploadRules(freshPortal);
    const quota = await getQuota(freshPortal, client, { includeInflight: true });
    let remaining = quota.remainingBytes;

    const clean = body.files.map((f) => ({
      ...f,
      cleanName: sanitizeFilename(f.name),
      cleanPath: sanitizeRelativePath(f.relativePath),
    }));

    // duplicates: same client + folder + name + size already stored
    const names = [...new Set(clean.map((f) => f.cleanName))];
    const dupIndex = new Map<string, { fileId: string; size: number; uploadedAt: string }>();
    for (let i = 0; i < names.length; i += 2000) {
      const rows = await getDb()
        .select({ id: files.id, name: files.originalFilename, path: files.relativePath, size: files.size, at: files.completedAt, created: files.createdAt })
        .from(files)
        .where(and(eq(files.clientId, client.id), inArray(files.originalFilename, names.slice(i, i + 2000)), inArray(files.status, ['ready', 'processing'])))
        .orderBy(asc(files.createdAt));
      for (const r of rows) dupIndex.set(`${r.path}\u0000${r.name}\u0000${Number(r.size)}`, { fileId: r.id, size: Number(r.size), uploadedAt: (r.at ?? r.created).toISOString() });
    }

    let requestedBytes = 0;
    const results: PreflightResult[] = clean.map((f) => {
      const violation = checkFileRules(rules, { name: f.cleanName, relativePath: f.cleanPath, size: f.size });
      if (violation) return { clientKey: f.clientKey, ok: false, reason: violation.reason, message: violation.message };
      if (remaining !== null && f.size > remaining) {
        return { clientKey: f.clientKey, ok: false, reason: 'quota_exceeded', message: quotaMessage(remaining) };
      }
      if (remaining !== null) remaining -= f.size;
      requestedBytes += f.size;
      return { clientKey: f.clientKey, ok: true, duplicate: dupIndex.get(`${f.cleanPath}\u0000${f.cleanName}\u0000${f.size}`) ?? null };
    });

    const res: PreflightResponse = { results, quota: { usedBytes: quota.usedBytes, limitBytes: quota.limitBytes, requestedBytes } };
    return res;
  });

  app.post('/portals/:token/sessions/complete', async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const body: CompleteSessionRequest = parse(completeSchema, req.body ?? {}) as CompleteSessionRequest;
    const { portal } = await loadPortalByToken(token);
    const { session } = await requireUploadSession(req, portal, { skipPortalState: true });
    if (session.status === 'completed') return reply.code(204).send(); // idempotent

    const completedAt = new Date();
    const db = getDb();
    const [updated] = await db
      .update(uploadSessions)
      .set({
        status: 'completed',
        completedAt,
        lastActivityAt: completedAt,
        failedFiles: sql`greatest(${uploadSessions.failedFiles}, ${Math.min(body.filesFailed ?? 0, 1_000_000)})`,
        avgSpeedBps: sql`case when ${uploadSessions.uploadedBytes} > 0 then (${uploadSessions.uploadedBytes} / greatest(extract(epoch from (${completedAt.toISOString()}::timestamptz - ${uploadSessions.startedAt})), 1))::bigint else null end`,
      })
      .where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.status, 'active')))
      .returning();
    if (!updated) return reply.code(204).send();

    if (updated.uploadedFiles > 0) {
      await clientActivity(req, {
        action: 'upload.completed',
        resourceType: 'upload_session',
        resourceId: session.id,
        clientId: session.clientId,
        portalId: session.portalId,
        actorLabel: session.uploaderName ?? undefined,
        metadata: { files: updated.uploadedFiles, bytes: Number(updated.uploadedBytes), failed: updated.failedFiles, portalName: portal.name },
      });
    }
    try {
      await enqueue('session-complete', { sessionId: session.id }, { jobId: `session-complete-${session.id}-${completedAt.getTime()}` });
    } catch (err) {
      req.log.error({ err, sessionId: session.id }, 'failed to enqueue session-complete');
    }
    return reply.code(204).send();
  });

  // ───────────── files (client-visible, this session only) ─────────────
  app.get('/portals/:token/files', async (req) => {
    const { token } = parse(tokenParam, req.params);
    const { portal } = await loadPortalByToken(token);
    const { session, portal: p } = await requireUploadSession(req, portal, { statuses: ['active', 'completed'], touch: false });
    if (!p.allowClientViewFiles) throw forbidden('Viewing uploaded files is not enabled for this upload link.');
    const rows = await getDb()
      .select()
      .from(files)
      .where(and(eq(files.uploadSessionId, session.id), inArray(files.status, ['uploading', 'processing', 'ready', 'quarantined'])))
      .orderBy(asc(files.createdAt))
      .limit(1000);
    const items: PublicFileDTO[] = rows.map((f) => ({
      id: f.id,
      name: f.originalFilename,
      relativePath: f.relativePath,
      size: Number(f.size),
      status: f.status,
      uploadedAt: f.completedAt?.toISOString() ?? null,
    }));
    return items;
  });

  app.delete('/portals/:token/files/:fileId', async (req, reply) => {
    const params = parse(z.object({ token: z.string().max(200), fileId: z.string().max(64) }), req.params);
    const { portal: p, client } = await loadUsablePortal(req, params.token);
    if (!p.allowClientDeleteFiles) throw forbidden('Deleting files is not enabled for this upload link.');
    if (!z.uuid().safeParse(params.fileId).success) throw notFound('File not found.');

    // The upload-session header is optional now; when it is valid it still names the actor and keeps
    // the previous behaviour of being able to remove any file of the visitor's own session.
    const header = req.headers[UPLOAD_SESSION_HEADER];
    const session = typeof header === 'string' ? await authenticateUploadToken(header, { portalId: p.id, touch: false, skipPortalState: true }).catch(() => null) : null;

    const [f] = await getDb()
      .select()
      .from(files)
      .where(
        and(
          eq(files.id, params.fileId),
          eq(files.portalId, p.id),
          session ? or(inArray(files.status, ['ready', 'processing']), eq(files.uploadSessionId, session.session.id)) : inArray(files.status, ['ready', 'processing']),
        ),
      )
      .limit(1);
    if (!f) throw notFound('File not found.');
    const deleted = await deleteFiles([f.id]);
    if (deleted.length) {
      await clientActivity(req, {
        action: 'file.deleted_by_client',
        resourceType: 'file',
        resourceId: f.id,
        clientId: client.id,
        portalId: p.id,
        actorLabel: session?.session.uploaderName ?? client.name,
        metadata: { filename: f.originalFilename, size: Number(f.size) },
      });
    }
    return reply.code(204).send();
  });

  // Bulk delete (client dashboard selection / folder delete)
  app.post('/portals/:token/files/delete', limit(60), async (req) => {
    const params = parse(z.object({ token: z.string().max(200) }), req.params);
    const body = parse(z.object({ fileIds: z.array(z.uuid()).min(1).max(1000) }), req.body);
    const { portal: p, client } = await loadUsablePortal(req, params.token);
    if (!p.allowClientDeleteFiles) throw forbidden('Deleting files is not enabled for this upload link.');
    const rows = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.portalId, p.id), inArray(files.id, [...new Set(body.fileIds)]), inArray(files.status, ['ready', 'processing'])));
    const deleted = await deleteFiles(rows.map((r) => r.id));
    if (deleted.length) {
      await clientActivity(req, {
        action: 'file.deleted_by_client',
        resourceType: 'portal',
        resourceId: p.id,
        clientId: client.id,
        portalId: p.id,
        actorLabel: client.name,
        metadata: { count: deleted.length, bytes: deleted.reduce((n, f) => n + Number(f.size), 0) },
      });
    }
    return { deleted: deleted.length };
  });

  // Inline preview for the client dashboard (images, video, audio, PDF, text). Range requests supported.
  app.get('/portals/:token/files/:fileId/preview', async (req, reply) => {
    const params = parse(z.object({ token: z.string().max(200), fileId: z.string().max(64) }), req.params);
    const { access } = parse(z.object({ access: z.string().max(128).optional() }), req.query);
    const { portal: p } = await loadUsablePortal(req, params.token, access);
    if (!p.allowClientViewFiles) throw new AppError(403, 'files_hidden', 'Viewing files is not enabled for this upload link.');
    if (!z.uuid().safeParse(params.fileId).success) throw notFound('File not found.');
    const [f] = await getDb().select().from(files).where(and(eq(files.id, params.fileId), eq(files.portalId, p.id))).limit(1);
    if (!f) throw notFound('File not found.');
    if (f.status !== 'ready') throw new AppError(409, 'file_not_ready', 'This file isn’t ready to preview yet.');
    const mime = (f.detectedMime ?? f.mimeType ?? '').toLowerCase();
    if (!INLINE_SAFE(mime)) throw new AppError(415, 'preview_unavailable', 'Preview isn’t available for this file type.');
    const key = currentStorageKey(f);
    if (!key) throw notFound('File not found.');
    return streamStoredFile(req, reply, f, key, true, { audit: false });
  });

  // ───────────── client dashboard (no upload session needed) ─────────────
  app.get('/portals/:token/dashboard', limit(120), async (req) => {
    const { token } = parse(tokenParam, req.params);
    const { portal, client } = await loadUsablePortal(req, token);
    return buildClientDashboard(portal, client);
  });

  app.get('/portals/:token/browse', limit(240), async (req) => {
    const { token } = parse(tokenParam, req.params);
    const query = parse(clientBrowseQuerySchema, req.query);
    const { portal } = await loadUsablePortal(req, token);
    if (!portal.allowClientViewFiles) throw new AppError(403, 'files_hidden', 'Viewing uploaded files is not enabled for this upload link.');
    return browseClientFiles(portal, query);
  });

  app.get('/portals/:token/uploads', limit(120), async (req) => {
    const { token } = parse(tokenParam, req.params);
    const { portal } = await loadUsablePortal(req, token);
    if (!portal.allowClientViewFiles) throw new AppError(403, 'files_hidden', 'Viewing uploaded files is not enabled for this upload link.');
    return listClientUploads(portal);
  });

  // ───────────── messages ─────────────
  const requireMessages = (portal: { allowClientMessages: boolean }) => {
    if (!portal.allowClientMessages) throw new AppError(403, 'messages_disabled', 'Messaging is not enabled for this upload link.');
  };

  app.get('/portals/:token/messages', limit(240), async (req) => {
    const { token } = parse(tokenParam, req.params);
    const query = parse(messageListQuerySchema, req.query);
    const { portal } = await loadUsablePortal(req, token);
    requireMessages(portal);
    const res = await listThread(portal.id, query, true);
    await markStaffMessagesRead(portal.id, query.fileId); // the visitor has now seen the staff replies of this thread
    return res;
  });

  app.post('/portals/:token/messages', limit(20), async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const body = parse(postClientMessageSchema, req.body ?? {});
    const { portal, client } = await loadUsablePortal(req, token);
    requireMessages(portal);
    const created = await createClientMessage(portal, body);
    await clientActivity(req, {
      action: 'message.posted',
      resourceType: 'message',
      resourceId: created.id,
      clientId: client.id,
      portalId: portal.id,
      actorLabel: created.authorName,
      metadata: { ...(body.fileId ? { fileId: body.fileId } : {}), length: body.body.length },
    });
    await notifyTeamOfClientMessage(portal, client, { authorName: created.authorName, body: body.body, fileName: created.fileName });
    return reply.code(201).send(await getMessageDTO(created.id, true));
  });
}
