import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { notFound } from '../lib/errors';

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/DEVELOPER_API.md (copied at build time; the Docker image has no docs/) → repo docs/ in development. */
const CANDIDATES = [
  path.resolve(here, 'DEVELOPER_API.md'),
  path.resolve(here, '../DEVELOPER_API.md'),
  path.resolve(here, '../../../../docs/DEVELOPER_API.md'),
  path.resolve(process.cwd(), '../../docs/DEVELOPER_API.md'),
  path.resolve(process.cwd(), 'docs/DEVELOPER_API.md'),
];

let cached: string | null = null;
function loadDocs(): string | null {
  if (cached !== null) return cached;
  for (const p of CANDIDATES) {
    try {
      cached = fs.readFileSync(p, 'utf8');
      return cached;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/** Public, machine-readable developer guide: GET /api/docs → Markdown. */
export default async function docsRoutes(app: FastifyInstance) {
  app.get('/docs', async (_req, reply) => {
    const md = loadDocs();
    if (md === null) throw notFound('The developer documentation is not available on this server.');
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(md.replaceAll('https://<your-domain>', config().appUrl));
  });
}
