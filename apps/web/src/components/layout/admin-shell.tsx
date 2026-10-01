'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Menu, X } from 'lucide-react';
import type { MeDTO } from '@scenox/shared';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { BrandingProvider } from '@/components/admin/branding-provider';
import { NotificationsBell } from '@/components/admin/notifications-bell';
import { SidebarContent } from './sidebar';

export function AdminShell({ me, children }: { me: MeDTO; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  React.useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="min-h-dvh">
      <BrandingProvider />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-md">
        Skip to content
      </a>

      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-surface lg:block">
        <SidebarContent me={me} showBell />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
          <DialogPrimitive.Trigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation" className="-ml-2">
              <Menu aria-hidden />
            </Button>
          </DialogPrimitive.Trigger>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-zinc-950/40 animate-fade-in" />
            <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-border bg-surface shadow-lg animate-slide-in-left focus:outline-none">
              <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">Main navigation menu</DialogPrimitive.Description>
              <SidebarContent me={me} onNavigate={() => setOpen(false)} />
              <DialogPrimitive.Close
                aria-label="Close navigation"
                className="absolute right-3 top-3.5 rounded-md p-1.5 text-fg-subtle hover:bg-surface-muted hover:text-fg"
              >
                <X className="size-4" aria-hidden />
              </DialogPrimitive.Close>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <Link href="/dashboard" aria-label="Scenox Vault home" className="rounded-md">
          <Logo />
        </Link>
        <NotificationsBell className="ml-auto" />
      </div>

      <div className="lg:pl-60">
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 py-6 focus:outline-none sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function AdminShellSkeleton() {
  return (
    <div className="min-h-dvh" aria-busy="true">
      <span className="sr-only" role="status">Loading</span>
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-border bg-surface p-4 lg:block">
        <div className="mb-6 flex items-center gap-2.5"><div className="size-8 animate-pulse rounded-lg bg-surface-muted" /><div className="h-4 w-28 animate-pulse rounded bg-surface-muted" /></div>
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="mb-2 h-8 animate-pulse rounded-md bg-surface-muted" />)}
      </aside>
      <div className="lg:pl-60">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="mb-3 h-8 w-56 animate-pulse rounded bg-surface-muted" />
          <div className="mb-8 h-4 w-80 max-w-full animate-pulse rounded bg-surface-muted" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-lg border border-border bg-surface" />)}
          </div>
        </div>
      </div>
    </div>
  );
}
