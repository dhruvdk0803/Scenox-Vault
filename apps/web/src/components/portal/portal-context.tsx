'use client';

import * as React from 'react';
import type { Branding, ClientFileDTO, PublicPortalDTO } from '@scenox/shared';
import type { PortalTab } from '@/lib/portal/tabs';

export type Portal = NonNullable<PublicPortalDTO['portal']>;

/** What the URL says about the current view (`?tab=files&path=Docs&type=image&q=invoice`). */
export interface UrlView {
  tab: PortalTab;
  path: string;
  type: string;
  q: string;
}

export interface NavPatch {
  tab?: PortalTab;
  path?: string | null;
  type?: string | null;
  q?: string | null;
}

export interface FileRef {
  id: string;
  name: string;
  relativePath?: string;
  size?: number;
  extension?: string;
  type?: string;
}

export interface PortalContextValue {
  token: string;
  portal: Portal;
  branding: Branding;
  /** Effective capabilities: portal settings, narrowed further if the server answered 403 for a feature. */
  canViewFiles: boolean;
  canDelete: boolean;
  canMessage: boolean;
  hideFeature: (f: 'files' | 'messages') => void;
  /** The portal access token stopped working (password changed / expired). */
  accessLost: () => void;
  /** The portal itself became unavailable (expired / disabled): reload its state. */
  reloadPortal: () => void;
  view: UrlView;
  navigate: (patch: NavPatch, mode?: 'push' | 'replace') => void;
  openFileComments: (f: FileRef) => void;
  /** Opens the full-screen viewer on `fileId`; ←/→ move through `files` (the list currently on screen). */
  openPreview: (files: ClientFileDTO[], fileId: string) => void;
}

const Ctx = React.createContext<PortalContextValue | null>(null);

export const PortalProvider = Ctx.Provider;

export function usePortal(): PortalContextValue {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('usePortal must be used inside <PortalProvider>');
  return v;
}
