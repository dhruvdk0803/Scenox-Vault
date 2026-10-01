import { formatBytes } from '@scenox/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { clients, files, portals, uploadSessions } from '../db/schema';
import { logger } from '../lib/logger';
import { appLink, createEmailNotification, createInAppNotification, adminEmails } from '../services/notifications';
import { getBranding, getSettings } from '../services/settings';

/** How long to keep waiting for a session's files to finish processing before notifying anyway. */
export const SESSION_COMPLETE_MAX_WAIT_MS = 30 * 60_000;
export const SESSION_COMPLETE_RETRY_MS = 30_000;

export type SessionCompleteResult = 'done' | 'wait' | 'skipped';

/**
 * Notify about a finished upload session. Returns "wait" while files of the session are still being
 * processed (the worker re-schedules itself); idempotent via upload_sessions.notified_at.
 */
export async function processSessionComplete(sessionId: string, now = new Date()): Promise<SessionCompleteResult> {
  const db = getDb();
  const [row] = await db
    .select({ session: uploadSessions, portal: portals, client: clients })
    .from(uploadSessions)
    .innerJoin(portals, eq(portals.id, uploadSessions.portalId))
    .innerJoin(clients, eq(clients.id, uploadSessions.clientId))
    .where(eq(uploadSessions.id, sessionId))
    .limit(1);
  if (!row || row.session.notifiedAt) return 'skipped';
  const { session, portal, client } = row;

  const [counts] = await db
    .select({
      processing: sql<number>`count(*) filter (where ${files.status} = 'processing')::int`,
      ready: sql<number>`count(*) filter (where ${files.status} in ('ready','quarantined'))::int`,
      quarantined: sql<number>`count(*) filter (where ${files.status} = 'quarantined')::int`,
      failed: sql<number>`count(*) filter (where ${files.status} = 'failed')::int`,
      bytes: sql<string>`coalesce(sum(${files.size}) filter (where ${files.status} in ('ready','quarantined')), 0)`,
    })
    .from(files)
    .where(eq(files.uploadSessionId, sessionId));

  const since = (session.completedAt ?? session.lastActivityAt).getTime();
  if (Number(counts?.processing ?? 0) > 0 && now.getTime() - since < SESSION_COMPLETE_MAX_WAIT_MS) return 'wait';

  // claim: exactly one run sends the notifications
  const claimed = await db
    .update(uploadSessions)
    .set({ notifiedAt: now })
    .where(and(eq(uploadSessions.id, sessionId), isNull(uploadSessions.notifiedAt)))
    .returning({ id: uploadSessions.id });
  if (claimed.length === 0) return 'skipped';

  const fileCount = Number(counts?.ready ?? 0);
  const failedCount = Math.max(Number(counts?.failed ?? 0), session.failedFiles);
  if (fileCount === 0) return 'done'; // nothing was uploaded; nothing to announce

  try {
    const s = await getSettings();
    const branding = await getBranding();
    const link = `${appLink('/uploads')}?session=${session.id}`;
    const total = formatBytes(Number(counts?.bytes ?? 0));
    const who = [session.uploaderName, session.uploaderEmail ? `<${session.uploaderEmail}>` : null].filter(Boolean).join(' ') || 'Anonymous';
    const completed = (session.completedAt ?? now).toUTCString();
    const subject = `New client upload completed — ${client.name}`;
    const lines = [
      `Client: ${client.name}`,
      `Portal: ${portal.name}`,
      `Uploaded by: ${who}${session.uploaderCompany ? ` (${session.uploaderCompany})` : ''}`,
      `Files: ${fileCount} (${total})`,
      ...(failedCount > 0 ? [`Failed files: ${failedCount}`] : []),
      ...(Number(counts?.quarantined ?? 0) > 0 ? [`Quarantined: ${counts!.quarantined}`] : []),
      ...(session.message ? [`Message: ${session.message}`] : []),
      `Completed: ${completed}`,
    ];
    const base = { type: 'upload_completed', subject, body: lines.join('\n'), link, clientId: client.id, uploadSessionId: session.id };

    await createInAppNotification(base);
    if (s.notifications.notifyOnUploadComplete) {
      for (const recipient of await adminEmails(portal.notifyEmails)) await createEmailNotification({ ...base, recipient });
    }
    if (portal.notifyClient && s.notifications.notifyClientReceipt && session.uploaderEmail) {
      await createEmailNotification({
        type: 'upload_receipt',
        subject: `We received your files — ${branding.companyName}`,
        body: `Hi${session.uploaderName ? ` ${session.uploaderName}` : ''},\n\nThanks — we received ${fileCount} file${fileCount === 1 ? '' : 's'} (${total}) through "${portal.title || client.name}".\n\nNo further action is needed.`,
        recipient: session.uploaderEmail,
        clientId: client.id,
        uploadSessionId: session.id,
      });
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'session-complete failed; releasing claim for retry');
    await db.update(uploadSessions).set({ notifiedAt: null }).where(eq(uploadSessions.id, sessionId));
    throw err;
  }
  return 'done';
}
