import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/api-keys';
import { createWebhook, deleteWebhook, listDeliveries, listWebhooks, redeliver, rotateWebhookSecret, sendTestDelivery, updateWebhook } from '../services/webhooks';

const idParam = z.object({ id: z.uuid() });

/**
 * Developer settings: API keys and webhooks. Session-cookie admins only — an API key can never
 * create other keys, read them or touch webhooks (requireSessionPermission answers 403 for keys).
 */
export default async function developerRoutes(app: FastifyInstance) {
  // viewing/creating/revoking your own keys is open to anyone who can open Settings; owners/admins see and revoke all
  const own = { preHandler: app.requireSessionPermission('settings.view') };
  const manage = { preHandler: app.requireSessionPermission('settings.manage') };

  // ───────────── API keys ─────────────
  app.get('/api-keys', own, async (req) => listApiKeys(req.user!));

  app.post('/api-keys', own, async (req, reply) => reply.code(201).send(await createApiKey(req, req.body ?? {})));

  app.delete('/api-keys/:id', own, async (req, reply) => {
    await revokeApiKey(req, parse(idParam, req.params).id);
    return reply.code(204).send();
  });

  // ───────────── webhooks ─────────────
  app.get('/webhooks', manage, async () => listWebhooks());

  app.post('/webhooks', manage, async (req, reply) => reply.code(201).send(await createWebhook(req, req.body ?? {})));

  app.patch('/webhooks/:id', manage, async (req) => updateWebhook(req, parse(idParam, req.params).id, req.body ?? {}));

  app.delete('/webhooks/:id', manage, async (req, reply) => {
    await deleteWebhook(req, parse(idParam, req.params).id);
    return reply.code(204).send();
  });

  app.post('/webhooks/:id/rotate-secret', manage, async (req) => rotateWebhookSecret(req, parse(idParam, req.params).id));

  app.post('/webhooks/:id/test', manage, async (req, reply) => reply.code(202).send(await sendTestDelivery(req, parse(idParam, req.params).id)));

  app.get('/webhooks/:id/deliveries', manage, async (req) => {
    const { id } = parse(idParam, req.params);
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return listDeliveries(id, limit);
  });

  app.post('/webhooks/deliveries/:deliveryId/redeliver', manage, async (req, reply) => {
    const { deliveryId } = parse(z.object({ deliveryId: z.uuid() }), req.params);
    return reply.code(202).send(await redeliver(req, deliveryId));
  });
}
