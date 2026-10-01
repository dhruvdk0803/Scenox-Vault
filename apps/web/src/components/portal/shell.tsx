'use client';

import * as React from 'react';
import { Lock } from 'lucide-react';
import type { Branding } from '@scenox/shared';
import { LogoMark } from '@/components/brand/logo';
import { Badge } from '@/components/ui';
import { brandStyle, isHexColor } from './branding';

export function PortalShell({
  branding, logoUrl, children, wide, bottomInset,
}: {
  branding?: Branding | null;
  logoUrl?: string | null;
  children: React.ReactNode;
  wide?: boolean;
  /** Extra bottom padding (px-ish class) so a sticky mobile bar never covers content. */
  bottomInset?: boolean;
}) {
  const primary = branding?.primaryColor;
  // Dialogs render in a portal outside this wrapper, so mirror the brand colour on <html> too.
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

  const logo = logoUrl ?? branding?.logoUrl ?? null;
  const [logoFailed, setLogoFailed] = React.useState(false);
  return (
    <div style={brandStyle(primary)} className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border bg-surface/80 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
        <div className={`mx-auto flex h-16 items-center justify-between gap-3 px-4 sm:px-6 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
          <div className="flex min-w-0 items-center gap-3">
            {logo && !logoFailed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" onError={() => setLogoFailed(true)} className="h-8 max-w-[140px] rounded-sm object-contain" />
            ) : (
              <LogoMark className="size-8" />
            )}
            {branding?.companyName && <span className="truncate text-[15px] font-semibold tracking-tight text-fg">{branding.companyName}</span>}
          </div>
          <Badge tone="neutral" className="shrink-0 gap-1.5 py-1 pl-2 pr-2.5">
            <Lock aria-hidden className="size-3" />
            Secure upload
          </Badge>
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 px-4 py-8 sm:px-6 sm:py-12 ${wide ? 'max-w-5xl' : 'max-w-3xl'} ${bottomInset ? 'pb-32 sm:pb-12' : ''}`}>{children}</main>
      <footer className="px-4 pb-8 text-center text-xs text-fg-subtle">
        Files are sent over an encrypted connection and delivered directly to {branding?.companyName ?? 'the recipient'}.
      </footer>
    </div>
  );
}
