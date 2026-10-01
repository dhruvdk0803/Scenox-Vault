import {
  UPLOAD_DEFAULTS,
  type Branding,
  type PublicPortalDTO,
  type StartSessionRequest,
  type StartSessionResponse,
} from '@scenox/shared';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../db';
import { clients, portalAccessTokens, portals, uploadSessions, type Client, type Portal } from '../db/schema';
import { clientActivity } from '../lib/activity';
import { hashToken, randomToken } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { verifyPassword } from '../lib/password';
import { getStorage } from '../storage';
import { getQuota } from './quota';
import { getBlockedExtensions, getBranding, getSettings } from './settings';
import { assertPortalUsable, hasPortalAccess, portalUsability } from './uploads';

const ACCESS_LOG_THROTTLE_MS = 5 * 60_000;

/** Update portal.lastAccessedAt and log portal.accessed at most once per 5 minutes. */
async function recordAccess(req: FastifyRequest, portal: Portal, client: Client) {
  const last = portal.lastAccessedAt?.getTime() ?? 0;
  if (Date.now() - last < ACCESS_LOG_THROTTLE_MS) return;
  const now = new Date();
  // conditional update so concurrent requests log only once
  const rows = await getDb()
    .update(portals)
    .set({ lastAccessedAt: now })
    .where(and(eq(portals.id, portal.id), or(isNull(portals.lastAccessedAt), lt(portals.lastAccessedAt, new Date(Date.now() - ACCESS_LOG_THROTTLE_MS)))))
    .returning({ id: portals.id });
  if (rows.length === 0) return;
  await clientActivity(req, {
    action: 'portal.accessed',
    resourceType: 'portal',
    resourceId: portal.id,
    clientId: client.id,
    portalId: portal.id,
    actorLabel: client.name,
    metadata: { portalName: portal.name },
  });
}

export async function buildPublicPortalDTO(req: FastifyRequest, token: string, portal: Portal, client: Client): Promise<PublicPortalDTO> {
  const branding: Branding = await getBranding();
  const usability = portalUsability(portal, client);
  if (usability !== 'ok') return { state: usability, branding };
  if (!(await hasPortalAccess(portal, req))) return { state: 'password_required', branding };

  await recordAccess(req, portal, client).catch((err) => req.log.warn({ err }, 'failed to record portal access'));

  const cfg = config();
  const quota = await getQuota(portal, client);
  const retryDelays = Array.from({ length: cfg.upload.retryCount }, (_, i) => UPLOAD_DEFAULTS.retryDelays[Math.min(i, UPLOAD_DEFAULTS.retryDelays.length - 1)]!);
  const s = await getSettings();
  const maxFile = [portal.maxFileSizeBytes, cfg.limits.maxFileSize, s.uploads.defaultMaxFileSizeBytes].filter((n): n is number => !!n && n > 0);

  return {
    state: 'ok',
    branding,
    portal: {
      title: portal.title || client.name,
      clientName: client.name,
      description: portal.description,
      instructions: portal.instructions,
      logoUrl: portal.logoKey ? `/api/public/portals/${encodeURIComponent(token)}/logo` : null,
      expiresAt: portal.expiresAt?.toISOString() ?? null,
      maxFileSizeBytes: maxFile.length ? Math.min(...maxFile) : null,
      quota: { usedBytes: quota.usedBytes, limitBytes: quota.limitBytes },
      allowedExtensions: portal.allowedExtensions?.length ? portal.allowedExtensions : null,
      blockedExtensions: await getBlockedExtensions(),
      requireName: portal.requireName,
      requireEmail: portal.requireEmail,
      requireCompany: portal.requireCompany,
      requireMessage: portal.requireMessage,
      allowFolders: portal.allowFolders,
      allowZip: portal.allowZip,
      allowResume: portal.allowResume,
      allowClientViewFiles: portal.allowClientViewFiles,
      allowClientDeleteFiles: portal.allowClientDeleteFiles,
      allowClientMessages: portal.allowClientMessages,
      allowMultipleSessions: portal.allowMultipleSessions,
    },
    upload: {
      endpoint: cfg.upload.tusPath,
      maxConcurrentUploads: cfg.upload.maxConcurrentUploads,
      defaultChunkSize: cfg.upload.defaultChunkSize,
      maxChunkSize: cfg.upload.maxChunkSize,
      minChunkSize: cfg.upload.minChunkSize,
      retryDelays,
    },
  };
}

// ───────────────────────── unlock ─────────────────────────

