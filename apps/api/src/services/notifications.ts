import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { getDb } from '../db';
import { notifications, type NotificationRow } from '../db/schema';
import { logger } from '../lib/logger';
import { enqueue } from '../queue';
import { emailLayout, escapeHtml, isMailConfigured, sendMail } from './mailer';
import { getBranding, getSettings } from './settings';

export interface NotificationInput {
  type: string;
  subject: string;
  body: string;
  link?: string | null;
  clientId?: string | null;
  uploadSessionId?: string | null;
}

export const SMTP_NOT_CONFIGURED = 'SMTP not configured';

export const appLink = (path: string) => `${config().appUrl}${path.startsWith('/') ? path : `/${path}`}`;

/** In-app notification for the admin team (recipient = null). */
export async function createInAppNotification(input: NotificationInput): Promise<NotificationRow> {
  const [row] = await getDb()
    .insert(notifications)
    .values({ ...input, channel: 'in_app', recipient: null, status: 'sent', sentAt: new Date() })
    .returning();
  return row!;
}

/**
 * Create an email notification row and queue its delivery. When SMTP is not configured the row is
 * recorded as "skipped" with an explicit reason — nothing is faked.
 */
export async function createEmailNotification(input: NotificationInput & { recipient: string }): Promise<NotificationRow> {
  const db = getDb();
  if (!isMailConfigured()) {
    const [row] = await db
      .insert(notifications)
      .values({ ...input, channel: 'email', status: 'skipped', error: SMTP_NOT_CONFIGURED })
      .returning();
    return row!;
  }
  const [row] = await db.insert(notifications).values({ ...input, channel: 'email', status: 'pending' }).returning();
  try {
    await enqueue('send-notification', { notificationId: row!.id });
  } catch (err) {
    logger.error({ err, notificationId: row!.id }, 'failed to enqueue send-notification');
    await db.update(notifications).set({ status: 'failed', error: 'Could not queue email delivery' }).where(eq(notifications.id, row!.id));
  }
  return row!;
}

/** Admin recipients: Settings → Notifications emails plus any extra addresses, de-duplicated. */
export async function adminEmails(extra: string[] = []): Promise<string[]> {
  const s = await getSettings();
  const seen = new Map<string, string>();
  for (const e of [...s.notifications.adminEmails, ...extra]) {
    const t = e?.trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()];
}

/** In-app notification for the admin team plus optional emails to the admin recipients. */
export async function notifyAdmins(input: NotificationInput & { email?: boolean; extraEmails?: string[] }) {
  const { email = true, extraEmails = [], ...n } = input;
  await createInAppNotification(n);
  if (!email) return;
  for (const recipient of await adminEmails(extraEmails)) await createEmailNotification({ ...n, recipient });
}

const CTA_LABEL: Record<string, string> = {
  upload_completed: 'View upload',
  file_quarantined: 'Review file',
  disk_warning: 'Open Vault',
  disk_critical: 'Open Vault',
  client_message: 'View message',
  staff_reply: 'Open portal',
};

const safeColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#4F46E5');

export function renderEmailHtml(n: Pick<NotificationRow, 'type' | 'subject' | 'body' | 'link'>, brand: { companyName: string; primaryColor: string }) {
  return emailLayout({
    title: escapeHtml(n.subject),
    bodyHtml: escapeHtml(n.body).replace(/\n/g, '<br>'),
    ctaLabel: n.link ? CTA_LABEL[n.type] ?? 'Open' : undefined,
    ctaUrl: n.link ? escapeHtml(n.link) : undefined,
    brand: escapeHtml(brand.companyName),
    color: safeColor(brand.primaryColor),
  });
}

/** Deliver one email notification row. Throws on delivery failure (so the job can retry) after recording it. */
export async function deliverNotification(id: string): Promise<'sent' | 'skipped' | 'noop'> {
  const db = getDb();
  const [n] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  if (!n || n.channel !== 'email' || n.status === 'sent' || n.status === 'skipped' || !n.recipient) return 'noop';
  if (!isMailConfigured()) {
    await db.update(notifications).set({ status: 'skipped', error: SMTP_NOT_CONFIGURED }).where(eq(notifications.id, id));
    return 'skipped';
  }
  try {
    const branding = await getBranding();
    await sendMail({ to: n.recipient, subject: n.subject, text: n.link ? `${n.body}\n\n${n.link}` : n.body, html: renderEmailHtml(n, branding) });
    await db.update(notifications).set({ status: 'sent', sentAt: new Date(), error: null }).where(eq(notifications.id, id));
    return 'sent';
  } catch (err) {
    logger.error({ err, notificationId: id }, 'email delivery failed');
    await db
      .update(notifications)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500) })
      .where(and(eq(notifications.id, id), isNull(notifications.sentAt)));
    throw err;
  }
}
