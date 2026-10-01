export type PortalTab = 'overview' | 'upload' | 'files' | 'uploads' | 'messages';

export const TAB_LABELS: Record<PortalTab, string> = {
  overview: 'Overview',
  upload: 'Upload',
  files: 'Files',
  uploads: 'Uploads',
  messages: 'Messages',
};

/** Tabs a client can see, in display order. */
export function availableTabs(f: { files: boolean; messages: boolean }): PortalTab[] {
  const tabs: PortalTab[] = ['overview', 'upload'];
  if (f.files) tabs.push('files', 'uploads');
  if (f.messages) tabs.push('messages');
  return tabs;
}

/** Reads `?tab=`; unknown or hidden tabs fall back to the overview. */
export function parseTab(raw: string | null | undefined, available: readonly PortalTab[]): PortalTab {
  return available.find((t) => t === raw) ?? 'overview';
}
