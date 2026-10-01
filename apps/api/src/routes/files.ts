import { type BulkFilesRequest, hasPermission } from '@scenox/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/activity';
import { AppError, forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import type { FileRow } from '../db/schema';
import { getStorage } from '../storage';
import { browseFiles, browseQuerySchema, fileListQuerySchema, currentStorageKey, deleteFiles, getFileDTO, getFileRow, listFiles, moveFiles, renameFile } from '../services/files';
import { createExport, getExport, listExportsForUser, MAX_EXPORT_FILES } from '../services/exports';
import { toExportDTO } from '../services/mappers';

const idParam = z.object({ id: z.uuid() });
const idsBody = (max: number) => z.object({ fileIds: z.array(z.uuid()).min(1, 'Select at least one file.').max(max, `Please select at most ${max} files at a time.`) });

/** Inline preview is only allowed for types that cannot run script in the app's origin. */
const INLINE_SAFE = (mime: string) =>
  (/^image\/(?!svg)/.test(mime) && !/^image\/svg/.test(mime)) || mime === 'application/pdf' || /^video\//.test(mime) || /^audio\//.test(mime) || mime === 'text/plain';

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // unsupported (multi-range etc.): serve the whole file
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (!(n > 0)) return 'invalid';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Content-Disposition with an ASCII fallback plus RFC 5987 filename*. */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export default async function filesRoutes(app: FastifyInstance) {
  const perm = (p: Parameters<FastifyInstance['requirePermission']>[0]) => ({ preHandler: app.requirePermission(p) });

  // ───────────── list / browse / get ─────────────
  app.get('/files', perm('files.view'), async (req) => listFiles(parse(fileListQuerySchema, req.query)));
  app.get('/files/browse', perm('files.view'), async (req) => browseFiles(parse(browseQuerySchema, req.query)));

  app.post('/files/move', perm('files.manage'), async (req, reply) => {
    const body = parse(idsBody(5000).extend({ relativePath: z.string().max(4096).default('') }), req.body ?? {});
    const { moved, relativePath } = await moveFiles(body.fileIds, body.relativePath);
    await audit(req, { action: 'file.moved', resourceType: 'file', metadata: { count: moved, to: relativePath } });
    return reply.code(204).send();
  });

  app.post('/files/delete', perm('files.delete'), async (req, reply) => {
    const body: BulkFilesRequest = parse(idsBody(MAX_EXPORT_FILES), req.body ?? {});
    const deleted = await deleteFiles(body.fileIds);
    const clientIds = new Set(deleted.map((f) => f.clientId));
    await audit(req, {
      action: 'file.deleted',
      resourceType: 'file',
      clientId: clientIds.size === 1 ? [...clientIds][0] : null,
      metadata: { count: deleted.length, name: deleted.length === 1 ? deleted[0]!.originalFilename : undefined },
    });
    return reply.code(204).send();
  });

  app.get('/files/:id', perm('files.view'), async (req) => getFileDTO(parse(idParam, req.params).id));

  app.patch('/files/:id', perm('files.manage'), async (req) => {
    const { id } = parse(idParam, req.params);
    const { name } = parse(z.object({ name: z.string().trim().min(1, 'Please enter a file name.').max(1024) }), req.body ?? {});
    const { before, after } = await renameFile(id, name);
    if (before.originalFilename !== after.originalFilename) {
      await audit(req, {
        action: 'file.renamed',
        resourceType: 'file',
        resourceId: id,
        clientId: after.clientId,
        portalId: after.portalId,
        metadata: { from: before.originalFilename, to: after.originalFilename },
      });
    }
    return getFileDTO(id);
  });

  app.delete('/files/:id', perm('files.delete'), async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [f] = await deleteFiles([id]);
    if (!f) throw notFound('File not found.');
    await audit(req, {
      action: 'file.deleted',
      resourceType: 'file',
      resourceId: id,
      clientId: f.clientId,
      portalId: f.portalId,
      metadata: { name: f.originalFilename, size: Number(f.size) },
    });
    return reply.code(204).send();
  });

  // ───────────── download ─────────────
  app.get('/files/:id/download', perm('files.download'), async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { inline } = parse(z.object({ inline: z.string().optional() }), req.query);
    const f = await getFileRow(id);
    if (f.status === 'quarantined') throw forbidden('This file is quarantined because it may contain a virus, so it can’t be downloaded.');
    if (f.status !== 'ready') throw new AppError(409, 'file_not_ready', 'This file isn’t ready to download yet. Please try again in a moment.');
    const key = currentStorageKey(f);
    if (!key) throw notFound('File not found.');
    return streamStoredFile(req, reply, f, key, inline === '1' || inline === 'true');
  });

  // ───────────── exports ─────────────
  app.post('/exports', perm('files.download'), async (req, reply) => {
    const body: BulkFilesRequest = parse(idsBody(MAX_EXPORT_FILES), req.body ?? {});
    const job = await createExport(req.user!.id, body.fileIds);
    await audit(req, { action: 'export.created', resourceType: 'export', resourceId: job.id, metadata: { count: job.fileCount, bytes: Number(job.totalBytes) } });
    return reply.code(201).send(toExportDTO(job));
  });

  app.get('/exports', perm('files.download'), async (req) => (await listExportsForUser(req.user!.id, 20)).map(toExportDTO));

  const ownExport = async (req: FastifyRequest) => {
    const { id } = parse(idParam, req.params);
    const job = await getExport(id);
    // 404 (not 403) so export ids of other users are not discoverable
    if (!job || (job.userId !== req.user!.id && !hasPermission(req.user!.role, 'settings.manage'))) throw notFound('Export not found.');
    return job;
  };

  app.get('/exports/:id', perm('files.download'), async (req) => toExportDTO(await ownExport(req)));

  app.get('/exports/:id/download', perm('files.download'), async (req, reply) => {
    const job = await ownExport(req);
    if (job.status === 'expired' || (job.expiresAt && job.expiresAt.getTime() < Date.now())) {
      throw new AppError(410, 'export_expired', 'This export has expired. Please create a new one.');
    }
    if (job.status !== 'ready' || !job.outputKey) throw new AppError(409, 'export_not_ready', 'This export isn’t ready yet.');
    let res;
    try {
      res = await getStorage().get(job.outputKey);
    } catch {
      throw new AppError(410, 'export_expired', 'This export is no longer available. Please create a new one.');
    }
    await audit(req, { action: 'export.downloaded', resourceType: 'export', resourceId: job.id, metadata: { count: job.fileCount } });
    const stamp = job.createdAt.toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', res.size)
      .header('content-disposition', contentDisposition('attachment', `scenox-export-${stamp}.zip`))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(res.stream);
  });
}

