import { FileStore } from '@tus/file-store';
import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { activityLogs, exportJobs, files, portalAccessTokens, uploadSessions } from '../db/schema';
import { logActivity } from '../lib/activity';
import { logger } from '../lib/logger';
import { enqueue, getQueue, QUEUES } from '../queue';
import { purgeExpiredSessions } from '../services/auth';
import { removeStoredObjects } from '../services/files';
import { getSettings } from '../services/settings';
import { KEYS, getStorage } from '../storage';

export const STALE_SESSION_MS = 6 * 3600_000;
const STUCK_PROCESSING_MS = 15 * 60_000;

/** Queue process-file again for a file whose earlier job finished/failed without completing it. */
export async function requeueProcessFile(fileId: string): Promise<boolean> {
  const jobId = `process-file-${fileId}`;
  const existing = await getQueue(QUEUES.fileProcessing).getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'].includes(state)) return false;
    await existing.remove().catch(() => {});
  }
  await enqueue('process-file', { fileId }, { jobId });
  return true;
}

export interface CleanupSummary {
  tusExpired: number;
  uploadsFailed: number;
  sessionsCompleted: number;
  sessionsAbandoned: number;
  accessTokensPurged: number;
  exportsExpired: number;
  activityPurged: number;
  processingRequeued: number;
}

/** Periodic housekeeping. Every step is independent: one failing step never blocks the others. */
export async function runCleanup(now = new Date()): Promise<CleanupSummary> {
  const db = getDb();
  const storage = getStorage();
  const settings = await getSettings();
  const summary: CleanupSummary = {
    tusExpired: 0,
    uploadsFailed: 0,
    sessionsCompleted: 0,
    sessionsAbandoned: 0,
    accessTokensPurged: 0,
    exportsExpired: 0,
    activityPurged: 0,
    processingRequeued: 0,
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, step: name }, 'cleanup step failed');
    }
  };
  const hours = Math.max(1, settings.retention.incompleteUploadHours);

  // 1. abandoned tus uploads (by creation time, per the tus expiration extension)
  await step('tus-expired', async () => {
    const store = new FileStore({ directory: storage.localPath!(KEYS.tus), expirationPeriodInMilliseconds: hours * 3600_000 });
    summary.tusExpired = await store.deleteExpired();
  });

  // 2. files stuck in "uploading" without recent progress
  await step('stale-uploads', async () => {
    const cutoff = new Date(now.getTime() - hours * 3600_000);
    const stale = await db.transaction(async (tx) => {
      const rows = await tx
        .update(files)
        .set({ status: 'failed', error: 'Upload was not completed in time.', updatedAt: now })
        .where(and(eq(files.status, 'uploading'), lt(files.updatedAt, cutoff)))
        .returning();
      for (const r of rows) await tx.execute(sql`update upload_sessions set failed_files = failed_files + 1 where id = ${r.uploadSessionId}`);
      return rows;
    });
    await removeStoredObjects(stale);
    summary.uploadsFailed = stale.length;
  });

  // 3. sessions whose client went away (closed the tab)
  await step('stale-sessions', async () => {
    const stale = await db
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.status, 'active'), lt(uploadSessions.lastActivityAt, new Date(now.getTime() - STALE_SESSION_MS))));
    for (const s of stale) {
      if (s.uploadedFiles > 0) {
        const seconds = Math.max(1, (s.lastActivityAt.getTime() - s.startedAt.getTime()) / 1000);
        const [done] = await db
          .update(uploadSessions)
          .set({ status: 'completed', completedAt: s.lastActivityAt, avgSpeedBps: Math.round(Number(s.uploadedBytes) / seconds) })
          .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.status, 'active')))
          .returning({ id: uploadSessions.id });
        if (!done) continue;
        summary.sessionsCompleted++;
        await logActivity({
          actorType: 'system',
          action: 'upload.completed',
          resourceType: 'upload_session',
          resourceId: s.id,
          clientId: s.clientId,
          portalId: s.portalId,
          metadata: { files: s.uploadedFiles, bytes: Number(s.uploadedBytes), autoCompleted: true },
        });
        if (!s.notifiedAt) {
          await enqueue('session-complete', { sessionId: s.id }, { jobId: `session-complete-${s.id}-${s.lastActivityAt.getTime()}` }).catch((err) =>
            logger.error({ err, sessionId: s.id }, 'failed to enqueue session-complete'),
          );
        }
      } else {
        const r = await db
          .update(uploadSessions)
          .set({ status: 'abandoned' })
          .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.status, 'active')))
          .returning({ id: uploadSessions.id });
        summary.sessionsAbandoned += r.length;
      }
    }
  });

  // 4. expired credentials
  await step('expired-tokens', async () => {
    const r = await db.delete(portalAccessTokens).where(lt(portalAccessTokens.expiresAt, now)).returning({ id: portalAccessTokens.id });
    summary.accessTokensPurged = r.length;
    await purgeExpiredSessions();
  });

  // 5. expired exports
  await step('expired-exports', async () => {
    const expired = await db
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.status, 'ready'), lt(exportJobs.expiresAt, now)));
    for (const e of expired) {
      if (e.outputKey) await storage.delete(e.outputKey).catch((err) => logger.error({ err, exportId: e.id }, 'failed to delete export'));
      await db.update(exportJobs).set({ status: 'expired', outputKey: null }).where(eq(exportJobs.id, e.id));
    }
    summary.exportsExpired = expired.length;
  });

  // 6. activity log retention
  await step('activity-retention', async () => {
    const days = settings.retention.activityLogDays;
    if (days > 0) {
      const r = await db
        .delete(activityLogs)
        .where(lt(activityLogs.createdAt, new Date(now.getTime() - days * 86_400_000)))
        .returning({ id: activityLogs.id });
      summary.activityPurged = r.length;
    }
  });

  // 7. files whose process-file job was lost
  await step('stuck-processing', async () => {
    const stuck = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.status, 'processing'), lt(files.completedAt, new Date(now.getTime() - STUCK_PROCESSING_MS))))
      .limit(500);
    for (const f of stuck) if (await requeueProcessFile(f.id)) summary.processingRequeued++;
  });

  logger.info({ ...summary }, 'cleanup finished');
  return summary;
}
