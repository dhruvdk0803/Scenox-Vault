import type { InboxThreadDTO, MessageDTO, MessageListResponse } from '@scenox/shared';
import { and, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import { clients, files, messages, notifications, portals, uploadSessions, users, type Client, type Portal } from '../db/schema';
import { logger } from '../lib/logger';
import { notFound } from '../lib/errors';
import { appLink, createEmailNotification, createInAppNotification, adminEmails } from './notifications';
import { isMailConfigured } from './mailer';
import { toMessageDTO } from './mappers';
import { decryptPortalUrl } from './portal-tokens';
import { getBranding } from './settings';

/** At most one "new client message" notification per portal in this window. */
export const MESSAGE_NOTIFY_THROTTLE_MS = 10 * 60_000;
export const MAX_MESSAGE_LENGTH = 5000;

// ───────────────────────── schemas ─────────────────────────

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Please keep this under ${max} characters.`)
    .nullish()
    .transform((v) => (v ? v : null));

const bodyField = z
  .string('Please write a message.')
  .trim()
  .min(1, 'Please write a message.')
  .max(MAX_MESSAGE_LENGTH, `Please keep your message under ${MAX_MESSAGE_LENGTH} characters.`);

export const postClientMessageSchema = z.object({
  body: bodyField,
  fileId: z.uuid('Invalid file.').nullish().transform((v) => v ?? null),
  name: optionalTrimmed(100),
  email: z
    .string()
    .trim()
    .max(200, 'Please keep this under 200 characters.')
    .nullish()
    .transform((v) => (v ? v : null))
    .pipe(z.email('Enter a valid email address.').nullable()),
});

export const postStaffMessageSchema = z.object({
  body: bodyField,
  fileId: z.uuid('Invalid file.').nullish().transform((v) => v ?? null),
});

export const messageListQuerySchema = z.object({
  fileId: z.uuid('Invalid file.').optional(),
  before: z.iso.datetime({ offset: true, message: 'Use an ISO date/time.' }).transform((v) => new Date(v)).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

// ───────────────────────── queries ─────────────────────────

const messageSelect = { m: messages, userName: users.name, fileName: files.originalFilename };

function selectMessages() {
  return getDb()
    .select(messageSelect)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(files, eq(files.id, messages.fileId));
}

type MessageJoinRow = Awaited<ReturnType<typeof selectMessages>>[number];

export const rowToMessage = (r: MessageJoinRow, companyName: string, forClient: boolean): MessageDTO =>
  toMessageDTO(r.m, { userName: r.userName, fileName: r.fileName, companyName }, { forClient });

/** A file must belong to the portal (404 otherwise, so ids of other portals are not discoverable). */
export async function assertFileInPortal(portalId: string, fileId: string): Promise<void> {
  const [f] = await getDb()
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.portalId, portalId)))
    .limit(1);
  if (!f) throw notFound('File not found.');
}

const threadCond = (portalId: string, fileId: string | null | undefined): SQL =>
  // no fileId → the whole conversation (portal messages + file comments, shown with a file chip)
  and(eq(messages.portalId, portalId), fileId ? eq(messages.fileId, fileId) : undefined)!;

/** One page of a thread (the whole conversation when no fileId, else that file's comments), oldest → newest within the page. */
export async function listThread(
  portalId: string,
  query: Pick<MessageListQuery, 'fileId' | 'before' | 'limit'>,
  forClient: boolean,
): Promise<MessageListResponse> {
  if (query.fileId) await assertFileInPortal(portalId, query.fileId);
  const rows = await selectMessages()
    .where(and(threadCond(portalId, query.fileId), query.before ? lt(messages.createdAt, query.before) : undefined))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const { companyName } = await getBranding();
  const items = rows
    .slice(0, query.limit)
    .reverse()
    .map((r) => rowToMessage(r, companyName, forClient));
  return { items, hasMore };
}

/** Comments on one file (admin). */
export async function listFileComments(fileId: string, query: Pick<MessageListQuery, 'before' | 'limit'>): Promise<MessageListResponse> {
  const [f] = await getDb().select({ portalId: files.portalId }).from(files).where(eq(files.id, fileId)).limit(1);
  if (!f) throw notFound('File not found.');
  return listThread(f.portalId, { ...query, fileId }, false);
}

export async function getMessageDTO(id: string, forClient: boolean): Promise<MessageDTO> {
  const [row] = await selectMessages().where(eq(messages.id, id)).limit(1);
  if (!row) throw notFound('Message not found.');
  return rowToMessage(row, (await getBranding()).companyName, forClient);
}

/** Mark the staff messages of a thread as seen by the client. */
export async function markStaffMessagesRead(portalId: string, fileId: string | null | undefined): Promise<void> {
  await getDb()
    .update(messages)
    .set({ readAt: new Date() })
    .where(and(threadCond(portalId, fileId), eq(messages.authorType, 'staff'), isNull(messages.readAt)));
}

/** Mark every client message of a portal (all threads) as seen by staff. */
export async function markClientMessagesRead(portalId: string): Promise<void> {
  await getDb()
    .update(messages)
    .set({ readAt: new Date() })
    .where(and(eq(messages.portalId, portalId), eq(messages.authorType, 'client'), isNull(messages.readAt)));
}

/** Client-side summary for the dashboard. */
export async function clientMessageSummary(portalId: string): Promise<{ total: number; unread: number; latest: MessageDTO | null }> {
  const [agg] = await getDb()
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${messages.authorType} = 'staff' and ${messages.readAt} is null)::int`,
    })
    .from(messages)
    .where(eq(messages.portalId, portalId));
  const total = Number(agg?.total ?? 0);
  if (total === 0) return { total: 0, unread: 0, latest: null };
  const [latest] = await selectMessages().where(eq(messages.portalId, portalId)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  return {
    total,
    unread: Number(agg?.unread ?? 0),
    latest: latest ? rowToMessage(latest, (await getBranding()).companyName, true) : null,
  };
}

