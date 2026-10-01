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
