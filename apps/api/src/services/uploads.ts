import {
  ARCHIVE_EXTENSIONS,
  PORTAL_ACCESS_HEADER,
  UPLOAD_SESSION_HEADER,
  formatBytes,
  getExtension,
  sanitizeFilename,
  sanitizeRelativePath,
  type PreflightResult,
  type UploadSessionStatus,
} from '@scenox/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { getDb } from '../db';
import {
  clients,
  portalAccessTokens,
  portals,
  uploadSessions,
  type Client,
  type Portal,
  type UploadSession,
} from '../db/schema';
import { hashToken } from '../lib/crypto';
import { AppError, notFound } from '../lib/errors';
import { effectiveMaxFileSize } from './quota';
import { findPortalByToken, portalEffectiveStatus } from './portal-tokens';
import { getBlockedExtensions, getSettings } from './settings';

export type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export interface UploadContext {
  session: UploadSession;
  portal: Portal;
  client: Client;
}

// ───────────────────────── portal lookup / state ─────────────────────────

/** Resolve a public portal by token (404 generic when unknown). */
export async function loadPortalByToken(token: string): Promise<{ portal: Portal; client: Client }> {
  const portal = await findPortalByToken(token);
  if (!portal) throw notFound('This upload link is not valid.');
  const [client] = await getDb().select().from(clients).where(eq(clients.id, portal.clientId)).limit(1);
  if (!client) throw notFound('This upload link is not valid.');
  return { portal, client };
}

export function portalUsability(portal: Pick<Portal, 'status' | 'expiresAt'>, client: Pick<Client, 'status'>): 'ok' | 'disabled' | 'expired' {
  if (portal.status === 'disabled' || client.status === 'disabled') return 'disabled';
  if (portalEffectiveStatus(portal) === 'expired') return 'expired';
  return 'ok';
}

export function assertPortalUsable(portal: Pick<Portal, 'status' | 'expiresAt'>, client: Pick<Client, 'status'>) {
  const u = portalUsability(portal, client);
  if (u === 'disabled') throw new AppError(403, 'portal_disabled', 'This upload link is no longer active.');
  if (u === 'expired') throw new AppError(403, 'portal_expired', 'This upload link has expired. Please ask for a new one.');
}

/** True when the request carries a valid, unexpired portal access token for this portal. */
export async function hasPortalAccess(portal: Pick<Portal, 'id' | 'passwordHash'>, req: FastifyRequest, queryToken?: string): Promise<boolean> {
  if (!portal.passwordHash) return true;
  // media tags (<img>/<video>) can't send headers, so preview URLs may carry the token as ?access=
  const header = req.headers[PORTAL_ACCESS_HEADER];
  const token = typeof header === 'string' ? header : queryToken;
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return false;
  const [row] = await getDb()
    .select({ id: portalAccessTokens.id })
    .from(portalAccessTokens)
    .where(and(eq(portalAccessTokens.tokenHash, hashToken(token)), eq(portalAccessTokens.portalId, portal.id), gt(portalAccessTokens.expiresAt, new Date())))
    .limit(1);
  return !!row;
}

// ───────────────────────── upload session auth ─────────────────────────

const SESSION_INVALID = () => new AppError(401, 'session_invalid', 'Your upload session has expired. Please refresh the page to start again.');
const TOUCH_MS = 30_000;

export interface AuthOptions {
  /** the session must belong to this portal */
  portalId?: string;
  /** accepted session statuses (default: active + completed — a completed session may still retry files until it expires) */
  statuses?: UploadSessionStatus[];
  /** slide the expiry window forward on activity (default true) */
  touch?: boolean;
  /** skip the portal enabled / not-expired check (used for read-only endpoints) */
  skipPortalState?: boolean;
}

