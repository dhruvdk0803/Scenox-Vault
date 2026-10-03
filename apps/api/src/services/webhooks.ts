import {
  WEBHOOK_EVENTS,
  type CreateWebhookResponse,
  type WebhookDTO,
  type WebhookDeliveryDTO,
  type WebhookEvent,
  type WebhookPayload,
} from '@scenox/shared';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../db';
import { clients, webhookDeliveries, webhooks, type WebhookDeliveryRow, type WebhookRow } from '../db/schema';
import { audit } from '../lib/activity';
import { decrypt, encrypt, randomToken } from '../lib/crypto';
import { notFound, validationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { isPrivateHostLiteral, safeLookup, SsrfError, urlHostname } from '../lib/ssrf';
import { parse } from '../lib/validate';
import { getQueue, QUEUES } from '../queue';
import { appLink, createInAppNotification } from './notifications';

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_BACKOFF_MS = 10_000;
export const WEBHOOK_AUTO_DISABLE_AFTER = 50;
export const MAX_WEBHOOKS = 50;
const RESPONSE_BODY_LIMIT = 1024;

type EventName = WebhookEvent | 'webhook.test';

// ───────────────────────── validation ─────────────────────────

/** URL rules: https (http only outside production); no credentials; no private literals unless explicitly allowed. */
export function validateWebhookUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Enter a full URL such as https://example.com/webhooks.';
  }
  const cfg = config();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !cfg.isProd)) {
    return cfg.isProd ? 'The URL must start with https://.' : 'The URL must start with https:// or http://.';
  }
  if (u.username || u.password) return 'Do not put credentials in the URL.';
  if (!cfg.webhookAllowPrivate && isPrivateHostLiteral(urlHostname(u))) return 'That address is private or internal and cannot be used.';
  return null;
}

