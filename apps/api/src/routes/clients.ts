import type { FastifyInstance } from 'fastify';
import { hasPermission } from '@scenox/shared';
import { forbidden } from '../lib/errors';
import { createClient, deleteClient, getClientDTO, listClients, updateClient } from '../services/clients';
import { idParam } from '../services/validation';

export default async function clientRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.requirePermission('clients.view') }, async (req) => listClients(req.query));

  app.post('/', { preHandler: app.requirePermission('clients.manage') }, async (req, reply) => reply.status(201).send(await createClient(req, req.body)));

  app.get<{ Params: { id: string } }>('/:id', { preHandler: app.requirePermission('clients.view') }, async (req) => getClientDTO(idParam(req.params.id)));

  app.patch<{ Params: { id: string } }>('/:id', { preHandler: app.requirePermission('clients.manage') }, async (req) =>
    updateClient(req, idParam(req.params.id), req.body),
  );

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: app.requirePermission('clients.manage') }, async (req, reply) => {
    if (!hasPermission(req.user!.role, 'files.delete')) throw forbidden();
    await deleteClient(req, idParam(req.params.id));
    return reply.status(204).send();
  });
}
