import {
  fileCategory,
  type ActivityDTO,
  type AnalyticsDTO,
  type ClientDTO,
  type DashboardDTO,
  type FileStatus,
  type StorageDTO,
  type UploadSessionDTO,
} from '@scenox/shared';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import { activityLogs, clients, files, portals, uploadSessions } from '../db/schema';
import { parse } from '../lib/validate';
import { getStorage, KEYS } from '../storage';
import { toActivityDTO, toClientDTO, toUploadSessionDTO } from './mappers';
import { diskWarningLevel } from './system';

/** Files that count as stored in the vault. */
const STORED: FileStatus[] = ['ready', 'processing', 'quarantined'];

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const bigSum = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::float8`;
const count = () => sql<number>`count(*)::int`;

export async function getDashboard(): Promise<DashboardDTO> {
  const db = getDb();
  const now = new Date();
  const today = startOfToday();

  const [
    [{ n: clientCount }],
    [{ n: activePortals }],
    [{ n: fileCount }],
    [{ n: storageUsed }],
    [{ n: uploadsToday }],
    [{ n: bytesToday }],
    [{ n: activeSessions }],
    sessionRows,
    clientRows,
    activityRows,
    capacity,
  ] = await Promise.all([
    db.select({ n: count() }).from(clients),
    db
      .select({ n: count() })
      .from(portals)
      .where(and(eq(portals.status, 'active'), sql`(${portals.expiresAt} is null or ${portals.expiresAt} > ${now.toISOString()}::timestamptz)`)),
    db.select({ n: count() }).from(files).where(inArray(files.status, STORED)),
    db.select({ n: bigSum(clients.storageUsedBytes) }).from(clients),
    db.select({ n: count() }).from(uploadSessions).where(gte(uploadSessions.startedAt, today)),
    db
      .select({ n: bigSum(files.size) })
      .from(files)
      .where(and(isNotNull(files.completedAt), gte(files.completedAt, today), inArray(files.status, STORED))),
    db.select({ n: count() }).from(uploadSessions).where(eq(uploadSessions.status, 'active')),
    db
      .select({ s: uploadSessions, clientName: clients.name, portalName: portals.name })
      .from(uploadSessions)
      .innerJoin(clients, eq(clients.id, uploadSessions.clientId))
      .innerJoin(portals, eq(portals.id, uploadSessions.portalId))
      .orderBy(desc(uploadSessions.startedAt), desc(uploadSessions.id))
      .limit(8),
    db
      .select({ client: clients, portalCount: sql<number>`(select count(*)::int from portals where portals.client_id = clients.id)` })
      .from(clients)
      .orderBy(desc(clients.createdAt), desc(clients.id))
      .limit(6),
    db
      .select({ log: activityLogs, clientName: clients.name })
      .from(activityLogs)
      .leftJoin(clients, eq(clients.id, activityLogs.clientId))
      .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
      .limit(10),
    getStorage().capacity().catch(() => ({ totalBytes: 0, usedBytes: 0, freeBytes: 0, path: null })),
  ]);

  // Live progress for in-flight sessions: bytes received so far across the session's files.
  const activeIds = sessionRows.filter((r) => r.s.status === 'active').map((r) => r.s.id);
  const live = new Map<string, number>();
  if (activeIds.length) {
    const rows = await db
      .select({ id: files.uploadSessionId, bytes: bigSum(files.bytesReceived) })
      .from(files)
      .where(and(inArray(files.uploadSessionId, activeIds), inArray(files.status, ['uploading', 'processing', 'ready', 'quarantined'])))
      .groupBy(files.uploadSessionId);
    for (const r of rows) live.set(r.id, r.bytes);
  }

  const recentSessions: UploadSessionDTO[] = sessionRows.map((r) => {
    const dto = toUploadSessionDTO(r.s, { clientName: r.clientName, portalName: r.portalName });
    return r.s.status === 'active' ? { ...dto, uploadedBytes: live.get(r.s.id) ?? 0 } : dto;
  });
  const recentClients: ClientDTO[] = clientRows.map((r) => toClientDTO(r.client, { portalCount: r.portalCount }));
  const recentActivity: ActivityDTO[] = activityRows.map((r) => toActivityDTO(r.log, r.clientName));

  return {
    totals: { clients: clientCount, activePortals, files: fileCount, storageUsedBytes: storageUsed, uploadsToday, bytesToday, activeSessions },
    storage: {
      usedBytes: capacity.usedBytes,
      capacityBytes: capacity.totalBytes,
      freeBytes: capacity.freeBytes,
      warningLevel: await diskWarningLevel(capacity.usedBytes, capacity.totalBytes),
    },
    recentSessions,
    recentClients,
    recentActivity,
  };
}

// ───────────────────────── analytics ─────────────────────────

const analyticsQuery = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function getAnalytics(query: unknown): Promise<AnalyticsDTO> {
  const { days } = parse(analyticsQuery, query);
  const db = getDb();
  const now = new Date();
  // Day buckets are UTC so the series is stable regardless of server timezone.
  const fromDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const from = fromDay.toISOString();
  const storedIn = sql`${files.status} in ('ready','processing','quarantined')`;
  const inRange = and(isNotNull(files.completedAt), sql`${files.completedAt} >= ${from}::timestamptz`, storedIn);

  const [dailyRows, [sess], [fileTotals], topRows, typeRows, [{ n: storageUsedBytes }]] = await Promise.all([
    db.execute(sql`
      select to_char(d, 'YYYY-MM-DD') as date,
             coalesce(f.files, 0)::int as files,
             coalesce(f.bytes, 0)::float8 as bytes,
             coalesce(s.sessions, 0)::int as sessions
      from generate_series(${ymd(fromDay)}::timestamp, ${ymd(now)}::timestamp, interval '1 day') d
      left join (
        select (completed_at at time zone 'UTC')::date as day, count(*) as files, sum(size) as bytes
        from files
        where completed_at >= ${from}::timestamptz and status in ('ready','processing','quarantined')
        group by 1
      ) f on f.day = d::date
      left join (
        select (started_at at time zone 'UTC')::date as day, count(*) as sessions
        from upload_sessions
        where started_at >= ${from}::timestamptz
        group by 1
      ) s on s.day = d::date
      order by d`),
    db
      .select({
        sessions: count(),
        completed: sql<number>`count(*) filter (where ${uploadSessions.status} = 'completed')::int`,
        failed: sql<number>`count(*) filter (where ${uploadSessions.status} = 'failed')::int`,
        active: sql<number>`count(*) filter (where ${uploadSessions.status} = 'active')::int`,
        avgSpeed: sql<number | null>`(avg(${uploadSessions.avgSpeedBps}) filter (where ${uploadSessions.status} = 'completed' and ${uploadSessions.avgSpeedBps} is not null))::float8`,
      })
      .from(uploadSessions)
      .where(sql`${uploadSessions.startedAt} >= ${from}::timestamptz`),
    db.select({ files: count(), bytes: bigSum(files.size) }).from(files).where(inRange),
    db
      .select({ clientId: files.clientId, clientName: clients.name, bytes: bigSum(files.size), files: count() })
      .from(files)
      .innerJoin(clients, eq(clients.id, files.clientId))
      .where(inRange)
      .groupBy(files.clientId, clients.name)
      .orderBy(sql`sum(${files.size}) desc`)
      .limit(10),
    db.select({ ext: files.extension, files: count(), bytes: bigSum(files.size) }).from(files).where(inRange).groupBy(files.extension),
    db.select({ n: bigSum(clients.storageUsedBytes) }).from(clients),
  ]);

  const buckets = new Map<string, { type: string; files: number; bytes: number }>();
  for (const r of typeRows) {
    const type = fileCategory(r.ext);
    const b = buckets.get(type) ?? { type, files: 0, bytes: 0 };
    b.files += r.files;
    b.bytes += r.bytes;
    buckets.set(type, b);
  }

  return {
    range: { from, to: now.toISOString() },
    totals: {
      sessions: sess.sessions,
      completedSessions: sess.completed,
      failedSessions: sess.failed,
      activeSessions: sess.active,
      filesUploaded: fileTotals.files,
      bytesUploaded: fileTotals.bytes,
      avgSpeedBps: sess.avgSpeed == null ? null : Math.round(sess.avgSpeed),
      storageUsedBytes,
    },
    daily: (dailyRows as unknown as { date: string; files: number; bytes: number; sessions: number }[]).map((r) => ({
      date: r.date,
      files: Number(r.files),
      bytes: Number(r.bytes),
      sessions: Number(r.sessions),
    })),
    topClients: topRows,
    fileTypes: [...buckets.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

// ───────────────────────── storage ─────────────────────────

export async function getStorageOverview(): Promise<StorageDTO> {
  const db = getDb();
  const storage = getStorage();
  const [capacity, statusRows, clientRows, [incomplete], exportsUsage] = await Promise.all([
    storage.capacity().catch(() => ({ totalBytes: 0, usedBytes: 0, freeBytes: 0, path: null })),
    db.select({ status: files.status, files: count(), bytes: bigSum(files.size) }).from(files).groupBy(files.status),
    db
      .select({ clientId: clients.id, clientName: clients.name, quotaBytes: clients.quotaBytes, files: count(), bytes: bigSum(files.size) })
      .from(files)
      .innerJoin(clients, eq(clients.id, files.clientId))
      .where(inArray(files.status, STORED))
      .groupBy(clients.id, clients.name, clients.quotaBytes)
      .orderBy(sql`sum(${files.size}) desc`)
      .limit(50),
    db
      .select({ files: count(), bytes: bigSum(files.bytesReceived) })
      .from(files)
      .where(eq(files.status, 'uploading')),
    storage.sizeOfPrefix(KEYS.exports).catch(() => ({ bytes: 0, files: 0 })),
  ]);
  const vaultUsedBytes = statusRows.filter((r) => STORED.includes(r.status)).reduce((a, r) => a + r.bytes, 0);
  return {
    driver: storage.driver,
    disk: { totalBytes: capacity.totalBytes, usedBytes: capacity.usedBytes, freeBytes: capacity.freeBytes, path: capacity.path },
    vaultUsedBytes,
    byStatus: statusRows,
    byClient: clientRows,
    temp: { incompleteUploads: incomplete.files, incompleteBytes: incomplete.bytes, exportsBytes: exportsUsage.bytes },
    warningLevel: await diskWarningLevel(capacity.usedBytes, capacity.totalBytes),
  };
}
