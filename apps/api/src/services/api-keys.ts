import {
  API_KEY_SCOPES,
  hasPermission,
  type ApiKeyDTO,
  type ApiKeyScope,
  type CreateApiKeyResponse,
  type Permission,
  type Role,
} from '@scenox/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db';
import { apiKeys, users, type ApiKeyRow } from '../db/schema';
import { audit } from '../lib/activity';
import { hashToken, randomToken } from '../lib/crypto';
import { notFound, validationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { parse } from '../lib/validate';
import type { AuthUser } from './auth';

export const API_KEY_PREFIX = 'svk_';
/** Shape check before touching the database: "svk_" + base64url token. */
const KEY_RE = /^svk_[A-Za-z0-9_-]{20,128}$/;
const LAST_USED_INTERVAL_MS = 60_000;

/**
 * Permissions an API key may ever hold, per scope. Team, settings, audit and system permissions are
 * deliberately absent: an API key can never manage users, API keys, webhooks or settings.
 */
const READ_PERMISSIONS: Permission[] = ['clients.view', 'portals.view', 'files.view', 'files.download', 'activity.view'];
const WRITE_PERMISSIONS: Permission[] = [...READ_PERMISSIONS, 'clients.manage', 'portals.manage', 'files.manage', 'files.delete'];
const SCOPE_PERMISSIONS: Record<ApiKeyScope, ReadonlySet<Permission>> = {
  read: new Set(READ_PERMISSIONS),
  write: new Set(WRITE_PERMISSIONS),
};

export function scopesAllow(scopes: readonly string[], perm: Permission): boolean {
  return scopes.some((s) => SCOPE_PERMISSIONS[s as ApiKeyScope]?.has(perm));
}

export interface ResolvedApiKey {
  id: string;
  name: string;
  scopes: ApiKeyScope[];
}

/** Pull an API key out of the request headers (never from the query string). Returns null when none was sent. */
export function extractApiKey(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m && m[1]!.startsWith(API_KEY_PREFIX)) return m[1]!;
  }
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}

const lastTouched = new Map<string, number>();

/**
 * Look up a presented key. Returns null for unknown, revoked and expired keys and for keys whose
 * creator is disabled — callers answer all of those with the same generic 401.
 */
export async function resolveApiKey(raw: string, ip: string | null): Promise<{ key: ResolvedApiKey; user: AuthUser } | null> {
  if (!KEY_RE.test(raw)) return null;
  const db = getDb();
  const [row] = await db
    .select({
      key: apiKeys,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      },
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.createdBy))
    .where(eq(apiKeys.keyHash, hashToken(raw)))
    .limit(1);
  if (!row || row.key.revokedAt || row.user.status !== 'active') return null;
  if (row.key.expiresAt && row.key.expiresAt.getTime() <= Date.now()) return null;

  // throttled: at most one write per key per minute (per process)
  const now = Date.now();
  const last = Math.max(row.key.lastUsedAt?.getTime() ?? 0, lastTouched.get(row.key.id) ?? 0);
  if (now - last >= LAST_USED_INTERVAL_MS) {
    lastTouched.set(row.key.id, now);
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(now), lastUsedIp: ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null })
      .where(eq(apiKeys.id, row.key.id))
      .catch((err) => logger.warn({ err }, 'failed to record API key usage'));
  }
  const scopes = row.key.scopes.filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s));
  return { key: { id: row.key.id, name: row.key.name, scopes }, user: row.user };
}

// ───────────────────────── management ─────────────────────────

export const createApiKeySchema = z.strictObject({
  name: z.string('Please enter a name.').trim().min(1, 'Please enter a name.').max(100, 'Please keep the name under 100 characters.'),
  scopes: z
    .array(z.enum(API_KEY_SCOPES, 'Choose "read" and/or "write".'))
    .min(1, 'Choose at least one scope.')
    .transform((s) => [...new Set(s)]),
  expiresInDays: z.number().int('Must be a whole number.').min(1, 'Must be at least 1 day.').max(3650, 'Must be at most 3650 days.').nullish(),
});

export function toApiKeyDTO(k: ApiKeyRow, creator: { id: string; name: string } | null): ApiKeyDTO {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes.filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s)),
    createdBy: creator,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

const canSeeAll = (role: Role) => hasPermission(role, 'team.manage');

export async function listApiKeys(user: AuthUser): Promise<ApiKeyDTO[]> {
  const rows = await getDb()
    .select({ key: apiKeys, creatorId: users.id, creatorName: users.name })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.createdBy))
    .where(canSeeAll(user.role) ? undefined : eq(apiKeys.createdBy, user.id))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  return rows.map((r) => toApiKeyDTO(r.key, { id: r.creatorId, name: r.creatorName }));
}

export async function createApiKey(req: FastifyRequest, body: unknown): Promise<CreateApiKeyResponse> {
  const user = req.user!;
  const data = parse(createApiKeySchema, body);
  // a key can never exceed what its creator may do
  if (data.scopes.includes('write') && !hasPermission(user.role, 'files.manage')) {
    throw validationError({ fields: { scopes: 'Your role can only create read-only keys.' } }, 'Your role can only create read-only keys.');
  }
  const token = randomToken(32);
  const key = `${API_KEY_PREFIX}${token}`;
  const [row] = await getDb()
    .insert(apiKeys)
    .values({
      name: data.name,
      prefix: `${API_KEY_PREFIX}${token.slice(0, 8)}`,
      keyHash: hashToken(key),
      scopes: data.scopes,
      createdBy: user.id,
      expiresAt: data.expiresInDays ? new Date(Date.now() + data.expiresInDays * 86_400_000) : null,
    })
    .returning();
  await audit(req, {
    action: 'apikey.created',
    resourceType: 'api_key',
    resourceId: row!.id,
    metadata: { name: row!.name, prefix: row!.prefix, scopes: row!.scopes, expiresAt: row!.expiresAt?.toISOString() ?? null },
  });
  return { key, apiKey: toApiKeyDTO(row!, { id: user.id, name: user.name }) };
}

export async function revokeApiKey(req: FastifyRequest, id: string): Promise<void> {
  const user = req.user!;
  const db = getDb();
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  // 404 (not 403) so other people's key ids are not discoverable
  if (!row || (row.createdBy !== user.id && !canSeeAll(user.role))) throw notFound('API key not found.');
  if (row.revokedAt) return;
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (!revoked) return;
  lastTouched.delete(id);
  await audit(req, {
    action: 'apikey.revoked',
    resourceType: 'api_key',
    resourceId: id,
    metadata: { name: row.name, prefix: row.prefix },
  });
}

