import { DEFAULT_BLOCKED_EXTENSIONS, type Branding, type SettingsDTO, type UpdateSettingsRequest } from '@scenox/shared';
import { config } from '../config';
import { getDb } from '../db';
import { settings } from '../db/schema';

/** Settings are persisted as one JSON document per section in the `settings` table. */
type Sections = Omit<SettingsDTO, 'smtpConfigured' | 'clamavEnabled'> & {
  branding: Branding & { logoKey?: string | null; faviconKey?: string | null };
};

export const DEFAULT_SETTINGS: Sections = {
  branding: {
    companyName: 'Scenox Vault',
    logoUrl: null,
    faviconUrl: null,
    primaryColor: '#4F46E5',
    portalTitle: 'Secure File Upload',
    supportEmail: null,
    logoKey: null,
    faviconKey: null,
  },
  notifications: {
    adminEmails: [],
    notifyOnUploadComplete: true,
    notifyOnUploadFailed: true,
    notifyClientReceipt: false,
    diskWarningPercent: 85,
    diskCriticalPercent: 95,
  },
  security: {
    blockedExtensions: DEFAULT_BLOCKED_EXTENSIONS,
    blockExecutables: true,
    adminSessionHours: 12,
    portalSessionHours: 72,
  },
  retention: {
    incompleteUploadHours: 72,
    exportHours: 24,
    activityLogDays: 365,
  },
  uploads: {
    defaultMaxFileSizeBytes: null,
    defaultPortalQuotaBytes: null,
  },
};

const SECTIONS = Object.keys(DEFAULT_SETTINGS) as (keyof Sections)[];
let cache: { at: number; value: Sections } | null = null;
const TTL_MS = 10_000;

export async function getSettings(): Promise<Sections> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await getDb().select().from(settings);
  const value = structuredClone(DEFAULT_SETTINGS);
  for (const row of rows) {
    const k = row.key as keyof Sections;
    if (SECTIONS.includes(k)) Object.assign(value[k], row.value as object);
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSettings(patch: UpdateSettingsRequest & { branding?: Partial<Sections['branding']> }, userId?: string) {
  const current = await getSettings();
  const db = getDb();
  for (const k of SECTIONS) {
    const p = (patch as Record<string, unknown>)[k];
    if (!p) continue;
    const next = { ...current[k], ...(p as object) };
    await db
      .insert(settings)
      .values({ key: k, value: next, updatedBy: userId ?? null })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date(), updatedBy: userId ?? null } });
  }
  invalidateSettings();
  return getSettings();
}

export function invalidateSettings() {
  cache = null;
}

/** Public branding with resolved asset URLs. */
export async function getBranding(): Promise<Branding> {
  const s = await getSettings();
  const { logoKey, faviconKey, ...b } = s.branding;
  return {
    ...b,
    logoUrl: logoKey ? `/api/public/branding/logo?v=${encodeURIComponent(logoKey.split('/').pop() ?? '')}` : null,
    faviconUrl: faviconKey ? `/api/public/branding/favicon?v=${encodeURIComponent(faviconKey.split('/').pop() ?? '')}` : null,
  };
}

export async function getSettingsDTO(): Promise<SettingsDTO> {
  const s = await getSettings();
  return {
    branding: await getBranding(),
    notifications: s.notifications,
    security: s.security,
    retention: s.retention,
    uploads: s.uploads,
    smtpConfigured: config().smtp.enabled,
    clamavEnabled: config().clamav.enabled,
  };
}

/** Effective blocked-extension set (empty when executables are allowed). */
export async function getBlockedExtensions(): Promise<string[]> {
  const s = await getSettings();
  return s.security.blockExecutables ? s.security.blockedExtensions.map((e) => e.toLowerCase().replace(/^\./, '')) : [];
}