const urlField = z
  .string('Please enter a URL.')
  .trim()
  .min(1, 'Please enter a URL.')
  .max(2048, 'The URL is too long.')
  .superRefine((v, ctx) => {
    const problem = validateWebhookUrl(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const eventsField = z
  .array(z.enum([...WEBHOOK_EVENTS, '*'], 'Unknown event.'))
  .min(1, 'Choose at least one event.')
  .transform((e) => (e.includes('*') ? ['*'] : [...new Set(e)]));

const webhookFields = {
  name: z.string('Please enter a name.').trim().min(1, 'Please enter a name.').max(100, 'Please keep the name under 100 characters.'),
  url: urlField,
  events: eventsField,
  clientId: z.uuid('Invalid client.').nullish(),
};
export const createWebhookSchema = z.strictObject(webhookFields);
export const updateWebhookSchema = z.strictObject({
  name: webhookFields.name.optional(),
  url: webhookFields.url.optional(),
  events: webhookFields.events.optional(),
  clientId: webhookFields.clientId,
  enabled: z.boolean().optional(),
});

// ───────────────────────── DTOs ─────────────────────────

export function toWebhookDTO(w: WebhookRow, clientName: string | null): WebhookDTO {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: w.events as WebhookDTO['events'],
    clientId: w.clientId,
    clientName,
    enabled: w.enabled,
    lastDeliveryAt: w.lastDeliveryAt?.toISOString() ?? null,
    lastStatus: w.lastStatus,
    consecutiveFailures: w.consecutiveFailures,
    createdAt: w.createdAt.toISOString(),
  };
}

export function toDeliveryDTO(d: WebhookDeliveryRow): WebhookDeliveryDTO {
  return {
    id: d.id,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    responseStatus: d.responseStatus,
    responseBody: d.responseBody,
    error: d.error,
    durationMs: d.durationMs,
    payload: d.payload,
    createdAt: d.createdAt.toISOString(),
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
  };
}

async function loadWebhook(id: string): Promise<{ hook: WebhookRow; clientName: string | null }> {
  const [row] = await getDb()
    .select({ hook: webhooks, clientName: clients.name })
    .from(webhooks)
    .leftJoin(clients, eq(clients.id, webhooks.clientId))
    .where(eq(webhooks.id, id))
    .limit(1);
  if (!row) throw notFound('Webhook not found.');
  return row;
}

async function assertClientExists(clientId: string | null | undefined) {
  if (!clientId) return;
  const [c] = await getDb().select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!c) throw validationError({ fields: { clientId: 'That client does not exist.' } }, 'That client does not exist.');
}

export const newWebhookSecret = () => `whsec_${randomToken(24)}`;

// ───────────────────────── management (admin routes) ─────────────────────────

export async function listWebhooks(): Promise<WebhookDTO[]> {
  const rows = await getDb()
    .select({ hook: webhooks, clientName: clients.name })
    .from(webhooks)
    .leftJoin(clients, eq(clients.id, webhooks.clientId))
    .orderBy(desc(webhooks.createdAt), desc(webhooks.id));
  return rows.map((r) => toWebhookDTO(r.hook, r.clientName));
}

export async function createWebhook(req: FastifyRequest, body: unknown): Promise<CreateWebhookResponse> {
  const data = parse(createWebhookSchema, body);
  const db = getDb();
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(webhooks);
  if (n >= MAX_WEBHOOKS) throw validationError({}, `You can have at most ${MAX_WEBHOOKS} webhooks.`);
  await assertClientExists(data.clientId);
  const secret = newWebhookSecret();
  const [row] = await db
    .insert(webhooks)
    .values({ name: data.name, url: data.url, events: data.events, clientId: data.clientId ?? null, secretEncrypted: encrypt(secret), createdBy: req.user?.id ?? null })
    .returning();
  await audit(req, {
    action: 'webhook.created',
    resourceType: 'webhook',
    resourceId: row!.id,
    clientId: row!.clientId,
    metadata: { name: row!.name, url: row!.url, events: row!.events },
  });
  const { clientName } = await loadWebhook(row!.id);
  return { webhook: toWebhookDTO(row!, clientName), secret };
}

export async function updateWebhook(req: FastifyRequest, id: string, body: unknown): Promise<WebhookDTO> {
  const data = parse(updateWebhookSchema, body ?? {});
  const { hook: before } = await loadWebhook(id);
  if (data.clientId !== undefined) await assertClientExists(data.clientId);
  const patch: Partial<typeof webhooks.$inferInsert> = { updatedAt: new Date() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.url !== undefined) patch.url = data.url;
  if (data.events !== undefined) patch.events = data.events;
  if (data.clientId !== undefined) patch.clientId = data.clientId;
  if (data.enabled !== undefined) {
    patch.enabled = data.enabled;
    if (data.enabled && !before.enabled) patch.consecutiveFailures = 0; // a fresh start after the admin re-enables it
  }
  const [row] = await getDb().update(webhooks).set(patch).where(eq(webhooks.id, id)).returning();
  await audit(req, {
    action: 'webhook.updated',
    resourceType: 'webhook',
    resourceId: id,
    clientId: row!.clientId,
    metadata: { name: row!.name, fields: Object.keys(data) },
  });
  const { clientName } = await loadWebhook(id);
  return toWebhookDTO(row!, clientName);
}

export async function deleteWebhook(req: FastifyRequest, id: string): Promise<void> {
  const { hook } = await loadWebhook(id);
  await getDb().delete(webhooks).where(eq(webhooks.id, id));
  await audit(req, { action: 'webhook.deleted', resourceType: 'webhook', resourceId: id, clientId: hook.clientId, metadata: { name: hook.name, url: hook.url } });
}

export async function rotateWebhookSecret(req: FastifyRequest, id: string): Promise<{ secret: string }> {
  const { hook } = await loadWebhook(id);
  const secret = newWebhookSecret();
  await getDb().update(webhooks).set({ secretEncrypted: encrypt(secret), updatedAt: new Date() }).where(eq(webhooks.id, id));
  await audit(req, { action: 'webhook.secret_rotated', resourceType: 'webhook', resourceId: id, clientId: hook.clientId, metadata: { name: hook.name } });
  return { secret };
}

export async function listDeliveries(webhookId: string, limit: number): Promise<WebhookDeliveryDTO[]> {
  await loadWebhook(webhookId);
  const rows = await getDb()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit);
  return rows.map(toDeliveryDTO);
}

