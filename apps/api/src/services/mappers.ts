import type { ActivityDTO, ClientDTO, ExportJobDTO, FileDTO, NotificationDTO, PortalDTO, UploadSessionDTO } from '@scenox/shared';
import type { ActivityLog, Client, ExportJob, FileRow, NotificationRow, Portal, UploadSession } from '../db/schema';
import { decryptPortalUrl, portalEffectiveStatus } from './portal-tokens';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const num = (v: unknown) => (v == null ? 0 : Number(v));

export function toClientDTO(c: Client, extra: { portalCount?: number } = {}): ClientDTO {
  return {
    id: c.id,
    name: c.name,
    company: c.company,
    email: c.email,
    phone: c.phone,
    notes: c.notes,
    status: c.status,
    quotaBytes: c.quotaBytes,
    storageUsedBytes: num(c.storageUsedBytes),
    fileCount: c.fileCount,
    uploadCount: c.uploadCount,
    portalCount: num(extra.portalCount),
    lastUploadAt: iso(c.lastUploadAt),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toPortalDTO(p: Portal, clientName: string): PortalDTO {
  return {
    id: p.id,
    clientId: p.clientId,
    clientName,
    name: p.name,
    status: portalEffectiveStatus(p),
    storedStatus: p.status,
    hasPassword: !!p.passwordHash,
    hasLogo: !!p.logoKey,
    url: decryptPortalUrl(p),
    tokenPreview: p.tokenPreview,
    title: p.title,
    description: p.description,
    instructions: p.instructions,
    expiresAt: iso(p.expiresAt),
    maxFileSizeBytes: p.maxFileSizeBytes,
    maxTotalBytes: p.maxTotalBytes,
    allowedExtensions: p.allowedExtensions,
    requireName: p.requireName,
    requireEmail: p.requireEmail,
    requireCompany: p.requireCompany,
    requireMessage: p.requireMessage,
    allowMultipleSessions: p.allowMultipleSessions,
    allowFolders: p.allowFolders,
    allowZip: p.allowZip,
    allowResume: p.allowResume,
    allowClientViewFiles: p.allowClientViewFiles,
    allowClientDeleteFiles: p.allowClientDeleteFiles,
    notifyEmails: p.notifyEmails,
    notifyClient: p.notifyClient,
    storageUsedBytes: num(p.storageUsedBytes),
    fileCount: p.fileCount,
    sessionCount: p.sessionCount,
    lastAccessedAt: iso(p.lastAccessedAt),
    lastUploadAt: iso(p.lastUploadAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toUploadSessionDTO(s: UploadSession, names: { clientName: string; portalName: string }): UploadSessionDTO {
  return {
    id: s.id,
    clientId: s.clientId,
    clientName: names.clientName,
    portalId: s.portalId,
    portalName: names.portalName,
    status: s.status,
    uploaderName: s.uploaderName,
    uploaderEmail: s.uploaderEmail,
    uploaderCompany: s.uploaderCompany,
    message: s.message,
    ip: s.ip,
    totalFiles: s.totalFiles,
    totalBytes: num(s.totalBytes),
    uploadedFiles: s.uploadedFiles,
    uploadedBytes: num(s.uploadedBytes),
    failedFiles: s.failedFiles,
    avgSpeedBps: s.avgSpeedBps,
    startedAt: s.startedAt.toISOString(),
    lastActivityAt: s.lastActivityAt.toISOString(),
    completedAt: iso(s.completedAt),
  };
}

export function toFileDTO(
  f: FileRow,
  extra: { clientName: string; portalName: string; uploaderName?: string | null; uploaderEmail?: string | null },
): FileDTO {
  return {
    id: f.id,
    clientId: f.clientId,
    clientName: extra.clientName,
    portalId: f.portalId,
    portalName: extra.portalName,
    uploadSessionId: f.uploadSessionId,
    name: f.originalFilename,
    relativePath: f.relativePath,
    extension: f.extension,
    mimeType: f.mimeType,
    detectedMime: f.detectedMime,
    size: num(f.size),
    checksumSha256: f.checksumSha256,
    status: f.status,
    scanStatus: f.scanStatus,
    scanResult: f.scanResult,
    duplicateOfId: f.duplicateOfId,
    uploaderName: extra.uploaderName ?? null,
    uploaderEmail: extra.uploaderEmail ?? null,
    createdAt: f.createdAt.toISOString(),
    completedAt: iso(f.completedAt),
  };
}

export function toExportDTO(e: ExportJob): ExportJobDTO {
  return {
    id: e.id,
    status: e.status,
    fileCount: e.fileCount,
    totalBytes: num(e.totalBytes),
    progress: e.progress,
    outputSize: e.outputSize,
    error: e.error,
    createdAt: e.createdAt.toISOString(),
    completedAt: iso(e.completedAt),
    expiresAt: iso(e.expiresAt),
    downloadUrl: e.status === 'ready' ? `/api/exports/${e.id}/download` : null,
  };
}

export function toNotificationDTO(n: NotificationRow): NotificationDTO {
  return {
    id: n.id,
    type: n.type,
    channel: n.channel,
    recipient: n.recipient,
    subject: n.subject,
    body: n.body,
    status: n.status,
    readAt: iso(n.readAt),
    link: n.link,
    createdAt: n.createdAt.toISOString(),
  };
}

/** Human-readable sentence for an activity row. Keep in sync with actions emitted across the API. */
export function activitySummary(a: Pick<ActivityLog, 'action' | 'actorLabel' | 'metadata'>, clientName: string | null): string {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const who = clientName ?? (a.actorLabel?.replace(/\s*<.*>$/, '') || 'System');
  const name = (m.name ?? m.filename ?? m.portalName ?? m.clientName ?? '') as string;
  const map: Record<string, string> = {
    'auth.login': 'Signed in',
    'auth.login_failed': 'Failed sign-in attempt',
    'auth.logout': 'Signed out',
    'auth.setup': 'Created the owner account',
    'auth.password_changed': 'Changed password',
    'user.created': `Added team member ${name}`,
    'user.updated': `Updated team member ${name}`,
    'user.deleted': `Removed team member ${name}`,
    'client.created': `Client ${name} created`,
    'client.updated': `Client ${name} updated`,
    'client.disabled': `Client ${name} disabled`,
    'client.deleted': `Client ${name} deleted`,
    'portal.created': `Portal "${name}" created`,
    'portal.updated': `Portal "${name}" updated`,
    'portal.disabled': `Portal "${name}" disabled`,
    'portal.enabled': `Portal "${name}" enabled`,
    'portal.link_regenerated': `Portal "${name}" link regenerated`,
    'portal.deleted': `Portal "${name}" deleted`,
    'portal.accessed': `${who} opened the upload portal`,
    'portal.unlock_failed': `Incorrect portal password`,
    'portal.unlocked': `${who} unlocked the portal`,
    'upload.started': `${who} started an upload session`,
    'upload.completed': `${who} uploaded ${m.files ?? ''} files`.replace('  ', ' '),
    'upload.failed': `Upload failed${name ? `: ${name}` : ''}`,
    'file.uploaded': `Uploaded ${name}`,
    'file.quarantined': `File ${name} quarantined`,
    'file.downloaded': `Downloaded ${name}`,
    'file.deleted': `Deleted ${name || `${m.count ?? ''} files`}`,
    'file.renamed': `Renamed ${m.from ?? ''} → ${m.to ?? ''}`,
    'file.moved': `Moved ${m.count ?? ''} files`,
    'file.deleted_by_client': `${who} deleted ${name}`,
    'export.created': `Requested a ZIP of ${m.count ?? ''} files`,
    'export.downloaded': 'Downloaded a ZIP export',
    'settings.updated': 'Updated settings',
  };
  return map[a.action] ?? a.action;
}

export function toActivityDTO(a: ActivityLog, clientName: string | null): ActivityDTO {
  return {
    id: String(a.id),
    actorType: a.actorType,
    actorId: a.actorId,
    actorLabel: a.actorLabel,
    action: a.action,
    resourceType: a.resourceType,
    resourceId: a.resourceId,
    clientId: a.clientId,
    clientName,
    portalId: a.portalId,
    ip: a.ip,
    result: a.result,
    summary: activitySummary(a, clientName),
    metadata: a.metadata ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}
