import type { ScanStatus } from '@scenox/shared';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { config } from '../config';
import { getDb } from '../db';
import { files } from '../db/schema';
import { logActivity } from '../lib/activity';
import { logger } from '../lib/logger';
import { KEYS, getStorage } from '../storage';
import { appLink, notifyAdmins } from '../services/notifications';
import { scanWithClamd } from '../services/scanner';
import { bumpCounters } from '../services/uploads';

const SNIFF_BYTES = 4100;

/** Stream a file once: SHA-256 + the first bytes for MIME sniffing. Never loads the file into memory. */
export async function hashAndSniff(path: string): Promise<{ sha256: string; head: Buffer; bytes: number }> {
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headLen = 0;
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
    if (headLen < SNIFF_BYTES) {
      const part = chunk.subarray(0, SNIFF_BYTES - headLen);
      head.push(part);
      headLen += part.length;
    }
  }
  return { sha256: hash.digest('hex'), head: Buffer.concat(head), bytes };
}

async function sniffMime(head: Buffer): Promise<string | null> {
  if (head.length === 0) return null;
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    return (await fileTypeFromBuffer(head))?.mime ?? null;
  } catch (err) {
    logger.warn({ err }, 'mime sniffing failed');
    return null;
  }
}

/**
 * Post-upload processing: checksum, MIME sniff, virus scan, duplicate detection, move to permanent
 * storage. Idempotent — safe to retry, and a no-op for files that are no longer "processing".
 */
export async function processFile(fileId: string): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const cfg = config();
  const [f] = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  if (!f || f.status !== 'processing') return;

  const finalKey = KEYS.fileKey(f.clientId, f.portalId, f.uploadSessionId, f.storedFilename);
  const quarantineKey = KEYS.quarantineKey(f.storedFilename);
  // a previous attempt may already have moved the bytes
  let sourceKey: string | null = null;
  for (const k of [f.storageKey, KEYS.stagingKey(f.storedFilename), finalKey, quarantineKey]) {
    if (k && (await storage.exists(k))) {
      sourceKey = k;
      break;
    }
  }
  if (!sourceKey) throw new Error(`file bytes not found for ${fileId}`);
  const sourcePath = storage.localPath!(sourceKey);

  const { sha256, head, bytes } = await hashAndSniff(sourcePath);
  if (bytes !== Number(f.size)) throw new Error(`size mismatch while processing ${fileId}: ${bytes} != ${f.size}`);
  const detectedMime = await sniffMime(head);

  let scanStatus: ScanStatus = 'skipped';
  let scanResult: string | null = null;
  let infected = false;
  if (cfg.clamav.enabled) {
    await db.update(files).set({ scanStatus: 'scanning' }).where(eq(files.id, fileId));
    try {
      const r = await scanWithClamd(sourcePath, { host: cfg.clamav.host, port: cfg.clamav.port });
      if (r.status === 'infected') {
        scanStatus = 'infected';
        scanResult = r.signature;
        infected = true;
      } else {
        scanStatus = 'clean';
      }
    } catch (err) {
      // scanner trouble must not lose the upload: keep the file, record that it was not scanned
      logger.error({ err, fileId }, 'virus scan failed; file kept without scan');
      scanStatus = 'failed';
      scanResult = 'The virus scanner could not be reached.';
    }
  }

  const destKey = infected ? quarantineKey : finalKey;
  if (sourceKey !== destKey) await storage.move(sourceKey, destKey);

  let duplicateOfId: string | null = null;
  if (!infected) {
    const [dup] = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.clientId, f.clientId), eq(files.checksumSha256, sha256), eq(files.status, 'ready'), ne(files.id, f.id)))
      .orderBy(asc(files.createdAt))
      .limit(1);
    duplicateOfId = dup?.id ?? null;
  }

  const [updated] = await db
    .update(files)
    .set({
      checksumSha256: sha256,
      detectedMime,
      scanStatus,
      scanResult,
      duplicateOfId,
      storageKey: destKey,
      status: infected ? 'quarantined' : 'ready',
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(files.id, fileId), eq(files.status, 'processing')))
    .returning({ id: files.id });

  if (!updated) {
    // deleted (or otherwise changed) while we were working: don't leave orphaned bytes behind
    await storage.delete(destKey).catch(() => {});
    return;
  }

  if (infected) {
    await logActivity({
      actorType: 'system',
      action: 'file.quarantined',
      resourceType: 'file',
      resourceId: f.id,
      clientId: f.clientId,
      portalId: f.portalId,
      metadata: { filename: f.originalFilename, signature: scanResult },
    });
    await notifyAdmins({
      type: 'file_quarantined',
      subject: `File quarantined — ${f.originalFilename}`,
      body: `The virus scanner flagged "${f.originalFilename}" (${scanResult}). The file was moved to quarantine and can't be downloaded.`,
      link: appLink(`/uploads?session=${f.uploadSessionId}`),
      clientId: f.clientId,
      uploadSessionId: f.uploadSessionId,
    }).catch((err) => logger.error({ err, fileId }, 'failed to notify about quarantined file'));
  }
}

/** Give up on a file after its retries are exhausted: mark failed, release its counted bytes. */
export async function markFileFailed(fileId: string, reason: string): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const failed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(files)
      .set({ status: 'failed', error: reason.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(files.id, fileId), eq(files.status, 'processing')))
      .returning();
    if (!row) return null;
    await bumpCounters(tx, row, -1, -Number(row.size));
    await tx.execute(sql`update upload_sessions set failed_files = failed_files + 1 where id = ${row.uploadSessionId}`);
    return row;
  });
  if (failed) {
    for (const k of [failed.storageKey, KEYS.stagingKey(failed.storedFilename)]) if (k) await storage.delete(k).catch(() => {});
    await logActivity({
      actorType: 'system',
      action: 'upload.failed',
      resourceType: 'file',
      resourceId: fileId,
      clientId: failed.clientId,
      portalId: failed.portalId,
      result: 'failure',
      metadata: { filename: failed.originalFilename },
    });
  }
}
