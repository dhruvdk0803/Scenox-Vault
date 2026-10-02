import { accessStore } from '@/components/portal/branding';

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

export interface PreviewableFile {
  type: string;
  extension: string;
  status: string;
}

/** Images a browser can't render (or that the server won't stream inline). */
const NO_PREVIEW_IMAGE = new Set(['svg', 'heic', 'heif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'psd', 'ai', 'eps', 'tif', 'tiff']);
const PREVIEW_VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
const NO_PREVIEW_AUDIO = new Set(['aiff', 'aif', 'wma']);

/** What kind of inline preview a file gets, or null when it can't be previewed (wrong type, or not 'ready' yet). */
export function previewKind(f: PreviewableFile): PreviewKind | null {
  if (f.status !== 'ready') return null;
  const ext = f.extension.replace(/^\./, '').toLowerCase();
  switch (f.type) {
    case 'image': return NO_PREVIEW_IMAGE.has(ext) ? null : 'image';
    case 'video': return PREVIEW_VIDEO.has(ext) ? 'video' : null;
    case 'audio': return NO_PREVIEW_AUDIO.has(ext) ? null : 'audio';
    default:
      if (ext === 'pdf') return 'pdf';
      if (ext === 'txt') return 'text';
      return null;
  }
}

/** Images above this size are shown as an icon in the grid instead of loading a thumbnail. */
export const THUMBNAIL_MAX_BYTES = 25 * 1024 * 1024;

export const canThumbnail = (f: PreviewableFile & { size: number }): boolean => previewKind(f) === 'image' && f.size <= THUMBNAIL_MAX_BYTES;

/** `<img>`/`<video>` can't send headers, so password-protected portals pass the access token as `?access=`. */
export function previewUrl(token: string, fileId: string, accessToken?: string | null): string {
  const a = accessToken === undefined ? accessStore.load(token)?.accessToken : accessToken;
  return `/api/public/portals/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}/preview${a ? `?access=${encodeURIComponent(a)}` : ''}`;
}
