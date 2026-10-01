'use client';

import * as React from 'react';
import type { PublicPortalDTO } from '@scenox/shared';
import { ApiClientError } from '@/lib/api';
import { portalApi } from '@/lib/upload';
import { accessStore } from './branding';
import { PasswordGate } from './password-gate';
import { PortalShell } from './shell';
import { DisabledState, ExpiredState, LoadErrorState, NotFoundState, PortalSkeleton } from './state-screens';
import { PortalDashboard } from './dashboard';

type State =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; data: PublicPortalDTO };

export function PortalApp({ token }: { token: string }) {
  const [state, setState] = React.useState<State>({ kind: 'loading' });

  const load = React.useCallback(async () => {
    try {
      const access = accessStore.load(token);
      const data = await portalApi.get(token, access?.accessToken);
      if (data.state === 'password_required' && access) accessStore.clear(token); // stale/invalid access token
      setState({ kind: 'loaded', data });
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 404) setState({ kind: 'not_found' });
      else if (e instanceof ApiClientError && e.status === 429) setState({ kind: 'error', message: 'Too many requests. Please wait a moment and try again.' });
      else setState({ kind: 'error', message: 'We couldn’t reach the server. Check your connection and try again.' });
    }
  }, [token]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /** The stored access token stopped working: forget it and ask the server again (→ password screen). */
  const onAccessLost = React.useCallback(() => {
    accessStore.clear(token);
    setState({ kind: 'loading' });
    void load();
  }, [token, load]);

  const onReload = React.useCallback(() => {
    setState({ kind: 'loading' });
    void load();
  }, [load]);

  const data = state.kind === 'loaded' ? state.data : null;
  React.useEffect(() => {
    if (data?.portal) document.title = `${data.portal.title} · ${data.branding.companyName}`;
    else if (data) document.title = data.branding.companyName;
  }, [data]);

  if (state.kind === 'loading') {
    return (
      <PortalShell>
        <PortalSkeleton />
      </PortalShell>
    );
  }
  if (state.kind === 'not_found') {
    return (
      <PortalShell>
        <NotFoundState />
      </PortalShell>
    );
  }
  if (state.kind === 'error') {
    return (
      <PortalShell>
        <LoadErrorState
          message={state.message}
          onRetry={() => {
            setState({ kind: 'loading' });
            void load();
          }}
        />
      </PortalShell>
    );
  }

  const { data: d } = state;
  const email = d.branding.supportEmail;
  if (d.state === 'expired') {
    return (
      <PortalShell branding={d.branding}>
        <ExpiredState supportEmail={email} />
      </PortalShell>
    );
  }
  if (d.state === 'disabled') {
    return (
      <PortalShell branding={d.branding}>
        <DisabledState supportEmail={email} />
      </PortalShell>
    );
  }
  if (d.state === 'password_required' || !d.portal) {
    return (
      <PortalShell branding={d.branding}>
        <PasswordGate
          token={token} companyName={d.branding.companyName}
          onUnlocked={() => {
            setState({ kind: 'loading' });
            void load();
          }}
        />
      </PortalShell>
    );
  }
  return (
    <React.Suspense
      fallback={
        <PortalShell branding={d.branding}>
          <PortalSkeleton />
        </PortalShell>
      }
    >
      <PortalDashboard token={token} portal={d.portal} uploadConfig={d.upload} branding={d.branding} onAccessLost={onAccessLost} onReload={onReload} />
    </React.Suspense>
  );
}
