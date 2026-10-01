import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { AppError } from './lib/errors';
import { logger, redactUrl } from './lib/logger';
import authPlugin from './plugins/auth';
import { getRedis } from './queue';
import activityRoutes from './routes/activity';
import authRoutes from './routes/auth';
import clientRoutes from './routes/clients';
import dashboardRoutes from './routes/dashboard';
import fileRoutes from './routes/files';
import healthRoutes from './routes/health';
import messageRoutes from './routes/messages';
import portalRoutes from './routes/portals';
import publicRoutes from './routes/public';
import settingsRoutes from './routes/settings';
import tusRoutes from './routes/tus';
import uploadRoutes from './routes/uploads';
import userRoutes from './routes/users';

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: (_addr: string, hop: number) => hop < cfg.trustProxy,
    // JSON bodies are small; upload bytes go through tus which bypasses body parsing entirely.
    bodyLimit: 2 * 1024 * 1024,
    genReqId: (req) => (req.headers['x-request-id'] as string)?.slice(0, 64) || randomUUID(),
    requestIdHeader: false,
    disableRequestLogging: true,
    routerOptions: { maxParamLength: 256 },
  });

  // structured access log without secrets (tokens in URLs are redacted)
  app.addHook('onResponse', (req, reply, done) => {
    if (req.url.startsWith('/health') || req.url.startsWith('/ready')) return done();
    req.log.info(
      { reqId: req.id, method: req.method, url: redactUrl(req.url), status: reply.statusCode, durationMs: Math.round(reply.elapsedTime), userId: req.user?.id },
      'request',
    );
    done();
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, {
    // API returns JSON / file streams only; the web app sets its own CSP.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: cfg.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || cfg.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type', 'x-requested-with', 'x-upload-session', 'x-portal-access', 'x-request-id',
      // tus protocol
      'tus-resumable', 'upload-length', 'upload-metadata', 'upload-offset', 'upload-defer-length', 'upload-concat', 'x-http-method-override',
    ],
    exposedHeaders: ['location', 'upload-offset', 'upload-length', 'tus-resumable', 'tus-version', 'tus-max-size', 'tus-extension', 'upload-metadata', 'upload-expires', 'x-request-id', 'content-disposition'],
    maxAge: 86400,
  });
  await app.register(cookie, { secret: cfg.sessionSecret });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, {
    global: false, // opt-in per route — upload data streams are never rate limited
    redis: cfg.isTest ? undefined : getRedis(),
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Too many requests. Please try again in ${Math.ceil(ctx.ttl / 1000)} seconds.` },
    }),
  });
  await app.register(authPlugin);

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Please wait a moment and try again.', requestId: req.id } });
    }
    if (status < 500) {
      const code = err.validation ? 'validation_error' : err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'too_large' : 'bad_request';
      return reply.status(status).send({ error: { code, message: status === 413 ? 'The request is too large.' : 'The request was invalid.', requestId: req.id } });
    }
    req.log.error({ err, reqId: req.id, url: redactUrl(req.url) }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.', requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found.', requestId: req.id } }));

  await app.register(healthRoutes);
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(clientRoutes, { prefix: '/clients' });
      await api.register(portalRoutes, { prefix: '/portals' });
      await api.register(messageRoutes, { prefix: '/messages' });
      await api.register(uploadRoutes, { prefix: '/uploads' });
      await api.register(fileRoutes); // /files/*, /exports/*
      await api.register(activityRoutes); // /activity, /audit, /notifications
      await api.register(dashboardRoutes); // /dashboard, /analytics, /storage, /system
      await api.register(settingsRoutes, { prefix: '/settings' });
      await api.register(publicRoutes, { prefix: '/public' });
      await api.register(tusRoutes, { prefix: '/tus' });
    },
    { prefix: '/api' },
  );

  return app;
}
