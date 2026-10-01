'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { Branding, UploadEngineConfig } from '@scenox/shared';
import { invalidatePortalData, useDashboard } from '@/lib/portal/hooks';
import { availableTabs, parseTab, TAB_LABELS, type PortalTab } from '@/lib/portal/tabs';
import { brandStyle } from './branding';
import { CommentsSheet } from './comments-sheet';
import { FilesTab } from './files-tab';
import { DashboardHeader, UploadPill } from './header';
import { MessagesTab } from './messages-tab';
import { OverviewTab } from './overview-tab';
import { PortalProvider, usePortal, type FileRef, type NavPatch, type Portal, type UrlView } from './portal-context';
import { DragOverlay } from './dropzone';
import { PreflightDialog } from './preflight-dialog';
import { useBrandOnRoot } from './shell';
import { panelId, TabNav, tabId } from './tab-nav';
import { toDialogPlan, useUploadController, type UploadController } from './use-upload-controller';
import { usePageGuards } from './use-page-guards';
import { UploadsTab } from './uploads-tab';
import { UploadTab } from './upload-tab';

const URL_KEYS = ['path', 'type', 'q'] as const;

export function PortalDashboard({
  token, portal, uploadConfig, branding, onAccessLost, onReload,
}: {
  token: string;
  portal: Portal;
  uploadConfig?: UploadEngineConfig;
  branding: Branding;
  /** The portal access token no longer works: go back to the password screen. */
  onAccessLost: () => void;
  /** Reload the portal state (e.g. it expired or was disabled while the page was open). */
  onReload: () => void;
}) {
  useBrandOnRoot(branding.primaryColor);
  const qc = useQueryClient();

  /* capabilities: portal settings, narrowed if the server answers 403 for a feature */
  const [hidden, setHidden] = React.useState({ files: false, messages: false });
  const hideFeature = React.useCallback((f: 'files' | 'messages') => setHidden((h) => (h[f] ? h : { ...h, [f]: true })), []);
  const canViewFiles = portal.allowClientViewFiles && !hidden.files;
  const canMessage = portal.allowClientMessages && !hidden.messages;
  const canDelete = canViewFiles && portal.allowClientDeleteFiles;
  const tabs = React.useMemo(() => availableTabs({ files: canViewFiles, messages: canMessage }), [canViewFiles, canMessage]);

  const lostRef = React.useRef(false);
  const accessLost = React.useCallback(() => {
    if (lostRef.current) return;
    lostRef.current = true;
    onAccessLost();
  }, [onAccessLost]);

  /* URL state: ?tab=files&path=…&type=…&q=… (pushState is synced with useSearchParams by Next) */
  const sp = useSearchParams();
  const view = React.useMemo<UrlView>(
    () => ({ tab: parseTab(sp.get('tab'), tabs), path: sp.get('path') ?? '', type: sp.get('type') ?? '', q: sp.get('q') ?? '' }),
    [sp, tabs],
  );
  const navigate = React.useCallback(
    (patch: NavPatch, mode: 'push' | 'replace' = 'push') => {
      const next = new URLSearchParams(window.location.search);
      const current = parseTab(next.get('tab'), tabs);
      if (patch.tab && patch.tab !== current) for (const k of URL_KEYS) next.delete(k);
      if (patch.tab) {
        if (patch.tab === 'overview') next.delete('tab');
        else next.set('tab', patch.tab);
      }
      for (const k of URL_KEYS) {
        const v = patch[k];
        if (v === undefined) continue;
        if (v) next.set(k, v);
        else next.delete(k);
      }
      const search = next.toString();
      const url = `${window.location.pathname}${search ? `?${search}` : ''}`;
      if (url === `${window.location.pathname}${window.location.search}`) return;
      window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
      if (patch.tab && patch.tab !== current) window.scrollTo({ top: 0 });
    },
    [tabs],
  );

  /* uploads live up here so they keep running across tabs */
  const upload = useUploadController({
    token, portal, uploadConfig,
    onRunComplete: React.useCallback(() => {
      invalidatePortalData(qc, token);
      // files may still be "processing" for a moment: refresh once more shortly after
      setTimeout(() => invalidatePortalData(qc, token), 6000);
    }, [qc, token]),
    onWindowDrop: React.useCallback(() => navigate({ tab: 'upload' }), [navigate]),
  });
  usePageGuards(upload.snapshot.stats.running);

  const [commentFile, setCommentFile] = React.useState<FileRef | null>(null);
  const openFileComments = React.useCallback((f: FileRef) => setCommentFile(f), []);

  const ctx = React.useMemo(
    () => ({ token, portal, branding, canViewFiles, canDelete, canMessage, hideFeature, accessLost, reloadPortal: onReload, view, navigate, openFileComments }),
    [token, portal, branding, canViewFiles, canDelete, canMessage, hideFeature, accessLost, onReload, view, navigate, openFileComments],
  );

  return (
    <PortalProvider value={ctx}>
      <Frame tabs={tabs} upload={upload} />

      <DragOverlay visible={upload.dragging} />
      <PreflightDialog
        plan={upload.plan ? toDialogPlan(upload.plan) : null}
        onCancel={() => {
          const plan = upload.plan;
          if (plan?.fromSelection) upload.selection.removeIds(new Set(plan.rejected.map((r) => r.c.selId!).filter((x) => x !== undefined)));
          upload.setPlan(null);
        }}
        onConfirm={(choice) => {
          const plan = upload.plan;
          if (!plan) return;
          upload.commit(plan.accepted, plan.duplicates, choice, plan.fromSelection);
          upload.setPlan(null);
        }}
      />
      {canMessage && <CommentsSheet file={commentFile} onClose={() => setCommentFile(null)} />}
    </PortalProvider>
  );
}

