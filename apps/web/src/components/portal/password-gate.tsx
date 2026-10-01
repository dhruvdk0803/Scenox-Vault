'use client';

import * as React from 'react';
import { KeyRound } from 'lucide-react';
import { ApiClientError } from '@/lib/api';
import { Button, Card, Field, Input } from '@/components/ui';
import { portalApi } from '@/lib/upload/portal-api';
import { accessStore } from './branding';

export function PasswordGate({ token, companyName, onUnlocked }: { token: string; companyName?: string; onUnlocked: () => void }) {
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await portalApi.unlock(token, password);
      accessStore.save(token, res);
      onUnlocked();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 429) setError('Too many attempts. Please wait a minute and try again.');
      else if (err instanceof ApiClientError && (err.status === 401 || err.status === 403 || err.status === 400)) setError('That password isn’t right. Please check it and try again.');
      else if (err instanceof ApiClientError && err.status === 0) setError('We couldn’t reach the server. Check your connection and try again.');
      else setError('Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto mt-6 max-w-md animate-fade-in px-6 py-10 shadow-sm sm:px-10">
      <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden>
            <KeyRound className="size-6" />
          </div>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight text-fg">This link is password protected</h1>
            <p className="text-sm text-fg-muted">
              Enter the password{companyName ? ` ${companyName} shared with you` : ' you were given'} to continue.
            </p>
          </div>
        </div>
        <Field label="Password" error={error}>
          <Input
            type="password" autoFocus autoComplete="current-password" value={password} className="h-11 text-base sm:text-sm"
            onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
          />
        </Field>
        <Button type="submit" size="lg" loading={busy} disabled={!password}>
          Continue
        </Button>
      </form>
    </Card>
  );
}