/** Queue one delivery job. `force` bypasses the "webhook is enabled" check (test + redeliver). */
async function enqueueDelivery(deliveryId: string, opts: { force?: boolean; unique?: boolean; attempts?: number } = {}) {
  await getQueue(QUEUES.webhooks).add(
    'deliver-webhook',
    { deliveryId, ...(opts.force ? { force: true } : {}) },
    {
      jobId: opts.unique ? `deliver-webhook-${deliveryId}-${Date.now()}` : `deliver-webhook-${deliveryId}`,
      ...deliveryJobOptions(),
      ...(opts.attempts ? { attempts: opts.attempts } : {}),
    },
  );
}

export const deliveryJobOptions = () => ({ attempts: WEBHOOK_MAX_ATTEMPTS, backoff: { type: 'exponential' as const, delay: WEBHOOK_BACKOFF_MS } });

/** POST /webhooks/:id/test → a "webhook.test" delivery (works even while the webhook is disabled). */
export async function sendTestDelivery(req: FastifyRequest, id: string): Promise<WebhookDeliveryDTO> {
  const { hook } = await loadWebhook(id);
  const deliveryId = randomUUID();
  const payload: WebhookPayload = {
    id: deliveryId,
    event: 'webhook.test',
    createdAt: new Date().toISOString(),
    data: { message: 'This is a test event from Scenox Vault.', webhookId: hook.id, webhookName: hook.name },
  };
  const [row] = await getDb()
    .insert(webhookDeliveries)
    .values({ id: deliveryId, webhookId: hook.id, event: 'webhook.test', payload: payload as unknown as Record<string, unknown> })
    .returning();
  try {
    await enqueueDelivery(deliveryId, { force: true, attempts: 1 }); // a test is a single attempt
  } catch (err) {
    logger.error({ err, deliveryId }, 'failed to enqueue webhook test delivery');
    const [failed] = await getDb()
      .update(webhookDeliveries)
      .set({ status: 'failed', error: 'Could not queue the delivery.' })
      .where(eq(webhookDeliveries.id, deliveryId))
      .returning();
    return toDeliveryDTO(failed!);
  }
  await audit(req, { action: 'webhook.tested', resourceType: 'webhook', resourceId: id, clientId: hook.clientId, metadata: { name: hook.name, deliveryId } });
  return toDeliveryDTO(row!);
}

/** POST /webhooks/deliveries/:deliveryId/redeliver — reset the delivery and send it again (same delivery id). */
export async function redeliver(req: FastifyRequest, deliveryId: string): Promise<WebhookDeliveryDTO> {
  const db = getDb();
  const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
  if (!d) throw notFound('Delivery not found.');
  const [reset] = await db
    .update(webhookDeliveries)
    .set({ status: 'pending', attempts: 0, error: null, responseStatus: null, responseBody: null, durationMs: null, deliveredAt: null })
    .where(eq(webhookDeliveries.id, deliveryId))
    .returning();
  await enqueueDelivery(deliveryId, { force: true, unique: true });
  await audit(req, { action: 'webhook.redelivered', resourceType: 'webhook', resourceId: d.webhookId, metadata: { deliveryId, event: d.event } });
  return toDeliveryDTO(reset!);
}

// ───────────────────────── emission ─────────────────────────

export interface EmitItem {
  data: unknown;
  clientId?: string | null;
}

