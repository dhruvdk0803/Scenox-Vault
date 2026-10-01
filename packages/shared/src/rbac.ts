import type { Role } from './constants';

export const PERMISSIONS = [
  'clients.view',
  'clients.manage',
  'portals.view',
  'portals.manage',
  'files.view',
  'files.download',
  'files.delete',
  'files.manage',
  'activity.view',
  'audit.view',
  'settings.view',
  'settings.manage',
  'team.view',
  'team.manage',
  'system.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS] as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL,
  // Admins hold every permission; canManageRole() limits which users they may change.
  admin: ALL,
  member: [
    'clients.view', 'clients.manage', 'portals.view', 'portals.manage',
    'files.view', 'files.download', 'files.manage', 'activity.view', 'settings.view', 'team.view', 'system.view',
  ],
  viewer: ['clients.view', 'portals.view', 'files.view', 'files.download', 'activity.view', 'team.view'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** Owners can manage everyone; admins can manage members/viewers; nobody else manages users. */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'admin') return target === 'member' || target === 'viewer';
  return false;
}
