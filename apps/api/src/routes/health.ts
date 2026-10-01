import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { getDb } from '../db';
import { getRedis } from '../queue';

async function timed<T>(fn: () => Promise<T>) {
  const t = performance.now();
  try {
    await fn();
    return { status: 'ok' as const, latencyMs: Math.round(performance.now() - t) };
  } catch (err) {
    return { status: 'down' as const, latencyMs: null, message: (err as Error).message };
  }
}

/** Liveness (/health) and readiness (/ready: database, redis, storage writable). */
export default async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', version: config().version, uptimeSeconds: Math.round(process.uptime()) }));

  const ready = async (_req: unknown, reply: import('fastify').FastifyReply) => {
    const checks = {
      database: await timed(() => getDb().execute(sql`select 1`)),
      redis: await timed(() => getRedis().ping()),
      storage: await timed(async () => {
        const probe = path.join(config().storage.path, '.ready-probe');
        await fs.writeFile(probe, String(Date.now()));
        await fs.rm(probe, { force: true });
      }),
    };
    const ok = Object.values(checks).every((c) => c.status === 'ok');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable', checks });
  };
  app.get('/ready', ready);
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', ready);
}
