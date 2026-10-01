/**
 * API data-transfer contracts shared by apps/api and apps/web.
 * All dates are ISO-8601 strings. All byte sizes are numbers (safe up to 9 PB).
 */
import type {
  ClientStatus,
  DuplicateAction,
  ExportStatus,
  FileStatus,
  PortalStatus,
  PortalStoredStatus,
  Role,
  ScanStatus,
  UploadSessionStatus,
} from './constants';
import type { Permission } from './rbac';

// ───────────────────────── common ─────────────────────────

export interface ApiError {
  error: {
    code: string; // machine readable e.g. "not_found", "validation_error", "quota_exceeded"
    message: string; // user-friendly message, safe to display
    details?: unknown;
    requestId?: string;
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListQuery {
  page?: number; // 1-based, default 1
  pageSize?: number; // default 25, max 200
  q?: string; // server-side search
  sort?: string; // field name
  order?: 'asc' | 'desc';
}

// ───────────────────────── auth / users ─────────────────────────

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
}

export interface MeDTO {
  user: UserDTO;
  permissions: Permission[];
  sessionExpiresAt: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface SetupStatusDTO {
  /** true when no users exist yet and the first-run owner account must be created */
  needsSetup: boolean;
}

export interface SetupRequest {
  name: string;
  email: string;
  password: string; // >= 12 chars
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface CreateUserRequest {
  name: string;
  email: string;
  role: Role;
  password: string;
}

export interface UpdateUserRequest {
  name?: string;
  role?: Role;
  status?: 'active' | 'disabled';
  password?: string;
}

// ───────────────────────── clients ─────────────────────────

export interface ClientDTO {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: ClientStatus;
  quotaBytes: number | null;
  storageUsedBytes: number;
  fileCount: number;
  uploadCount: number;
  portalCount: number;
  lastUploadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateClientRequest {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  quotaBytes?: number | null;
}

export type UpdateClientRequest = Partial<CreateClientRequest> & { status?: ClientStatus };

// ───────────────────────── portals ─────────────────────────

export interface PortalSettings {
  title: string | null; // heading shown to client, defaults to client name
  description: string | null;
  instructions: string | null;
  expiresAt: string | null;
  maxFileSizeBytes: number | null;
  maxTotalBytes: number | null; // portal quota
  allowedExtensions: string[] | null; // null = any (minus blocked list)
  requireName: boolean;
  requireEmail: boolean;
  requireCompany: boolean;
  requireMessage: boolean;
  allowMultipleSessions: boolean; // "allow multiple uploads"
  allowFolders: boolean;
  allowZip: boolean;
  allowResume: boolean;
  allowClientViewFiles: boolean;
  allowClientDeleteFiles: boolean;
  allowClientMessages: boolean; // client can message the team and comment on files
  notifyEmails: string[]; // admin recipients; empty = settings default
  notifyClient: boolean; // email uploader a receipt when they provided an email
}

export interface PortalDTO extends PortalSettings {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  status: PortalStatus; // derived: expired when expiresAt < now
  storedStatus: PortalStoredStatus;
  hasPassword: boolean;
  hasLogo: boolean;
  url: string | null; // full public URL (decrypted); null if token cannot be decrypted
  tokenPreview: string; // first 6 chars, for display
  storageUsedBytes: number;
  fileCount: number;
  sessionCount: number;
  lastAccessedAt: string | null;
  lastUploadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreatePortalRequest = Partial<PortalSettings> & {
  clientId: string;
  name: string;
  password?: string | null;
};

export type UpdatePortalRequest = Partial<PortalSettings> & {
  name?: string;
  status?: PortalStoredStatus;
  /** string = set/replace password, null = remove password, undefined = unchanged */
  password?: string | null;
};

// ───────────────────────── public portal (client side) ─────────────────────────

export interface Branding {
  companyName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string; // hex
  portalTitle: string; // e.g. "Secure File Upload"
  supportEmail: string | null;
}

export interface UploadEngineConfig {
  endpoint: string; // tus endpoint, e.g. "/api/tus"
  maxConcurrentUploads: number;
  defaultChunkSize: number;
  maxChunkSize: number;
  minChunkSize: number;
  retryDelays: number[];
}

/** GET /api/public/portals/:token — always 200 for a valid token; inspect `state`. */
export interface PublicPortalDTO {
  state: 'ok' | 'password_required' | 'expired' | 'disabled';
  branding: Branding;
  portal?: {
    title: string;
    clientName: string;
    description: string | null;
    instructions: string | null;
    logoUrl: string | null;
    expiresAt: string | null;
    maxFileSizeBytes: number | null;
    quota: { usedBytes: number; limitBytes: number | null }; // effective (min of portal & client)
    allowedExtensions: string[] | null;
    blockedExtensions: string[];
    requireName: boolean;
    requireEmail: boolean;
    requireCompany: boolean;
    requireMessage: boolean;
    allowFolders: boolean;
    allowZip: boolean;
    allowResume: boolean;
    allowClientViewFiles: boolean;
    allowClientDeleteFiles: boolean;
    allowClientMessages: boolean;
    allowMultipleSessions: boolean;
  };
  upload?: UploadEngineConfig;
}

export interface PortalUnlockRequest {
  password: string;
}
export interface PortalUnlockResponse {
  accessToken: string; // send as x-portal-access header
  expiresAt: string;
}

export interface StartSessionRequest {
  name?: string;
  email?: string;
  company?: string;
  message?: string;
  /** planned totals for this batch (informational, used for quota pre-check) */
  totalFiles?: number;
  totalBytes?: number;
}
export interface StartSessionResponse {
  sessionId: string;
  sessionToken: string; // send as x-upload-session header (and tus metadata sessionId)
  expiresAt: string;
}

export interface PreflightFile {
  clientKey: string; // opaque id from the client queue
  name: string;
  relativePath: string; // folder only, '' for root
  size: number;
  type?: string;
}
export interface PreflightRequest {
  files: PreflightFile[]; // up to 5000 per request
}
export interface PreflightResult {
  clientKey: string;
  ok: boolean;
  reason?: 'blocked_type' | 'not_allowed_type' | 'too_large' | 'quota_exceeded' | 'zip_not_allowed' | 'folders_not_allowed';
  message?: string;
  duplicate?: { fileId: string; size: number; uploadedAt: string } | null;
}
export interface PreflightResponse {
  results: PreflightResult[];
  quota: { usedBytes: number; limitBytes: number | null; requestedBytes: number };
}

/**
 * tus Upload-Metadata keys sent by the client:
 *   filename, filetype, relativePath, sessionId, clientKey, duplicateAction ("replace"|"keep_both"|"skip"), lastModified
 * The session token travels in the x-upload-session header on every tus request.
 */
export interface TusMetadata {
  filename: string;
  filetype?: string;
  relativePath?: string;
  sessionId: string;
  clientKey?: string;
  duplicateAction?: DuplicateAction;
  lastModified?: string;
}

export interface PublicFileDTO {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  status: FileStatus;
  uploadedAt: string | null;
}

export interface CompleteSessionRequest {
  filesUploaded: number;
  bytesUploaded: number;
  filesFailed: number;
}

// ───────────────────────── upload sessions (admin) ─────────────────────────

export interface UploadSessionDTO {
  id: string;
  clientId: string;
  clientName: string;
  portalId: string;
  portalName: string;
  status: UploadSessionStatus;
  uploaderName: string | null;
  uploaderEmail: string | null;
  uploaderCompany: string | null;
  message: string | null;
  ip: string | null;
  totalFiles: number; // declared
  totalBytes: number; // declared
  uploadedFiles: number;
  uploadedBytes: number;
  failedFiles: number;
  avgSpeedBps: number | null;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
}

// ───────────────────────── files ─────────────────────────

export interface FileDTO {
  id: string;
  clientId: string;
  clientName: string;
  portalId: string;
  portalName: string;
  uploadSessionId: string;
  name: string; // original (sanitised) filename
  relativePath: string; // folder path, '' for root
  extension: string;
  mimeType: string | null; // declared by browser
  detectedMime: string | null; // sniffed server-side
  size: number;
  checksumSha256: string | null;
  status: FileStatus;
  scanStatus: ScanStatus;
  scanResult: string | null;
  duplicateOfId: string | null;
  uploaderName: string | null;
  uploaderEmail: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface FileListQuery extends ListQuery {
  clientId?: string;
  portalId?: string;
  uploadSessionId?: string;
  status?: FileStatus;
  scanStatus?: ScanStatus;
  type?: 'image' | 'video' | 'audio' | 'document' | 'spreadsheet' | 'archive' | 'other';
  from?: string; // ISO date
  to?: string;
  minSize?: number;
  maxSize?: number;
  path?: string; // exact folder (browser mode)
}

/** GET /api/files/browse?clientId=&portalId=&path= */
export interface BrowseResponse {
  path: string;
  breadcrumbs: { name: string; path: string }[];
  folders: { name: string; path: string; fileCount: number; totalBytes: number }[];
  files: Paginated<FileDTO>;
}

export interface RenameFileRequest {
  name: string;
}
export interface MoveFilesRequest {
  fileIds: string[];
  relativePath: string;
}
export interface BulkFilesRequest {
  fileIds: string[];
}

export interface ExportJobDTO {
  id: string;
  status: ExportStatus;
  fileCount: number;
  totalBytes: number;
  progress: number; // 0..1
  outputSize: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  downloadUrl: string | null; // set when ready
}

// ───────────────────────── activity / audit ─────────────────────────

export interface ActivityDTO {
  id: string;
  actorType: 'user' | 'client' | 'system';
  actorId: string | null;
  actorLabel: string | null;
  action: string; // e.g. "client.created", "upload.completed"
  resourceType: string | null;
  resourceId: string | null;
  clientId: string | null;
  clientName: string | null;
  portalId: string | null;
  ip: string | null;
  result: 'success' | 'failure';
  summary: string; // human readable sentence
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ───────────────────────── dashboard / analytics ─────────────────────────

export interface DashboardDTO {
  totals: {
    clients: number;
    activePortals: number;
    files: number;
    storageUsedBytes: number;
    uploadsToday: number;
    bytesToday: number;
    activeSessions: number;
  };
  storage: { usedBytes: number; capacityBytes: number; freeBytes: number; warningLevel: 'ok' | 'warning' | 'critical' };
  recentSessions: UploadSessionDTO[];
  recentClients: ClientDTO[];
  recentActivity: ActivityDTO[];
}

export interface AnalyticsDTO {
  range: { from: string; to: string };
  totals: {
    sessions: number;
    completedSessions: number;
    failedSessions: number;
    activeSessions: number;
    filesUploaded: number;
    bytesUploaded: number;
    avgSpeedBps: number | null;
    storageUsedBytes: number;
  };
  daily: { date: string; files: number; bytes: number; sessions: number }[];
  topClients: { clientId: string; clientName: string; bytes: number; files: number }[];
  fileTypes: { type: string; files: number; bytes: number }[];
}

export interface StorageDTO {
  driver: 'local' | 's3';
  disk: { totalBytes: number; usedBytes: number; freeBytes: number; path: string | null };
  vaultUsedBytes: number;
  byStatus: { status: FileStatus; files: number; bytes: number }[];
  byClient: { clientId: string; clientName: string; files: number; bytes: number; quotaBytes: number | null }[];
  temp: { incompleteUploads: number; incompleteBytes: number; exportsBytes: number };
  warningLevel: 'ok' | 'warning' | 'critical';
}

export interface SystemHealthDTO {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptimeSeconds: number;
  cpu: { cores: number; loadAvg: [number, number, number]; usagePercent: number };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; processRssBytes: number };
  disk: { totalBytes: number; usedBytes: number; freeBytes: number };
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
  checks: { name: 'database' | 'redis' | 'storage' | 'worker' | 'clamav' | 'smtp'; status: 'ok' | 'down' | 'disabled'; latencyMs: number | null; message?: string }[];
  queues: { name: string; waiting: number; active: number; failed: number; completed: number }[];
}

// ───────────────────────── settings ─────────────────────────

export interface SettingsDTO {
  branding: Branding;
  notifications: {
    adminEmails: string[];
    notifyOnUploadComplete: boolean;
    notifyOnUploadFailed: boolean;
    notifyClientReceipt: boolean;
    diskWarningPercent: number; // e.g. 85
    diskCriticalPercent: number; // e.g. 95
  };
  security: {
    blockedExtensions: string[];
    blockExecutables: boolean;
    adminSessionHours: number;
    portalSessionHours: number;
  };
  retention: {
    incompleteUploadHours: number; // abandoned tus uploads cleaned after N hours
    exportHours: number; // zip exports deleted after N hours
    activityLogDays: number; // 0 = keep forever
  };
  uploads: {
    defaultMaxFileSizeBytes: number | null;
    defaultPortalQuotaBytes: number | null;
  };
  smtpConfigured: boolean; // read-only
  clamavEnabled: boolean; // read-only (env)
}

export type UpdateSettingsRequest = {
  branding?: Partial<Omit<Branding, 'logoUrl' | 'faviconUrl'>>;
  notifications?: Partial<SettingsDTO['notifications']>;
  security?: Partial<SettingsDTO['security']>;
  retention?: Partial<SettingsDTO['retention']>;
  uploads?: Partial<SettingsDTO['uploads']>;
};

export interface NotificationDTO {
  id: string;
  type: string;
  channel: 'email' | 'in_app';
  recipient: string | null;
  subject: string;
  body: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  readAt: string | null;
  link: string | null;
  createdAt: string;
}

// ───────────────────────── client dashboard (public) ─────────────────────────
// All endpoints below live under /api/public/portals/:token and need the x-portal-access
// header when the portal is password protected. They do NOT need an upload session.

export interface ClientDashboardDTO {
  stats: {
    files: number; // ready + processing + quarantined
    totalBytes: number;
    uploads: number; // upload sessions with ≥1 file
    folders: number; // distinct top-level folders
    lastUploadAt: string | null;
  };
  quota: { usedBytes: number; limitBytes: number | null };
  expiresAt: string | null;
  byType: { type: string; files: number; bytes: number }[]; // shared fileCategory buckets
  recentUploads: ClientUploadDTO[]; // newest 5
  recentFiles: ClientFileDTO[]; // newest 6 (only when allowClientViewFiles)
  messages: { total: number; unread: number; latest: MessageDTO | null }; // unread = staff messages not yet seen by client
}

export interface ClientFileDTO {
  id: string;
  name: string;
  relativePath: string;
  extension: string;
  type: string; // fileCategory
  size: number;
  status: FileStatus;
  uploadedAt: string | null;
  uploadedBy: string | null; // uploader name, if given
  commentCount: number;
  canDelete: boolean;
}

/** GET /browse?path=&q=&type=&sort=name|size|uploadedAt&order=&page=&pageSize= (requires allowClientViewFiles) */
export interface ClientBrowseResponse {
  path: string;
  breadcrumbs: { name: string; path: string }[];
  folders: { name: string; path: string; fileCount: number; totalBytes: number }[];
  files: Paginated<ClientFileDTO>;
}

/** GET /uploads — upload history (requires allowClientViewFiles) */
export interface ClientUploadDTO {
  id: string;
  uploaderName: string | null;
  message: string | null;
  files: number;
  bytes: number;
  status: UploadSessionStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface MessageDTO {
  id: string;
  portalId: string;
  fileId: string | null;
  fileName: string | null;
  authorType: 'client' | 'staff';
  authorName: string; // staff: team member name (or company name); client: given name or "Client"
  body: string; // plain text, max 5000 chars — render as text, never as HTML
  createdAt: string;
  readAt: string | null;
  own?: boolean; // public API: true when written by the client side
}

/** GET /messages?fileId=&before=<iso>&limit=50 → newest last. Marks staff messages as read. */
export interface MessageListResponse {
  items: MessageDTO[];
  hasMore: boolean;
}

/** POST /messages (public) */
export interface PostClientMessageRequest {
  body: string;
  fileId?: string | null;
  name?: string | null; // remembered by the browser; falls back to the upload session's uploader name
  email?: string | null; // optional: lets the team's replies be emailed
}

/** POST /api/portals/:id/messages (admin) */
export interface PostStaffMessageRequest {
  body: string;
  fileId?: string | null;
}

/** GET /api/messages/inbox — one row per portal that has messages, newest activity first */
export interface InboxThreadDTO {
  portalId: string;
  portalName: string;
  clientId: string;
  clientName: string;
  lastMessage: MessageDTO;
  unread: number; // client messages not yet read by staff
  total: number;
}

export type { DuplicateAction };
