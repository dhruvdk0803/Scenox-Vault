import type { FastifyInstance } from 'fastify';
import { getInbox } from '../services/messages';

/** Admin messaging overview. Thread endpoints live under /portals/:id/messages. */
export default async function messageRoutes(app: FastifyInstance) {
  const view = { preHandler: app.requirePermission('portals.view') };
  app.get('/inbox', view, async () => getInbox());
}
