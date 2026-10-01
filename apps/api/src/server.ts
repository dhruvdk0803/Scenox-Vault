import { buildApp } from './app';
import { config } from './config';
import { closeDb } from './db';
import { runMigrations } from './db/migrate';
import { logger } from './lib/logger';
import { closeQueues } from './queue';
import { initStorage } from './storage';

async function main() {
  const cfg = config();
  await initStorage();
  if (process.env.MIGRATE_ON_START !== 'false') {
    await runMigrations();
    logger.info('database migrations applied');
  }
  const app = await buildApp();
  // Large uploads: never let Node's default timeouts cut a slow chunk.
  app.server.requestTimeout = 0;
  app.server.headersTimeout = 60_000;
  app.server.keepAliveTimeout = 75_000;
  app.server.timeout = cfg.upload.timeoutMs;

  await app.listen({ host: cfg.host, port: cfg.port });
  logger.info({ port: cfg.port, storage: cfg.storage.path, env: cfg.env }, 'Scenox Vault API listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close().catch(() => {});
    await closeQueues();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start API');
  process.exit(1);
});
