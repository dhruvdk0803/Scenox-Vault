import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../src/db';
import { clients, portals, sessions, users, type Client, type Portal } from '../src/db/schema';
import { hashToken } from '../src/lib/crypto';
import { hashPassword } from '../src/lib/password';
import { generatePortalToken } from '../src/services/portal-tokens';
import { ORIGIN } from './helpers';

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export async function seedPortal(
  opts: { client?: Partial<typeof clients.$inferInsert>; portal?: Partial<typeof portals.$inferInsert> & { password?: string } } = {},
): Promise<{ client: Client; portal: Portal; token: string }> {
  const db = getDb();
  const [client] = await db.insert(clients).values({ name: 'ABC Company', ...opts.client }).returning();
  const { password, ...portalOpts } = opts.portal ?? {};
  const t = generatePortalToken();
  const [portal] = await db
    .insert(portals)
    .values({
      clientId: client!.id,
      name: 'Main portal',
      tokenHash: t.tokenHash,
      tokenEncrypted: t.tokenEncrypted,
      tokenPreview: t.tokenPreview,
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
      ...portalOpts,
    })
    .returning();
  return { client: client!, portal: portal!, token: t.token };
}

/** Admin cookie created directly in the DB (no dependency on the auth routes). */
export async function adminHeaders(role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner') {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({ email: `${role}-${randomBytes(4).toString('hex')}@example.com`, name: `${role} user`, role, passwordHash: 'x' })
    .returning();
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) });
  return { user: user!, headers: { cookie: `sv_session=${token}`, ...ORIGIN } };
}

export async function startSession(app: FastifyInstance, token: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'POST', url: `/api/public/portals/${token}/sessions`, payload, headers });
  return { res, body: res.json() as { sessionId: string; sessionToken: string; expiresAt: string } };
}

// ───────────────────────── tus client (fetch) ─────────────────────────

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
export const tusMetadata = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k} ${b64(v)}`).join(',');

export interface TusCtx {
  base: string; // http://127.0.0.1:port
  sessionToken: string;
  sessionId: string;
}

const tusHeaders = (ctx: TusCtx, extra: Record<string, string> = {}) => ({
  'tus-resumable': '1.0.0',
  'x-upload-session': ctx.sessionToken,
  ...extra,
});

export async function tusCreate(
  ctx: TusCtx,
  file: { name: string; size: number; relativePath?: string; extra?: Record<string, string>; sessionId?: string },
  extraHeaders: Record<string, string> = {},
) {
  const res = await fetch(`${ctx.base}/api/tus`, {
    method: 'POST',
    headers: tusHeaders(ctx, {
      'upload-length': String(file.size),
      'upload-metadata': tusMetadata({
        filename: file.name,
        filetype: 'application/octet-stream',
        relativePath: file.relativePath ?? '',
        sessionId: file.sessionId ?? ctx.sessionId,
        clientKey: 'k1',
        ...file.extra,
      }),
      ...extraHeaders,
    }),
  });
  const location = res.headers.get('location');
  const text = await res.text();
  return { res, status: res.status, location, url: location ? `${ctx.base}${location}` : null, text };
}

export async function tusPatch(ctx: TusCtx, url: string, offset: number, body: Buffer) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: tusHeaders(ctx, { 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }),
    body: new Uint8Array(body),
  });
  await res.arrayBuffer();
  return { status: res.status, offset: Number(res.headers.get('upload-offset') ?? -1) };
}

export async function tusHead(ctx: TusCtx, url: string) {
  const res = await fetch(url, { method: 'HEAD', headers: tusHeaders(ctx) });
  return { status: res.status, offset: Number(res.headers.get('upload-offset') ?? -1), length: Number(res.headers.get('upload-length') ?? -1) };
}

/** Upload a whole buffer in chunks, returning the final status. */
export async function tusUploadAll(ctx: TusCtx, file: Omit<Parameters<typeof tusCreate>[1], 'size'> & { data: Buffer }, chunk = 1024 * 1024) {
  const c = await tusCreate(ctx, { ...file, size: file.data.length });
  if (c.status !== 201) return { create: c, status: c.status };
  let offset = 0;
  let last = { status: 201, offset: 0 };
  while (offset < file.data.length) {
    last = await tusPatch(ctx, c.url!, offset, file.data.subarray(offset, offset + chunk));
    if (last.status !== 204) break;
    offset = last.offset;
  }
  return { create: c, status: last.status, url: c.url! };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── direct seeding ─────────────────────────
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config';
import { files, uploadSessions } from '../src/db/schema';
import { KEYS } from '../src/storage';

/** Create a session row directly. */
export async function seedSession(portal: Portal, extra: Partial<typeof uploadSessions.$inferInsert> = {}) {
  const [s] = await getDb()
    .insert(uploadSessions)
    .values({ portalId: portal.id, clientId: portal.clientId, tokenHash: hashToken(randomBytes(16).toString('hex')), expiresAt: new Date(Date.now() + 3600_000), ...extra })
    .returning();
  return s!;
}

/** Create a "ready" file with real bytes on disk and correct counters. */
export async function seedReadyFile(
  portal: Portal,
  session: { id: string },
  opts: { name?: string; relativePath?: string; data?: Buffer; status?: 'ready' | 'quarantined' | 'processing'; extra?: Partial<typeof files.$inferInsert> } = {},
) {
  const data = opts.data ?? randomBytes(2048);
  const stored = randomUUID();
  const status = opts.status ?? 'ready';
  const key = status === 'ready' ? KEYS.fileKey(portal.clientId, portal.id, session.id, stored) : status === 'quarantined' ? KEYS.quarantineKey(stored) : KEYS.stagingKey(stored);
  const abs = nodePath.join(config().storage.path, key);
  await fs.mkdir(nodePath.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
  const name = opts.name ?? `file-${stored.slice(0, 6)}.txt`;
  const [f] = await getDb()
    .insert(files)
    .values({
      clientId: portal.clientId,
      portalId: portal.id,
      uploadSessionId: session.id,
      originalFilename: name,
      storedFilename: stored,
      relativePath: opts.relativePath ?? '',
      extension: name.includes('.') ? name.split('.').pop()!.toLowerCase() : '',
      size: data.length,
      bytesReceived: data.length,
      status,
      storageKey: status === 'processing' ? null : key,
      checksumSha256: sha256Hex(data),
      completedAt: new Date(),
      ...opts.extra,
    })
    .returning();
  const { sql } = await import('drizzle-orm');
  const db = getDb();
  await db.execute(sql`update upload_sessions set uploaded_files = uploaded_files + 1, uploaded_bytes = uploaded_bytes + ${data.length} where id = ${session.id}`);
  await db.execute(sql`update portals set file_count = file_count + 1, storage_used_bytes = storage_used_bytes + ${data.length} where id = ${portal.id}`);
  await db.execute(sql`update clients set file_count = file_count + 1, storage_used_bytes = storage_used_bytes + ${data.length} where id = ${portal.clientId}`);
  return { file: f!, data, key, abs };
}
