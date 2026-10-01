import type { SystemHealthDTO } from '@scenox/shared';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config';
import { getDb } from '../db';
import { getQueue, getRedis, QUEUES } from '../queue';
import { getStorage } from '../storage';
import { verifyMail } from './mailer';
import { getSettings } from './settings';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type WarningLevel = 'ok' | 'warning' | 'critical';

export async function diskWarningLevel(usedBytes: number, totalBytes: number): Promise<WarningLevel> {
  if (!totalBytes) return 'ok';
  const { notifications } = await getSettings();
  const pct = (usedBytes / totalBytes) * 100;
  if (pct >= notifications.diskCriticalPercent) return 'critical';
  if (pct >= notifications.diskWarningPercent) return 'warning';
  return 'ok';
}

// ───────────────────────── samplers ─────────────────────────

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

async function sampleCpuUsage(ms = 200): Promise<number> {
  const a = cpuTimes();
  await sleep(ms);
  const b = cpuTimes();
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / total) * 100)) * 10) / 10;
}

async function readNetBytes(): Promise<{ rx: number; tx: number } | null> {
  try {
    const text = await fs.readFile('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const [iface, rest] = line.split(':');
      if (!rest || iface.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0] || 0;
      tx += f[8] || 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

async function sampleNetwork(ms = 250): Promise<{ rxBytesPerSec: number | null; txBytesPerSec: number | null }> {
  const a = await readNetBytes();
  if (!a) return { rxBytesPerSec: null, txBytesPerSec: null };
  const t0 = performance.now();
  await sleep(ms);
  const b = await readNetBytes();
  if (!b) return { rxBytesPerSec: null, txBytesPerSec: null };
  const secs = (performance.now() - t0) / 1000;
  return { rxBytesPerSec: Math.max(0, Math.round((b.rx - a.rx) / secs)), txBytesPerSec: Math.max(0, Math.round((b.tx - a.tx) / secs)) };
}

// ───────────────────────── checks ─────────────────────────

type Check = SystemHealthDTO['checks'][number];
type CheckName = Check['name'];

async function timed(name: CheckName, fn: () => Promise<string | void>): Promise<Check> {
  const t = performance.now();
  try {
    const message = await fn();
    return { name, status: 'ok', latencyMs: Math.round(performance.now() - t), ...(message ? { message } : {}) };
  } catch (err) {
    return { name, status: 'down', latencyMs: null, message: (err as Error).message.slice(0, 200) };
  }
}

async function clamavCheck(): Promise<Check> {
  const { enabled, host, port } = config().clamav;
  if (!enabled) return { name: 'clamav', status: 'disabled', latencyMs: null, message: 'Virus scanning is not enabled' };
  return timed('clamav', () =>
    new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host, port });
      let buf = '';
      const done = (err?: Error) => {
        socket.destroy();
        err ? reject(err) : resolve();
      };
      socket.setTimeout(2000, () => done(new Error('ClamAV timed out')));
      socket.on('error', (e) => done(e));
      socket.on('connect', () => socket.write('zPING\0'));
      socket.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('PONG')) done();
        else if (buf.length > 64) done(new Error('Unexpected ClamAV response'));
      });
      socket.on('close', () => done(new Error('ClamAV closed the connection')));
    }),
  );
}

let smtpCache: { at: number; check: Check } | null = null;
async function smtpCheck(): Promise<Check> {
  if (!config().smtp.enabled) return { name: 'smtp', status: 'disabled', latencyMs: null, message: 'Email is not configured' };
  if (smtpCache && Date.now() - smtpCache.at < 60_000) return smtpCache.check;
  const check = await timed('smtp', async () => {
    const err = await verifyMail();
    if (err) throw new Error(err);
  });
  smtpCache = { at: Date.now(), check };
  return check;
}

export async function runChecks(): Promise<Check[]> {
  return Promise.all([
    timed('database', async () => void (await getDb().execute(sql`select 1`))),
    timed('redis', async () => void (await getRedis().ping())),
    timed('storage', async () => {
      const storage = getStorage();
      const probe = path.posix.join('exports', `.health-probe-${process.pid}-${Date.now()}`);
      await storage.put(probe, Buffer.from('ok'));
      await storage.delete(probe);
    }),
    timed('worker', async () => {
      const workers = await getQueue(QUEUES.fileProcessing).getWorkers();
      if (workers.length === 0) throw new Error('No worker process connected');
    }),
    clamavCheck(),
    smtpCheck(),
  ]);
}

async function queueStats(): Promise<SystemHealthDTO['queues']> {
  return Promise.all(
    Object.values(QUEUES).map(async (name) => {
      try {
        const c = await getQueue(name).getJobCounts('waiting', 'active', 'failed', 'completed');
        return { name, waiting: c.waiting ?? 0, active: c.active ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0 };
      } catch {
        return { name, waiting: 0, active: 0, failed: 0, completed: 0 };
      }
    }),
  );
}

export async function getSystemHealth(): Promise<SystemHealthDTO> {
  const [cpuUsage, network, checks, queues, disk] = await Promise.all([
    sampleCpuUsage(),
    sampleNetwork(),
    runChecks(),
    queueStats(),
    getStorage().capacity().catch(() => ({ totalBytes: 0, usedBytes: 0, freeBytes: 0 })),
  ]);
  const total = os.totalmem();
  const free = os.freemem();
  const [l1, l5, l15] = os.loadavg();
  const dbDown = checks.find((c) => c.name === 'database')?.status === 'down';
  const status: SystemHealthDTO['status'] = dbDown ? 'down' : checks.some((c) => c.status === 'down') ? 'degraded' : 'ok';
  return {
    status,
    version: config().version,
    uptimeSeconds: Math.round(process.uptime()),
    cpu: { cores: os.cpus().length, loadAvg: [round2(l1), round2(l5), round2(l15)], usagePercent: cpuUsage },
    memory: { totalBytes: total, usedBytes: total - free, freeBytes: free, processRssBytes: process.memoryUsage().rss },
    disk: { totalBytes: disk.totalBytes, usedBytes: disk.usedBytes, freeBytes: disk.freeBytes },
    network,
    checks,
    queues,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
