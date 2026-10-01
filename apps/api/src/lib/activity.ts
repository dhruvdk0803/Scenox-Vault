import type { FastifyRequest } from 'fastify';
import { getDb } from '../db';
import { activityLogs } from '../db/schema';
import { logger } from './logger';

export interface ActivityInput {
  actorType: 'user' | 'client' | 'system';
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  clientId?: string | null;
  portalId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  result?: 'success' | 'failure';
  /** NEVER include passwords, tokens or other secrets. */
  metadata?: Record<string, unknown> | null;
}

/** Best-effort write; activity logging must never break the request that triggered it. */
export async function logActivity(input: ActivityInput): Promise<void> {
  try {
    await getDb()
      .insert(activityLogs)
      .values({
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel ?? null,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        clientId: input.clientId ?? null,
        portalId: input.portalId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        requestId: input.requestId ?? null,
        result: input.result ?? 'success',
        metadata: input.metadata ?? null,
      });
  } catch (err) {
    logger.error({ err, action: input.action }, 'failed to write activity log');
  }
}

/** Activity entry attributed to the signed-in admin making `req`. */
export function audit(req: FastifyRequest, input: Omit<ActivityInput, 'actorType' | 'actorId' | 'actorLabel' | 'ip' | 'userAgent' | 'requestId'>) {
  return logActivity({
    ...input,
    actorType: req.user ? 'user' : 'system',
    actorId: req.user?.id ?? null,
    actorLabel: req.user ? `${req.user.name} <${req.user.email}>` : null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.id,
  });
}

/** Activity entry attributed to a public client (portal visitor). */
export function clientActivity(
  req: FastifyRequest | null,
  input: Omit<ActivityInput, 'actorType' | 'ip' | 'userAgent' | 'requestId'>,
) {
  return logActivity({
    ...input,
    actorType: 'client',
    ip: req?.ip ?? null,
    userAgent: req?.headers['user-agent'] ?? null,
    requestId: req?.id ?? null,
  });
}