/**
 * Record + queue one delivery per matching webhook for each item. NEVER throws: webhooks are a side
 * channel and must not break the flow that triggered them.
 */
export async function emitEvents(event: WebhookEvent, items: EmitItem[]): Promise<void> {
  if (items.length === 0) return;
  try {
    const db = getDb();
    const hooks = (await db.select().from(webhooks).where(eq(webhooks.enabled, true))).filter(
      (h) => h.events.includes(event) || h.events.includes('*'),
    );
    if (hooks.length === 0) return;
    const now = new Date();
    const rows: (typeof webhookDeliveries.$inferInsert)[] = [];
    for (const item of items) {
      for (const h of hooks) {
        if (h.clientId && h.clientId !== (item.clientId ?? null)) continue;
        const id = randomUUID();
        const payload: WebhookPayload = { id, event, createdAt: now.toISOString(), data: item.data };
        rows.push({ id, webhookId: h.id, event, payload: payload as unknown as Record<string, unknown>, createdAt: now });
      }
    }
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await db.insert(webhookDeliveries).values(chunk);
      try {
        await getQueue(QUEUES.webhooks).addBulk(
          chunk.map((r) => ({ name: 'deliver-webhook', data: { deliveryId: r.id! }, opts: { jobId: `deliver-webhook-${r.id}`, ...deliveryJobOptions() } })),
        );
      } catch (err) {
        logger.error({ err, event }, 'failed to enqueue webhook deliveries');
        await db
          .update(webhookDeliveries)
          .set({ status: 'failed', error: 'Could not queue the delivery.' })
          .where(inArray(webhookDeliveries.id, chunk.map((r) => r.id!)));
      }
    }
  } catch (err) {
    logger.error({ err, event }, 'failed to emit webhook event');
  }
}

export const emitEvent = (event: WebhookEvent, data: unknown, ctx: { clientId?: string | null } = {}) =>
  emitEvents(event, [{ data, clientId: ctx.clientId }]);

// ───────────────────────── delivery (worker) ─────────────────────────

export const signPayload = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

interface HttpResult {
  status: number;
  body: string;
}

/** One POST. No redirects, 10 s overall timeout, response body capped at 1 KB, DNS-pinned SSRF guard. */
function postJson(url: string, body: string, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!config().webhookAllowPrivate && isPrivateHostLiteral(urlHostname(u))) return reject(new SsrfError());
    const lib = u.protocol === 'https:' ? https : http;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
    const req = lib.request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, lookup: safeLookup, signal: ac.signal, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, RESPONSE_BODY_LIMIT) });
        };
        res.on('data', (c: Buffer) => {
          if (size < RESPONSE_BODY_LIMIT) {
            chunks.push(c.subarray(0, RESPONSE_BODY_LIMIT - size));
            size += c.length;
          }
          if (size >= RESPONSE_BODY_LIMIT) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', finish); // destroyed after the cap: the status + partial body are all we need
      },
    );
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(ac.signal.aborted ? new Error(`Timed out after ${WEBHOOK_TIMEOUT_MS / 1000} seconds.`) : err);
    });
    req.end(body);
  });
}

const errorText = (err: unknown) => {
  if (err instanceof SsrfError) return err.message;
  const e = err as NodeJS.ErrnoException;
  const msg = e.code && !e.message.includes(e.code) ? `${e.code}: ${e.message}` : (e.message ?? String(err));
  return msg.slice(0, 500);
};

export type DeliveryResult = 'success' | 'retry' | 'failed' | 'skipped';

/**
 * Attempt one delivery. Returns 'retry' when the attempt failed and the job should be retried (the job
 * handler throws); 'failed' once no retries remain (or the failure is permanent); 'skipped' for a
 * delivery that no longer needs sending.
 */
