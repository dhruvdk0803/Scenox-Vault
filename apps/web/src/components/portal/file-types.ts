import { File as FileIcon, FileArchive, FileSpreadsheet, FileText, Film, Image as ImageIcon, Music, type LucideIcon } from 'lucide-react';

export interface CategoryMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
}

/** Display metadata for the shared `fileCategory` buckets. */
export const CATEGORY_META: Record<string, CategoryMeta> = {
  image: { label: 'Image', plural: 'Images', icon: ImageIcon },
  video: { label: 'Video', plural: 'Videos', icon: Film },
  audio: { label: 'Audio', plural: 'Audio', icon: Music },
  document: { label: 'Document', plural: 'Documents', icon: FileText },
  spreadsheet: { label: 'Spreadsheet', plural: 'Spreadsheets', icon: FileSpreadsheet },
  archive: { label: 'Archive', plural: 'Archives', icon: FileArchive },
  other: { label: 'Other', plural: 'Other', icon: FileIcon },
};

export const categoryMeta = (type: string): CategoryMeta => CATEGORY_META[type] ?? CATEGORY_META.other!;

export const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'document', label: 'Documents' },
  { value: 'spreadsheet', label: 'Spreadsheets' },
  { value: 'archive', label: 'Archives' },
  { value: 'audio', label: 'Audio' },
  { value: 'other', label: 'Other' },
];
