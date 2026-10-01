import type { FastifyInstance } from 'fastify';
import { createUser, deleteUser, listUsers, updateUser } from '../services/users';
import { idParam } from '../services/validation';

export default async function userRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.requirePermission('team.view') }, async () => listUsers());

  app.post('/', { preHandler: app.requirePermission('team.manage') }, async (req, reply) => {
    const user = await createUser(req, req.body);
    return reply.status(201).send(user);
  });

  app.patch<{ Params: { id: string } }>('/:id', { preHandler: app.requirePermission('team.manage') }, async (req) =>
    updateUser(req, idParam(req.params.id), req.body),
  );

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: app.requirePermission('team.manage') }, async (req, reply) => {
    await deleteUser(req, idParam(req.params.id));
    return reply.status(204).send();
  });
}
