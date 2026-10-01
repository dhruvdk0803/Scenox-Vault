import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { createTusServer, findFinishedUpload } from '../services/tus';

/**
 * tus 1.0.0 endpoint. The Fastify layer only hands the raw Node request/response to @tus/server,
 * which streams PATCH bodies straight to disk. No body parsing, no buffering, no rate limit.
 */
export default async function tusRoutes(app: FastifyInstance) {
  const { server } = createTusServer();

  // Never consume the upload body: tus reads it from the raw request stream.
  app.addContentTypeParser('application/offset+octet-stream', (_req, _payload, done) => done(null));

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    // A HEAD for an upload that already finished (final response lost) reports it as complete,
    // so the client stops instead of creating a duplicate.
    if (req.method === 'HEAD') {
      let id = '';
      try {
        id = decodeURIComponent((req.url.split('?')[0] ?? '').replace(/\/+$/, '').split('/').pop() ?? '');
      } catch {
        /* malformed escape: let tus answer 404 */
      }
      // only ids we generate (hex) are looked up; anything else falls through to tus (404)
      if (/^[A-Za-z0-9_-]{8,128}$/.test(id) && req.headers['tus-resumable']) {
        try {
          const done = await findFinishedUpload(req.headers['x-upload-session'] as string | undefined, id);
          if (done) {
            return reply
              .code(200)
              .headers({
                'tus-resumable': '1.0.0',
                'cache-control': 'no-store',
                'upload-offset': String(done.size),
                'upload-length': String(done.size),
              })
              .send();
          }
        } catch (err) {
          if (err instanceof AppError) {
            return reply.code(err.statusCode).header('tus-resumable', '1.0.0').send({ error: { code: err.code, message: err.message } });
          }
          throw err;
        }
      }
    }

    reply.hijack();
    try {
      await server.handle(req.raw, reply.raw);
    } catch (err) {
      logger.error({ err, reqId: req.id }, 'tus handler crashed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' } }));
      } else {
        reply.raw.destroy();
      }
    }
  };

  const methods = ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'] as const;
  app.route({ method: [...methods], url: '/', handler });
  app.route({ method: [...methods], url: '/*', handler });
}