// ───────────────────────── posting ─────────────────────────

/** Name to show for a client message: given name → latest upload-session uploader → "Client". */
export async function resolveClientAuthorName(portalId: string, given: string | null): Promise<string> {
  if (given) return given;
  const [s] = await getDb()
    .select({ name: uploadSessions.uploaderName })
    .from(uploadSessions)
    .where(and(eq(uploadSessions.portalId, portalId), sql`${uploadSessions.uploaderName} is not null and ${uploadSessions.uploaderName} <> ''`))
    .orderBy(desc(uploadSessions.startedAt))
    .limit(1);
  return s?.name?.trim() || 'Client';
}

export async function createClientMessage(
  portal: Portal,
  data: { body: string; fileId: string | null; name: string | null; email: string | null },
): Promise<{ id: string; authorName: string; fileName: string | null }> {
  if (data.fileId) await assertFileInPortal(portal.id, data.fileId);
  const authorName = await resolveClientAuthorName(portal.id, data.name);
  const [row] = await getDb()
    .insert(messages)
    .values({
      portalId: portal.id,
      clientId: portal.clientId,
      fileId: data.fileId,
      authorType: 'client',
      authorName,
      authorEmail: data.email,
      body: data.body,
      createdAt: new Date(),
    })
    .returning({ id: messages.id });
  let fileName: string | null = null;
  if (data.fileId) {
    const [f] = await getDb().select({ n: files.originalFilename }).from(files).where(eq(files.id, data.fileId)).limit(1);
    fileName = f?.n ?? null;
  }
  return { id: row!.id, authorName, fileName };
}

export async function createStaffMessage(
  portal: Pick<Portal, 'id' | 'clientId'>,
  user: { id: string; name: string },
  data: { body: string; fileId: string | null },
): Promise<string> {
  if (data.fileId) await assertFileInPortal(portal.id, data.fileId);
  const [row] = await getDb()
    .insert(messages)
    .values({
      portalId: portal.id,
      clientId: portal.clientId,
      fileId: data.fileId,
      authorType: 'staff',
      authorUserId: user.id,
      authorName: user.name,
      body: data.body,
      createdAt: new Date(),
    })
    .returning({ id: messages.id });
  return row!.id;
}

// ───────────────────────── notifications ─────────────────────────

const messageLink = (portalId: string) => `/portals/${portalId}?tab=messages`;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Tell the team about a new client message: one in-app notification plus emails to the admin recipients,
 * at most once per portal per 10 minutes (a burst of messages is one notification). Never throws.
 */
