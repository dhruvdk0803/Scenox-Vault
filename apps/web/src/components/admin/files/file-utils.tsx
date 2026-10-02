import { File as FileIcon, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, type LucideIcon } from 'lucide-react';
import { fileCategory, type FileDTO } from '@scenox/shared';

const ICONS: Record<string, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  archive: FileArchive,
  other: FileIcon,
};

export function FileTypeIcon({ extension, className }: { extension: string; className?: string }) {
  const Icon = ICONS[fileCategory(extension)] ?? FileIcon;
  return <Icon className={className} aria-hidden />;
}

export function filePath(f: Pick<FileDTO, 'clientName' | 'portalName' | 'relativePath' | 'name'>): string {
  return [f.clientName, f.portalName, f.relativePath, f.name].filter(Boolean).join('/');
}

export function downloadUrl(id: string): string {
  return `/api/files/${id}/download`;
}

/** Same-origin inline source (HTTP Range supported, so <video> can seek). */
export function inlineUrl(id: string): string {
  return `/api/files/${id}/download?inline=1`;
}

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/pjpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-ms-bmp', 'image/x-bmp']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus']);

/**
 * What the in-browser viewer can show for a file. Mirrors the server, which decides inline-ability from the sniffed
 * MIME (detected, then declared); the extension is only a fallback when no useful MIME is known.
 */
export function previewKind(f: Pick<FileDTO, 'detectedMime' | 'mimeType' | 'extension'>): PreviewKind {
  const mime = (f.detectedMime ?? f.mimeType ?? '').toLowerCase().split(';')[0]!.trim();
  const ext = f.extension.toLowerCase().replace(/^\./, '');
  if (mime.startsWith('image/')) return IMAGE_MIMES.has(mime) ? 'image' : 'none'; // svg, heic, tiff, raw… are not previewed
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/plain') return 'text';
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') return 'none';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'none';
}

/** Largest image the thumbnail grid will load (it fetches the original). */
export const THUMBNAIL_MAX_BYTES = 25 * 1000 * 1000;

export const FILE_TYPE_OPTIONS = [
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'document', label: 'Documents' },
  { value: 'spreadsheet', label: 'Spreadsheets' },
  { value: 'archive', label: 'Archives' },
  { value: 'other', label: 'Other' },
] as const;

export const FILE_STATUS_OPTIONS = [
  { value: 'ready', label: 'Ready' },
  { value: 'uploading', label: 'Uploading' },
  { value: 'processing', label: 'Processing' },
  { value: 'quarantined', label: 'Quarantined' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;
