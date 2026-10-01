import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Conventions
 *  - UUID primary keys generated in Postgres (gen_random_uuid()).
 *  - Byte sizes are BIGINT with mode 'number' (safe to 9 PB).
 *  - Secrets (session tokens, portal tokens) are stored as SHA-256 hashes; portal tokens
 *    additionally stored AES-256-GCM encrypted so admins can re-copy the link.
 *  - Binary file content NEVER lives in Postgres.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const big = (name: string) => bigint(name, { mode: 'number' });

export const roleEnum = pgEnum('user_role', ['owner', 'admin', 'member', 'viewer']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled']);
export const clientStatusEnum = pgEnum('client_status', ['active', 'disabled']);
export const portalStatusEnum = pgEnum('portal_status', ['active', 'disabled']);
export const sessionStatusEnum = pgEnum('upload_session_status', ['active', 'completed', 'abandoned', 'failed']);
export const fileStatusEnum = pgEnum('file_status', ['uploading', 'processing', 'ready', 'quarantined', 'failed', 'cancelled']);
export const scanStatusEnum = pgEnum('scan_status', ['pending', 'scanning', 'clean', 'infected', 'skipped', 'failed']);
export const exportStatusEnum = pgEnum('export_status', ['queued', 'processing', 'ready', 'failed', 'expired']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'client', 'system']);
export const resultEnum = pgEnum('activity_result', ['success', 'failure']);
export const notificationStatusEnum = pgEnum('notification_status', ['pending', 'sent', 'failed', 'skipped']);
export const notificationChannelEnum = pgEnum('notification_channel', ['email', 'in_app']);

