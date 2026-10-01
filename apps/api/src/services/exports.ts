import { withCopySuffix } from '@scenox/shared';
import { ZipArchive } from 'archiver';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { getDb } from '../db';
import { exportJobs, files, type ExportJob } from '../db/schema';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { enqueue } from '../queue';
import { KEYS, getStorage } from '../storage';
import { getSettings } from './settings';

export const MAX_EXPORT_FILES = 10_000;

export async function createExport(userId: string, fileIds: string[]): Promise<ExportJob> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) throw new AppError(400, 'no_files', 'Select at least one file to export.');
  if (ids.length > MAX_EXPORT_FILES) throw new AppError(400, 'too_many_files', `You can export up to ${MAX_EXPORT_FILES.toLocaleString('en-US')} files at once.`);
  const db = getDb();
  const ready: { id: string; size: number }[] = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await db
      .select({ id: files.id, size: files.size })
      .from(files)
      .where(and(inArray(files.id, ids.slice(i, i + 2000)), eq(files.status, 'ready')));
    ready.push(...rows.map((r) => ({ id: r.id, size: Number(r.size) })));
  }
  if (ready.length === 0) throw new AppError(400, 'no_ready_files', 'None of the selected files are ready to download yet.');
  const [job] = await db
    .insert(exportJobs)
    .values({ userId, fileIds: ready.map((r) => r.id), fileCount: ready.length, totalBytes: ready.reduce((s, r) => s + r.size, 0) })
    .returning();
  try {
    await enqueue('build-zip', { exportId: job!.id }, { jobId: `build-zip-${job!.id}`, attempts: 2 });
  } catch (err) {
    await db.update(exportJobs).set({ status: 'failed', error: 'The export service is unavailable. Please try again.' }).where(eq(exportJobs.id, job!.id));
    logger.error({ err, exportId: job!.id }, 'failed to enqueue build-zip');
    throw new AppError(503, 'queue_unavailable', 'The export service is temporarily unavailable. Please try again in a moment.');
  }
  return job!;
}

export async function listExportsForUser(userId: string, limit = 20): Promise<ExportJob[]> {
  return getDb().select().from(exportJobs).where(eq(exportJobs.userId, userId)).orderBy(desc(exportJobs.createdAt)).limit(limit);
}

export async function getExport(id: string): Promise<ExportJob | null> {
  const [row] = await getDb().select().from(exportJobs).where(eq(exportJobs.id, id)).limit(1);
  return row ?? null;
}

/**
 * Build the ZIP for an export job. Entries are stored (no recompression) and streamed one at a time
 * from disk straight into a temp file, which is renamed into place when complete. Zip64 is automatic.
 * Plain async function so tests can call it without a Redis worker.
 */
export async function buildExportZip(exportId: string): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const job = await getExport(exportId);
  if (!job || job.status === 'ready' || job.status === 'expired') return;

  await db.update(exportJobs).set({ status: 'processing', progress: 0, error: null }).where(eq(exportJobs.id, exportId));
  const partKey = `${KEYS.exportKey(exportId)}.part`;
  const finalKey = KEYS.exportKey(exportId);
  try {
    const rows: (typeof files.$inferSelect)[] = [];
    for (let i = 0; i < job.fileIds.length; i += 2000) {
      rows.push(...(await db.select().from(files).where(and(inArray(files.id, job.fileIds.slice(i, i + 2000)), eq(files.status, 'ready')))));
    }
    rows.sort((a, b) => (a.relativePath + '/' + a.originalFilename).localeCompare(b.relativePath + '/' + b.originalFilename));
    if (rows.length === 0) throw new Error('no ready files remain');
    const totalBytes = rows.reduce((s, r) => s + Number(r.size), 0) || 1;

    const partPath = storage.localPath!(partKey);
    await fs.mkdir(storage.localPath!(KEYS.exports), { recursive: true });
    const archive = new ZipArchive({ store: true, forceLocalTime: false });
    const outDone = pipeline(archive, createWriteStream(partPath, { mode: 0o640 }));
    outDone.catch(() => {}); // surfaced through Promise.race below

    let lastWrite = 0;
    let lastFraction = 0;
    archive.on('progress', (p) => {
      const fraction = Math.min(0.99, p.fs.processedBytes / totalBytes);
      const now = Date.now();
      if (now - lastWrite < 2000 || fraction - lastFraction < 0.005) return;
      lastWrite = now;
      lastFraction = fraction;
      void db.update(exportJobs).set({ progress: fraction }).where(eq(exportJobs.id, exportId)).catch(() => {});
    });
    archive.on('warning', (err) => logger.warn({ err, exportId }, 'zip warning'));

    const used = new Set<string>();
    let skipped = 0;
    for (const f of rows) {
      const key = f.storageKey;
      if (!key) {
        skipped++;
        continue;
      }
      let stream;
      try {
        ({ stream } = await storage.get(key));
      } catch (err) {
        logger.warn({ err, exportId, fileId: f.id }, 'export: file missing on disk');
        skipped++;
        continue;
      }
      let name = f.relativePath ? `${f.relativePath}/${f.originalFilename}` : f.originalFilename;
      for (let n = 1; used.has(name.toLowerCase()); n++) {
        name = withCopySuffix(f.relativePath ? `${f.relativePath}/${f.originalFilename}` : f.originalFilename, n);
      }
      used.add(name.toLowerCase());
      await Promise.race([
        outDone,
        new Promise<void>((resolve, reject) => {
          const onEntry = () => {
            archive.off('error', onErr);
            resolve();
          };
          const onErr = (e: Error) => {
            archive.off('entry', onEntry);
            reject(e);
          };
          archive.once('entry', onEntry);
          archive.once('error', onErr);
          stream.once('error', onErr);
          archive.append(stream, { name, date: f.lastModified ?? f.completedAt ?? f.createdAt, store: true });
        }),
      ]);
    }
    if (skipped === rows.length) throw new Error('no files could be read');
    await archive.finalize();
    await outDone;

    await storage.move(partKey, finalKey);
    const meta = await storage.getMetadata(finalKey);
    const { retention } = await getSettings();
    await db
      .update(exportJobs)
      .set({
        status: 'ready',
        progress: 1,
        outputKey: finalKey,
        outputSize: meta?.size ?? null,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + retention.exportHours * 3600_000),
        error: skipped > 0 ? `${skipped} file${skipped === 1 ? ' was' : 's were'} unavailable and left out of the ZIP.` : null,
      })
      .where(eq(exportJobs.id, exportId));
  } catch (err) {
    logger.error({ err, exportId }, 'build-zip failed');
    await storage.delete(partKey).catch(() => {});
    await db
      .update(exportJobs)
      .set({ status: 'failed', error: 'The ZIP could not be created. Please try again.', completedAt: new Date() })
      .where(eq(exportJobs.id, exportId));
  }
}