export async function deliverWebhook(deliveryId: string, opts: { finalAttempt?: boolean; force?: boolean } = {}): Promise<DeliveryResult> {
  const db = getDb();
  const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
  if (!d || d.status === 'success') return 'skipped';
  const [hook] = await db.select().from(webhooks).where(eq(webhooks.id, d.webhookId)).limit(1);
  if (!hook) return 'skipped';
  if (!hook.enabled && !opts.force) {
    await db.update(webhookDeliveries).set({ status: 'failed', error: 'The webhook is disabled.' }).where(eq(webhookDeliveries.id, deliveryId));
    return 'skipped';
  }

  const secret = decrypt(hook.secretEncrypted);
  const body = JSON.stringify(d.payload);
  const attempts = d.attempts + 1;
  const started = Date.now();
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  let permanent = false;

  if (!secret) {
    error = 'The signing secret could not be read. Rotate the secret and redeliver.';
    permanent = true;
  } else {
    const t = Math.floor(Date.now() / 1000);
    try {
      const res = await postJson(hook.url, body, {
        'Content-Type': 'application/json',
        'User-Agent': 'ScenoxVault-Webhooks/1.0',
        'X-Scenox-Event': d.event,
        'X-Scenox-Delivery': d.id,
        'X-Scenox-Signature': `t=${t},v1=${signPayload(secret, t, body)}`,
      });
      responseStatus = res.status;
      responseBody = res.body;
      if (res.status < 200 || res.status >= 300) error = `The endpoint responded with HTTP ${res.status}.`;
    } catch (err) {
      error = errorText(err);
      permanent = err instanceof SsrfError;
    }
  }
  const durationMs = Date.now() - started;
  const now = new Date();

  if (!error) {
    await db
      .update(webhookDeliveries)
      .set({ status: 'success', attempts, responseStatus, responseBody, error: null, durationMs, deliveredAt: now })
      .where(eq(webhookDeliveries.id, deliveryId));
    await db
      .update(webhooks)
      .set({ lastDeliveryAt: now, lastStatus: responseStatus, consecutiveFailures: 0 })
      .where(eq(webhooks.id, hook.id));
    return 'success';
  }

  const final = permanent || !!opts.finalAttempt;
  await db
    .update(webhookDeliveries)
    .set({ status: final ? 'failed' : 'pending', attempts, responseStatus, responseBody, error, durationMs })
    .where(eq(webhookDeliveries.id, deliveryId));
  // lastStatus mirrors the most recent attempt; the failure streak only grows when a delivery finally fails
  const [updated] = await db
    .update(webhooks)
    .set({
      lastDeliveryAt: now,
      lastStatus: responseStatus,
      ...(final ? { consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1` } : {}),
    })
    .where(eq(webhooks.id, hook.id))
    .returning({ failures: webhooks.consecutiveFailures });
  if (final && updated && updated.failures >= WEBHOOK_AUTO_DISABLE_AFTER) await autoDisable(hook, updated.failures);
  return final ? 'failed' : 'retry';
}

async function autoDisable(hook: WebhookRow, failures: number) {
  try {
    const [r] = await getDb()
      .update(webhooks)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(webhooks.id, hook.id), eq(webhooks.enabled, true)))
      .returning({ id: webhooks.id });
    if (!r) return; // already disabled
    logger.warn({ webhookId: hook.id, failures }, 'webhook disabled after repeated failures');
    await createInAppNotification({
      type: 'webhook_disabled',
      subject: `Webhook disabled — ${hook.name}`,
      body: `The webhook "${hook.name}" (${hook.url}) failed ${failures} deliveries in a row and was disabled. Fix the endpoint, then re-enable it in Settings.`,
      link: appLink('/settings'),
      clientId: hook.clientId,
    });
  } catch (err) {
    logger.error({ err, webhookId: hook.id }, 'failed to auto-disable webhook');
  }
}

/** Retention: delivery history older than `days` days. */
export async function purgeOldDeliveries(now = new Date(), days = 30): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const r = await getDb().delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, cutoff)).returning({ id: webhookDeliveries.id });
  return r.length;
}

