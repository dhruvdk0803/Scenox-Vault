import { formatBytes } from '@scenox/shared';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { getDb } from '../db';
import { files, type Client, type Portal } from '../db/schema';
import { getSettings } from './settings';

type DbLike = Pick<ReturnType<typeof getDb>, 'select'>;

const positive = (n: number | null | undefined): number | null => (typeof n === 'number' && n > 0 ? n : null);
const minOf = (...vals: (number | null)[]): number | null => {
  const v = vals.filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
};

/** Effective per-file size limit: min of portal limit, MAX_FILE_SIZE and the settings default. null = unlimited. */
export async function effectiveMaxFileSize(portal: Pick<Portal, 'maxFileSizeBytes'>): Promise<number | null> {
  const s = await getSettings();
  return minOf(positive(portal.maxFileSizeBytes), positive(config().limits.maxFileSize), positive(s.uploads.defaultMaxFileSizeBytes));
}

export interface QuotaState {
  /** bytes already stored for the portal */
  usedBytes: number;
  /** bytes of uploads currently in flight (declared size of files in status "uploading") */
  inflightBytes: number;
  /** effective limit expressed as usedBytes + remaining; null when unlimited */
  limitBytes: number | null;
  /** bytes that may still be accepted; null when unlimited */
  remainingBytes: number | null;
}

/**
 * Effective storage quota for a portal: min of (portal limit [or settings default], MAX_PORTAL_SIZE,
 * remaining client quota). `includeInflight` also subtracts the declared size of uploads that are
 * still in progress, so parallel uploads cannot over-commit the quota.
 */
export async function getQuota(
  portal: Pick<Portal, 'id' | 'clientId' | 'maxTotalBytes' | 'storageUsedBytes'>,
  client: Pick<Client, 'id' | 'quotaBytes' | 'storageUsedBytes'>,
  opts: { includeInflight?: boolean; db?: DbLike } = {},
): Promise<QuotaState> {
  const s = await getSettings();
  let inflightPortal = 0;
  let inflightClient = 0;
  if (opts.includeInflight) {
    const db = opts.db ?? getDb();
    const [row] = await db
      .select({
        portal: sql<string>`coalesce(sum(${files.size}) filter (where ${files.portalId} = ${portal.id}), 0)`,
        client: sql<string>`coalesce(sum(${files.size}), 0)`,
      })
      .from(files)
      .where(and(eq(files.clientId, client.id), eq(files.status, 'uploading')));
    inflightPortal = Number(row?.portal ?? 0);
    inflightClient = Number(row?.client ?? 0);
  }
  const portalLimit = minOf(positive(portal.maxTotalBytes) ?? positive(s.uploads.defaultPortalQuotaBytes), positive(config().limits.maxPortalSize));
  const portalRemaining = portalLimit === null ? null : portalLimit - Number(portal.storageUsedBytes) - inflightPortal;
  const clientLimit = positive(client.quotaBytes);
  const clientRemaining = clientLimit === null ? null : clientLimit - Number(client.storageUsedBytes) - inflightClient;
  const remaining = minOf(portalRemaining, clientRemaining);
  const usedBytes = Number(portal.storageUsedBytes);
  return {
    usedBytes,
    inflightBytes: inflightPortal,
    remainingBytes: remaining === null ? null : Math.max(0, remaining),
    limitBytes: remaining === null ? null : usedBytes + Math.max(0, remaining),
  };
}

export function quotaMessage(remaining: number | null): string {
  if (remaining === null) return 'This upload would exceed the available storage for this portal.';
  if (remaining <= 0) return 'This upload link has reached its storage limit. Please contact the person who sent you the link.';
  return `Not enough storage left on this upload link (${formatBytes(remaining)} remaining). Please upload fewer or smaller files.`;
}