async function streamStoredFile(req: FastifyRequest, reply: FastifyReply, f: FileRow, key: string, wantInline: boolean) {
  const storage = getStorage();
  const meta = await storage.getMetadata(key);
  if (!meta) throw new AppError(410, 'file_missing', 'This file is no longer available on the server.');
  const size = meta.size;
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    return reply.code(416).header('content-range', `bytes */${size}`).header('accept-ranges', 'bytes').send({ error: { code: 'range_not_satisfiable', message: 'The requested range is not valid for this file.' } });
  }

  const sniffed = f.detectedMime ?? f.mimeType ?? '';
  const inline = wantInline && INLINE_SAFE(sniffed.toLowerCase());
  const { stream } = await storage.get(key, range ?? undefined);

  reply
    .header('content-type', inline ? sniffed.toLowerCase() : 'application/octet-stream')
    .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', f.originalFilename))
    .header('accept-ranges', 'bytes')
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store');
  if (inline) {
    reply.header('content-security-policy', sniffed === 'application/pdf' ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; media-src 'self'; img-src 'self'; frame-ancestors 'self'; sandbox");
  }
  if (range) {
    reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1);
  } else {
    reply.header('content-length', size);
  }

  if (!range || range.start === 0) {
    await audit(req, {
      action: 'file.downloaded',
      resourceType: 'file',
      resourceId: f.id,
      clientId: f.clientId,
      portalId: f.portalId,
      metadata: { filename: f.originalFilename, size: Number(f.size), inline },
    });
  }
  return reply.send(stream);
}