export const unlockSchema = z.object({ password: z.string().min(1).max(256) });

export async function unlockPortal(req: FastifyRequest, portal: Portal, client: Client, password: string) {
  assertPortalUsable(portal, client);
  if (!portal.passwordHash) {
    // nothing to unlock; still hand out a token so clients can treat both cases uniformly
  } else if (!(await verifyPassword(portal.passwordHash, password))) {
    await clientActivity(req, {
      action: 'portal.unlock_failed',
      resourceType: 'portal',
      resourceId: portal.id,
      clientId: client.id,
      portalId: portal.id,
      result: 'failure',
      metadata: { portalName: portal.name },
    });
    throw new AppError(401, 'incorrect_password', 'Incorrect password.');
  }
  const { security } = await getSettings();
  const accessToken = randomToken(32);
  const expiresAt = new Date(Date.now() + security.portalSessionHours * 3600_000);
  await getDb().insert(portalAccessTokens).values({ portalId: portal.id, tokenHash: hashToken(accessToken), ip: req.ip, expiresAt });
  if (portal.passwordHash) {
    await clientActivity(req, { action: 'portal.unlocked', resourceType: 'portal', resourceId: portal.id, clientId: client.id, portalId: portal.id, metadata: { portalName: portal.name } });
  }
  return { accessToken, expiresAt: expiresAt.toISOString() };
}

// ───────────────────────── sessions ─────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Please keep this under ${max} characters.`)
    .optional()
    .transform((v) => (v ? v : undefined));

export const startSessionSchema = z.object({
  name: optionalText(200),
  email: z
    .string()
    .trim()
    .max(320)
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || z.email().safeParse(v).success, 'Please enter a valid email address.'),
  company: optionalText(200),
  message: optionalText(5000),
  totalFiles: z.number().int().min(0).max(10_000_000).optional(),
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export function validateIntake(portal: Portal, body: StartSessionRequest): Record<string, string> {
  const errors: Record<string, string> = {};
  if (portal.requireName && !body.name) errors.name = 'Please enter your name.';
  if (portal.requireEmail && !body.email) errors.email = 'Please enter your email address.';
  if (portal.requireCompany && !body.company) errors.company = 'Please enter your company.';
  if (portal.requireMessage && !body.message) errors.message = 'Please add a short message.';
  return errors;
}

export async function startSession(req: FastifyRequest, portal: Portal, client: Client, body: StartSessionRequest): Promise<StartSessionResponse> {
  const db = getDb();
  if (!portal.allowMultipleSessions) {
    const [used] = await db
      .select({ id: uploadSessions.id })
      .from(uploadSessions)
      .where(and(eq(uploadSessions.portalId, portal.id), gt(uploadSessions.uploadedFiles, 0)))
      .limit(1);
    if (used) {
      throw new AppError(409, 'already_uploaded', 'Files have already been uploaded through this link, and it only allows one upload. Please contact the person who sent it to you.');
    }
  }
  const { security } = await getSettings();
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + security.portalSessionHours * 3600_000);
  const session = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(uploadSessions)
      .values({
        portalId: portal.id,
        clientId: client.id,
        tokenHash: hashToken(token),
        uploaderName: body.name ?? null,
        uploaderEmail: body.email ?? null,
        uploaderCompany: body.company ?? null,
        message: body.message ?? null,
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 512) ?? null,
        totalFiles: body.totalFiles ?? 0,
        totalBytes: body.totalBytes ?? 0,
        expiresAt,
      })
      .returning();
    await tx.update(portals).set({ sessionCount: sql`${portals.sessionCount} + 1` }).where(eq(portals.id, portal.id));
    await tx.update(clients).set({ uploadCount: sql`${clients.uploadCount} + 1` }).where(eq(clients.id, client.id));
    return s!;
  });
  await clientActivity(req, {
    action: 'upload.started',
    resourceType: 'upload_session',
    resourceId: session.id,
    clientId: client.id,
    portalId: portal.id,
    actorLabel: body.name ?? client.name,
    metadata: { portalName: portal.name, files: body.totalFiles ?? null, bytes: body.totalBytes ?? null },
  });
  return { sessionId: session.id, sessionToken: token, expiresAt: expiresAt.toISOString() };
}

// ───────────────────────── static images (branding / portal logo) ─────────────────────────

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

export async function openStoredImage(key: string | null | undefined) {
  if (!key) return null;
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  try {
    const { stream, size } = await getStorage().get(key);
    return { stream, size, contentType: IMAGE_TYPES[ext] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}