// ───────────────────────── users & sessions ─────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role').notNull().default('member'),
    status: userStatusEnum('status').notNull().default('active'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    passwordChangedAt: ts('password_changed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

// ───────────────────────── clients & portals ─────────────────────────

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    company: text('company'),
    email: text('email'),
    phone: text('phone'),
    notes: text('notes'),
    status: clientStatusEnum('status').notNull().default('active'),
    quotaBytes: big('quota_bytes'),
    // denormalised counters, maintained transactionally by the upload pipeline
    storageUsedBytes: big('storage_used_bytes').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    uploadCount: integer('upload_count').notNull().default(0),
    lastUploadAt: ts('last_upload_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('clients_status_idx').on(t.status),
    index('clients_created_idx').on(t.createdAt),
    index('clients_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
  ],
);

export const portals = pgTable(
  'portals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** human-friendly prefix in the URL, e.g. "abc-company" → /u/abc-company-<token> is NOT used; token only */
    tokenHash: text('token_hash').notNull(),
    tokenEncrypted: text('token_encrypted').notNull(),
    tokenPreview: text('token_preview').notNull(),
    status: portalStatusEnum('status').notNull().default('active'),
    title: text('title'),
    description: text('description'),
    instructions: text('instructions'),
    logoKey: text('logo_key'),
    expiresAt: ts('expires_at'),
    passwordHash: text('password_hash'),
    maxFileSizeBytes: big('max_file_size_bytes'),
    maxTotalBytes: big('max_total_bytes'),
    allowedExtensions: text('allowed_extensions').array(),
    requireName: boolean('require_name').notNull().default(false),
    requireEmail: boolean('require_email').notNull().default(false),
    requireCompany: boolean('require_company').notNull().default(false),
    requireMessage: boolean('require_message').notNull().default(false),
    allowMultipleSessions: boolean('allow_multiple_sessions').notNull().default(true),
    allowFolders: boolean('allow_folders').notNull().default(true),
    allowZip: boolean('allow_zip').notNull().default(true),
    allowResume: boolean('allow_resume').notNull().default(true),
    allowClientViewFiles: boolean('allow_client_view_files').notNull().default(true),
    allowClientDeleteFiles: boolean('allow_client_delete_files').notNull().default(false),
    allowClientMessages: boolean('allow_client_messages').notNull().default(true),
    notifyEmails: text('notify_emails').array().notNull().default(sql`'{}'::text[]`),
    notifyClient: boolean('notify_client').notNull().default(false),
    storageUsedBytes: big('storage_used_bytes').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    lastAccessedAt: ts('last_accessed_at'),
    lastUploadAt: ts('last_upload_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('portals_token_hash_uq').on(t.tokenHash),
    index('portals_client_idx').on(t.clientId),
    index('portals_status_idx').on(t.status),
    index('portals_created_idx').on(t.createdAt),
  ],
);

/** Short-lived access grants issued after a portal password is verified. */
export const portalAccessTokens = pgTable(
  'portal_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalId: uuid('portal_id')
      .notNull()
      .references(() => portals.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ip: inet('ip'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [uniqueIndex('portal_access_token_hash_uq').on(t.tokenHash), index('portal_access_portal_idx').on(t.portalId)],
);

// ───────────────────────── upload sessions & files ─────────────────────────

/** One "visit"/batch of uploads by a client through a portal. */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalId: uuid('portal_id')
      .notNull()
      .references(() => portals.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    status: sessionStatusEnum('status').notNull().default('active'),
    uploaderName: text('uploader_name'),
    uploaderEmail: text('uploader_email'),
    uploaderCompany: text('uploader_company'),
    message: text('message'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    totalFiles: integer('total_files').notNull().default(0),
    totalBytes: big('total_bytes').notNull().default(0),
    uploadedFiles: integer('uploaded_files').notNull().default(0),
    uploadedBytes: big('uploaded_bytes').notNull().default(0),
    failedFiles: integer('failed_files').notNull().default(0),
    avgSpeedBps: big('avg_speed_bps'),
    startedAt: ts('started_at').notNull().defaultNow(),
    lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    expiresAt: ts('expires_at').notNull(),
    notifiedAt: ts('notified_at'),
  },
  (t) => [
    uniqueIndex('upload_sessions_token_hash_uq').on(t.tokenHash),
    index('upload_sessions_portal_idx').on(t.portalId),
    index('upload_sessions_client_idx').on(t.clientId),
    index('upload_sessions_status_idx').on(t.status),
    index('upload_sessions_started_idx').on(t.startedAt),
    index('upload_sessions_activity_idx').on(t.lastActivityAt),
  ],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    portalId: uuid('portal_id')
      .notNull()
      .references(() => portals.id, { onDelete: 'cascade' }),
    uploadSessionId: uuid('upload_session_id')
      .notNull()
      .references(() => uploadSessions.id, { onDelete: 'cascade' }),
    /** tus upload id (also the temp filename in STORAGE_PATH/tus). */
    tusId: text('tus_id'),
    originalFilename: text('original_filename').notNull(),
    /** generated on-disk name (uuid), never user controlled */
    storedFilename: text('stored_filename').notNull(),
    relativePath: text('relative_path').notNull().default(''),
    extension: text('extension').notNull().default(''),
    mimeType: text('mime_type'),
    detectedMime: text('detected_mime'),
    size: big('size').notNull(),
    bytesReceived: big('bytes_received').notNull().default(0),
    checksumSha256: text('checksum_sha256'),
    status: fileStatusEnum('status').notNull().default('uploading'),
    scanStatus: scanStatusEnum('scan_status').notNull().default('pending'),
    scanResult: text('scan_result'),
    duplicateOfId: uuid('duplicate_of_id'),
    /** storage driver key, relative to the storage root. Never exposed to clients. */
    storageKey: text('storage_key'),
    clientKey: text('client_key'),
    lastModified: ts('last_modified'),
    avgSpeedBps: big('avg_speed_bps'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('files_tus_id_uq').on(t.tusId),
    index('files_client_idx').on(t.clientId),
    index('files_portal_idx').on(t.portalId),
    index('files_session_idx').on(t.uploadSessionId),
    index('files_status_idx').on(t.status),
    index('files_created_idx').on(t.createdAt),
    index('files_checksum_idx').on(t.checksumSha256),
    index('files_client_path_idx').on(t.clientId, t.relativePath, t.originalFilename),
    index('files_name_trgm_idx').using('gin', t.originalFilename.op('gin_trgm_ops')),
  ],
);

// ───────────────────────── exports (bulk zip) ─────────────────────────

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    status: exportStatusEnum('status').notNull().default('queued'),
    fileIds: uuid('file_ids').array().notNull(),
    fileCount: integer('file_count').notNull().default(0),
    totalBytes: big('total_bytes').notNull().default(0),
    progress: real('progress').notNull().default(0),
    outputKey: text('output_key'),
    outputSize: big('output_size'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('export_jobs_user_idx').on(t.userId), index('export_jobs_status_idx').on(t.status)],
);

// ───────────────────────── activity, notifications, settings ─────────────────────────

export const activityLogs = pgTable(
  'activity_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    clientId: uuid('client_id'),
    portalId: uuid('portal_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    result: resultEnum('result').notNull().default('success'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('activity_created_idx').on(t.createdAt),
    index('activity_client_idx').on(t.clientId, t.createdAt),
    index('activity_action_idx').on(t.action),
    index('activity_actor_idx').on(t.actorType, t.actorId),
  ],
);

// ───────────────────────── messages & file comments ─────────────────────────

export const messageAuthorEnum = pgEnum('message_author', ['client', 'staff']);

/**
 * Conversation between the client (portal visitor) and the agency team, per portal.
 * fileId set → it is a comment on that file; null → portal-level message.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalId: uuid('portal_id')
      .notNull()
      .references(() => portals.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'cascade' }),
    uploadSessionId: uuid('upload_session_id').references(() => uploadSessions.id, { onDelete: 'set null' }),
    authorType: messageAuthorEnum('author_type').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name'),
    authorEmail: text('author_email'),
    body: text('body').notNull(),
    /** set when the other side has seen it (staff for client messages, client for staff messages) */
    readAt: ts('read_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('messages_portal_idx').on(t.portalId, t.createdAt),
    index('messages_file_idx').on(t.fileId),
    index('messages_client_idx').on(t.clientId),
    index('messages_unread_idx').on(t.authorType, t.readAt),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    recipient: text('recipient'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    link: text('link'),
    status: notificationStatusEnum('status').notNull().default('pending'),
    error: text('error'),
    clientId: uuid('client_id'),
    uploadSessionId: uuid('upload_session_id'),
    readAt: ts('read_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt), index('notifications_status_idx').on(t.status)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Portal = typeof portals.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type ExportJob = typeof exportJobs.$inferSelect;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
