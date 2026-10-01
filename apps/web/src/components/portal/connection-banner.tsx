'use client';

import { RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui';

export function ConnectionBanner({ offline, sessionExpired }: { offline: boolean; sessionExpired: boolean }) {
  if (sessionExpired) {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger sm:flex-row sm:items-center sm:justify-between">
        <span>Your upload session expired. Refresh the page to continue.</span>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          <RefreshCw aria-hidden /> Refresh page
        </Button>
      </div>
    );
  }
  if (!offline) return null;
  return (
    <div role="status" aria-live="polite" className="flex animate-fade-in items-start gap-3 rounded-lg border border-warning-border bg-warning-bg p-4 text-sm text-warning">
      <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>Connection lost — we’ll resume automatically when you’re back online.</span>
    </div>
  );
}
