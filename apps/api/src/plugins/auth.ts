import { hasPermission, type Permission } from '@scenox/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from './fp';
import { config } from '../config';
import { forbidden, unauthorized } from '../lib/errors';
import { resolveSession, type AuthUser } from '../services/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    authSession: { id: string; tokenHash: string; expiresAt: Date } | null;
  }
  interface FastifyInstance {
    /** preHandler: require a signed-in admin user */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler factory: require a permission (implies authenticate) */
    requirePermission: (perm: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence for cookie-authenticated requests: SameSite=Lax cookies + a strict
 * Origin/Referer allow-list on every state-changing request.
 */
function assertSameOrigin(req: FastifyRequest) {
  if (!UNSAFE.has(req.method)) return;
  const allowed = config().allowedOrigins;
  const origin = req.headers.origin;
  if (origin) {
    if (!allowed.includes(origin)) throw forbidden('Request origin not allowed.');
    return;
  }
  const referer = req.headers.referer;
  // Non-browser clients send neither header; they cannot carry a victim's cookie cross-site.
  if (!referer) return;
  let refOrigin: string | null = null;
  try {
    refOrigin = new URL(referer).origin;
  } catch {
    /* invalid referer */
  }
  if (!refOrigin || !allowed.includes(refOrigin)) throw forbidden('Request origin not allowed.');
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);

  const authenticate = async (req: FastifyRequest) => {
    if (req.user) return;
    const s = await resolveSession(req);
    if (!s) throw unauthorized();
    assertSameOrigin(req);
    req.user = s.user;
    req.authSession = { id: s.sessionId, tokenHash: s.tokenHash, expiresAt: s.expiresAt };
  };

  app.decorate('authenticate', authenticate);
  app.decorate('requirePermission', (perm: Permission) => async (req: FastifyRequest) => {
    await authenticate(req);
    if (!hasPermission(req.user!.role, perm)) throw forbidden();
  });
});
