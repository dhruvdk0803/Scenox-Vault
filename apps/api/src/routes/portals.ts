import { hasPermission } from '@scenox/shared';
import type { FastifyInstance } from 'fastify';
import { forbidden } from '../lib/errors';
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
  app.delete<IdParams>('/:id', manage, async (req, reply) => {
    if (!hasPermission(req.user!.role, 'files.delete')) throw forbidden();
    await deletePortal(req, idParam(req.params.id));
    return reply.status(204).send();
  });
}
