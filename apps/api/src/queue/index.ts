import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config';

/**
 * Background job queues (BullMQ on Redis). Nothing in the upload hot path waits on these.
 *
 *  file-processing : process-file      — checksum (SHA-256), MIME sniff, virus scan, duplicate detection, move to permanent storage
 *  notifications   : session-complete  — build + send "upload completed" emails / in-app notifications
 *                    send-notification — deliver one notifications row (email)
 *  exports         : build-zip         — stream selected files into a ZIP in STORAGE/exports
 *  maintenance     : cleanup           — abandoned tus uploads, stale sessions, expired exports, retention, disk alerts
 */
export const QUEUES = {
  fileProcessing: 'file-processing',
  notifications: 'notifications',
  exports: 'exports',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  'process-file': { fileId: string };
  'session-complete': { sessionId: string };
  'send-notification': { notificationId: string };
  'build-zip': { exportId: string };
  cleanup: Record<string, never>;
  'storage-check': Record<string, never>;
}
export type JobName = keyof JobPayloads;

const JOB_QUEUE: Record<JobName, QueueName> = {
  'process-file': QUEUES.fileProcessing,
  'session-complete': QUEUES.notifications,
  'send-notification': QUEUES.notifications,
  'build-zip': QUEUES.exports,
  cleanup: QUEUES.maintenance,
  'storage-check': QUEUES.maintenance,
};

let connection: Redis | null = null;
export function getRedis(): Redis {
  if (!connection) {
    connection = new Redis(config().redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
  }
  return connection;
}

const queues = new Map<QueueName, Queue>();
export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue<N extends JobName>(name: N, data: JobPayloads[N], opts?: JobsOptions) {
  return getQueue(JOB_QUEUE[name]).add(name, data, opts);
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => {});
    connection = null;
  }
}
