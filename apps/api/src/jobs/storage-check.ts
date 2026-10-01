import { formatBytes } from '@scenox/shared';
import { logger } from '../lib/logger';
import { getRedis } from '../queue';
import { appLink, notifyAdmins } from '../services/notifications';
import { getSettings } from '../services/settings';
import { getStorage } from '../storage';

export type DiskLevel = 'ok' | 'warning' | 'critical';
const ALERT_TTL_SECONDS = 24 * 3600;

export async function runStorageCheck(): Promise<{ level: DiskLevel; percent: number; alerted: boolean }> {
  const cap = await getStorage().capacity();
  const percent = cap.totalBytes > 0 ? (cap.usedBytes / cap.totalBytes) * 100 : 0;
  const { notifications } = await getSettings();
  const level: DiskLevel = percent >= notifications.diskCriticalPercent ? 'critical' : percent >= notifications.diskWarningPercent ? 'warning' : 'ok';
  if (level === 'ok') return { level, percent, alerted: false };

  // at most one alert per level per 24 h
  const acquired = await getRedis().set(`scenox:disk-alert:${level}`, String(Date.now()), 'EX', ALERT_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') return { level, percent, alerted: false };

  const pct = percent.toFixed(1);
  try {
    await notifyAdmins({
      type: level === 'critical' ? 'disk_critical' : 'disk_warning',
      subject: level === 'critical' ? `Storage almost full — ${pct}% used` : `Storage is filling up — ${pct}% used`,
      body: `The Vault storage volume is ${pct}% full (${formatBytes(cap.usedBytes)} of ${formatBytes(cap.totalBytes)} used, ${formatBytes(cap.freeBytes)} free).${
        level === 'critical' ? ' New uploads may start failing. Free up space or add capacity as soon as possible.' : ' Consider freeing up space or adding capacity.'
      }`,
      link: appLink('/'),
    });
  } catch (err) {
    logger.error({ err }, 'failed to send disk alert');
    await getRedis().del(`scenox:disk-alert:${level}`).catch(() => {});
    throw err;
  }
  return { level, percent, alerted: true };
}
