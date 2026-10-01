'use client';

import * as React from 'react';
import { Lock } from 'lucide-react';
import type { Branding } from '@scenox/shared';
import { LogoMark } from '@/components/brand/logo';
import { Badge } from '@/components/ui';
import { brandStyle, isHexColor } from './branding';

/** Dialogs render in a portal outside the themed wrapper, so mirror the brand colour on <html> too. */
export function useBrandOnRoot(primary: string | null | undefined) {
  React.useEffect(() => {
    if (!isHexColor(primary)) return;
    const root = document.documentElement;
    const style = brandStyle(primary) as Record<string, string>;
    const prev: Record<string, string> = {};
    for (const k of Object.keys(style)) {
      prev[k] = root.style.getPropertyValue(k);
      root.style.setProperty(k, style[k]!);
    }
    return () => {
      for (const k of Object.keys(prev)) {
        if (prev[k]) root.style.setProperty(k, prev[k]!);
        else root.style.removeProperty(k);
      }
    };
  }, [primary]);
}

/** Logo (or the default mark) that falls back gracefully if the image fails to load. */
export function BrandLogo({ src, className }: { src: string | null | undefined; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [src]);
  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" onError={() => setFailed(true)} className={className ?? 'h-8 max-w-[140px] rounded-sm object-contain'} />;
  }
  return <LogoMark className="size-8" />;
}

/** Minimal branded frame for the pre-dashboard screens (loading, password, expired, errors). */
export function PortalShell({ branding, logoUrl, children }: { branding?: Branding | null; logoUrl?: string | null; children: React.ReactNode }) {
  const primary = branding?.primaryColor;
  useBrandOnRoot(primary);
  const logo = logoUrl ?? branding?.logoUrl ?? null;
  return (
    <div style={brandStyle(primary)} className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border bg-surface/80 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandLogo src={logo} />
            {branding?.companyName && <span className="truncate text-[15px] font-semibold tracking-tight text-fg">{branding.companyName}</span>}
          </div>
          <Badge tone="neutral" className="shrink-0 gap-1.5 py-1 pl-2 pr-2.5">
            <Lock aria-hidden className="size-3" />
            Secure portal
          </Badge>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>
      <footer className="px-4 pb-8 text-center text-xs text-fg-subtle">
        Files are sent over an encrypted connection and delivered directly to {branding?.companyName ?? 'the recipient'}.
      </footer>
    </div>
  );
}
