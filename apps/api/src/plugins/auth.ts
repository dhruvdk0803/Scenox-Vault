import { hasPermission, type Permission } from '@scenox/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from './fp';
import { config } from '../config';
import { forbidden, unauthorized } from '../lib/errors';
import { extractApiKey, resolveApiKey, scopesAllow, type ResolvedApiKey } from '../services/api-keys';
import { resolveSession, type AuthUser } from '../services/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    authSession: { id: string; tokenHash: string; expiresAt: Date } | null;
    /** Set when the request was authenticated with an API key (then `user` is the key's creator). */
    apiKey: ResolvedApiKey | null;
  }
  interface FastifyInstance {
    /** preHandler: require a signed-in admin user via the session cookie. API keys are refused (403). */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler factory: require a permission via session cookie OR API key (key scopes AND role must both allow it) */
    requirePermission: (perm: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Like requirePermission, but API keys are always refused (403): developer settings, team, etc. */
    requireSessionPermission: (perm: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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

const API_KEY_RATE_LIMIT = 600; // requests per minute, per key
const INVALID_KEY = 'Invalid or expired API key.';

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.decorateRequest('apiKey', null);

  // One limiter instance for all API-key traffic, keyed by key id (not IP: agents share egress IPs).
  // Only applied where authentication runs, so tus / public portal routes are never throttled.
  const keyLimiter = app.hasDecorator('rateLimit')
    ? app.rateLimit({ max: API_KEY_RATE_LIMIT, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `apikey:${req.apiKey?.id ?? req.ip}` })
    : null;

  /** Resolve the caller from an API key (header) or the session cookie. Idempotent per request. */
  const resolveAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user) return;
    const rawKey = extractApiKey(req);
    if (rawKey !== null) {
      // API keys carry no cookies, so there is nothing for CSRF to protect: the Origin check is skipped.
      const found = await resolveApiKey(rawKey, req.ip);
      if (!found) throw unauthorized(INVALID_KEY);
      req.user = found.user;
      req.apiKey = found.key;
      if (config().rateLimitEnabled && keyLimiter) await keyLimiter.call(app, req, reply);
      return;
    }
    const s = await resolveSession(req);
    if (!s) throw unauthorized();
    assertSameOrigin(req);
    req.user = s.user;
    req.authSession = { id: s.sessionId, tokenHash: s.tokenHash, expiresAt: s.expiresAt };
  };

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    await resolveAuth(req, reply);
    if (req.apiKey) throw forbidden('This action is not available to API keys.');
  };

  const checkPermission = (req: FastifyRequest, perm: Permission) => {
    if (!hasPermission(req.user!.role, perm)) throw forbidden();
    if (req.apiKey && !scopesAllow(req.apiKey.scopes, perm)) throw forbidden('This API key does not have permission to do that.');
  };

  app.decorate('authenticate', authenticate);
  app.decorate('requirePermission', (perm: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
    await resolveAuth(req, reply);
    checkPermission(req, perm);
  });
  app.decorate('requireSessionPermission', (perm: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
    await authenticate(req, reply);
    checkPermission(req, perm);
  });
});