/** Header, tab navigation and the active tab. Lives inside the provider so it can read the dashboard query. */
function Frame({ tabs, upload }: { tabs: readonly PortalTab[]; upload: UploadController }) {
  const { portal, branding, canMessage, view, navigate } = usePortal();
  const dashboard = useDashboard();
  const unread = canMessage ? (dashboard.data?.messages.unread ?? 0) : 0;

  React.useEffect(() => {
    document.title = `${TAB_LABELS[view.tab]} · ${portal.title} · ${branding.companyName}`;
  }, [view.tab, portal.title, branding.companyName]);

  const select = (t: PortalTab) => navigate({ tab: t });
  let content: React.ReactNode;
  switch (view.tab) {
    case 'upload': content = <UploadTab upload={upload} />; break;
    case 'files': content = <FilesTab />; break;
    case 'uploads': content = <UploadsTab />; break;
    case 'messages': content = <MessagesTab />; break;
    default: content = <OverviewTab />;
  }

  return (
    <div style={brandStyle(branding.primaryColor)} className="flex min-h-dvh flex-col bg-background">
      <a href="#portal-main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-md">
        Skip to content
      </a>
      <DashboardHeader
        companyName={branding.companyName} title={portal.title} logoUrl={portal.logoUrl ?? branding.logoUrl ?? null}
        pill={view.tab === 'upload' ? null : <UploadPill snapshot={upload.snapshot} onOpen={() => select('upload')} />}
      >
        <TabNav tabs={tabs} active={view.tab} onSelect={select} unread={unread} variant="top" />
      </DashboardHeader>

      <main id="portal-main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 md:pb-12 md:pt-8">
        <div role="tabpanel" id={panelId(view.tab)} aria-labelledby={tabId('top', view.tab)} className="animate-fade-in" key={view.tab}>
          {content}
        </div>
      </main>

      <footer className="hidden px-4 pb-8 text-center text-xs text-fg-subtle md:block">
        Files are sent over an encrypted connection and delivered directly to {branding.companyName || 'the recipient'}.
      </footer>

      <TabNav tabs={tabs} active={view.tab} onSelect={select} unread={unread} variant="bottom" />
    </div>
  );
}
