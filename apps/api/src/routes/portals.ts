import { hasPermission } from '@scenox/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../lib/activity';
import { forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { getDb } from '../db';
import { clients, portals } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
  createStaffMessage,
  emailClientOfReply,
  getMessageDTO,
  listThread,
  markClientMessagesRead,
  messageListQuerySchema,
  postStaffMessageSchema,
} from '../services/messages';
import {
  createPortal,
  deletePortal,
  getPortalDTO,
  listPortals,
  regeneratePortalLink,
  removePortalLogo,
  setPortalLogo,
  updatePortal,
} from '../services/portals';
import { idParam } from '../services/validation';

type IdParams = { Params: { id: string } };

export default async function portalRoutes(app: FastifyInstance) {
  const view = { preHandler: app.requirePermission('portals.view') };
  const manage = { preHandler: app.requirePermission('portals.manage') };

  app.get('/', view, async (req) => listPortals(req.query));
  app.post('/', manage, async (req, reply) => reply.status(201).send(await createPortal(req, req.body)));
  app.get<IdParams>('/:id', view, async (req) => getPortalDTO(idParam(req.params.id)));
  app.patch<IdParams>('/:id', manage, async (req) => updatePortal(req, idParam(req.params.id), req.body));
  app.post<IdParams>('/:id/regenerate', manage, async (req) => regeneratePortalLink(req, idParam(req.params.id)));
  app.post<IdParams>('/:id/logo', manage, async (req) => setPortalLogo(req, idParam(req.params.id)));
  app.delete<IdParams>('/:id/logo', manage, async (req) => removePortalLogo(req, idParam(req.params.id)));

  // ───────────── messages (portal thread) ─────────────
  const loadPortalRow = async (id: string) => {
    const [row] = await getDb()
      .select({ portal: portals, client: clients })
      .from(portals)
      .innerJoin(clients, eq(clients.id, portals.clientId))
      .where(eq(portals.id, id))
      .limit(1);
    if (!row) throw notFound('Portal not found.');
    return row;
  };

  app.get<IdParams>('/:id/messages', view, async (req) => {
    const id = idParam(req.params.id);
    const query = parse(messageListQuerySchema, req.query);
    await loadPortalRow(id);
    return listThread(id, query, false);
  });

  app.post<IdParams>('/:id/messages', manage, async (req, reply) => {
    const id = idParam(req.params.id);
    const body = parse(postStaffMessageSchema, req.body ?? {});
    const { portal, client } = await loadPortalRow(id);
    const user = req.user!;
    const messageId = await createStaffMessage(portal, user, body);
    await audit(req, {
      action: 'message.replied',
      resourceType: 'message',
      resourceId: messageId,
      clientId: portal.clientId,
      portalId: portal.id,
      metadata: { ...(body.fileId ? { fileId: body.fileId } : {}), length: body.body.length },
    });
    // queued email; never blocks or fails the request
    await emailClientOfReply(portal, client, { fileId: body.fileId }, body.body);
    return reply.status(201).send(await getMessageDTO(messageId, false));
  });

  app.post<IdParams>('/:id/messages/read', view, async (req, reply) => {
    const id = idParam(req.params.id);
    await loadPortalRow(id);
    await markClientMessagesRead(id);
    return reply.status(204).send();
  });

  app.delete<IdParams>('/:id', manage, async (req, reply) => {
    if (!hasPermission(req.user!.role, 'files.delete')) throw forbidden();
    await deletePortal(req, idParam(req.params.id));
    return reply.status(204).send();
  });
}
