export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const CLIENT_STATUSES = ['active', 'disabled'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Stored portal status. "expired" is derived from expiresAt at read time. */
export const PORTAL_STATUSES = ['active', 'disabled'] as const;
export type PortalStoredStatus = (typeof PORTAL_STATUSES)[number];
export type PortalStatus = PortalStoredStatus | 'expired';

export const UPLOAD_SESSION_STATUSES = ['active', 'completed', 'abandoned', 'failed'] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

export const FILE_STATUSES = ['uploading', 'processing', 'ready', 'quarantined', 'failed', 'cancelled'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const SCAN_STATUSES = ['pending', 'scanning', 'clean', 'infected', 'skipped', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const EXPORT_STATUSES = ['queued', 'processing', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const DUPLICATE_ACTIONS = ['replace', 'keep_both', 'skip'] as const;
export type DuplicateAction = (typeof DUPLICATE_ACTIONS)[number];

/** Extensions blocked by default (configurable in Settings → Security). */
export const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'scr', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msi', 'msp', 'cpl', 'hta', 'jar', 'pif', 'reg', 'lnk',
];

/** Header carrying the public upload-session bearer token (client portal → API). */
export const UPLOAD_SESSION_HEADER = 'x-upload-session';
/** Header carrying the portal access token (issued after password / intake form). */
export const PORTAL_ACCESS_HEADER = 'x-portal-access';

export const ADMIN_SESSION_COOKIE = 'sv_session';

/** Upload engine defaults (overridable via env and returned by the portal config endpoint). */
export const UPLOAD_DEFAULTS = {
  maxConcurrentUploads: 4,
  defaultChunkSize: 64 * 1024 * 1024,
  maxChunkSize: 256 * 1024 * 1024,
  minChunkSize: 8 * 1024 * 1024,
  retryCount: 6,
  /** Exponential backoff schedule in ms; the final entry repeats. */
  retryDelays: [500, 1000, 2000, 4000, 8000, 16000],
};
