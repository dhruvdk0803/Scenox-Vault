import {
  Activity, Code2, FolderOpen, HardDrive, HeartPulse, LayoutDashboard, Link2, MessagesSquare, ScrollText, Settings, UploadCloud, Users, UserCog,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@scenox/shared';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Hidden from the nav when the user lacks this permission. */
  permission?: Permission;
  /** Show the unread-messages count as a badge. */
  badge?: 'messages';
}

export const PRIMARY_NAV: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Clients', href: '/clients', icon: Users, permission: 'clients.view' },
  { label: 'Upload Portals', href: '/portals', icon: Link2, permission: 'portals.view' },
  { label: 'Files', href: '/files', icon: FolderOpen, permission: 'files.view' },
  { label: 'Uploads', href: '/uploads', icon: UploadCloud, permission: 'files.view' },
  { label: 'Messages', href: '/messages', icon: MessagesSquare, permission: 'portals.view', badge: 'messages' },
  { label: 'Activity', href: '/activity', icon: Activity, permission: 'activity.view' },
  { label: 'Storage', href: '/storage', icon: HardDrive, permission: 'files.view' },
  { label: 'Settings', href: '/settings', icon: Settings, permission: 'settings.view' },
];

export const SECONDARY_NAV: NavItem[] = [
  { label: 'Team', href: '/team', icon: UserCog, permission: 'team.view' },
  { label: 'Developers', href: '/developers', icon: Code2, permission: 'settings.view' },
  { label: 'Audit Log', href: '/audit', icon: ScrollText, permission: 'audit.view' },
  { label: 'System Health', href: '/system', icon: HeartPulse, permission: 'system.view' },
];
