'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, LogOut, Settings } from 'lucide-react';
import { hasPermission, type MeDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/brand/logo';
import { Avatar } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toaster';
import { PRIMARY_NAV, SECONDARY_NAV, type NavItem } from './nav';

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-150',
        active ? 'bg-primary-soft text-primary-soft-fg' : 'text-fg-muted hover:bg-surface-muted hover:text-fg',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-fg-subtle group-hover:text-fg-muted')} aria-hidden />
      {item.label}
    </Link>
  );
}

function UserMenu({ me, onNavigate }: { me: MeDTO; onNavigate?: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  async function signOut() {
    try {
      await api.post('/auth/logout', undefined, { redirectOn401: false });
    } catch {
      // Even if the call fails (already expired), leave the admin area.
    }
    queryClient.clear();
    router.push('/login');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg border border-transparent p-2 text-left transition-colors duration-150 hover:bg-surface-muted data-[state=open]:bg-surface-muted"
        >
          <Avatar name={me.user.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">{me.user.name}</span>
            <span className="block truncate text-xs capitalize text-fg-subtle">{me.user.role}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-fg-subtle" aria-hidden />
          <span className="sr-only">Open user menu</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium text-fg">{me.user.name}</span>
          <span className="block truncate text-xs text-fg-subtle">{me.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings" onClick={onNavigate}>
            <Settings aria-hidden /> Account settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut().catch(() => toast.error('Could not sign out'))}>
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Sidebar contents (used by both the desktop rail and the mobile drawer). */
export function SidebarContent({ me, onNavigate }: { me: MeDTO; onNavigate?: () => void }) {
  const visible = (items: NavItem[]) => items.filter((i) => !i.permission || hasPermission(me.user.role, i.permission));
  const primary = visible(PRIMARY_NAV);
  const secondary = visible(SECONDARY_NAV);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Link href="/dashboard" onClick={onNavigate} className="rounded-md" aria-label="Scenox Vault home">
          <Logo />
        </Link>
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="flex flex-col gap-0.5">
          {primary.map((item) => (
            <li key={item.href}>
              <NavLink item={item} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
        {secondary.length > 0 && (
          <>
            <p className="mb-1 mt-6 px-2.5 text-xs font-medium uppercase tracking-wide text-fg-subtle">Administration</p>
            <ul className="flex flex-col gap-0.5">
              {secondary.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
      <div className="shrink-0 border-t border-border p-3">
        <UserMenu me={me} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
