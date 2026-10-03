import type { WebhookEvent } from '@scenox/shared';

export const EVENT_INFO: Record<WebhookEvent, string> = {
  'upload.completed': 'A client finished uploading a batch',
  'file.ready': 'A file finished processing and can be downloaded',
  'file.quarantined': 'A file was flagged by the virus scan',
  'file.deleted': 'A file was deleted',
  'message.created': 'A client sent a message or file comment',
  'client.created': 'A new client was added',
  'portal.created': 'A new upload portal was created',
};

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
