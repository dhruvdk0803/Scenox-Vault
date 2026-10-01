'use client';

import * as React from 'react';

/** While `active`: warn before closing the tab and keep the screen awake (where supported). */
export function usePageGuards(active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  React.useEffect(() => {
    if (!active) return;
    type Sentinel = { release(): Promise<void>; addEventListener?: unknown };
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } };
    if (!nav.wakeLock) return;
    let lock: Sentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      try {
        const l = await nav.wakeLock!.request('screen');
        if (stopped) void l.release().catch(() => undefined);
        else lock = l;
      } catch {
        /* denied (battery saver, hidden tab): ignore */
      }
    };
    void acquire();
    // The lock is released automatically when the tab is hidden; re-acquire when it's visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}