/** Validate an x-upload-session token and load its session, portal and client. Throws friendly AppErrors. */
export async function authenticateUploadToken(token: string | null | undefined, opts: AuthOptions = {}): Promise<UploadContext> {
  if (!token || token.length < 16 || token.length > 128) throw SESSION_INVALID();
  const db = getDb();
  const [row] = await db
    .select({ session: uploadSessions, portal: portals, client: clients })
    .from(uploadSessions)
    .innerJoin(portals, eq(portals.id, uploadSessions.portalId))
    .innerJoin(clients, eq(clients.id, uploadSessions.clientId))
    .where(eq(uploadSessions.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) throw SESSION_INVALID();
  const { session, portal, client } = row;
  const now = new Date();
  if (opts.portalId && session.portalId !== opts.portalId) throw SESSION_INVALID();
  if (session.expiresAt.getTime() <= now.getTime()) throw SESSION_INVALID();
  if (!(opts.statuses ?? ['active', 'completed']).includes(session.status)) {
    throw session.status === 'completed'
      ? new AppError(409, 'session_completed', 'This upload session has already been completed. Please refresh the page to start a new one.')
      : SESSION_INVALID();
  }
  if (!opts.skipPortalState) assertPortalUsable(portal, client);

  if (session.status === 'active' && opts.touch !== false && now.getTime() - session.lastActivityAt.getTime() > TOUCH_MS) {
    const { security } = await getSettings();
    const expiresAt = new Date(now.getTime() + security.portalSessionHours * 3600_000);
    await db.update(uploadSessions).set({ lastActivityAt: now, expiresAt }).where(eq(uploadSessions.id, session.id));
    session.lastActivityAt = now;
    session.expiresAt = expiresAt;
  }
  return { session, portal, client };
}

/** Route helper: authenticate the x-upload-session header against an already-resolved portal. */
export function requireUploadSession(req: FastifyRequest, portal: Pick<Portal, 'id'>, opts: Omit<AuthOptions, 'portalId'> = {}): Promise<UploadContext> {
  const header = req.headers[UPLOAD_SESSION_HEADER];
  return authenticateUploadToken(typeof header === 'string' ? header : undefined, { ...opts, portalId: portal.id });
}

// ───────────────────────── per-file rules ─────────────────────────

export interface UploadRules {
  blocked: Set<string>;
  allowed: Set<string> | null;
  maxFileSize: number | null;
  allowFolders: boolean;
  allowZip: boolean;
}

export async function getUploadRules(portal: Portal): Promise<UploadRules> {
  const allowed = portal.allowedExtensions?.length ? new Set(portal.allowedExtensions.map((e) => e.toLowerCase().replace(/^\./, ''))) : null;
  return {
    blocked: new Set(await getBlockedExtensions()),
    allowed,
    maxFileSize: await effectiveMaxFileSize(portal),
    allowFolders: portal.allowFolders,
    allowZip: portal.allowZip,
  };
}

export interface FileRuleViolation {
  reason: NonNullable<PreflightResult['reason']>;
  message: string;
}

/** Check one (already sanitised) file against the portal rules. Quota is checked separately. */
export function checkFileRules(rules: UploadRules, f: { name: string; relativePath: string; size: number }): FileRuleViolation | null {
  const ext = getExtension(f.name);
  if (f.relativePath !== '' && !rules.allowFolders) {
    return { reason: 'folders_not_allowed', message: "Folders aren't accepted on this upload link. Please upload individual files." };
  }
  if (ext && rules.blocked.has(ext)) {
    return { reason: 'blocked_type', message: `"${f.name}" can't be uploaded: .${ext} files aren't allowed for security reasons.` };
  }
  if (!rules.allowZip && ARCHIVE_EXTENSIONS.includes(ext)) {
    return { reason: 'zip_not_allowed', message: "ZIP and other archive files aren't accepted on this upload link. Please upload the individual files instead." };
  }
  if (rules.allowed && !rules.allowed.has(ext)) {
    return { reason: 'not_allowed_type', message: `"${f.name}" isn't an accepted file type. Allowed types: ${[...rules.allowed].join(', ')}.` };
  }
  if (rules.maxFileSize !== null && f.size > rules.maxFileSize) {
    return { reason: 'too_large', message: `"${f.name}" is larger than the maximum file size of ${formatBytes(rules.maxFileSize)}.` };
  }
  return null;
}

export const cleanName = sanitizeFilename;
export const cleanPath = sanitizeRelativePath;

// ───────────────────────── counters ─────────────────────────

/**
 * Apply a delta to the denormalised counters of a file's session/portal/client. Counters never go negative.
 * `uploaded` = true also stamps lastUploadAt (a file was just accepted).
 */
export async function bumpCounters(
  tx: Tx,
  f: { uploadSessionId: string; portalId: string; clientId: string },
  files: number,
  bytes: number,
  uploaded = false,
) {
  const now = new Date();
  await tx
    .update(uploadSessions)
    .set({
      uploadedFiles: sql`greatest(${uploadSessions.uploadedFiles} + ${files}, 0)`,
      uploadedBytes: sql`greatest(${uploadSessions.uploadedBytes} + ${bytes}, 0)`,
      ...(uploaded ? { lastActivityAt: now } : {}),
    })
    .where(eq(uploadSessions.id, f.uploadSessionId));
  await tx
    .update(portals)
    .set({
      storageUsedBytes: sql`greatest(${portals.storageUsedBytes} + ${bytes}, 0)`,
      fileCount: sql`greatest(${portals.fileCount} + ${files}, 0)`,
      ...(uploaded ? { lastUploadAt: now } : {}),
    })
    .where(eq(portals.id, f.portalId));
  await tx
    .update(clients)
    .set({
      storageUsedBytes: sql`greatest(${clients.storageUsedBytes} + ${bytes}, 0)`,
      fileCount: sql`greatest(${clients.fileCount} + ${files}, 0)`,
      ...(uploaded ? { lastUploadAt: now } : {}),
    })
    .where(eq(clients.id, f.clientId));
}
