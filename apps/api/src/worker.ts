import { logger } from './lib/logger';
import { startWorkers } from './jobs';
import { initStorage } from './storage';

process.env.SERVICE_NAME ??= 'worker';

async function main() {
  await initStorage();
  const stop = await startWorkers();
  logger.info('Scenox Vault worker started');
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
