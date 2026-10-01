import { DelayedError, Worker, type Job, type Processor } from 'bullmq';
import { config } from '../config';
import { closeDb } from '../db';
import { logger } from '../lib/logger';
import { closeQueues, getQueue, getRedis, QUEUES, type JobName, type JobPayloads, type QueueName } from '../queue';
import { buildExportZip } from '../services/exports';
import { deliverNotification } from '../services/notifications';
import { runCleanup } from './cleanup';
import { markFileFailed, processFile } from './process-file';
import { processSessionComplete, SESSION_COMPLETE_RETRY_MS } from './session-complete';
import { runStorageCheck } from './storage-check';

export { processFile, markFileFailed } from './process-file';
export { processSessionComplete } from './session-complete';
export { runCleanup } from './cleanup';
export { runStorageCheck } from './storage-check';
export { buildExportZip } from '../services/exports';

const CLEANUP_EVERY_MS = 15 * 60_000;
const STORAGE_CHECK_EVERY_MS = 10 * 60_000;

type Handler = (job: Job, token?: string) => Promise<unknown>;

const handlers: Record<JobName, Handler> = {
  'process-file': (job) => processFile((job.data as JobPayloads['process-file']).fileId),
  'session-complete': async (job, token) => {
    const result = await processSessionComplete((job.data as JobPayloads['session-complete']).sessionId);
    if (result === 'wait') {
      // files are still being processed: re-run in 30 s without consuming an attempt
      await job.moveToDelayed(Date.now() + SESSION_COMPLETE_RETRY_MS, token);
      throw new DelayedError();
    }
    return result;
  },
  'send-notification': (job) => deliverNotification((job.data as JobPayloads['send-notification']).notificationId),
  'build-zip': (job) => buildExportZip((job.data as JobPayloads['build-zip']).exportId),
  cleanup: () => runCleanup(),
  'storage-check': () => runStorageCheck(),
};

const dispatch: Processor = async (job, token) => {
  const handler = handlers[job.name as JobName];
  if (!handler) throw new Error(`Unknown job "${job.name}"`);
  return handler(job, token);
};

/** Start one worker per queue plus the repeatable maintenance schedulers. Returns a stop() function. */
export async function startWorkers(): Promise<() => Promise<void>> {
  const cfg = config();
  const connection = getRedis();
  const plan: [QueueName, number][] = [
    [QUEUES.fileProcessing, Math.max(1, cfg.workerConcurrency)],
    [QUEUES.notifications, Math.max(1, cfg.workerConcurrency)],
    [QUEUES.exports, 1],
    [QUEUES.maintenance, 1],
  ];

  const workers = plan.map(([queue, concurrency]) => {
    const worker = new Worker(queue, dispatch, { connection, concurrency, lockDuration: 120_000 });
    worker.on('failed', (job, err) => {
      const attempts = job?.opts.attempts ?? 1;
      const exhausted = !!job && job.attemptsMade >= attempts;
      logger.error({ queue, jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, attempts, exhausted, data: job?.data, err }, 'job failed');
      if (exhausted && job?.name === 'process-file') {
        void markFileFailed((job.data as JobPayloads['process-file']).fileId, 'File processing failed.').catch((e) =>
          logger.error({ err: e }, 'failed to mark file as failed'),
        );
      }
    });
    worker.on('error', (err) => logger.error({ queue, err }, 'worker error'));
    return worker;
  });

  const maintenance = getQueue(QUEUES.maintenance);
  const tmpl = { removeOnComplete: true, removeOnFail: 50, attempts: 1 };
  await maintenance.upsertJobScheduler('cleanup-every-15m', { every: CLEANUP_EVERY_MS }, { name: 'cleanup', data: {}, opts: tmpl });
  await maintenance.upsertJobScheduler('storage-check-every-10m', { every: STORAGE_CHECK_EVERY_MS }, { name: 'storage-check', data: {}, opts: tmpl });

  logger.info({ workers: plan.map(([q, c]) => `${q}x${c}`) }, 'workers started');

  return async () => {
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await closeDb();
  };
}