export async function notifyTeamOfClientMessage(
  portal: Portal,
  client: Pick<Client, 'id' | 'name'>,
  msg: { authorName: string; body: string; fileName: string | null },
): Promise<'notified' | 'throttled' | 'error'> {
  try {
    const link = messageLink(portal.id);
    const subject = `New message from ${client.name}`;
    const body = [`${msg.authorName}${msg.fileName ? ` commented on "${msg.fileName}"` : ''} (${portal.name}):`, '', truncate(msg.body, 500)].join('\n');
    const base = { type: 'client_message', subject, body, clientId: client.id };

    // serialise per portal so concurrent messages cannot both pass the throttle check
    const claimed = await getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`client_message:${portal.id}`}))`);
      const [recent] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'client_message'),
            eq(notifications.channel, 'in_app'),
            eq(notifications.link, link),
            gt(notifications.createdAt, new Date(Date.now() - MESSAGE_NOTIFY_THROTTLE_MS)),
          ),
        )
        .limit(1);
      if (recent) return false;
      await tx.insert(notifications).values({ ...base, link, channel: 'in_app', recipient: null, status: 'sent', sentAt: new Date() });
      return true;
    });
    if (!claimed) return 'throttled';

    const emailLink = appLink(link);
    for (const recipient of await adminEmails(portal.notifyEmails)) {
      await createEmailNotification({ ...base, link: emailLink, recipient });
    }
    return 'notified';
  } catch (err) {
    logger.error({ err, portalId: portal.id }, 'failed to notify team about client message');
    return 'error';
  }
}

/** Email the client about a staff reply (queued, never blocks the request). Returns true when queued. */
export async function emailClientOfReply(
  portal: Portal,
  client: Pick<Client, 'id'>,
  thread: { fileId: string | null },
  body: string,
): Promise<boolean> {
  try {
    if (!isMailConfigured()) return false;
    const [last] = await getDb()
      .select({ email: messages.authorEmail, name: messages.authorName })
      .from(messages)
      .where(and(threadCond(portal.id, thread.fileId), eq(messages.authorType, 'client'), sql`${messages.authorEmail} is not null and ${messages.authorEmail} <> ''`))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    if (!last?.email) return false;
    const { companyName } = await getBranding();
    await createEmailNotification({
      type: 'staff_reply',
      subject: `New reply from ${companyName}`,
      body: `${last.name && last.name !== 'Client' ? `Hi ${last.name},\n\n` : ''}${companyName} replied to your message:\n\n${truncate(body, 2000)}`,
      link: decryptPortalUrl(portal),
      recipient: last.email,
      clientId: client.id,
    });
    return true;
  } catch (err) {
    logger.error({ err, portalId: portal.id }, 'failed to queue reply email');
    return false;
  }
}

// ───────────────────────── admin inbox ─────────────────────────

const INBOX_LIMIT = 200;

export async function getInbox(): Promise<{ items: InboxThreadDTO[]; unreadTotal: number }> {
  const db = getDb();
  const lastAt = sql<Date>`max(${messages.createdAt})`;
  const agg = await db
    .select({
      portalId: messages.portalId,
      portalName: portals.name,
      clientId: portals.clientId,
      clientName: clients.name,
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${messages.authorType} = 'client' and ${messages.readAt} is null)::int`,
    })
    .from(messages)
    .innerJoin(portals, eq(portals.id, messages.portalId))
    .innerJoin(clients, eq(clients.id, portals.clientId))
    .groupBy(messages.portalId, portals.name, portals.clientId, clients.name)
    .orderBy(desc(lastAt))
    .limit(INBOX_LIMIT);

  const [{ unread: unreadTotal } = { unread: 0 }] = await db
    .select({ unread: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.authorType, 'client'), isNull(messages.readAt)));

  if (agg.length === 0) return { items: [], unreadTotal: Number(unreadTotal) };

  // latest message per portal
  const lasts = await db
    .selectDistinctOn([messages.portalId], messageSelect)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(files, eq(files.id, messages.fileId))
    .where(inArray(messages.portalId, agg.map((a) => a.portalId)))
    .orderBy(messages.portalId, desc(messages.createdAt), desc(messages.id));
  const { companyName } = await getBranding();
  const lastByPortal = new Map(lasts.map((r) => [r.m.portalId, rowToMessage(r, companyName, false)]));

  const items: InboxThreadDTO[] = [];
  for (const a of agg) {
    const lastMessage = lastByPortal.get(a.portalId);
    if (!lastMessage) continue;
    items.push({
      portalId: a.portalId,
      portalName: a.portalName,
      clientId: a.clientId,
      clientName: a.clientName,
      lastMessage,
      unread: Number(a.unread),
      total: Number(a.total),
    });
  }
  return { items, unreadTotal: Number(unreadTotal) };
}
